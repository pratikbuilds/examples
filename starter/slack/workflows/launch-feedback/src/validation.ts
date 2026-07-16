export type XStatusRef = {
  postId: string;
  canonicalURL: string;
};

export function parseXStatusURL(value: unknown): XStatusRef {
  if (typeof value !== "string") throw invalidXStatusURL();

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidXStatusURL();
  }

  const host = url.hostname.toLowerCase();
  const allowedHost =
    host === "x.com" ||
    host === "www.x.com" ||
    host === "twitter.com" ||
    host === "www.twitter.com";
  const match = /^\/([^/]+)\/status\/(\d+)\/?$/.exec(url.pathname);
  const username = match?.[1];
  const postId = match?.[2];

  if (
    url.protocol !== "https:" ||
    !allowedHost ||
    username === undefined ||
    postId === undefined
  ) {
    throw invalidXStatusURL();
  }

  return {
    postId,
    canonicalURL: `https://x.com/${username}/status/${postId}`,
  };
}

function invalidXStatusURL(): Error {
  return new Error(
    "Expected a full X status URL such as https://x.com/user/status/123",
  );
}

export function validatePostText(
  value: unknown,
): { text: string; error?: undefined } | { text?: undefined; error: string } {
  if (typeof value !== "string") {
    return { error: 'x.createPost requires a string "text" argument' };
  }
  const text = value.normalize("NFC").trim();
  if (text === "") return { error: "Post text cannot be empty" };
  const parsed = twitterText.parseTweet(text);
  if (!parsed.valid || parsed.weightedLength > 280) {
    return {
      error: `Post text is ${String(parsed.weightedLength)} weighted characters; X allows 280`,
    };
  }
  const slackPreview = `>${text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .split("\n")
    .join("\n>")}`;
  if (text.length > 3000 || slackPreview.length > 3000) {
    return {
      error:
        "Post text is X-valid but too large to review safely in Slack (3000-character display limit)",
    };
  }
  return { text };
}

export function parseLaunchFeedback(
  value: unknown,
  context: { source: XPost; replies: XReplyCollection },
): LaunchFeedback {
  const input = requiredRecord(value, "launch feedback");
  const allowedEvidence = new Set(
    context.replies.replies.map((reply) => reply.id),
  );
  const themes = boundedArray(input.themes, "themes", 8).map((item, index) => {
    const theme = requiredRecord(item, `themes[${String(index)}]`);
    return {
      label: requiredString(theme.label, `themes[${String(index)}].label`),
      sentiment: requiredEnum(
        theme.sentiment,
        ["positive", "mixed", "negative", "neutral"] as const,
        `themes[${String(index)}].sentiment`,
      ),
      summary: requiredString(
        theme.summary,
        `themes[${String(index)}].summary`,
      ),
      evidenceUrls: parseEvidence(
        theme.evidencePostIds,
        allowedEvidence,
        context.replies,
        `themes[${String(index)}].evidencePostIds`,
      ),
    };
  });
  const faq = boundedArray(input.faq, "faq", 8).map((item, index) => {
    const entry = requiredRecord(item, `faq[${String(index)}]`);
    return {
      question: requiredString(
        entry.question,
        `faq[${String(index)}].question`,
      ),
      suggestedAnswer: requiredString(
        entry.suggestedAnswer,
        `faq[${String(index)}].suggestedAnswer`,
      ),
      evidenceUrls: parseEvidence(
        entry.evidencePostIds,
        allowedEvidence,
        context.replies,
        `faq[${String(index)}].evidencePostIds`,
      ),
    };
  });
  const actions = boundedArray(input.actions, "actions", 8).map(
    (item, index) => {
      const action = requiredRecord(item, `actions[${String(index)}]`);
      return {
        priority: requiredEnum(
          action.priority,
          ["high", "medium", "low"] as const,
          `actions[${String(index)}].priority`,
        ),
        owner: requiredEnum(
          action.owner,
          ["product", "support", "marketing"] as const,
          `actions[${String(index)}].owner`,
        ),
        action: requiredString(
          action.action,
          `actions[${String(index)}].action`,
        ),
        evidenceUrls: parseEvidence(
          action.evidencePostIds,
          allowedEvidence,
          context.replies,
          `actions[${String(index)}].evidencePostIds`,
        ),
      };
    },
  );
  const rawDrafts = requiredArray(input.drafts, "drafts");
  if (rawDrafts.length !== 3) {
    throw new Error("drafts must contain exactly three entries");
  }
  const drafts = rawDrafts.map((item, index) => {
    const draft = requiredRecord(item, `drafts[${String(index)}]`);
    const validation = validatePostText(draft.text);
    if (validation.error !== undefined) {
      throw new Error(`drafts[${String(index)}].text: ${validation.error}`);
    }
    return {
      strategy: requiredEnum(
        draft.strategy,
        ["concise-recap", "what-we-heard", "next-steps"] as const,
        `drafts[${String(index)}].strategy`,
      ),
      title: requiredString(draft.title, `drafts[${String(index)}].title`),
      text: validation.text,
    };
  });
  const strategies = new Set(drafts.map((draft) => draft.strategy));
  if (strategies.size !== 3) {
    throw new Error("drafts must contain each strategy exactly once");
  }
  if (
    context.replies.analyzedReplies === 0 &&
    (themes.length !== 0 || faq.length !== 0 || actions.length !== 0)
  ) {
    throw new Error(
      "themes, faq, and actions must be empty when recent search returns no replies",
    );
  }

  return {
    source: {
      url: context.source.url,
      postId: context.source.id,
      authorId: context.source.authorId,
      authorUsername: context.source.author?.username ?? "unknown",
      text: context.source.text,
    },
    coverage: {
      analyzedReplies: context.replies.analyzedReplies,
      truncated: context.replies.truncated,
      searchWindow: "recent-7-days",
      ...(context.replies.nextToken !== undefined
        ? { nextToken: context.replies.nextToken }
        : {}),
    },
    summary: requiredString(input.summary, "summary"),
    themes,
    faq,
    actions,
    drafts: [drafts[0]!, drafts[1]!, drafts[2]!],
  };
}

function parseEvidence(
  value: unknown,
  allowed: Set<string>,
  replies: XReplyCollection,
  path: string,
): string[] {
  const rawIds = requiredArray(value, path);
  if (rawIds.length > 5) {
    throw new Error(`${path} must contain at most five replies`);
  }
  const ids = rawIds.map((id, index) =>
    requiredString(id, `${path}[${String(index)}]`),
  );
  for (const id of ids) {
    if (!allowed.has(id)) throw new Error(`${path} contains unknown reply ${id}`);
  }
  const byId = new Map(replies.replies.map((reply) => [reply.id, reply.url]));
  return ids.map((id) => byId.get(id)!);
}

function requiredRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function boundedArray(
  value: unknown,
  path: string,
  maximum: number,
): unknown[] {
  const result = requiredArray(value, path);
  if (result.length > maximum) {
    throw new Error(`${path} must contain at most ${String(maximum)} entries`);
  }
  return result;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function requiredEnum<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  path: string,
): Values[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${path} must be one of ${allowed.join(", ")}`);
  }
  return value;
}
import twitterText from "twitter-text";

import type {
  LaunchFeedback,
  XPost,
  XReplyCollection,
} from "./types";
