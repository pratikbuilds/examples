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
