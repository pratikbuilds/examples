import { describe, expect, test } from "bun:test";

import type { BaseEnv } from "@intx/agent";

import type {
  ApprovedDraft,
  LaunchFeedback,
  PostReceipt,
  XPost,
  XReplyCollection,
} from "./types";
import {
  createAnalysisState,
  createAnalyzeXTools,
  createApprovedDraftCapability,
  createCreatePostTool,
} from "./x-tools";
import type { XClient } from "./x-client";

const source: XPost = {
  id: "123",
  url: "https://x.com/builder/status/123",
  text: "We shipped",
  authorId: "u1",
  author: { id: "u1", name: "Builder", username: "builder" },
  directReply: false,
};

const replies: XReplyCollection = {
  sourcePostId: "123",
  replies: [
    {
      id: "124",
      url: "https://x.com/user/status/124",
      text: "Can this export data?",
      authorId: "u2",
      author: { id: "u2", name: "User", username: "user" },
      parentPostId: "123",
      directReply: true,
    },
  ],
  analyzedReplies: 1,
  truncated: false,
  coverage: { source: "recent-search", days: 7, complete: false },
};

function analysisArguments(evidencePostId = "124") {
  return {
    summary: "People want export support.",
    themes: [
      {
        label: "Exports",
        sentiment: "neutral",
        summary: "Users asked about exports.",
        evidencePostIds: [evidencePostId],
      },
    ],
    faq: [
      {
        question: "Can it export data?",
        suggestedAnswer: "Exports are on the roadmap.",
        evidencePostIds: [evidencePostId],
      },
    ],
    actions: [
      {
        priority: "high",
        owner: "product",
        action: "Clarify export support.",
        evidencePostIds: [evidencePostId],
      },
    ],
    drafts: [
      { strategy: "concise-recap", title: "Recap", text: "Thanks for the feedback." },
      { strategy: "what-we-heard", title: "What we heard", text: "We heard your export questions." },
      { strategy: "next-steps", title: "Next", text: "Next, we are clarifying exports." },
    ],
  };
}

function createClient(overrides: Partial<XClient> = {}): XClient {
  return {
    writeMode: "dry-run",
    getMe: async () => ({ id: "u1", name: "Builder", username: "builder" }),
    getPost: async () => source,
    getPostReplies: async () => replies,
    createPost: async (text) => ({
      mode: "dry-run",
      postId: "dryrun-1",
      url: "https://x.com/i/web/status/dryrun-1",
      text,
      postedAt: "2026-07-16T00:00:00.000Z",
    }),
    ...overrides,
  };
}

describe("analysis X tools", () => {
  test("exposes reads and structured feedback but no createPost", async () => {
    const captured: LaunchFeedback[] = [];
    const state = createAnalysisState();
    const factory = createAnalyzeXTools();
    const bundle = factory({
      xClient: createClient(),
      analysisState: state,
      feedbackSink: (value: LaunchFeedback) => void captured.push(value),
    } as unknown as BaseEnv & Parameters<typeof factory>[0]);

    expect(bundle.definitions.map((definition) => definition.name)).toEqual([
      "x_get_post",
      "x_get_post_replies",
      "launch_present_feedback",
    ]);

    await bundle.run(
      { id: "post", name: "x_get_post", arguments: { url: source.url } },
      new AbortController().signal,
    );
    await bundle.run(
      {
        id: "replies",
        name: "x_get_post_replies",
        arguments: { url: source.url },
      },
      new AbortController().signal,
    );
    const result = await bundle.run(
      {
        id: "feedback",
        name: "launch_present_feedback",
        arguments: analysisArguments(),
      },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    expect(captured[0]?.source.id).toBe("123");
    expect(captured[0]?.themes[0]?.evidenceUrls).toEqual([
      "https://x.com/user/status/124",
    ]);
  });

  test("rejects evidence that was not returned by getPostReplies", async () => {
    const state = createAnalysisState();
    const factory = createAnalyzeXTools();
    const bundle = factory({
      xClient: createClient(),
      analysisState: state,
      feedbackSink: () => undefined,
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
      {
        id: "feedback",
        name: "launch_present_feedback",
        arguments: analysisArguments("999"),
      },
      signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("999");
  });
});

describe("createPost approval capability", () => {
  const approved: ApprovedDraft = {
    draftId: "draft-1",
    revision: 2,
    text: "Approved text",
    approvedBy: "U1",
    approvedAt: "2026-07-16T00:00:00.000Z",
  };

  test("does not consume approval on mismatch and consumes exact text once", async () => {
    const published: string[] = [];
    const client = createClient({
      createPost: async (text) => {
        published.push(text);
        return {
          mode: "dry-run",
          postId: "p1",
          url: "https://x.com/i/web/status/p1",
          text,
          postedAt: "2026-07-16T00:00:00.000Z",
        };
      },
    });
    const factory = createCreatePostTool();
    const bundle = factory({
      xClient: client,
      approvedDraft: createApprovedDraftCapability(approved),
      receiptSink: () => undefined,
    } as unknown as BaseEnv & Parameters<typeof factory>[0]);
    const signal = new AbortController().signal;

    const mismatch = await bundle.run(
      {
        id: "bad",
        name: "x_create_post",
        arguments: { text: "Changed" },
      },
      signal,
    );
    const success = await bundle.run(
      {
        id: "good",
        name: "x_create_post",
        arguments: { text: "Approved text" },
      },
      signal,
    );
    const replay = await bundle.run(
      {
        id: "replay",
        name: "x_create_post",
        arguments: { text: "Approved text" },
      },
      signal,
    );

    expect(mismatch.isError).toBe(true);
    expect(success.isError).not.toBe(true);
    expect(replay.isError).toBe(true);
    expect(published).toEqual(["Approved text"]);
  });

  test("keeps a successful receipt when the receipt sink throws", async () => {
    const receipt: PostReceipt = {
      mode: "live",
      postId: "p1",
      url: "https://x.com/i/web/status/p1",
      text: "Approved text",
      postedAt: "2026-07-16T00:00:00.000Z",
    };
    const factory = createCreatePostTool();
    const bundle = factory({
      xClient: createClient({ createPost: async () => receipt }),
      approvedDraft: createApprovedDraftCapability(approved),
      receiptSink: () => {
        throw new Error("Slack unavailable");
      },
    } as unknown as BaseEnv & Parameters<typeof factory>[0]);

    const result = await bundle.run(
      {
        id: "call",
        name: "x_create_post",
        arguments: { text: "Approved text" },
      },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    expect(result.detail).toEqual(receipt);
    expect(result.content).toContain("receipt sink failed");
  });
});
