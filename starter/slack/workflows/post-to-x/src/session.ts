import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  postMessage,
  safePathSegment,
  slackThreadKey,
  truncateForSlack,
  type SlackBlockAction,
  type SlackThreadRef,
  type Write,
} from "@corbits/example-slack-bridge";
import {
  runLocal,
  type WorkflowAuthorizeFn,
  type WorkflowRun,
} from "@intx/workflow";

import {
  APPROVE_ACTION_ID,
  REJECT_ACTION_ID,
  alreadyRunningBlocks,
  approvalBlocks,
  decisionRecordedBlocks,
  dryRunReceiptBlocks,
  failedBlocks,
  rejectedBlocks,
  startedBlocks,
  terminalStatusBlocks,
} from "./blocks";
import { SERVICE_NAME, type PostToXConfig } from "./config";
import { createPostStepInvoker } from "./invoke-step";
import { requireApprovedPost, type ApprovedPost } from "./post";
import { APPROVAL_SIGNAL, definePostWorkflow } from "./workflow";
import type { PostReceipt } from "./x-client";

type PendingPost = {
  approvalId: string;
  thread: SlackThreadRef;
  run: WorkflowRun;
  approvedPost?: ApprovedPost;
  approvalMessageTs?: string;
  decisionClaimed: boolean;
};

type ApprovalAction = SlackBlockAction & { value: string };

type ActionablePendingPost = PendingPost & {
  approvedPost: ApprovedPost;
  approvalMessageTs: string;
};

export type PostSessions = {
  start: (input: {
    teamId: string | undefined;
    channel: string;
    threadTs: string;
    prompt: string;
  }) => Promise<void>;
  approve: (action: ApprovalAction) => Promise<void>;
  reject: (action: ApprovalAction) => Promise<void>;
};

