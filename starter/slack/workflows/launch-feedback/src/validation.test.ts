import { describe, expect, test } from "bun:test";

import { parseXStatusURL } from "./validation";

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
