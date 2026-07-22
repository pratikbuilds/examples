import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  createSlackThreadSessionStore,
  postMessage,
  safePathSegment,
  slackThreadKey,
  truncateForSlack,
  type SlackThreadRef,
  type Write,
} from "@corbits/example-slack-bridge";
import {
  runLocal,
  type WorkflowAuthorizeFn,
  type WorkflowRun,
} from "@intx/workflow";

import {
  approvedBlocks,
  approvalBlocks,
  dryRunReceiptBlocks,
  failedBlocks,
  notReadyBlocks,
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
  key: string;
  thread: SlackThreadRef;
  run: WorkflowRun;
  status: "drafting" | "awaiting-approval" | "resuming" | "finished";
  decision?: "approved" | "rejected";
};

export type PostSessions = {
  start: (input: {
    teamId: string | undefined;
    channel: string;
    threadTs: string;
    prompt: string;
  }) => Promise<void>;
  approve: (runId: string, userId: string | undefined) => Promise<void>;
  reject: (runId: string) => Promise<void>;
};

export function createPostSessions(opts: {
  config: PostToXConfig;
  stderr: Write;
}): PostSessions {
  const { config, stderr } = opts;
  const pendingByThread = createSlackThreadSessionStore<PendingPost>(
    (pending) => pending.status !== "finished",
  );
  const pendingByRunId = new Map<string, PendingPost>();

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
    if (pendingByThread.getActive(key) !== undefined) return;

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
      key,
      thread,
      run,
      status: "drafting",
    };

    pendingByThread.set(key, pending);
    pendingByRunId.set(run.runId, pending);
    void postApprovalWhenReady(pending, policyReady.promise);
    void postTerminalResult(pending, outputs);

    await postMessage(config.botToken, {
      channel: thread.channel,
      thread_ts: thread.threadTs,
      text: `Started post-to-X workflow ${run.runId}. Drafting now...`,
      blocks: startedBlocks(run.runId),
    });
  }

  async function approve(
    runId: string,
    userId: string | undefined,
  ): Promise<void> {
    const pending = pendingByRunId.get(runId);
    if (pending === undefined || pending.status === "finished") return;
    if (pending.status !== "awaiting-approval") {
      await postNotReady(pending);
      return;
    }

    pending.status = "resuming";
    pending.decision = "approved";
    try {
      await pending.run.signal(APPROVAL_SIGNAL, {
        approvedBy: userId ?? "slack-user",
        approvedAt: new Date().toISOString(),
        channel: pending.thread.channel,
        threadTs: pending.thread.threadTs,
      });
    } catch (error) {
      pending.status = "awaiting-approval";
      pending.decision = undefined;
      throw error;
    }

    await postMessage(config.botToken, {
      channel: pending.thread.channel,
      thread_ts: pending.thread.threadTs,
      text: "Approved. Producing a dry-run receipt now...",
      blocks: approvedBlocks(),
    });
  }

  async function reject(runId: string): Promise<void> {
    const pending = pendingByRunId.get(runId);
    if (pending === undefined || pending.status === "finished") return;
    if (pending.status !== "awaiting-approval") {
      await postNotReady(pending);
      return;
    }

    pending.status = "resuming";
    pending.decision = "rejected";
    try {
      await pending.run.cancel("supervisor-operator", "rejected from Slack");
    } catch (error) {
      pending.status = "awaiting-approval";
      pending.decision = undefined;
      throw error;
    }

    await postMessage(config.botToken, {
      channel: pending.thread.channel,
      thread_ts: pending.thread.threadTs,
      text: "Rejected. Workflow cancelled; nothing was posted.",
      blocks: rejectedBlocks(),
    });
  }

  async function postApprovalWhenReady(
    pending: PendingPost,
    policyReady: Promise<ApprovedPost>,
  ): Promise<void> {
    try {
      const approved = await Promise.race([
        policyReady,
        pending.run.complete.then(() => undefined),
      ]);
      if (approved === undefined || pending.status !== "drafting") return;

      await postMessage(config.botToken, {
        channel: pending.thread.channel,
        thread_ts: pending.thread.threadTs,
        text: truncateForSlack(
          `Post ready for approval:\n\n${approved.text}\n\n` +
            `${approved.weightedLength}/${approved.limit} weighted characters`,
        ),
        blocks: approvalBlocks(approved, pending.run.runId),
      });
      pending.status = "awaiting-approval";
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
      finish(pending);

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

      if (pending.decision === "rejected") return;
      await postMessage(config.botToken, {
        channel: pending.thread.channel,
        thread_ts: pending.thread.threadTs,
        text: `Post-to-X workflow ended with status ${result.terminalStatus}.`,
        blocks: terminalStatusBlocks(result.terminalStatus),
      });
    } catch (error) {
      finish(pending);
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

  function finish(pending: PendingPost): void {
    pending.status = "finished";
    pendingByThread.delete(pending.key);
    pendingByRunId.delete(pending.run.runId);
  }

  async function postNotReady(pending: PendingPost): Promise<void> {
    await postMessage(config.botToken, {
      channel: pending.thread.channel,
      thread_ts: pending.thread.threadTs,
      text: "The workflow is not waiting for approval yet.",
      blocks: notReadyBlocks(),
    });
  }

  return { start, approve, reject };
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
