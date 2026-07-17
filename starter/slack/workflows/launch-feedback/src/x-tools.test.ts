import { describe, expect, test } from "bun:test";

import type { BaseEnv } from "@intx/agent";

import type { ReplySnapshot, ReplyTriage, XPost, XReplyCollection } from "./types";
import {
  DEFAULT_REPLY_SAMPLE_SIZE,
  type XReadClient,
} from "./x-client";
import {
  createCollectState,
  createCollectXTools,
  createTriageTools,
} from "./x-tools";

const source: XPost = {
  id: "123",
  url: "https://x.com/builder/status/123",
  text: "We shipped",
  authorId: "u1",
  author: {
    id: "u1",
    name: "Builder",
    username: "builder",
    publicMetrics: { followers: 100, following: 1, posts: 10, listed: 2 },
  },
  conversationId: "123",
  directReply: false,
  publicMetrics: { replies: 1, likes: 5, reposts: 2, quotes: 1 },
};

const replies: XReplyCollection = {
  sourcePostId: "123",
  replies: [
    {
      id: "124",
      url: "https://x.com/user/status/124",
      text: "Can this export data?",
      authorId: "u2",
      author: {
        id: "u2",
        name: "User",
        username: "user",
        publicMetrics: { followers: 25, following: 2, posts: 5, listed: 0 },
      },
      conversationId: "123",
      parentPostId: "123",
      directReply: true,
      publicMetrics: { replies: 0, likes: 1, reposts: 0, quotes: 0 },
    },
  ],
  analyzedReplies: 1,
  truncated: false,
  coverage: { source: "recent-search", days: 7, complete: false },
};

const client: XReadClient = {
  getPost: async () => source,
  getPostReplies: async () => replies,
};

async function collectSnapshot(): Promise<ReplySnapshot> {
  let captured: ReplySnapshot | undefined;
  const factory = createCollectXTools();
  const bundle = factory({
    xClient: client,
    collectState: createCollectState(source.url),
    snapshotSink: (value: ReplySnapshot) => {
      captured = value;
    },
  } as unknown as BaseEnv & Parameters<typeof factory>[0]);
  const signal = new AbortController().signal;
  await bundle.run(
    { id: "post", name: "x_get_post", arguments: { url: source.url } },
    signal,
  );
  await bundle.run(
    {
      id: "replies",
      name: "x_get_post_replies",
      arguments: { url: source.url },
    },
    signal,
  );
  const result = await bundle.run(
    { id: "snapshot", name: "replies_return_snapshot", arguments: {} },
    signal,
  );
  expect(result.isError).not.toBe(true);
  return captured!;
}

