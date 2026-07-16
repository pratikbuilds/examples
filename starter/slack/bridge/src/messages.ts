import { WebClient } from "@slack/web-api";
import type { ModalView } from "@slack/types";

import type { SlackBlock } from "./blocks";

export type SlackPostMessage = {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks?: SlackBlock[];
};

export type SlackUpdateMessage = {
  channel: string;
  ts: string;
  text: string;
  blocks?: SlackBlock[];
};

export async function postMessage(
  botToken: string,
  message: SlackPostMessage,
): Promise<{ channel: string; ts: string }> {
  const client = new WebClient(botToken);
  const result = await client.chat.postMessage(message);

  if (result.channel === undefined || result.ts === undefined) {
    throw new Error(
      `Slack chat.postMessage failed: ${result.error ?? "unknown error"}`,
    );
  }

  return { channel: result.channel, ts: result.ts };
}

export async function updateMessage(
  botToken: string,
  message: SlackUpdateMessage,
  client: WebClient = new WebClient(botToken),
): Promise<{ channel: string; ts: string }> {
  const result = await client.chat.update(message);

  if (result.channel === undefined || result.ts === undefined) {
    throw new Error(
      `Slack chat.update failed: ${result.error ?? "unknown error"}`,
    );
  }

  return { channel: result.channel, ts: result.ts };
}

export async function openModal(
  botToken: string,
  input: { triggerId: string; view: ModalView },
  client: WebClient = new WebClient(botToken),
): Promise<void> {
  await client.views.open({ trigger_id: input.triggerId, view: input.view });
}

export function cleanSlackText(text: string): string {
  return text
    .replace(/<@[UW][A-Z0-9]+(?:\|[^>]+)?>/g, "")
    .replace(/\*Sent using\*.*$/gim, "")
    .trim();
}

export function truncateForSlack(text: string): string {
  return text.length > 39000 ? text.slice(0, 38997) + "..." : text;
}
