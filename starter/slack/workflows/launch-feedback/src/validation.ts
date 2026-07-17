import twitterText from "twitter-text";

import type {
  LaunchFeedback,
  ReplySnapshot,
  ReplyTriage,
  XPost,
  XReplyCollection,
} from "./types";

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

export function createReplySnapshot(
  source: XPost,
  replyCollection: XReplyCollection,
  expectedURL: string,
): ReplySnapshot {
  const expected = parseXStatusURL(expectedURL);
  const sourceRef = parseXStatusURL(source.url);
  if (
    source.id !== expected.postId ||
    sourceRef.postId !== source.id
  ) {
    throw new Error("reply snapshot source must match the trigger URL");
  }
  if (replyCollection.sourcePostId !== source.id) {
    throw new Error("reply collection must belong to the source post");
  }
  if (replyCollection.analyzedReplies !== replyCollection.replies.length) {
    throw new Error("reply collection analyzedReplies must equal replies.length");
  }
  if (
    replyCollection.truncated !== (replyCollection.nextToken !== undefined)
  ) {
    throw new Error(
      "reply collection truncated must match nextToken presence",
    );
  }
  const sourceAuthor = source.author;
  const sourceMetrics = source.publicMetrics;
  if (sourceAuthor === undefined || sourceMetrics === undefined) {
    throw new Error("source post must include author and public metrics");
  }
  if (
    statusUsername(sourceRef.canonicalURL).toLowerCase() !==
    sourceAuthor.username.toLowerCase()
  ) {
    throw new Error("source post URL must match the expanded author");
  }

  const replyIds = new Set<string>();
  const replyURLs = new Set<string>();
  const replies = replyCollection.replies.map((reply, index) => {
      const path = `replies[${String(index)}]`;
      const ref = parseXStatusURL(reply.url);
      if (ref.postId !== reply.id) {
        throw new Error(`${path}.url must contain the reply id`);
      }
      if (replyIds.has(reply.id) || replyURLs.has(ref.canonicalURL)) {
        throw new Error(`${path} is a duplicate reply`);
      }
      replyIds.add(reply.id);
      replyURLs.add(ref.canonicalURL);
      const author = reply.author;
      const authorMetrics = author?.publicMetrics;
      const metrics = reply.publicMetrics;
      if (author === undefined || authorMetrics === undefined || metrics === undefined) {
        throw new Error(`${path} must include author and public metrics`);
      }
      if (reply.conversationId !== source.id) {
        throw new Error(`${path} must belong to the source conversation`);
      }
      if (
        statusUsername(ref.canonicalURL).toLowerCase() !==
        author.username.toLowerCase()
      ) {
        throw new Error(`${path}.url must match the expanded author`);
      }
      return {
        id: reply.id,
        url: ref.canonicalURL,
        text: reply.text,
        author: {
          username: author.username,
          followers: nonNegativeInteger(
            authorMetrics.followers,
            `${path}.author.followers`,
          ),
          verified: author.verified === true,
        },
        metrics: {
          likes: nonNegativeInteger(metrics.likes, `${path}.metrics.likes`),
          replies: nonNegativeInteger(
            metrics.replies,
            `${path}.metrics.replies`,
          ),
          reposts: nonNegativeInteger(
            metrics.reposts,
            `${path}.metrics.reposts`,
          ),
        },
        directReply: reply.directReply,
      };
    });

  return {
    source: {
      url: sourceRef.canonicalURL,
      postId: source.id,
      authorUsername: sourceAuthor.username,
      text: source.text,
      metrics: {
        replies: nonNegativeInteger(sourceMetrics.replies, "source.metrics.replies"),
        likes: nonNegativeInteger(sourceMetrics.likes, "source.metrics.likes"),
        reposts: nonNegativeInteger(sourceMetrics.reposts, "source.metrics.reposts"),
        quotes: nonNegativeInteger(sourceMetrics.quotes, "source.metrics.quotes"),
      },
    },
    coverage: {
      analyzedReplies: replyCollection.analyzedReplies,
      truncated: replyCollection.truncated,
      searchWindow: "recent-7-days",
      ...(replyCollection.nextToken !== undefined
        ? { nextToken: replyCollection.nextToken }
        : {}),
    },
    replies,
  };
}

