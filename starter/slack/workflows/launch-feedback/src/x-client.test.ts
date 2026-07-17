import { describe, expect, test } from "bun:test";

import {
  buildOAuthHeader,
  createXReader,
  XAPIError,
  type Fetch,
} from "./x-client";
import type { XCredentials } from "./types";

const credentials: XCredentials = {
  apiKey: "consumer-key",
  apiSecret: "consumer-secret",
  accessToken: "access-token",
  accessTokenSecret: "token-secret",
};

describe("buildOAuthHeader", () => {
  test("signs decoded duplicate query pairs in encoded sort order", () => {
    const header = buildOAuthHeader(
      "GET",
      "https://api.x.com/2/tweets/search/recent?query=conversation_id%3A123&tag=b&tag=a",
      credentials,
      { nonce: "fixed-nonce", timestamp: "1700000000" },
    );

    expect(header).toContain(
      'oauth_signature="AAY3FIC8V9cAsbHWl7l%2B38cZTDE%3D"',
    );
  });
});

describe("X read client", () => {
  test("exposes only post and reply reads", () => {
    const reader = createXReader(credentials, async () => Response.json({}));

    expect(Object.keys(reader).sort()).toEqual(["getPost", "getPostReplies"]);
    expect("createPost" in reader).toBe(false);
  });

  test("normalizes a post and its expanded author", async () => {
    const requests: Request[] = [];
    const reader = createXReader(credentials, async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        data: {
          id: "123",
          text: "We shipped it",
          author_id: "u1",
          conversation_id: "123",
          created_at: "2026-07-16T00:00:00.000Z",
          public_metrics: {
            reply_count: 3,
            retweet_count: 4,
            like_count: 5,
            quote_count: 6,
          },
        },
        includes: {
          users: [
            {
              id: "u1",
              name: "Builder",
              username: "builder",
              verified: true,
              public_metrics: {
                followers_count: 10,
                following_count: 2,
                tweet_count: 20,
                listed_count: 1,
              },
            },
          ],
        },
      });
    });

    const post = await reader.getPost("https://x.com/builder/status/123");

    expect(post).toEqual({
      id: "123",
      url: "https://x.com/builder/status/123",
      text: "We shipped it",
      authorId: "u1",
      author: {
        id: "u1",
        name: "Builder",
        username: "builder",
        verified: true,
        publicMetrics: {
          followers: 10,
          following: 2,
          posts: 20,
          listed: 1,
        },
      },
      createdAt: "2026-07-16T00:00:00.000Z",
      conversationId: "123",
      directReply: false,
      publicMetrics: { replies: 3, reposts: 4, likes: 5, quotes: 6 },
    });
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/2/tweets/123");
  });

  test("normalizes replies, filters the root, and preserves pagination", async () => {
    let requestedURL = "";
    const fetchImpl: Fetch = async (input) => {
      requestedURL = String(input);
      return Response.json({
        data: [
          { id: "123", text: "root", author_id: "u1" },
          {
            id: "124",
            text: "Question",
            author_id: "u2",
            conversation_id: "123",
            referenced_tweets: [{ type: "replied_to", id: "123" }],
          },
          {
            id: "125",
            text: "Nested",
            author_id: "u3",
            conversation_id: "123",
            referenced_tweets: [{ type: "replied_to", id: "124" }],
          },
        ],
        includes: {
          users: [
            { id: "u2", name: "Two", username: "two" },
            { id: "u3", name: "Three", username: "three" },
          ],
        },
        meta: { result_count: 3, next_token: "opaque-next" },
      });
    };
    const reader = createXReader(credentials, fetchImpl);

    const result = await reader.getPostReplies({
      url: "https://x.com/builder/status/123",
      maxResults: 500,
    });

    expect(result.replies.map((reply) => reply.id)).toEqual(["124", "125"]);
    expect(result.replies[0]?.directReply).toBe(true);
    expect(result.replies[1]?.parentPostId).toBe("124");
    expect(result.nextToken).toBe("opaque-next");
    expect(result.truncated).toBe(true);
    expect(result.coverage.complete).toBe(false);
    const url = new URL(requestedURL);
    expect(url.searchParams.get("query")).toBe(
      "conversation_id:123 is:reply",
    );
    expect(url.searchParams.get("max_results")).toBe("100");
  });

  test("defaults recent reply collection to a bounded sample", async () => {
    let requestedURL = "";
    const reader = createXReader(credentials, async (input) => {
      requestedURL = String(input);
      return Response.json({ meta: { result_count: 0 } });
    });

    await reader.getPostReplies({
      url: "https://x.com/builder/status/123",
    });

    expect(new URL(requestedURL).searchParams.get("max_results")).toBe("25");
  });

  test("rejects malformed successful responses at the fetch boundary", async () => {
    const reader = createXReader(credentials, async () =>
      Response.json({ data: { id: "123" } }),
    );

    await expect(
      reader.getPost("https://x.com/builder/status/123"),
    ).rejects.toThrow("text");
  });

  test("preserves API status and rate-limit details", async () => {
    const reader = createXReader(credentials, async () =>
      new Response("rate limited", {
        status: 429,
        headers: {
          "x-rate-limit-limit": "15",
          "x-rate-limit-remaining": "0",
          "x-rate-limit-reset": "1700000000",
        },
      }),
    );

    try {
      await reader.getPost("https://x.com/builder/status/123");
      throw new Error("expected X API error");
    } catch (error) {
      expect(error).toBeInstanceOf(XAPIError);
      expect((error as XAPIError).status).toBe(429);
      expect((error as XAPIError).rateLimit).toEqual({
        limit: 15,
        remaining: 0,
        resetAt: "2023-11-14T22:13:20.000Z",
      });
    }
  });
});