export function createPostSessions(opts: {
  config: PostToXConfig;
  stderr: Write;
}): PostSessions {
  const { config, stderr } = opts;
  const pendingByThread = new Map<string, PendingPost>();
  const pendingByApprovalId = new Map<string, PendingPost>();

  async function start(input: {
    teamId: string | undefined;
    channel: string;
    threadTs: string;
    prompt: string;
  }): Promise<void> {
    const thread = {
      teamId: input.teamId,
      channel: input.channel,
      threadTs: input.threadTs,
    };
    const key = slackThreadKey(thread);
    if (pendingByThread.has(key)) {
      await postMessage(config.botToken, {
        channel: thread.channel,
        thread_ts: thread.threadTs,
        text: "A post-to-X workflow is already running in this thread.",
        blocks: alreadyRunningBlocks(),
      });
      return;
    }

    const outputs = new Map<string, unknown>();
    const policyReady = deferred<ApprovedPost>();
    const authorize = createSlackAuthorize();
    const invokeStep = createPostStepInvoker({
      source: config.source,
      contextRoot: join(config.contextRoot, safePathSegment(randomUUID())),
      publisher: config.publisher,
      authorize,
      log: (line) => stderr(`${SERVICE_NAME}: ${line}\n`),
      onStepDone: (stepId, output) => {
        outputs.set(stepId, output);
        if (stepId === "policy") {
          policyReady.resolve(requireApprovedPost(output));
        }
      },
    });
    const run = runLocal(definePostWorkflow(config.source), {
      triggerPayload: input.prompt,
      invokeStep,
      authorize,
    });
    const pending: PendingPost = {
      approvalId: randomUUID(),
      thread,
      run,
      decisionClaimed: false,
    };

    pendingByThread.set(key, pending);
    void postApprovalWhenReady(pending, policyReady.promise);
    void postTerminalResult(pending, outputs);

    await postMessage(config.botToken, {
      channel: thread.channel,
      thread_ts: thread.threadTs,
      text: `Started post-to-X workflow ${run.runId}. Drafting now...`,
      blocks: startedBlocks(run.runId),
    });
  }

  async function approve(action: ApprovalAction): Promise<void> {
    const pending = claimDecision(action, APPROVE_ACTION_ID);
    if (pending === undefined) {
      await postDecisionUnavailable(action);
      return;
    }

    try {
      await pending.run.signal(APPROVAL_SIGNAL, {
        approvedBy: action.userId ?? "slack-user",
        approvedAt: new Date().toISOString(),
        channel: pending.thread.channel,
        threadTs: pending.thread.threadTs,
      });
    } catch (error) {
      await surfaceDecisionFailure(pending, "Approval", error);
      throw error;
    }

    await postMessage(config.botToken, {
      channel: pending.thread.channel,
      thread_ts: pending.thread.threadTs,
      text: "Approval recorded. Producing a dry-run receipt now...",
      blocks: decisionRecordedBlocks("Approval"),
    });
  }

  async function reject(action: ApprovalAction): Promise<void> {
    const pending = claimDecision(action, REJECT_ACTION_ID);
    if (pending === undefined) {
      await postDecisionUnavailable(action);
      return;
    }

    try {
      await pending.run.cancel("supervisor-operator", "rejected from Slack");
    } catch (error) {
      await surfaceDecisionFailure(pending, "Rejection", error);
      throw error;
    }

    await postMessage(config.botToken, {
      channel: pending.thread.channel,
      thread_ts: pending.thread.threadTs,
      text: "Rejection recorded. Workflow cancelled; nothing was posted.",
      blocks: rejectedBlocks(),
    });
  }

  function claimDecision(
    action: ApprovalAction,
    expectedActionId: string,
  ): ActionablePendingPost | undefined {
    const pending = pendingByApprovalId.get(action.value);
    if (
      pending === undefined ||
      pending.decisionClaimed ||
      pending.approvedPost === undefined ||
      pending.approvalMessageTs === undefined ||
      action.actionId !== expectedActionId ||
      normalizeTeamId(action.teamId) !==
        normalizeTeamId(pending.thread.teamId) ||
      action.channelId !== pending.thread.channel ||
      action.messageTs !== pending.approvalMessageTs
    ) {
      return undefined;
    }

    pending.decisionClaimed = true;
    pendingByApprovalId.delete(pending.approvalId);
    return pending as ActionablePendingPost;
  }

  async function postApprovalWhenReady(
    pending: PendingPost,
    policyReady: Promise<ApprovedPost>,
  ): Promise<void> {
    try {
      const approvedPost = await Promise.race([
        policyReady,
        pending.run.complete.then(() => undefined),
      ]);
      if (approvedPost === undefined || !ownsThread(pending)) return;

      pending.approvedPost = approvedPost;
      const message = await postMessage(config.botToken, {
        channel: pending.thread.channel,
        thread_ts: pending.thread.threadTs,
        text: truncateForSlack(
          `Post ready for approval:\n\n${approvedPost.text}\n\n` +
            `${approvedPost.weightedLength}/${approvedPost.limit} weighted characters`,
        ),
        blocks: approvalBlocks(approvedPost, pending.approvalId),
      });

      if (!ownsThread(pending) || pending.decisionClaimed) return;
      pending.approvalMessageTs = message.ts;
      pendingByApprovalId.set(pending.approvalId, pending);
    } catch (error) {
      stderr(`${SERVICE_NAME}: failed to post approval: ${errorMessage(error)}\n`);
      try {
        await pending.run.cancel(
          "supervisor-operator",
          "failed to post approval controls",
        );
      } catch (cancelError) {
        stderr(
          `${SERVICE_NAME}: failed to cancel workflow: ${errorMessage(cancelError)}\n`,
        );
      }
    }
  }

  async function postTerminalResult(
    pending: PendingPost,
    outputs: Map<string, unknown>,
  ): Promise<void> {
    try {
      const result = await pending.run.complete;
      cleanup(pending);

      if (result.terminalStatus === "completed") {
        const receipt = requirePostReceipt(
          result.outputs.publish ?? outputs.get("publish"),
        );
        await postMessage(config.botToken, {
          channel: pending.thread.channel,
          thread_ts: pending.thread.threadTs,
          text: truncateForSlack(
            `Dry-run complete. No X post was created.\n\n${receipt.text}\n\n` +
              `Receipt: ${receipt.postId}`,
          ),
          blocks: dryRunReceiptBlocks(receipt),
        });
        return;
      }

      if (pending.decisionClaimed) return;
      await postMessage(config.botToken, {
        channel: pending.thread.channel,
        thread_ts: pending.thread.threadTs,
        text: `Post-to-X workflow ended with status ${result.terminalStatus}.`,
        blocks: terminalStatusBlocks(result.terminalStatus),
      });
    } catch (error) {
      cleanup(pending);
      const message = errorMessage(error);
      stderr(`${SERVICE_NAME}: workflow failed: ${message}\n`);
      await postMessage(config.botToken, {
        channel: pending.thread.channel,
        thread_ts: pending.thread.threadTs,
        text: truncateForSlack(`Post-to-X workflow failed: ${message}`),
        blocks: failedBlocks(message),
      }).catch(() => undefined);
    }
  }

  async function postDecisionUnavailable(action: ApprovalAction): Promise<void> {
    const pending = [...pendingByThread.values()].find(
      (candidate) =>
        candidate.approvalId === action.value &&
        normalizeTeamId(action.teamId) ===
          normalizeTeamId(candidate.thread.teamId) &&
        action.channelId === candidate.thread.channel &&
        action.messageTs === candidate.approvalMessageTs,
    );
    if (pending === undefined) return;

    await postMessage(config.botToken, {
      channel: pending.thread.channel,
      thread_ts: pending.thread.threadTs,
      text: "A decision was already recorded for this approval.",
      blocks: decisionRecordedBlocks("Decision already"),
    });
  }

  async function surfaceDecisionFailure(
    pending: PendingPost,
    decision: string,
    error: unknown,
  ): Promise<void> {
    const message = `${decision} failed: ${errorMessage(error)}`;
    stderr(`${SERVICE_NAME}: ${message}\n`);
    await postMessage(config.botToken, {
      channel: pending.thread.channel,
      thread_ts: pending.thread.threadTs,
      text: truncateForSlack(message),
      blocks: failedBlocks(message),
    }).catch(() => undefined);
  }

  function ownsThread(pending: PendingPost): boolean {
    return pendingByThread.get(slackThreadKey(pending.thread)) === pending;
  }

  function cleanup(pending: PendingPost): void {
    const key = slackThreadKey(pending.thread);
    if (pendingByThread.get(key) === pending) {
      pendingByThread.delete(key);
    }
    if (pendingByApprovalId.get(pending.approvalId) === pending) {
      pendingByApprovalId.delete(pending.approvalId);
    }
  }

  return { start, approve, reject };
}

function normalizeTeamId(teamId: string | undefined): string | undefined {
  const normalized = teamId?.trim();
  return normalized === "" ? undefined : normalized;
}

function createSlackAuthorize(): WorkflowAuthorizeFn {
  return async (resource, action) => ({
    effect: "allow",
    matchingGrants: [
      {
        id: "slack-operator-grant",
        resource,
        action,
        effect: "allow",
        origin: "invoker",
        specificity: 100,
      },
    ],
    resolvedBy: {
      id: "slack-operator-grant",
      resource,
      action,
      effect: "allow",
      origin: "invoker",
      specificity: 100,
    },
  });
}

function requirePostReceipt(input: unknown): PostReceipt {
  if (
    typeof input !== "object" ||
    input === null ||
    !("mode" in input) ||
    input.mode !== "dry-run" ||
    !("postId" in input) ||
    typeof input.postId !== "string" ||
    !("text" in input) ||
    typeof input.text !== "string" ||
    !("postedAt" in input) ||
    typeof input.postedAt !== "string"
  ) {
    throw new Error("publish step did not return a dry-run receipt");
  }
  return input as PostReceipt;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
