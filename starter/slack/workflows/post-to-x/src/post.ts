import twitterText from "twitter-text";

export type ApprovedPost = Readonly<{
  text: string;
  weightedLength: number;
  limit: 280;
}>;

export function validateXPost(input: unknown): ApprovedPost {
  const raw =
    typeof input === "string"
      ? input
      : isRecord(input) && typeof input.text === "string"
        ? input.text
        : undefined;

  const text = raw?.trim().normalize("NFC");
  if (text === undefined || text === "") {
    throw new Error("draft must contain non-empty post text");
  }

  const parsed = twitterText.parseTweet(text);
  if (!parsed.valid || parsed.weightedLength > 280) {
    throw new Error(
      `draft is not valid for X (${parsed.weightedLength}/280 weighted characters)`,
    );
  }

  return Object.freeze({
    text,
    weightedLength: parsed.weightedLength,
    limit: 280,
  });
}

export function requireApprovedPost(input: unknown): ApprovedPost {
  if (
    !isRecord(input) ||
    typeof input.text !== "string" ||
    typeof input.weightedLength !== "number" ||
    input.limit !== 280
  ) {
    throw new Error("publish input must be an approved X post");
  }

  return Object.freeze({
    text: input.text,
    weightedLength: input.weightedLength,
    limit: 280,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