describe("collection tools", () => {
  test("exposes only X reads and deterministic snapshot construction", async () => {
    const factory = createCollectXTools();
    const bundle = factory({
      xClient: client,
      collectState: createCollectState(source.url),
      snapshotSink: () => undefined,
    } as unknown as BaseEnv & Parameters<typeof factory>[0]);

    expect(bundle.definitions.map((definition) => definition.name)).toEqual([
      "x_get_post",
      "x_get_post_replies",
      "replies_return_snapshot",
    ]);
    expect(await collectSnapshot()).toMatchObject({
      source: { postId: "123", authorUsername: "builder" },
      coverage: { analyzedReplies: 1, searchWindow: "recent-7-days" },
      replies: [{ id: "124", author: { username: "user" } }],
    });
  });

  test("rejects model-selected URLs that differ from the trigger", async () => {
    const factory = createCollectXTools();
    const bundle = factory({
      xClient: client,
      collectState: createCollectState(source.url),
      snapshotSink: () => undefined,
    } as unknown as BaseEnv & Parameters<typeof factory>[0]);
    const result = await bundle.run(
      {
        id: "wrong",
        name: "x_get_post",
        arguments: { url: "https://x.com/other/status/999" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("trigger URL");
  });

  test("uses a bounded reply sample when the model omits maxResults", async () => {
    let observedMaxResults: number | undefined;
    const factory = createCollectXTools();
    const bundle = factory({
      xClient: {
        getPost: async () => source,
        getPostReplies: async (input: {
          url: string;
          maxResults?: number;
          signal?: AbortSignal;
        }) => {
          observedMaxResults = input.maxResults;
          return replies;
        },
      },
      collectState: createCollectState(source.url),
      snapshotSink: () => undefined,
    } as unknown as BaseEnv & Parameters<typeof factory>[0]);
    const signal = new AbortController().signal;

    await bundle.run(
      { id: "post", name: "x_get_post", arguments: { url: source.url } },
      signal,
    );
    await bundle.run(
      {
        id: "replies",
        name: "x_get_post_replies",
        arguments: { url: source.url },
      },
      signal,
    );

    expect(observedMaxResults).toBe(DEFAULT_REPLY_SAMPLE_SIZE);
  });

  test("enforces the reply sample cap when the model requests more", async () => {
    let observedMaxResults: number | undefined;
    const factory = createCollectXTools();
    const bundle = factory({
      xClient: {
        getPost: async () => source,
        getPostReplies: async (input: {
          url: string;
          maxResults?: number;
          signal?: AbortSignal;
        }) => {
          observedMaxResults = input.maxResults;
          return replies;
        },
      },
      collectState: createCollectState(source.url),
      snapshotSink: () => undefined,
    } as unknown as BaseEnv & Parameters<typeof factory>[0]);
    const signal = new AbortController().signal;

    await bundle.run(
      { id: "post", name: "x_get_post", arguments: { url: source.url } },
      signal,
    );
    await bundle.run(
      {
        id: "replies",
        name: "x_get_post_replies",
        arguments: { url: source.url, maxResults: 100 },
      },
      signal,
    );

    expect(observedMaxResults).toBe(DEFAULT_REPLY_SAMPLE_SIZE);
  });
});

describe("triage tool", () => {
  test("has no X tools and returns evidence-bound triage", async () => {
    const snapshot = await collectSnapshot();
    const captured: ReplyTriage[] = [];
    const factory = createTriageTools();
    const bundle = factory({
      snapshot,
      triageSink: (value: ReplyTriage) => void captured.push(value),
    } as unknown as BaseEnv & Parameters<typeof factory>[0]);

    expect(bundle.definitions.map((definition) => definition.name)).toEqual([
      "replies_present_triage",
    ]);
    const result = await bundle.run(
      {
        id: "triage",
        name: "replies_present_triage",
        arguments: {
          overview: "One product question needs a response.",
          classifications: [
            {
              replyId: "124",
              priority: "respond-now",
              reason: "question",
              summary: "Asked about export support",
              recommendedOwner: "product",
              suggestedResponseAngle: "Clarify current export support.",
            },
          ],
          themes: [
            {
              label: "Exports",
              count: 1,
              sentiment: "neutral",
              summary: "A user asked about exports.",
              evidenceReplyIds: ["124"],
            },
          ],
          amplificationOpportunities: [],
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    expect(captured[0]).toMatchObject({
      counts: { respondNow: 1, respondLater: 0, noResponse: 0 },
      classifications: [{ replyURL: "https://x.com/user/status/124" }],
    });
  });

  test("rejects reply evidence outside the trusted snapshot", async () => {
    const snapshot = await collectSnapshot();
    const factory = createTriageTools();
    const bundle = factory({
      snapshot,
      triageSink: () => undefined,
    } as unknown as BaseEnv & Parameters<typeof factory>[0]);
    const result = await bundle.run(
      {
        id: "bad",
        name: "replies_present_triage",
        arguments: {
          overview: "Unknown",
          classifications: [
            {
              replyId: "999",
              priority: "respond-now",
              reason: "question",
              summary: "Unknown",
              recommendedOwner: "marketing",
            },
          ],
          themes: [],
          amplificationOpportunities: [],
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("exactly once");
  });
});
