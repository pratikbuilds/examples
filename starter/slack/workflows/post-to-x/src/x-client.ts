import { randomUUID } from "node:crypto";

export type PostReceipt = Readonly<{
  mode: "dry-run" | "live";
  postId: string;
  url?: string;
  text: string;
  postedAt: string;
}>;

export type Publisher = {
  readonly mode: PostReceipt["mode"];
  publish(text: string): Promise<PostReceipt>;
};

export function createDryRunPublisher(): Publisher {
  return {
    mode: "dry-run",
    async publish(text) {
      return Object.freeze({
        mode: "dry-run",
        postId: `dryrun-${randomUUID()}`,
        text,
        postedAt: new Date().toISOString(),
      });
    },
  };
}
