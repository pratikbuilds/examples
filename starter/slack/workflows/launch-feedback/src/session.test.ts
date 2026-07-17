import { describe, expect, test } from "bun:test";

import type { SlackBlock } from "@corbits/example-slack-bridge";

import { triageResultBlocks } from "./blocks";
import type { ReplyTriageConfig } from "./config";
import {
  createReplyTriageSessions,
  extractXStatusURL,
  type ReplyTriageRun,
  type StartWorkflow,
} from "./session";
import type { CreateDraftsResult, PostRepliesResult } from "./types";

const config = {
  signingSecret: "secret",
  botToken: "xoxb-test",
  appToken: "xapp-test",
  port: 3000,
  source: {
    id: "openai:test",
    provider: "openai",
    baseURL: "https://api.openai.com/v1",
    apiKey: "test",
    model: "test",
  },
  xClient: {
    getPost: async () => {
      throw new Error("not used");
    },
    getPostReplies: async () => {
      throw new Error("not used");
    },
  },
  xPublisher: {
    mode: "dry-run" as const,
    reply: async () => {
      throw new Error("not used");
    },
  },
  contextRoot: "/tmp/reply-triage-test",
} satisfies ReplyTriageConfig;

const created: CreateDraftsResult = {
  snapshot: {
    source: {
      url: "https://x.com/OpenAI/status/123",
      postId: "123",
      authorUsername: "OpenAI",
      text: "Launch",
      metrics: { replies: 2, likes: 10, reposts: 2, quotes: 1 },
    },
    coverage: {
      fetchedReplies: 2,
      analyzedReplies: 1,
      truncated: true,
      nextToken: "next",
      searchWindow: "recent-7-days",
    },
    replies: [
      {
        id: "201",
        url: "https://x.com/alice/status/201",
        text: "Can we use the API?",
        author: { username: "alice", followers: 50, verified: false },
        metrics: { likes: 2, replies: 0, reposts: 0 },
        directReply: true,
      },
    ],
  },
  triage: {
    overview: "One question needs a response.",
    classifications: [
      {
        priority: "respond-now",
        reason: "question",
        replyURL: "https://x.com/alice/status/201",
        authorUsername: "alice",
        summary: "Asked about API access",
        recommendedOwner: "marketing",
        suggestedResponseAngle: "Clarify availability.",
      },
    ],
    themes: [],
    amplificationOpportunities: [],
    counts: { respondNow: 1, respondLater: 0, noResponse: 0 },
  },
  drafts: [
    {
      replyId: "201",
      replyURL: "https://x.com/alice/status/201",
      authorUsername: "alice",
      reason: "question",
      text: "Yes — API access is available for teams today.",
    },
  ],
};

const posted: PostRepliesResult = {
  posted: [
    {
      replyId: "201",
      replyURL: "https://x.com/alice/status/201",
      postedURL: "https://x.com/i/web/status/dryrun-1",
      text: created.drafts[0]!.text,
      mode: "dry-run",
    },
  ],
};

type SentMessage = {
  channel: string;
  thread_ts?: string;
  text: string;
  blocks?: SlackBlock[];
};

function mockRun(options?: {
  onStepDone?: (stepId: string, output: unknown) => void;
  complete?: ReplyTriageRun["complete"];
}): ReplyTriageRun {
  queueMicrotask(() => options?.onStepDone?.("create", created));
  return {
    complete:
      options?.complete ??
      Promise.resolve({
        runId: "completed-run",
        terminalStatus: "completed",
        outputs: { post: posted },
        events: [],
      }),
    signal: async () => undefined,
  };
}

