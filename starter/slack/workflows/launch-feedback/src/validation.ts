import type {
  ApprovalPayload,
  CreateDraftsResult,
  ReplyDraft,
  ReplySnapshot,
  ReplyTriage,
  ReplyTriageResult,
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
  selectedReplyIds?: readonly string[],
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
  if (
    replyCollection.coverage.source !== "recent-search" ||
    replyCollection.coverage.days !== 7 ||
    replyCollection.coverage.complete !== false
  ) {
    throw new Error("reply collection must declare incomplete recent-search coverage");
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
  const fetched = replyCollection.replies.map((reply, index) => {
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

  const replies = selectCandidateReplies(fetched, selectedReplyIds);

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
      fetchedReplies: replyCollection.analyzedReplies,
      analyzedReplies: replies.length,
      truncated: replyCollection.truncated,
      searchWindow: "recent-7-days",
      ...(replyCollection.nextToken !== undefined
        ? { nextToken: replyCollection.nextToken }
        : {}),
    },
    replies,
  };
}

function selectCandidateReplies(
  fetched: ReplySnapshot["replies"],
  selectedReplyIds: readonly string[] | undefined,
): ReplySnapshot["replies"] {
  if (selectedReplyIds === undefined) return fetched;
  const byId = new Map(fetched.map((reply) => [reply.id, reply]));
  const seen = new Set<string>();
  return selectedReplyIds.map((replyId, index) => {
    const path = `selectedReplyIds[${String(index)}]`;
    if (seen.has(replyId)) {
      throw new Error(`${path} is a duplicate reply id`);
    }
    seen.add(replyId);
    const reply = byId.get(replyId);
    if (reply === undefined) {
      throw new Error(`${path} is not in the fetched reply set`);
    }
    return reply;
  });
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
      ["question", "complaint", "feature-request"] as const,
      `${path}.reason`,
    );
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
      "classifications, themes, and amplification opportunities must be empty when no candidate replies were selected",
    );
  }

  return {
    overview: emptyCandidateOverview(snapshot, input.overview),
    classifications,
    themes,
    amplificationOpportunities,
    counts: derivedCounts,
  };
}

export function parseReplyDrafts(
  value: unknown,
  triageResult: ReplyTriageResult,
): ReplyDraft[] {
  const input = requiredRecord(value, "reply drafts");
  const draftsInput = boundedArray(input.drafts, "drafts", 25);
  const respondNow = triageResult.triage.classifications.filter(
    (item) => item.priority === "respond-now",
  );
  const drafted = new Set<string>();
  const drafts = draftsInput.map((item, index) => {
    const path = `drafts[${String(index)}]`;
    const draft = requiredRecord(item, path);
    const replyId = requiredString(draft.replyId, `${path}.replyId`);
    const reply = triageResult.snapshot.replies.find((entry) => entry.id === replyId);
    if (reply === undefined) {
      throw new Error(`${path}.replyId is not a candidate reply`);
    }
    if (drafted.has(replyId)) {
      throw new Error(`${path}.replyId is duplicated`);
    }
    drafted.add(replyId);
    const classification = respondNow.find(
      (entry) => entry.replyURL === reply.url,
    );
    if (classification === undefined) {
      throw new Error(`${path} must target a respond-now classification`);
    }
    return {
      replyId,
      replyURL: reply.url,
      authorUsername: reply.author.username,
      reason: classification.reason,
      text: requiredString(draft.text, `${path}.text`),
    };
  });
  if (drafts.length !== respondNow.length || drafted.size !== respondNow.length) {
    throw new Error(
      "drafts must include exactly one entry for every respond-now classification",
    );
  }
  return drafts;
}

export function parseApprovalPayload(value: unknown): ApprovalPayload {
  const input = requiredRecord(value, "approval payload");
  const approved = boundedArray(input.approved, "approved", 25).map(
    (item, index) => parseApprovedDraft(item, `approved[${String(index)}]`),
  );
  return { approved };
}

function parseApprovedDraft(value: unknown, path: string): ReplyDraft {
  const draft = requiredRecord(value, path);
  return {
    replyId: requiredString(draft.replyId, `${path}.replyId`),
    replyURL: parseXStatusURL(draft.replyURL).canonicalURL,
    authorUsername: requiredString(
      draft.authorUsername,
      `${path}.authorUsername`,
    ),
    reason: requiredEnum(
      draft.reason,
      ["question", "complaint", "feature-request"] as const,
      `${path}.reason`,
    ),
    text: requiredString(draft.text, `${path}.text`),
  };
}

export function toCreateDraftsResult(
  triageResult: ReplyTriageResult,
  drafts: ReplyDraft[],
): CreateDraftsResult {
  return {
    snapshot: triageResult.snapshot,
    triage: triageResult.triage,
    drafts,
  };
}

function emptyCandidateOverview(
  snapshot: ReplySnapshot,
  overview: unknown,
): string {
  if (snapshot.coverage.analyzedReplies !== 0) {
    return requiredString(overview, "overview");
  }
  if (snapshot.coverage.fetchedReplies === 0) {
    return "X recent search returned no replies in its available window. This does not establish historical absence of replies.";
  }
  return "Recent replies were fetched, but none were kept as question, complaint, or feature-request candidates.";
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