export function parseReplyTriage(
  value: unknown,
  snapshot: ReplySnapshot,
): ReplyTriage {
  const input = requiredRecord(value, "reply triage");
  const repliesById = new Map(snapshot.replies.map((reply) => [reply.id, reply]));
  const classified = new Set<string>();
  const classifications = boundedArray(
    input.classifications,
    "classifications",
    100,
  ).map((item, index) => {
    const path = `classifications[${String(index)}]`;
    const classification = requiredRecord(item, path);
    const replyId = requiredString(classification.replyId, `${path}.replyId`);
    const reply = repliesById.get(replyId);
    if (reply === undefined || classified.has(replyId)) {
      throw new Error(
        "classifications must classify every snapshot reply exactly once",
      );
    }
    classified.add(replyId);
    const priority = requiredEnum(
      classification.priority,
      ["respond-now", "respond-later", "no-response"] as const,
      `${path}.priority`,
    );
    const reason = requiredEnum(
      classification.reason,
      [
        "question",
        "complaint",
        "purchase-intent",
        "feature-request",
        "misinformation",
        "high-reach-author",
        "praise",
        "spam",
      ] as const,
      `${path}.reason`,
    );
    if (priority === "respond-now" && reason === "high-reach-author") {
      throw new Error(
        `${path}.reason high-reach-author cannot alone justify respond-now`,
      );
    }
    const suggestedResponseAngle = optionalString(
      classification.suggestedResponseAngle,
      `${path}.suggestedResponseAngle`,
    );
    return {
      priority,
      reason,
      replyURL: reply.url,
      authorUsername: reply.author.username,
      summary: requiredString(classification.summary, `${path}.summary`),
      recommendedOwner: requiredEnum(
        classification.recommendedOwner,
        ["marketing", "support", "product"] as const,
        `${path}.recommendedOwner`,
      ),
      ...(suggestedResponseAngle !== undefined
        ? { suggestedResponseAngle }
        : {}),
    };
  });
  if (
    classifications.length !== snapshot.replies.length ||
    classified.size !== repliesById.size
  ) {
    throw new Error(
      "classifications must classify every snapshot reply exactly once",
    );
  }

  const derivedCounts = {
    respondNow: classifications.filter(
      (item) => item.priority === "respond-now",
    ).length,
    respondLater: classifications.filter(
      (item) => item.priority === "respond-later",
    ).length,
    noResponse: classifications.filter(
      (item) => item.priority === "no-response",
    ).length,
  };
  const themes = boundedArray(input.themes, "themes", 8).map((item, index) => {
    const path = `themes[${String(index)}]`;
    const theme = requiredRecord(item, path);
    const count = positiveInteger(theme.count, `${path}.count`);
    if (count > snapshot.coverage.analyzedReplies) {
      throw new Error(`${path}.count cannot exceed analyzed replies`);
    }
    const evidenceURLs = parseReplyEvidence(
      theme.evidenceReplyIds,
      repliesById,
      `${path}.evidenceReplyIds`,
    );
    if (evidenceURLs.length > count) {
      throw new Error(`${path}.count cannot be less than its evidence count`);
    }
    return {
      label: requiredString(theme.label, `${path}.label`),
      count,
      sentiment: requiredEnum(
        theme.sentiment,
        ["positive", "mixed", "negative", "neutral"] as const,
        `${path}.sentiment`,
      ),
      summary: requiredString(theme.summary, `${path}.summary`),
      evidenceURLs,
    };
  });
  const amplificationReplyIds = new Set<string>();
  const amplificationOpportunities = boundedArray(
    input.amplificationOpportunities,
    "amplificationOpportunities",
    8,
  ).map((item, index) => {
    const path = `amplificationOpportunities[${String(index)}]`;
    const opportunity = requiredRecord(item, path);
    const replyId = requiredString(opportunity.replyId, `${path}.replyId`);
    const reply = repliesById.get(replyId);
    if (reply === undefined) throw new Error(`${path} contains unknown reply ${replyId}`);
    if (amplificationReplyIds.has(replyId)) {
      throw new Error(`${path} contains duplicate reply ${replyId}`);
    }
    amplificationReplyIds.add(replyId);
    return {
      replyURL: reply.url,
      reason: requiredString(opportunity.reason, `${path}.reason`),
    };
  });

  if (
    snapshot.coverage.analyzedReplies === 0 &&
    (classifications.length !== 0 ||
      themes.length !== 0 ||
      amplificationOpportunities.length !== 0)
  ) {
    throw new Error(
      "classifications, themes, and amplification opportunities must be empty when recent search returns no replies",
    );
  }

  return {
    overview:
      snapshot.coverage.analyzedReplies === 0
        ? "X recent search returned no replies in its available window. This does not establish historical absence of replies."
        : requiredString(input.overview, "overview"),
    classifications,
    themes,
    amplificationOpportunities,
    counts: derivedCounts,
  };
}

function parseReplyEvidence(
  value: unknown,
  repliesById: Map<string, ReplySnapshot["replies"][number]>,
  path: string,
): string[] {
  const ids = boundedArray(value, path, 5).map((item, index) =>
    requiredString(item, `${path}[${String(index)}]`),
  );
  if (ids.length === 0) throw new Error(`${path} must not be empty`);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${path} must not contain duplicate replies`);
  }
  return ids.map((id) => {
    const reply = repliesById.get(id);
    if (reply === undefined) throw new Error(`${path} contains unknown reply ${id}`);
    return reply.url;
  });
}

function statusUsername(canonicalURL: string): string {
  return new URL(canonicalURL).pathname.split("/")[1]!;
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

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, path);
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, path: string): number {
  const result = nonNegativeInteger(value, path);
  if (result === 0) throw new Error(`${path} must be a positive integer`);
  return result;
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
