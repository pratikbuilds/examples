import { describe, expect, test } from "bun:test";

import {
  parseLaunchFeedback,
  parseXStatusURL,
  validatePostText,
} from "./validation";

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

describe("empty recent-search coverage", () => {
  test("rejects reply-derived claims when X returns no replies", () => {
    expect(() =>
      parseLaunchFeedback(
        {
          summary: "Users love it",
          themes: [
            {
              label: "Love",
              sentiment: "positive",
              summary: "People love it",
              evidencePostIds: [],
            },
          ],
          faq: [],
          actions: [],
          drafts: [
            { strategy: "concise-recap", title: "One", text: "One" },
            { strategy: "what-we-heard", title: "Two", text: "Two" },
            { strategy: "next-steps", title: "Three", text: "Three" },
          ],
        },
        {
          source: {
            id: "123",
            url: "https://x.com/user/status/123",
            text: "Launch",
            authorId: "u1",
            directReply: false,
          },
          replies: {
            sourcePostId: "123",
            replies: [],
            analyzedReplies: 0,
            truncated: false,
            coverage: { source: "recent-search", days: 7, complete: false },
          },
        },
      ),
    ).toThrow("must be empty");
  });
});

describe("Slack-safe X text", () => {
  test("rejects URL-heavy text that is X-valid but too large for Slack", () => {
    const text = Array.from(
      { length: 10 },
      (_, index) => `https://example.com/${String(index)}/${"x".repeat(300)}`,
    ).join(" ");
    const result = validatePostText(text);

    expect(result.error).toContain("too large to review safely in Slack");
  });
});
