import { createHmac, randomUUID } from "node:crypto";

import { type } from "arktype";

const X_POST_URL = "https://api.x.com/2/tweets";
const X_REQUEST_TIMEOUT_MS = 30_000;
const ERROR_EXCERPT_LIMIT = 500;

const XCredentials = type({
  APIKey: "string > 0",
  APISecret: "string > 0",
  accessToken: "string > 0",
  accessTokenSecret: "string > 0",
});

const XCreatePostResponse = type({
  data: { id: "string > 0" },
});

const PostReceipt = type({
  mode: "'dry-run'",
  postID: "string > 0",
  text: "string",
  postedAt: "string",
}).or({
  mode: "'live'",
  postID: "string > 0",
  url: "string > 0",
  text: "string",
  postedAt: "string",
});

type XCredentials = typeof XCredentials.infer;
export type PostReceipt = typeof PostReceipt.infer;

export interface Publisher {
  readonly mode: PostReceipt["mode"];
  publish(text: string): Promise<PostReceipt>;
}

export function createPublisher(env: NodeJS.ProcessEnv): Publisher {
  const credentials = resolveCredentials(env);
  if (env.X_LIVE !== "1" || credentials === undefined) {
    return createDryRunPublisher();
  }

  return {
    mode: "live",
    async publish(text) {
      const postID = await createPost(text, credentials);
      return Object.freeze({
        mode: "live",
        postID,
        url: `https://x.com/i/web/status/${postID}`,
        text,
        postedAt: new Date().toISOString(),
      });
    },
  };
}

export function createDryRunPublisher(): Publisher {
  return {
    mode: "dry-run",
    async publish(text) {
      return Object.freeze({
        mode: "dry-run",
        postID: `dryrun-${randomUUID()}`,
        text,
        postedAt: new Date().toISOString(),
      });
    },
  };
}

function resolveCredentials(
  env: NodeJS.ProcessEnv,
): XCredentials | undefined {
  const credentials = XCredentials({
    APIKey: env.X_API_KEY?.trim(),
    APISecret: env.X_API_SECRET?.trim(),
    accessToken: env.X_ACCESS_TOKEN?.trim(),
    accessTokenSecret: env.X_ACCESS_TOKEN_SECRET?.trim(),
  });

  return credentials instanceof type.errors ? undefined : credentials;
}

function createOAuthHeader(credentials: XCredentials): string {
  const parameters = {
    oauth_consumer_key: credentials.APIKey,
    oauth_nonce: randomUUID().replaceAll("-", ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
  };
  const signature = createOAuthSignature(parameters, credentials);
  const headerParameters = { ...parameters, oauth_signature: signature };

  return `OAuth ${Object.entries(headerParameters)
    .map(([key, value]) => `${encodeOAuth(key)}="${encodeOAuth(value)}"`)
    .join(", ")}`;
}

export function parsePostReceipt(input: unknown): PostReceipt {
  const receipt = PostReceipt(input);
  if (receipt instanceof type.errors) {
    throw new Error(
      `publish step returned an invalid receipt: ${receipt.summary}`,
    );
  }
  return receipt;
}

async function createPost(
  text: string,
  credentials: XCredentials,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), X_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(X_POST_URL, {
      method: "POST",
      headers: {
        Authorization: createOAuthHeader(credentials),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const responseText = await response.text();

  if (!response.ok) {
    const excerpt = responseText
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, ERROR_EXCERPT_LIMIT);
    throw new Error(
      `X post request failed (${response.status})${excerpt === "" ? "" : `: ${excerpt}`}`,
    );
  }

  let rawResponse: unknown;
  try {
    rawResponse = JSON.parse(responseText);
  } catch (cause) {
    throw new Error("X post response was not valid JSON", { cause });
  }

  const postResponse = XCreatePostResponse(rawResponse);
  if (postResponse instanceof type.errors) {
    throw new Error(`X post response was invalid: ${postResponse.summary}`);
  }
  return postResponse.data.id;
}

function createOAuthSignature(
  parameters: Record<string, string>,
  credentials: XCredentials,
): string {
  const normalizedParameters = Object.entries(parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeOAuth(key)}=${encodeOAuth(value)}`)
    .join("&");
  const signatureBase = [
    "POST",
    encodeOAuth(X_POST_URL),
    encodeOAuth(normalizedParameters),
  ].join("&");
  const signingKey = [
    encodeOAuth(credentials.APISecret),
    encodeOAuth(credentials.accessTokenSecret),
  ].join("&");

  return createHmac("sha1", signingKey)
    .update(signatureBase)
    .digest("base64");
}

function encodeOAuth(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
