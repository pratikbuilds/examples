import { describe, expect, test } from "bun:test";

import {
  createReplySnapshot,
  parseReplyTriage,
  parseXStatusURL,
} from "./validation";
import type { ReplySnapshot, XPost, XReplyCollection } from "./types";

const snapshotInput: ReplySnapshot = {
  source: {
    url: "https://x.com/company/status/123",
    postId: "123",
    authorUsername: "company",
    text: "Launch",
    metrics: { replies: 2, likes: 10, reposts: 3, quotes: 1 },
  },
  coverage: {
    analyzedReplies: 2,
    truncated: false,
    searchWindow: "recent-7-days",
  },
  replies: [
    {
      id: "201",
      url: "https://x.com/alice/status/201",
      text: "Can teams use the API?",
      author: { username: "alice", followers: 50, verified: false },
      metrics: { likes: 2, replies: 0, reposts: 0 },
      directReply: true,
    },
    {
      id: "202",
      url: "https://x.com/bob/status/202",
      text: "Great launch",
      author: { username: "bob", followers: 20, verified: false },
      metrics: { likes: 1, replies: 0, reposts: 0 },
      directReply: true,
    },
  ],
};

const sourcePost: XPost = {
  id: "123",
  url: "https://x.com/company/status/123",
  text: "Launch",
  authorId: "company-id",
  author: {
    id: "company-id",
    name: "Company",
    username: "company",
    verified: true,
    publicMetrics: { followers: 100, following: 1, posts: 20, listed: 2 },
  },
  directReply: false,
  publicMetrics: { replies: 2, likes: 10, reposts: 3, quotes: 1 },
};

const replyCollection: XReplyCollection = {
  sourcePostId: "123",
  analyzedReplies: 2,
  truncated: false,
  coverage: { source: "recent-search", days: 7, complete: false },
  replies: snapshotInput.replies.map((reply, index) => ({
    id: reply.id,
    url: reply.url,
    text: reply.text,
    authorId: `author-${String(index)}`,
    author: {
      id: `author-${String(index)}`,
      name: reply.author.username,
      username: reply.author.username,
      verified: reply.author.verified,
      publicMetrics: {
        followers: reply.author.followers,
        following: 0,
        posts: 1,
        listed: 0,
      },
    },
    conversationId: "123",
    directReply: reply.directReply,
    publicMetrics: { ...reply.metrics, quotes: 0 },
  })),
};

function testSnapshot() {
  return createReplySnapshot(sourcePost, replyCollection, sourcePost.url);
}

const triageInput = {
  overview: "One question needs a response.",
  classifications: [
    {
      replyId: "201",
      priority: "respond-now",
      reason: "question",
      summary: "API availability question",
      recommendedOwner: "marketing",
      suggestedResponseAngle: "Clarify current availability.",
    },
    {
      replyId: "202",
      priority: "no-response",
      reason: "praise",
      summary: "General praise",
      recommendedOwner: "marketing",
    },
  ],
  themes: [
    {
      label: "API access",
      count: 1,
      sentiment: "neutral",
      summary: "One person asked about API access.",
      evidenceReplyIds: ["201"],
    },
  ],
  amplificationOpportunities: [
    { replyId: "202", reason: "Positive customer reaction" },
  ],
} as const;

describe("parseXStatusURL", () => {
  test("accepts X and legacy Twitter status URLs", () => {
    expect(
      parseXStatusURL("https://x.com/XDevelopers/status/12345?s=20#fragment"),
    ).toEqual({
      postId: "12345",
      canonicalURL: "https://x.com/XDevelopers/status/12345",
    });
    expect(
      parseXStatusURL("https://twitter.com/XDevelopers/status/67890"),
    ).toEqual({
      postId: "67890",
      canonicalURL: "https://x.com/XDevelopers/status/67890",
    });
  });

  test("rejects raw ids and non-status URLs", () => {
    for (const value of [
      "12345",
      "https://x.com/XDevelopers",
      "https://example.com/XDevelopers/status/12345",
      "http://x.com/XDevelopers/status/12345",
    ]) {
      expect(() => parseXStatusURL(value)).toThrow("X status URL");
    }
  });
});

