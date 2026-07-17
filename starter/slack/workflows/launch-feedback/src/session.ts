import {
  postMessage,
  slackThreadKey,
  type SlackThreadRef,
  type Write,
} from "@corbits/example-slack-bridge";
import { runLocal, type WorkflowRun } from "@intx/workflow";

import {
  alreadyRunningBlocks,
  failedBlocks,
  invalidURLBlocks,
  startedBlocks,
  triageResultBlocks,
} from "./blocks";
import type { ReplyTriageConfig } from "./config";
import { createInvokeStep, createWorkflowAuthorize } from "./invoke-step";
import type { ReplyTriageResult, ReplyTriageTrigger } from "./types";
import { parseXStatusURL } from "./validation";
import { defineReplyTriageWorkflow } from "./workflow";

type SendMessage = typeof postMessage;

export type ReplyTriageRun = Pick<WorkflowRun, "complete">;

export type StartWorkflow = (input: {
  triggerPayload: ReplyTriageTrigger;
  log: (line: string) => void;
}) => ReplyTriageRun;

export type ReplyTriageSessions = {
  start: (input: {
    teamId: string | undefined;
    channel: string;
    threadTs: string;
    prompt: string;
    userId?: string;
  }) => Promise<void>;
};

export function createReplyTriageSessions(options: {
  config: ReplyTriageConfig;
  stderr: Write;
  startWorkflow?: StartWorkflow;
  sendMessage?: SendMessage;
}): ReplyTriageSessions {
  const { config, stderr } = options;
  const sendMessage = options.sendMessage ?? postMessage;
  const activeThreads = new Set<string>();

  const startWorkflow: StartWorkflow =
    options.startWorkflow ??
    ((input) => {
      const authorize = createWorkflowAuthorize();
      return runLocal(defineReplyTriageWorkflow(config.source), {
        triggerPayload: input.triggerPayload,
        invokeStep: createInvokeStep({
          source: config.source,
          xClient: config.xClient,
          contextRoot: config.contextRoot,
          authorize,
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
    if (activeThreads.has(key)) {
      await sendMessage(config.botToken, {
        channel: input.channel,
        thread_ts: input.threadTs,
        text: "A reply triage run is already active in this thread.",
        blocks: alreadyRunningBlocks(),
      });
      return;
    }

    activeThreads.add(key);
    let watching = false;
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
            ...(input.userId !== undefined ? { requestedBy: input.userId } : {}),
          },
        },
        log: (line) => stderr(`slack-x-reply-triage: ${line}\n`),
      });
      watching = true;
      void watchTerminal(key, thread, run);
    } catch (error) {
      await reportFailure(thread, error);
    } finally {
      if (!watching) activeThreads.delete(key);
    }
  }

  async function watchTerminal(
    key: string,
    thread: SlackThreadRef,
    run: ReplyTriageRun,
  ): Promise<void> {
    try {
      const completed = await run.complete;
      if (completed.terminalStatus !== "completed") {
        throw new Error("Workflow run failed");
      }
      const result = completed.outputs.triage as ReplyTriageResult | undefined;
      if (result === undefined) throw new Error("Triage step returned no output");
      await sendMessage(config.botToken, {
        channel: thread.channel,
        thread_ts: thread.threadTs,
        text: `Reply triage complete: ${String(result.triage.counts.respondNow)} respond now, ${String(result.triage.counts.respondLater)} respond later`,
        blocks: triageResultBlocks(result),
      });
    } catch (error) {
      await reportFailure(thread, error);
    } finally {
      activeThreads.delete(key);
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

  return { start };
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
