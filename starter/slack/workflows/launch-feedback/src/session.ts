import { randomUUID } from "node:crypto";

import {
  createSlackThreadSessionStore,
  openModal,
  postMessage,
  slackThreadKey,
  updateMessage,
  type SlackBlockAction,
  type SlackThreadRef,
  type SlackViewSubmission,
  type SlackViewSubmissionResult,
  type Write,
} from "@corbits/example-slack-bridge";
import { runLocal, type WorkflowRun } from "@intx/workflow";

import {
  alreadyRunningBlocks,
  completionBlocks,
  draftCardBlocks,
  editDraftModal,
  failedBlocks,
  feedbackBriefBlocks,
  invalidURLBlocks,
  startedBlocks,
  DRAFT_EDIT_CALLBACK_ID,
} from "./blocks";
import type { LaunchFeedbackConfig } from "./config";
import {
  createInvokeStep,
  createWorkflowAuthorize,
  parseDraftActionSignal,
} from "./invoke-step";
import type {
  DraftActionSignal,
  FollowUpDraft,
  LaunchFeedback,
  LaunchFeedbackTrigger,
  PostReceipt,
} from "./types";
import { parseXStatusURL, validatePostText } from "./validation";
import {
  defineLaunchFeedbackWorkflow,
  DRAFT_ACTION_SIGNAL,
} from "./workflow";

type SessionStatus =
  | "analyzing"
  | "awaiting-action"
  | "resuming"
  | "expired"
  | "finished";

type StoredDraft = {
  id: string;
  revision: number;
  draft: FollowUpDraft;
  actionToken: string;
  status: "pending" | "skipped" | "publishing" | "published" | "disabled" | "expired" | "preview-only";
  messageTs?: string;
  actor?: string;
  receipt?: PostReceipt;
};

type PendingSession = {
  key: string;
  sessionId: string;
  thread: SlackThreadRef;
  requestedBy?: string;
  run: WorkflowRun;
  status: SessionStatus;
  publishAllowed: boolean;
  drafts: StoredDraft[];
  selectedDraftId?: string;
  timeout?: ReturnType<typeof setTimeout>;
};

type DraftAction = SlackBlockAction & { value: string };
type SendMessage = typeof postMessage;
type UpdateMessage = typeof updateMessage;
type OpenModal = typeof openModal;

export type StartWorkflow = (input: {
  triggerPayload: LaunchFeedbackTrigger;
  onStepDone: (stepId: string, output: unknown) => void;
  log: (line: string) => void;
}) => WorkflowRun;

export type LaunchFeedbackSessions = {
  start: (input: {
    teamId: string | undefined;
    channel: string;
    threadTs: string;
    prompt: string;
    userId?: string;
  }) => Promise<void>;
  edit: (action: DraftAction) => Promise<void>;
  publish: (action: DraftAction) => Promise<void>;
  skip: (action: DraftAction) => Promise<void>;
  submitEdit: (submission: SlackViewSubmission) => SlackViewSubmissionResult;
};

