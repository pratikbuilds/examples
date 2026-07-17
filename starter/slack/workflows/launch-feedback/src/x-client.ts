import { createHmac, randomBytes } from "node:crypto";

import type {
  XCredentials,
  XPost,
  XReplyCollection,
  XUser,
} from "./types";
import { parseXStatusURL } from "./validation";

const API_ORIGIN = "https://api.x.com";
export const DEFAULT_REPLY_SAMPLE_SIZE = 25;

export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type XReadClient = {
  getPost: (url: string, signal?: AbortSignal) => Promise<XPost>;
  getPostReplies: (input: {
    url: string;
    maxResults?: number;
    signal?: AbortSignal;
  }) => Promise<XReplyCollection>;
};

export class XAPIError extends Error {
  readonly status: number;
  readonly rateLimit?: {
    limit?: number;
    remaining?: number;
    resetAt?: string;
  };

  constructor(
    status: number,
    message: string,
    rateLimit?: XAPIError["rateLimit"],
  ) {
    super(message);
    this.name = "XAPIError";
    this.status = status;
    this.rateLimit = rateLimit;
  }
}

export function createXReader(
  credentials: XCredentials,
  fetchImpl: Fetch = fetch,
): XReadClient {
  async function getPost(
    rawURL: string,
    signal?: AbortSignal,
  ): Promise<XPost> {
    const ref = parseXStatusURL(rawURL);
    const endpoint = new URL(`/2/tweets/${ref.postId}`, API_ORIGIN);
    endpoint.searchParams.set(
      "tweet.fields",
      "author_id,conversation_id,created_at,public_metrics,referenced_tweets",
    );
    endpoint.searchParams.set("expansions", "author_id");
    endpoint.searchParams.set(
      "user.fields",
      "id,name,username,profile_image_url,public_metrics,verified",
    );

    const payload = await requestJSON(
      "GET",
      endpoint,
      credentials,
      fetchImpl,
      signal,
    );
    const root = requiredRecord(payload, "X post response");
    const users = parseIncludedUsers(root.includes);
    return parsePost(requiredRecord(root.data, "X post response data"), users);
  }

  async function getPostReplies(input: {
    url: string;
    maxResults?: number;
    signal?: AbortSignal;
  }): Promise<XReplyCollection> {
    const ref = parseXStatusURL(input.url);
    const endpoint = new URL("/2/tweets/search/recent", API_ORIGIN);
    endpoint.searchParams.set(
      "query",
      `conversation_id:${ref.postId} is:reply`,
    );
    endpoint.searchParams.set(
      "tweet.fields",
      "author_id,conversation_id,created_at,in_reply_to_user_id,public_metrics,referenced_tweets",
    );
    endpoint.searchParams.set("expansions", "author_id");
    endpoint.searchParams.set(
      "user.fields",
      "id,name,username,profile_image_url,public_metrics,verified",
    );
    endpoint.searchParams.set(
      "max_results",
      String(clampMaxResults(input.maxResults)),
    );

    const payload = await requestJSON(
      "GET",
      endpoint,
      credentials,
      fetchImpl,
      input.signal,
    );
    const root = requiredRecord(payload, "X reply search response");
    const users = parseIncludedUsers(root.includes);
    const rawData = root.data === undefined ? [] : requiredArray(root.data, "data");
    const replies = rawData
      .map((value) => requiredRecord(value, "reply"))
      .filter((value) => requiredString(value.id, "reply.id") !== ref.postId)
      .map((value) => parsePost(value, users, ref.postId));
    const meta = optionalRecord(root.meta);
    const nextToken = optionalString(meta?.next_token);

    return {
      sourcePostId: ref.postId,
      replies,
      analyzedReplies: replies.length,
      ...(nextToken !== undefined ? { nextToken } : {}),
      truncated: nextToken !== undefined,
      coverage: { source: "recent-search", days: 7, complete: false },
    };
  }

  return { getPost, getPostReplies };
}

export function resolveCredentials(
  env: NodeJS.ProcessEnv,
): XCredentials | undefined {
  const apiKey = env.X_API_KEY;
  const apiSecret = env.X_API_SECRET;
  const accessToken = env.X_ACCESS_TOKEN;
  const accessTokenSecret = env.X_ACCESS_TOKEN_SECRET;
  if (
    apiKey === undefined ||
    apiKey === "" ||
    apiSecret === undefined ||
    apiSecret === "" ||
    accessToken === undefined ||
    accessToken === "" ||
    accessTokenSecret === undefined ||
    accessTokenSecret === ""
  ) {
    return undefined;
  }
  return { apiKey, apiSecret, accessToken, accessTokenSecret };
}

