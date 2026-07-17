import {
  postMessage,
  slackThreadKey,
  updateMessage,
  type SlackThreadRef,
  type Write,
} from "@corbits/example-slack-bridge";
import { runLocal, type WorkflowRun } from "@intx/workflow";

import {
  alreadyRunningBlocks,
  createReadyBlocks,
  draftApprovalBlocks,
  draftDecisionBlocks,
  failedBlocks,
  invalidURLBlocks,
  postedResultBlocks,
  progressBlocks,
  startedBlocks,
  triageResultBlocks,
  type ProgressPhase,
} from "./blocks";
import type { ReplyTriageConfig } from "./config";
import { createInvokeStep, createWorkflowAuthorize } from "./invoke-step";
import type {
  ApprovalPayload,
  CreateDraftsResult,
  PostRepliesResult,
  ReplyDraft,
  ReplyTriageTrigger,
} from "./types";
import { parseXStatusURL } from "./validation";
import { APPROVAL_SIGNAL, defineReplyTriageWorkflow } from "./workflow";

type SendMessage = typeof postMessage;
type UpdateMessage = typeof updateMessage;

export type ReplyTriageRun = Pick<WorkflowRun, "complete" | "signal">;

export type StartWorkflow = (input: {
  triggerPayload: ReplyTriageTrigger;
  log: (line: string) => void;
  onStepStart?: (stepId: string) => void;
  onStepDone?: (stepId: string, output: unknown) => void;
}) => ReplyTriageRun;

type DraftDecision = "approved" | "rejected";

type PendingDraft = {
  key: string;
  draft: ReplyDraft;
  messageTs: string;
  decision?: DraftDecision;
};

type PendingRun = {
  key: string;
  thread: SlackThreadRef;
  run: ReplyTriageRun;
  drafts: Map<string, PendingDraft>;
  progressTs?: string;
  signaled: boolean;
  status: "running" | "awaiting-approval" | "finishing" | "finished";
};

export type ReplyTriageSessions = {
  start: (input: {
    teamId: string | undefined;
    channel: string;
    threadTs: string;
    prompt: string;
    userId?: string;
  }) => Promise<void>;
  approve: (key: string, userId?: string) => Promise<void>;
  reject: (key: string, userId?: string) => Promise<void>;
};