export function createLaunchFeedbackSessions(options: {
  config: LaunchFeedbackConfig;
  stderr: Write;
  startWorkflow?: StartWorkflow;
  sendMessage?: SendMessage;
  updateMessage?: UpdateMessage;
  openModal?: OpenModal;
}): LaunchFeedbackSessions {
  const { config, stderr } = options;
  const sendMessage = options.sendMessage ?? postMessage;
  const update = options.updateMessage ?? updateMessage;
  const open = options.openModal ?? openModal;
  const sessions = createSlackThreadSessionStore<PendingSession>(
    (session) => session.status !== "finished" && session.status !== "expired",
  );
  const startingThreads = new Set<string>();
  const draftsByToken = new Map<string, { session: PendingSession; draft: StoredDraft }>();

  const startWorkflow: StartWorkflow =
    options.startWorkflow ??
    ((input) => {
      const authorize = createWorkflowAuthorize();
      return runLocal(defineLaunchFeedbackWorkflow(config.source), {
        triggerPayload: input.triggerPayload,
        invokeStep: createInvokeStep({
          source: config.source,
          xClient: config.xClient,
          contextRoot: config.contextRoot,
          authorize,
          onStepDone: input.onStepDone,
          log: input.log,
        }),
        authorize,
      });
    });

  async function start(input: {
    teamId: string | undefined;
    channel: string;
    threadTs: string;
    prompt: string;
    userId?: string;
  }): Promise<void> {
    const thread: SlackThreadRef = {
      teamId: input.teamId,
      channel: input.channel,
      threadTs: input.threadTs,
    };
    const key = slackThreadKey(thread);
    if (sessions.getActive(key) !== undefined || startingThreads.has(key)) {
      await sendMessage(config.botToken, {
        channel: input.channel,
        thread_ts: input.threadTs,
        text: "A launch feedback analysis is already active in this thread.",
        blocks: alreadyRunningBlocks(),
      });
      return;
    }

    const url = extractXStatusURL(input.prompt);
    if (url === undefined) {
      await sendMessage(config.botToken, {
        channel: input.channel,
        thread_ts: input.threadTs,
        text: "A full X status URL is required.",
        blocks: invalidURLBlocks(),
      });
      return;
    }

    startingThreads.add(key);
    let pending: PendingSession | undefined;
    try {
      await sendMessage(config.botToken, {
        channel: input.channel,
        thread_ts: input.threadTs,
        text: `Analyzing recent replies to ${url}`,
        blocks: startedBlocks(url),
      });

      const run = startWorkflow({
        triggerPayload: {
          url,
          request: input.prompt,
          slack: {
            ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
            channel: input.channel,
            threadTs: input.threadTs,
            ...(input.userId !== undefined
              ? { requestedBy: input.userId }
              : {}),
          },
        },
        onStepDone(stepId, output) {
          if (stepId !== "analyze") return;
          queueMicrotask(() => {
            if (pending !== undefined) {
            void presentFeedback(pending, output).catch((error) =>
                abortPresentation(pending!, error),
              );
            }
          });
        },
        log: (line) => stderr(`slack-launch-feedback: ${line}\n`),
      });
      pending = {
        key,
        sessionId: randomUUID(),
        thread,
        ...(input.userId !== undefined ? { requestedBy: input.userId } : {}),
        run,
        status: "analyzing",
        publishAllowed: false,
        drafts: [],
      };
      sessions.set(key, pending);
      void watchTerminal(pending);
    } finally {
      startingThreads.delete(key);
    }
  }

  async function presentFeedback(
    session: PendingSession,
    output: unknown,
  ): Promise<void> {
    if (session.status !== "analyzing") return;
    const feedback = output as LaunchFeedback;
    session.publishAllowed = await canPublish(feedback);

    await sendMessage(config.botToken, {
      channel: session.thread.channel,
      thread_ts: session.thread.threadTs,
      text: `Launch feedback: ${feedback.summary}`,
      blocks: feedbackBriefBlocks(feedback),
    });

    session.drafts = feedback.drafts.map((draft) => ({
      id: randomUUID(),
      revision: 1,
      draft,
      actionToken: randomUUID(),
      status: session.publishAllowed ? "pending" : "preview-only",
    }));
    for (const draft of session.drafts) {
      registerDraft(session, draft);
      const message = await sendMessage(config.botToken, {
        channel: session.thread.channel,
        thread_ts: session.thread.threadTs,
        text: `${draft.draft.title}: ${draft.draft.text}`,
        blocks: draftCardBlocks(draft),
      });
      draft.messageTs = message.ts;
    }

    if (!session.publishAllowed) {
      session.status = "resuming";
      await session.run.cancel(
        "supervisor-operator",
        "Authenticated X account does not own the source post",
      );
      return;
    }
    session.status = "awaiting-action";
    session.timeout = setTimeout(() => {
      void expireSession(session);
    }, config.approvalTimeoutMs);
  }

  async function edit(action: DraftAction): Promise<void> {
    const match = matchingDraft(action);
    if (match === undefined || action.triggerId === undefined) return;
    await open(config.botToken, {
      triggerId: action.triggerId,
      view: editDraftModal({
        actionToken: match.draft.actionToken,
        draft: match.draft.draft,
        revision: match.draft.revision,
      }),
    });
  }

  function submitEdit(
    submission: SlackViewSubmission,
  ): SlackViewSubmissionResult {
    if (submission.callbackId !== DRAFT_EDIT_CALLBACK_ID) return {};
    const match = draftsByToken.get(submission.privateMetadata);
    if (match === undefined || !matchesSubmission(match.session, submission)) {
      return {};
    }
    if (
      match.session.status !== "awaiting-action" ||
      match.draft.status !== "pending"
    ) {
      return {};
    }

    const validation = validatePostText(submission.textValues["draft.text"]);
    if (validation.error !== undefined) {
      return { errors: { draft: validation.error } };
    }

    draftsByToken.delete(match.draft.actionToken);
    match.draft.actionToken = randomUUID();
    match.draft.revision += 1;
    match.draft.draft = { ...match.draft.draft, text: validation.text };
    registerDraft(match.session, match.draft);

    return {
      afterAck: async () => {
        await updateDraftCard(match.session, match.draft);
      },
    };
  }

  async function publish(action: DraftAction): Promise<void> {
    const match = matchingDraft(action);
    if (match === undefined || !match.session.publishAllowed) return;
    const { session, draft } = match;
    session.status = "resuming";
    session.selectedDraftId = draft.id;
    draft.status = "publishing";
    draft.actor = action.userId ?? "slack-user";
    clearSessionTimeout(session);
    invalidateSessionTokens(session);
    const cardUpdates: Promise<unknown>[] = [];
    for (const candidate of session.drafts) {
      if (candidate !== draft && candidate.status === "pending") {
        candidate.status = "disabled";
      }
      cardUpdates.push(updateDraftCard(session, candidate));
    }
    await Promise.allSettled(cardUpdates);

    const signal = parseDraftActionSignal({
      publish: true,
      draftId: draft.id,
      revision: draft.revision,
      text: draft.draft.text,
      approvedBy: draft.actor,
      approvedAt: new Date().toISOString(),
    } satisfies DraftActionSignal);
    await session.run.signal(DRAFT_ACTION_SIGNAL, {
      publish: true,
      ...signal,
    } satisfies DraftActionSignal);
  }

  async function skip(action: DraftAction): Promise<void> {
    const match = matchingDraft(action);
    if (match === undefined) return;
    const { session, draft } = match;
    draftsByToken.delete(draft.actionToken);
    draft.status = "skipped";
    const allSkipped = !session.drafts.some(
      (candidate) => candidate.status === "pending",
    );
    if (allSkipped) {
      session.status = "resuming";
      clearSessionTimeout(session);
      invalidateSessionTokens(session);
    }
    await updateDraftCard(session, draft).catch(() => undefined);
    if (!allSkipped) return;
    await session.run.signal(DRAFT_ACTION_SIGNAL, {
      publish: false,
      reason: "all-drafts-skipped",
    } satisfies DraftActionSignal);
  }

  async function watchTerminal(session: PendingSession): Promise<void> {
    try {
      const result = await session.run.complete;
      clearSessionTimeout(session);
      if (result.terminalStatus === "completed") {
        const receipt = result.outputs.publish as PostReceipt | undefined;
        const selected = session.drafts.find(
          (draft) => draft.id === session.selectedDraftId,
        );
        if (receipt !== undefined && selected !== undefined) {
          selected.status = "published";
          selected.receipt = receipt;
          try {
            await updateDraftCard(session, selected);
          } catch (error) {
            stderr(
              `slack-launch-feedback: receipt card update failed: ${errorMessage(error)}\n`,
            );
            await sendMessage(config.botToken, {
              channel: session.thread.channel,
              thread_ts: session.thread.threadTs,
              text:
                receipt.mode === "live"
                  ? `Published to X: ${receipt.url}`
                  : `Dry-run publication completed: ${receipt.postId}`,
            }).catch(() => undefined);
          }
        } else if (result.outputs.complete !== undefined) {
          await sendMessage(config.botToken, {
            channel: session.thread.channel,
            thread_ts: session.thread.threadTs,
            text: "Review completed without publishing.",
            blocks: completionBlocks(),
          });
        }
      } else if (result.terminalStatus === "failed") {
        await reportFailure(session, new Error("Workflow run failed"));
      }
    } catch (error) {
      await reportFailure(session, error);
    } finally {
      finishSession(session);
    }
  }

  async function expireSession(session: PendingSession): Promise<void> {
    if (session.status !== "awaiting-action") return;
    session.status = "expired";
    invalidateSessionTokens(session);
    for (const draft of session.drafts) {
      if (draft.status === "pending") {
        draft.status = "expired";
        await updateDraftCard(session, draft).catch(() => undefined);
      }
    }
    await session.run.cancel("supervisor-operator", "Slack draft actions expired");
  }

  function matchingDraft(
    action: DraftAction,
  ): { session: PendingSession; draft: StoredDraft } | undefined {
    const match = draftsByToken.get(action.value);
    if (match === undefined) return undefined;
    if (
      match.session.status !== "awaiting-action" ||
      match.draft.status !== "pending" ||
      action.teamId !== match.session.thread.teamId ||
      action.channelId !== match.session.thread.channel ||
      action.messageTs !== match.draft.messageTs
    ) {
      return undefined;
    }
    return match;
  }

  function registerDraft(session: PendingSession, draft: StoredDraft): void {
    if (draft.status === "pending") {
      draftsByToken.set(draft.actionToken, { session, draft });
    }
  }

  function invalidateSessionTokens(session: PendingSession): void {
    for (const draft of session.drafts) draftsByToken.delete(draft.actionToken);
  }

  async function updateDraftCard(
    session: PendingSession,
    draft: StoredDraft,
  ): Promise<void> {
    if (draft.messageTs === undefined) return;
    await update(config.botToken, {
      channel: session.thread.channel,
      ts: draft.messageTs,
      text: `${draft.draft.title}: ${draft.draft.text}`,
      blocks: draftCardBlocks(draft),
    });
  }

  function matchesSubmission(
    session: PendingSession,
    submission: SlackViewSubmission,
  ): boolean {
    return submission.teamId === session.thread.teamId;
  }

  async function canPublish(feedback: LaunchFeedback): Promise<boolean> {
    if (config.xClient.writeMode === "dry-run") return true;
    const me = await config.xClient.getMe();
    return me.id === feedback.source.authorId;
  }

  async function reportFailure(
    session: PendingSession,
    error: unknown,
  ): Promise<void> {
    const message = errorMessage(error);
    stderr(`slack-launch-feedback: ${message}\n`);
    await sendMessage(config.botToken, {
      channel: session.thread.channel,
      thread_ts: session.thread.threadTs,
      text: `Launch feedback failed: ${message}`,
      blocks: failedBlocks(message),
    }).catch(() => undefined);
  }

  async function abortPresentation(
    session: PendingSession,
    error: unknown,
  ): Promise<void> {
    await reportFailure(session, error);
    try {
      await session.run.cancel(
        "supervisor-operator",
        "Slack feedback presentation failed",
      );
    } finally {
      finishSession(session);
    }
  }

  function clearSessionTimeout(session: PendingSession): void {
    if (session.timeout !== undefined) clearTimeout(session.timeout);
    delete session.timeout;
  }

  function finishSession(session: PendingSession): void {
    clearSessionTimeout(session);
    invalidateSessionTokens(session);
    session.status = "finished";
    if (sessions.get(session.key) === session) sessions.delete(session.key);
  }

  return { start, edit, publish, skip, submitEdit };
}

export function extractXStatusURL(prompt: string): string | undefined {
  const match =
    /https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s/>|]+\/status\/\d+[^\s>|]*/i.exec(
      prompt,
    );
  if (match === null) return undefined;
  try {
    return parseXStatusURL(match[0].replace(/[),.!?]+$/, "")).canonicalURL;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
