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
  failedBlocks,
  receiptBlocks,
  rejectedBlocks,
  startedBlocks,
  terminalStatusBlocks,
} from "./blocks";
import { SERVICE_NAME, type PostToXConfig } from "./config";
import { createPostStepInvoker } from "./invoke-step";
import {
  requireApprovedPost,
  X_POST_LIMIT,
  type ApprovedPost,
} from "./post";
import { createPostToolRunner } from "./post-tools";
import { APPROVAL_SIGNAL, definePostWorkflow } from "./workflow";
import { parsePostReceipt, type PostReceipt } from "./x-client";

type PendingPost = {
  approvalID: string;
  thread: SlackThreadRef;
  run: WorkflowRun;
  approvalMessageTs?: string;
  decisionClaimed: boolean;
  failureReported: boolean;
};

type ApprovalAction = SlackBlockAction & { value: string };

export function createPostSessions(opts: {
  config: PostToXConfig;
  stderr: Write;
}) {
  const { config, stderr } = opts;
  const pendingByThread = new Map<string, PendingPost>();
  const pendingByApprovalID = new Map<string, PendingPost>();

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

    const policyReady = deferred<ApprovedPost>();
    const authorize = createSlackAuthorize();
    const toolRunner = createPostToolRunner(config.publisher);
    const invokeStep = createPostStepInvoker({
      source: config.source,
      contextRoot: join(config.contextRoot, safePathSegment(randomUUID())),
      toolRunner,
      authorize,
      log: (line) => stderr(`${SERVICE_NAME}: ${line}\n`),
      onStepDone: (stepID, output) => {
        if (stepID === "policy") {
          policyReady.resolve(requireApprovedPost(output));
        }
      },
      onStepFailed: (stepID, error) => {
        if (stepID === "draft" || stepID === "policy") {
          policyReady.reject(error);
        }
      },
    });
    const run = runLocal(definePostWorkflow(config.source), {
      triggerPayload: input.prompt,
      invokeStep,
      authorize,
    });
    const pending: PendingPost = {
      approvalID: randomUUID(),
      thread,
      run,
      decisionClaimed: false,
      failureReported: false,
    };

    pendingByThread.set(key, pending);
    void postApprovalWhenReady(pending, policyReady.promise);
    void postTerminalResult(pending);

    await postMessage(config.botToken, {
      channel: thread.channel,
      thread_ts: thread.threadTs,
      text: `Started post-to-X workflow ${run.runId}. Drafting now...`,
      blocks: startedBlocks(run.runId),
    });
  }

  async function approve(action: ApprovalAction): Promise<void> {
    if (action.userId === undefined) {
      throw new Error("Slack approval action is missing its user ID");
    }
    const pending = claimDecision(action, APPROVE_ACTION_ID);
    if (pending === undefined) {
      await postDecisionUnavailable(action);
      return;
    }

    try {
      await pending.run.signal(APPROVAL_SIGNAL, {
        approvedBy: action.userId,
        approvedAt: new Date().toISOString(),
        channel: pending.thread.channel,
        threadTs: pending.thread.threadTs,
      });
    } catch (error) {
      cleanup(pending);
      await surfaceDecisionFailure(pending, "Approval", error);
      throw error;
    }

    await postMessage(config.botToken, {
      channel: pending.thread.channel,
      thread_ts: pending.thread.threadTs,
      text:
        config.publisher.mode === "live"
          ? "Approval recorded. Publishing the approved post now..."
          : "Approval recorded. Producing a dry-run receipt now...",
      blocks: decisionRecordedBlocks("Approval"),
    });
  }

  async function reject(action: ApprovalAction): Promise<void> {
    if (action.userId === undefined) {
      throw new Error("Slack rejection action is missing its user ID");
    }
    const pending = claimDecision(action, REJECT_ACTION_ID);
    if (pending === undefined) {
      await postDecisionUnavailable(action);
      return;
    }

    try {
      await pending.run.cancel(
        "supervisor-operator",
        `rejected from Slack by ${action.userId}`,
      );
    } catch (error) {
      cleanup(pending);
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
    expectedActionID: string,
  ): PendingPost | undefined {
    const pending = pendingByApprovalID.get(action.value);
    if (
      pending === undefined ||
      pending.decisionClaimed ||
      pending.approvalMessageTs === undefined ||
      action.actionId !== expectedActionID ||
      normalizeTeamID(action.teamId) !==
        normalizeTeamID(pending.thread.teamId) ||
      action.channelId !== pending.thread.channel ||
      action.messageTs !== pending.approvalMessageTs
    ) {
      return undefined;
    }

    pending.decisionClaimed = true;
    pendingByApprovalID.delete(pending.approvalID);
    return pending;
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

      const message = await postMessage(config.botToken, {
        channel: pending.thread.channel,
        thread_ts: pending.thread.threadTs,
        text: truncateForSlack(
          `Post ready for approval:\n\n${approvedPost.text}\n\n` +
            `${approvedPost.length}/${String(X_POST_LIMIT)} characters`,
        ),
        blocks: approvalBlocks(approvedPost, pending.approvalID),
      });

      if (!ownsThread(pending) || pending.decisionClaimed) return;
      pending.approvalMessageTs = message.ts;
      pendingByApprovalID.set(pending.approvalID, pending);
    } catch (error) {
      const message = errorMessage(error);
      pending.failureReported = true;
      stderr(`${SERVICE_NAME}: failed before approval: ${message}\n`);
      try {
        await pending.run.cancel(
          "supervisor-operator",
          "failed before Slack approval",
        );
      } catch (cancelError) {
        stderr(
          `${SERVICE_NAME}: failed to cancel workflow: ${errorMessage(cancelError)}\n`,
        );
        cleanup(pending);
      }
      await postMessage(config.botToken, {
        channel: pending.thread.channel,
        thread_ts: pending.thread.threadTs,
        text: truncateForSlack(`Post-to-X workflow failed: ${message}`),
        blocks: failedBlocks(message),
      }).catch(() => undefined);
    }
  }

  async function postTerminalResult(pending: PendingPost): Promise<void> {
    try {
      const result = await pending.run.complete;
      cleanup(pending);

      if (result.terminalStatus === "completed") {
        const receipt = parsePostReceipt(result.outputs.publish);
        await postMessage(config.botToken, {
          channel: pending.thread.channel,
          thread_ts: pending.thread.threadTs,
          text: truncateForSlack(receiptText(receipt)),
          blocks: receiptBlocks(receipt),
        });
        return;
      }

      if (pending.decisionClaimed || pending.failureReported) return;
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
        candidate.approvalID === action.value &&
        normalizeTeamID(action.teamId) ===
          normalizeTeamID(candidate.thread.teamId) &&
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
    if (pendingByApprovalID.get(pending.approvalID) === pending) {
      pendingByApprovalID.delete(pending.approvalID);
    }
  }

  return { start, approve, reject };
}

function normalizeTeamID(teamID: string | undefined): string | undefined {
  const normalized = teamID?.trim();
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

function receiptText(receipt: PostReceipt): string {
  if (receipt.mode === "live") {
    return `Posted to X: ${receipt.url}\n\n${receipt.text}`;
  }
  return (
    `Dry-run complete. No X post was created.\n\n${receipt.text}\n\n` +
    `Receipt: ${receipt.postID}`
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