export function createReplyTriageSessions(options: {
  config: ReplyTriageConfig;
  stderr: Write;
  startWorkflow?: StartWorkflow;
  sendMessage?: SendMessage;
  updateMessage?: UpdateMessage;
}): ReplyTriageSessions {
  const { config, stderr } = options;
  const sendMessage = options.sendMessage ?? postMessage;
  const editMessage = options.updateMessage ?? updateMessage;
  const pendingByThread = new Map<string, PendingRun>();
  const draftByKey = new Map<string, { threadKey: string; draftKey: string }>();

  const startWorkflow: StartWorkflow =
    options.startWorkflow ??
    ((input) => {
      const authorize = createWorkflowAuthorize();
      return runLocal(defineReplyTriageWorkflow(config.source), {
        triggerPayload: input.triggerPayload,
        invokeStep: createInvokeStep({
          source: config.source,
          xClient: config.xClient,
          xPublisher: config.xPublisher,
          contextRoot: config.contextRoot,
          authorize,
          log: input.log,
          onStepStart: input.onStepStart,
          onStepDone: input.onStepDone,
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

    const thread: SlackThreadRef = {
      teamId: input.teamId,
      channel: input.channel,
      threadTs: input.threadTs,
    };
    const key = slackThreadKey(thread);
    if (pendingByThread.has(key)) {
      await sendMessage(config.botToken, {
        channel: input.channel,
        thread_ts: input.threadTs,
        text: "A reply triage run is already active in this thread.",
        blocks: alreadyRunningBlocks(),
      });
      return;
    }

    const createReady = deferred<CreateDraftsResult>();
    let watching = false;
    try {
      await sendMessage(config.botToken, {
        channel: input.channel,
        thread_ts: input.threadTs,
        text: `Analyzing recent replies to ${url}`,
        blocks: startedBlocks(url),
      });
      const progress = await sendMessage(config.botToken, {
        channel: input.channel,
        thread_ts: input.threadTs,
        text: "Status: Collect candidates from X",
        blocks: progressBlocks("collecting"),
      });
      const pendingHolder: { current?: PendingRun } = {};
      const run = startWorkflow({
        triggerPayload: {
          url,
          request: input.prompt,
          slack: {
            ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
            channel: input.channel,
            threadTs: input.threadTs,
            ...(input.userId !== undefined ? { requestedBy: input.userId } : {}),
          },
        },
        log: (line) => stderr(`slack-x-reply-triage: ${line}\n`),
        onStepStart(stepId) {
          const pending = pendingHolder.current;
          if (pending !== undefined) setProgress(pending, phaseForStepStart(stepId));
        },
        onStepDone(stepId, output) {
          if (stepId === "create") {
            createReady.resolve(output as CreateDraftsResult);
          }
        },
      });
      const pending: PendingRun = {
        key,
        thread,
        run,
        drafts: new Map(),
        progressTs: progress.ts,
        signaled: false,
        status: "running",
      };
      pendingHolder.current = pending;
      pendingByThread.set(key, pending);
      watching = true;
      void handleCreateReady(pending, createReady.promise);
      void watchTerminal(pending);
    } catch (error) {
      pendingByThread.delete(key);
      await reportFailure(thread, error);
    } finally {
      if (!watching) pendingByThread.delete(key);
    }
  }

  function setProgress(pending: PendingRun, phase: ProgressPhase): void {
    if (pending.progressTs === undefined || pending.status === "finished") {
      return;
    }
    void editMessage(config.botToken, {
      channel: pending.thread.channel,
      ts: pending.progressTs,
      text: `Status: ${phase}`,
      blocks: progressBlocks(phase),
    }).catch(() => undefined);
  }

  function phaseForStepStart(stepId: string): ProgressPhase {
    if (stepId === "collect") return "collecting";
    if (stepId === "triage") return "triaging";
    if (stepId === "create") return "drafting";
    if (stepId === "post") return "publishing";
    return "collecting";
  }

  async function approve(key: string): Promise<void> {
    await decideDraft(key, "approved");
  }

  async function reject(key: string): Promise<void> {
    await decideDraft(key, "rejected");
  }

  async function decideDraft(
    key: string,
    decision: DraftDecision,
  ): Promise<void> {
    const ref = draftByKey.get(key);
    if (ref === undefined) return;
    const pending = pendingByThread.get(ref.threadKey);
    if (pending === undefined || pending.status !== "awaiting-approval") return;
    const draft = pending.drafts.get(ref.draftKey);
    if (draft === undefined || draft.decision !== undefined) return;

    draft.decision = decision;
    await editMessage(config.botToken, {
      channel: pending.thread.channel,
      ts: draft.messageTs,
      text:
        decision === "approved"
          ? `Approved reply to @${draft.draft.authorUsername}`
          : `Rejected reply to @${draft.draft.authorUsername}`,
      blocks: draftDecisionBlocks(draft.draft, decision),
    }).catch(() => undefined);

    await maybeSignalApproval(pending);
  }

  async function handleCreateReady(
    pending: PendingRun,
    createReady: Promise<CreateDraftsResult>,
  ): Promise<void> {
    try {
      const created = await Promise.race([
        createReady,
        pending.run.complete.then(() => undefined),
      ]);
      if (created === undefined || pending.status !== "running") return;

      await sendMessage(config.botToken, {
        channel: pending.thread.channel,
        thread_ts: pending.thread.threadTs,
        text: `Reply triage complete: ${String(created.triage.counts.respondNow)} respond now`,
        blocks: triageResultBlocks(created),
      });
      await sendMessage(config.botToken, {
        channel: pending.thread.channel,
        thread_ts: pending.thread.threadTs,
        text: "Draft approval",
        blocks: createReadyBlocks(created),
      });

      if (created.drafts.length === 0) {
        pending.status = "awaiting-approval";
        setProgress(pending, "publishing");
        await signalApproval(pending, { approved: [] });
        return;
      }

      pending.status = "awaiting-approval";
      setProgress(pending, "awaiting-approval");
      for (const draft of created.drafts) {
        const draftKey = `${pending.key}:${draft.replyId}`;
        const posted = await sendMessage(config.botToken, {
          channel: pending.thread.channel,
          thread_ts: pending.thread.threadTs,
          text: `Draft reply to @${draft.authorUsername}`,
          blocks: draftApprovalBlocks(draft, draftKey),
        });
        pending.drafts.set(draft.replyId, {
          key: draftKey,
          draft,
          messageTs: posted.ts,
        });
        draftByKey.set(draftKey, {
          threadKey: pending.key,
          draftKey: draft.replyId,
        });
      }
    } catch (error) {
      if (pending.status !== "finished") {
        await reportFailure(pending.thread, error);
        finish(pending);
      }
    }
  }

  async function maybeSignalApproval(pending: PendingRun): Promise<void> {
    if (pending.signaled || pending.status !== "awaiting-approval") return;
    for (const draft of pending.drafts.values()) {
      if (draft.decision === undefined) return;
    }
    const approved = [...pending.drafts.values()]
      .filter((item) => item.decision === "approved")
      .map((item) => item.draft);
    await signalApproval(pending, { approved });
  }

  async function signalApproval(
    pending: PendingRun,
    payload: ApprovalPayload,
  ): Promise<void> {
    if (pending.signaled) return;
    pending.signaled = true;
    pending.status = "finishing";
    setProgress(pending, "publishing");
    await pending.run.signal(APPROVAL_SIGNAL, payload);
  }

  async function watchTerminal(pending: PendingRun): Promise<void> {
    try {
      const completed = await pending.run.complete;
      if (completed.terminalStatus !== "completed") {
        throw new Error("Workflow run failed");
      }
      const result = completed.outputs.post as PostRepliesResult | undefined;
      if (result === undefined) throw new Error("Post step returned no output");
      setProgress(pending, "done");
      await sendMessage(config.botToken, {
        channel: pending.thread.channel,
        thread_ts: pending.thread.threadTs,
        text:
          result.posted.length === 0
            ? "No replies posted"
            : `Posted ${String(result.posted.length)} ${result.posted.length === 1 ? "reply" : "replies"} to X`,
        blocks: postedResultBlocks(result),
      });
    } catch (error) {
      await reportFailure(pending.thread, error);
    } finally {
      finish(pending);
    }
  }

  async function reportFailure(
    thread: SlackThreadRef,
    error: unknown,
  ): Promise<void> {
    const message = errorMessage(error);
    stderr(`slack-x-reply-triage: ${message}\n`);
    await sendMessage(config.botToken, {
      channel: thread.channel,
      thread_ts: thread.threadTs,
      text: `Reply triage failed: ${message}`,
      blocks: failedBlocks(message),
    }).catch(() => undefined);
  }

  function finish(pending: PendingRun): void {
    pending.status = "finished";
    pendingByThread.delete(pending.key);
    for (const draft of pending.drafts.values()) {
      draftByKey.delete(draft.key);
    }
  }

  return { start, approve, reject };
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