describe("reply snapshot validation", () => {
  test("binds the snapshot to the canonical trigger URL", () => {
    expect(
      createReplySnapshot(sourcePost, replyCollection, sourcePost.url),
    ).toEqual(snapshotInput);
    expect(() =>
      createReplySnapshot(
        sourcePost,
        replyCollection,
        "https://x.com/other/status/999",
      ),
    ).toThrow("trigger URL");
  });

  test("treats X usernames as case-insensitive when binding the trigger", () => {
    expect(() =>
      createReplySnapshot(
        sourcePost,
        replyCollection,
        "https://x.com/COMPANY/status/123",
      ),
    ).not.toThrow();
  });

  test("rejects duplicate replies and inconsistent pagination", () => {
    expect(() =>
      createReplySnapshot(
        sourcePost,
        {
          ...replyCollection,
          replies: [replyCollection.replies[0]!, replyCollection.replies[0]!],
        },
        sourcePost.url,
      ),
    ).toThrow("duplicate reply");
    expect(() =>
      createReplySnapshot(
        sourcePost,
        {
          ...replyCollection,
          nextToken: "next",
        },
        sourcePost.url,
      ),
    ).toThrow("truncated");
    expect(() =>
      createReplySnapshot(
        sourcePost,
        {
          ...replyCollection,
          coverage: { source: "recent-search", days: 7, complete: true },
        } as unknown as XReplyCollection,
        sourcePost.url,
      ),
    ).toThrow("incomplete recent-search coverage");
  });
});

describe("reply triage validation", () => {
  test("normalizes evidence and derives trustworthy counts", () => {
    const snapshot = testSnapshot();
    expect(parseReplyTriage(triageInput, snapshot)).toMatchObject({
      counts: { respondNow: 1, respondLater: 0, noResponse: 1 },
      classifications: [
        { replyURL: "https://x.com/alice/status/201", authorUsername: "alice" },
        { replyURL: "https://x.com/bob/status/202", authorUsername: "bob" },
      ],
      themes: [{ evidenceURLs: ["https://x.com/alice/status/201"] }],
    });
  });

  test("requires every snapshot reply to be classified exactly once", () => {
    const snapshot = testSnapshot();
    expect(() =>
      parseReplyTriage(
        { ...triageInput, classifications: [triageInput.classifications[0]] },
        snapshot,
      ),
    ).toThrow("exactly once");
    expect(() =>
      parseReplyTriage(
        {
          ...triageInput,
          classifications: [
            triageInput.classifications[0],
            triageInput.classifications[0],
          ],
        },
        snapshot,
      ),
    ).toThrow("exactly once");
  });

  test("rejects unknown evidence, inflated themes, and unsupported urgency", () => {
    const snapshot = testSnapshot();
    expect(() =>
      parseReplyTriage(
        {
          ...triageInput,
          themes: [
            { ...triageInput.themes[0], evidenceReplyIds: ["999"] },
          ],
        },
        snapshot,
      ),
    ).toThrow("unknown reply");
    expect(() =>
      parseReplyTriage(
        {
          ...triageInput,
          themes: [{ ...triageInput.themes[0], count: 999 }],
        },
        snapshot,
      ),
    ).toThrow("cannot exceed analyzed replies");
    expect(() =>
      parseReplyTriage(
        {
          ...triageInput,
          themes: [
            {
              ...triageInput.themes[0],
              count: 1,
              evidenceReplyIds: ["201", "202"],
            },
          ],
        },
        snapshot,
      ),
    ).toThrow("less than its evidence count");
    expect(parseReplyTriage(triageInput, snapshot).counts).toEqual({
      respondNow: 1,
      respondLater: 0,
      noResponse: 1,
    });
    expect(() =>
      parseReplyTriage(
        {
          ...triageInput,
          classifications: [
            {
              ...triageInput.classifications[0],
              reason: "high-reach-author",
            },
            triageInput.classifications[1],
          ],
        },
        snapshot,
      ),
    ).toThrow("high-reach-author");
    expect(() =>
      parseReplyTriage(
        {
          ...triageInput,
          classifications: [
            {
              ...triageInput.classifications[0],
              reason: "praise",
            },
            triageInput.classifications[1],
          ],
        },
        snapshot,
      ),
    ).toThrow("cannot justify respond-now");
  });

  test("allows amplification only for replies classified as praise", () => {
    const snapshot = testSnapshot();

    expect(() =>
      parseReplyTriage(
        {
          ...triageInput,
          amplificationOpportunities: [
            { replyId: "201", reason: "Highlight this complaint" },
          ],
        },
        snapshot,
      ),
    ).toThrow("classified as praise");
  });

  test("returns fixed incomplete-coverage output for an empty snapshot", () => {
    const emptySnapshot = createReplySnapshot(
      { ...sourcePost, publicMetrics: { ...sourcePost.publicMetrics!, replies: 4 } },
      { ...replyCollection, analyzedReplies: 0, replies: [] },
      sourcePost.url,
    );
    const result = parseReplyTriage(
      {
        overview: "Nobody replied.",
        classifications: [],
        themes: [],
        amplificationOpportunities: [],
      },
      emptySnapshot,
    );

    expect(result.overview).toContain("does not establish historical absence");
  });
});