describe("reply triage Slack sessions", () => {
  test("rejects invalid URLs before workflow execution", async () => {
    let starts = 0;
    const messages: SentMessage[] = [];
    const sessions = createReplyTriageSessions({
      config,
      stderr: () => undefined,
      startWorkflow: (() => {
        starts += 1;
        return mockRun();
      }) as StartWorkflow,
      sendMessage: async (_token, message) => {
        messages.push(message);
        return { channel: message.channel, ts: "1" };
      },
    });

    for (const prompt of ["analyze 123", "analyze https://x.com/example"]) {
      await sessions.start({
        teamId: "T1",
        channel: "C1",
        threadTs: prompt,
        prompt,
      });
    }

    expect(starts).toBe(0);
    expect(messages).toHaveLength(2);
    expect(messages.every((message) => message.text.includes("status URL"))).toBe(
      true,
    );
  });

  test("posts triage, draft cards, and waits for approvals", async () => {
    const messages: SentMessage[] = [];
    const pendingComplete = deferred<Awaited<ReplyTriageRun["complete"]>>();
    const sessions = createReplyTriageSessions({
      config,
      stderr: () => undefined,
      startWorkflow: (input) =>
        mockRun({
          onStepDone: input.onStepDone,
          complete: pendingComplete.promise,
        }),
      sendMessage: async (_token, message) => {
        messages.push(message);
        return { channel: message.channel, ts: String(messages.length) };
      },
      updateMessage: async (_token, message) => ({
        channel: message.channel,
        ts: message.ts,
      }),
    });

    await sessions.start({
      teamId: "T1",
      channel: "C1",
      threadTs: "1.1",
      prompt: "triage https://x.com/OpenAI/status/123",
      userId: "U1",
    });
    await waitFor(() =>
      messages.some((message) => message.text.startsWith("Draft reply to")),
    );

    expect(messages.map((message) => message.text)).toEqual([
      "Analyzing recent replies to https://x.com/OpenAI/status/123",
      "Status: Collect candidates from X",
      "Reply triage complete: 1 respond now",
      "Draft approval",
      "Draft reply to @alice",
    ]);
    expect(JSON.stringify(messages.at(-1)?.blocks)).toContain("reply.approve");

    const blocksText = JSON.stringify(messages.at(-1)?.blocks);
    const valueMatch = /"value":"([^"]+)"/.exec(blocksText);
    expect(valueMatch?.[1]).toBeDefined();
    await sessions.approve(valueMatch![1]!);

    pendingComplete.resolve({
      runId: "completed-run",
      terminalStatus: "completed",
      outputs: { post: posted },
      events: [],
    });
    await waitFor(() =>
      messages.some((message) => message.text.startsWith("Posted")),
    );
    expect(messages.at(-1)?.text).toContain("Posted");
  });

  test("reserves a thread atomically and releases it after completion", async () => {
    const pending = deferred<Awaited<ReplyTriageRun["complete"]>>();
    let starts = 0;
    const messages: SentMessage[] = [];
    const startWorkflow: StartWorkflow = (input) => {
      starts += 1;
      if (starts === 1) {
        queueMicrotask(() => input.onStepDone?.("create", { ...created, drafts: [] }));
        return {
          complete: pending.promise,
          signal: async () => undefined,
        };
      }
      return mockRun({ onStepDone: input.onStepDone });
    };
    const sessions = createReplyTriageSessions({
      config,
      stderr: () => undefined,
      startWorkflow,
      sendMessage: async (_token, message) => {
        messages.push(message);
        return { channel: message.channel, ts: String(messages.length) };
      },
      updateMessage: async (_token, message) => ({
        channel: message.channel,
        ts: message.ts,
      }),
    });
    const input = {
      teamId: "T1",
      channel: "C1",
      threadTs: "2.2",
      prompt: "triage https://x.com/OpenAI/status/123",
    };

    await sessions.start(input);
    await sessions.start(input);
    expect(starts).toBe(1);
    expect(
      messages.some((message) => message.text.includes("already active")),
    ).toBe(true);

    pending.resolve({
      runId: "pending-run",
      terminalStatus: "completed",
      outputs: { post: { posted: [] } },
      events: [],
    });
    await waitFor(() =>
      messages.some((message) => message.text.includes("No replies posted")),
    );
    await sessions.start(input);
    expect(starts).toBe(2);
  });

  test("releases the reservation and reports one terminal failure", async () => {
    let starts = 0;
    const messages: SentMessage[] = [];
    const sessions = createReplyTriageSessions({
      config,
      stderr: () => undefined,
      startWorkflow: (input) => {
        starts += 1;
        if (starts === 1) {
          queueMicrotask(() =>
            input.onStepDone?.("create", { ...created, drafts: [] }),
          );
          return {
            complete: Promise.resolve({
              runId: "failed-run",
              terminalStatus: "failed",
              outputs: {},
              events: [],
            }),
            signal: async () => undefined,
          } satisfies ReplyTriageRun;
        }
        return mockRun({ onStepDone: input.onStepDone });
      },
      sendMessage: async (_token, message) => {
        messages.push(message);
        return { channel: message.channel, ts: String(messages.length) };
      },
      updateMessage: async (_token, message) => ({
        channel: message.channel,
        ts: message.ts,
      }),
    });
    const input = {
      teamId: "T1",
      channel: "C1",
      threadTs: "3.3",
      prompt: "triage https://x.com/OpenAI/status/123",
    };

    await sessions.start(input);
    await waitFor(() => messages.some((message) => message.text.includes("failed")));
    await Bun.sleep(0);
    await sessions.start(input);

    expect(starts).toBe(2);
    expect(messages.filter((message) => message.text.includes("failed"))).toHaveLength(
      1,
    );
  });
});

describe("reply triage Block Kit", () => {
  test("triage summary contains no interactive elements", () => {
    const blocks = triageResultBlocks(created);
    expect(JSON.stringify(blocks)).not.toContain('"type":"actions"');
    expect(blocks.length).toBeLessThanOrEqual(50);
  });
});

test("extractXStatusURL canonicalizes Slack-formatted URLs", () => {
  expect(
    extractXStatusURL(
      "triage <https://twitter.com/OpenAI/status/123?s=20|this post>",
    ),
  ).toBe("https://x.com/OpenAI/status/123");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition was not reached");
}
