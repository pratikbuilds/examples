import { type } from "arktype";

const DraftInput = type("string").or({ text: "string" });

const ApprovedPost = type({
  text: "string",
  length: "number",
  limit: "280",
});

export type ApprovedPost = typeof ApprovedPost.infer;

export function validateXPost(input: unknown): ApprovedPost {
  const draft = DraftInput(input);
  if (draft instanceof type.errors) {
    throw new Error("draft must contain post text");
  }

  const text = (typeof draft === "string" ? draft : draft.text)
    .trim()
    .normalize("NFC");
  if (text === "") {
    throw new Error("draft must contain non-empty post text");
  }

  const length = Array.from(text).length;
  if (length > 280) {
    throw new Error(`draft is too long for X (${length}/280 characters)`);
  }

  return Object.freeze({
    text,
    length,
    limit: 280,
  });
}

export function requireApprovedPost(input: unknown): ApprovedPost {
  const approvedPost = ApprovedPost(input);
  if (approvedPost instanceof type.errors) {
    throw new Error(
      `publish input must be an approved X post: ${approvedPost.summary}`,
    );
  }

  return Object.freeze(approvedPost);
}