export function buildOAuthHeader(
  method: string,
  rawURL: string,
  credentials: XCredentials,
  overrides?: { nonce?: string; timestamp?: string },
): string {
  const url = new URL(rawURL);
  const oauthParams: Array<[string, string]> = [
    ["oauth_consumer_key", credentials.apiKey],
    ["oauth_nonce", overrides?.nonce ?? randomBytes(16).toString("hex")],
    ["oauth_signature_method", "HMAC-SHA1"],
    [
      "oauth_timestamp",
      overrides?.timestamp ?? String(Math.floor(Date.now() / 1000)),
    ],
    ["oauth_token", credentials.accessToken],
    ["oauth_version", "1.0"],
  ];
  const signaturePairs = [...oauthParams, ...url.searchParams.entries()]
    .map(([key, value]) => [percentEncode(key), percentEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey
        ? leftValue.localeCompare(rightValue)
        : leftKey.localeCompare(rightKey),
    );
  const parameterString = signaturePairs
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const baseURL = `${url.origin}${url.pathname}`;
  const baseString = [
    method.toUpperCase(),
    percentEncode(baseURL),
    percentEncode(parameterString),
  ].join("&");
  const signingKey = `${percentEncode(credentials.apiSecret)}&${percentEncode(credentials.accessTokenSecret)}`;
  const signature = createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");
  const headerParams = [...oauthParams, ["oauth_signature", signature] as const]
    .map(([key, value]) => [percentEncode(key), percentEncode(value)] as const)
    .sort(([left], [right]) => left.localeCompare(right));

  return `OAuth ${headerParams
    .map(([key, value]) => `${key}="${value}"`)
    .join(", ")}`;
}

export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function requestJSON(
  method: "GET",
  url: URL,
  credentials: XCredentials,
  fetchImpl: Fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method,
    headers: {
      Authorization: buildOAuthHeader(method, url.href, credentials),
    },
    signal,
  });
  const responseBody = await response.text();

  if (!response.ok) {
    throw new XAPIError(
      response.status,
      `X API returned ${String(response.status)}: ${responseBody.slice(0, 500)}`,
      parseRateLimit(response.headers),
    );
  }

  try {
    return JSON.parse(responseBody) as unknown;
  } catch {
    throw new XAPIError(response.status, "X API returned invalid JSON");
  }
}

function parsePost(
  value: Record<string, unknown>,
  users: Map<string, XUser>,
  rootPostId?: string,
): XPost {
  const id = requiredString(value.id, "post.id");
  const text = requiredString(value.text, "post.text");
  const authorId = requiredString(value.author_id, "post.author_id");
  const author = users.get(authorId);
  const parentPostId = parseParentPostId(value.referenced_tweets);
  const createdAt = optionalString(value.created_at);
  const conversationId = optionalString(value.conversation_id);
  const publicMetrics = parsePostMetrics(value.public_metrics);

  return {
    id,
    url:
      author === undefined
        ? `https://x.com/i/web/status/${id}`
        : `https://x.com/${author.username}/status/${id}`,
    text,
    authorId,
    ...(author !== undefined ? { author } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(parentPostId !== undefined ? { parentPostId } : {}),
    directReply: rootPostId !== undefined && parentPostId === rootPostId,
    ...(publicMetrics !== undefined ? { publicMetrics } : {}),
  };
}

function parseIncludedUsers(value: unknown): Map<string, XUser> {
  const includes = optionalRecord(value);
  const rawUsers = includes?.users;
  if (rawUsers === undefined) return new Map();

  return new Map(
    requiredArray(rawUsers, "includes.users").map((rawUser) => {
      const user = parseUser(requiredRecord(rawUser, "user"));
      return [user.id, user] as const;
    }),
  );
}

function parseUser(value: Record<string, unknown>): XUser {
  const profileImageURL = optionalString(value.profile_image_url);
  const verified = optionalBoolean(value.verified);
  const publicMetrics = parseUserMetrics(value.public_metrics);

  return {
    id: requiredString(value.id, "user.id"),
    name: requiredString(value.name, "user.name"),
    username: requiredString(value.username, "user.username"),
    ...(profileImageURL !== undefined ? { profileImageURL } : {}),
    ...(verified !== undefined ? { verified } : {}),
    ...(publicMetrics !== undefined ? { publicMetrics } : {}),
  };
}

function parseParentPostId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  for (const rawReference of requiredArray(value, "referenced_tweets")) {
    const reference = requiredRecord(rawReference, "referenced_tweet");
    if (reference.type === "replied_to") {
      return requiredString(reference.id, "referenced_tweet.id");
    }
  }
  return undefined;
}

function parsePostMetrics(value: unknown): XPost["publicMetrics"] {
  const metrics = optionalRecord(value);
  if (metrics === undefined) return undefined;
  return {
    replies: requiredNumber(metrics.reply_count, "public_metrics.reply_count"),
    reposts: requiredNumber(
      metrics.retweet_count,
      "public_metrics.retweet_count",
    ),
    likes: requiredNumber(metrics.like_count, "public_metrics.like_count"),
    quotes: requiredNumber(metrics.quote_count, "public_metrics.quote_count"),
  };
}

function parseUserMetrics(value: unknown): XUser["publicMetrics"] {
  const metrics = optionalRecord(value);
  if (metrics === undefined) return undefined;
  return {
    followers: requiredNumber(
      metrics.followers_count,
      "public_metrics.followers_count",
    ),
    following: requiredNumber(
      metrics.following_count,
      "public_metrics.following_count",
    ),
    posts: requiredNumber(metrics.tweet_count, "public_metrics.tweet_count"),
    listed: requiredNumber(metrics.listed_count, "public_metrics.listed_count"),
  };
}

function parseRateLimit(headers: Headers): XAPIError["rateLimit"] {
  const limit = optionalHeaderNumber(headers.get("x-rate-limit-limit"));
  const remaining = optionalHeaderNumber(headers.get("x-rate-limit-remaining"));
  const reset = optionalHeaderNumber(headers.get("x-rate-limit-reset"));
  if (limit === undefined && remaining === undefined && reset === undefined) {
    return undefined;
  }
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(reset !== undefined
      ? { resetAt: new Date(reset * 1000).toISOString() }
      : {}),
  };
}

function clampMaxResults(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_REPLY_SAMPLE_SIZE;
  }
  return Math.min(100, Math.max(10, Math.trunc(value)));
}

function requiredRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  const record = optionalRecord(value);
  if (record === undefined) throw new Error(`${path} must be an object`);
  return record;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function requiredString(value: unknown, path: string): string {
  const string = optionalString(value);
  if (string === undefined) throw new Error(`${path} must be a string`);
  return string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function requiredNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a number`);
  }
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalHeaderNumber(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
