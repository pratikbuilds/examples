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
import type { ReplyTriageResult } from "./types";

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
  contextRoot: "/tmp/reply-triage-test",
} satisfies ReplyTriageConfig;

const result: ReplyTriageResult = {
  snapshot: {
    source: {
      url: "https://x.com/OpenAI/status/123",
      postId: "123",
      authorUsername: "OpenAI",
      text: "Launch",
      metrics: { replies: 2, likes: 10, reposts: 2, quotes: 1 },
    },
    coverage: {
      analyzedReplies: 2,
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
      {
        id: "202",
        url: "https://x.com/bob/status/202",
        text: "Great work",
        author: { username: "bob", followers: 20, verified: false },
        metrics: { likes: 1, replies: 0, reposts: 0 },
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
      {
        priority: "no-response",
        reason: "praise",
        replyURL: "https://x.com/bob/status/202",
        authorUsername: "bob",
        summary: "Positive feedback",
        recommendedOwner: "marketing",
      },
    ],
    themes: [
      {
        label: "API access",
        count: 1,
        sentiment: "neutral",
        summary: "A user asked about access.",
        evidenceURLs: ["https://x.com/alice/status/201"],
      },
    ],
    amplificationOpportunities: [
      {
        replyURL: "https://x.com/bob/status/202",
        reason: "Positive reaction",
      },
    ],
    counts: { respondNow: 1, respondLater: 0, noResponse: 1 },
  },
};

type SentMessage = {
  channel: string;
  thread_ts?: string;
  text: string;
  blocks?: SlackBlock[];
};

function completedRun(output = result): ReplyTriageRun {
  return {
    complete: Promise.resolve({
      runId: "completed-run",
      terminalStatus: "completed",
      outputs: { triage: output },
      events: [],
    }),
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
        return completedRun();
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

  test("posts one started message and one compact terminal result", async () => {
    const messages: SentMessage[] = [];
    const sessions = createReplyTriageSessions({
      config,
      stderr: () => undefined,
      startWorkflow: () => completedRun(),
      sendMessage: async (_token, message) => {
        messages.push(message);
        return { channel: message.channel, ts: String(messages.length) };
      },
    });

    await sessions.start({
      teamId: "T1",
      channel: "C1",
      threadTs: "1.1",
      prompt: "triage https://x.com/OpenAI/status/123",
      userId: "U1",
    });
    await waitFor(() => messages.length === 2);

    expect(messages.map((message) => message.text)).toEqual([
      "Analyzing recent replies to https://x.com/OpenAI/status/123",
      "Reply triage complete: 1 respond now, 0 respond later",
    ]);
    expect(JSON.stringify(messages[1]?.blocks)).not.toContain('"actions"');
    expect(JSON.stringify(messages[1]?.blocks)).not.toContain("Publish");
  });

  test("reserves a thread atomically and releases it after completion", async () => {
    const pending = deferred<Awaited<ReplyTriageRun["complete"]>>();
    let starts = 0;
    const messages: SentMessage[] = [];
    const startWorkflow: StartWorkflow = () => {
      starts += 1;
      return starts === 1
        ? { complete: pending.promise }
        : completedRun();
    };
    const sessions = createReplyTriageSessions({
      config,
      stderr: () => undefined,
      startWorkflow,
      sendMessage: async (_token, message) => {
        messages.push(message);
        return { channel: message.channel, ts: String(messages.length) };
      },
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
    expect(messages.at(-1)?.text).toContain("already active");

    pending.resolve({
      runId: "pending-run",
      terminalStatus: "completed",
      outputs: { triage: result },
      events: [],
    });
    await waitFor(() => messages.some((message) => message.text.startsWith("Reply triage complete")));
    await sessions.start(input);
    expect(starts).toBe(2);
  });

  test("releases the reservation and reports one terminal failure", async () => {
    let starts = 0;
    const messages: SentMessage[] = [];
    const sessions = createReplyTriageSessions({
      config,
      stderr: () => undefined,
      startWorkflow: () => {
        starts += 1;
        return starts === 1
          ? ({
              complete: Promise.resolve({
                runId: "failed-run",
                terminalStatus: "failed",
                outputs: {},
                events: [],
              }),
            } satisfies ReplyTriageRun)
          : completedRun();
      },
      sendMessage: async (_token, message) => {
        messages.push(message);
        return { channel: message.channel, ts: String(messages.length) };
      },
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
  test("contains no interactive elements and stays within Slack limits", () => {
    const blocks = triageResultBlocks(result);
    expect(JSON.stringify(blocks)).not.toContain('"type":"actions"');
    expect(blocks.length).toBeLessThanOrEqual(50);
    for (const block of blocks) {
      if (
        block.type === "section" &&
        "text" in block &&
        block.text !== undefined &&
        block.text.type === "mrkdwn"
      ) {
        expect(block.text.text.length).toBeLessThanOrEqual(3000);
      }
    }
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
