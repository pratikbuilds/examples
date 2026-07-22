import {
  actions,
  button,
  header,
  section,
  type SlackBlock,
} from "@corbits/example-slack-bridge";

import type { ApprovedPost } from "./post";
import type { PostReceipt } from "./x-client";

export const APPROVE_ACTION_ID = "post-to-x.approve";
export const REJECT_ACTION_ID = "post-to-x.reject";

export function startedBlocks(runId: string): SlackBlock[] {
  return [section(`*Post-to-X workflow started*\nRun \`${runId}\` is drafting now.`)];
}

export function approvalBlocks(
  approved: ApprovedPost,
  runId: string,
): SlackBlock[] {
  return [
    header("Post ready for approval"),
    section(truncateBlockText(approved.text)),
    section(`${approved.weightedLength}/${approved.limit} weighted characters`),
    actions([
      button({
        text: "Approve",
        style: "primary",
        actionId: APPROVE_ACTION_ID,
        value: runId,
      }),
      button({
        text: "Reject",
        style: "danger",
        actionId: REJECT_ACTION_ID,
        value: runId,
      }),
    ]),
  ];
}

export function approvedBlocks(): SlackBlock[] {
  return statusBlocks("Approved", "Publishing the exact approved text now.");
}

export function rejectedBlocks(): SlackBlock[] {
  return statusBlocks("Rejected", "Workflow cancelled. Nothing was posted.");
}

export function dryRunReceiptBlocks(receipt: PostReceipt): SlackBlock[] {
  return [
    header("Dry-run complete"),
    section(truncateBlockText(receipt.text)),
    section(`No X post was created. Receipt: \`${receipt.postId}\``),
  ];
}

export function failedBlocks(message: string): SlackBlock[] {
  return statusBlocks("Post-to-X workflow failed", truncateBlockText(message));
}

export function terminalStatusBlocks(status: string): SlackBlock[] {
  return statusBlocks("Workflow ended", `Status: \`${status}\``);
}

export function notReadyBlocks(): SlackBlock[] {
  return statusBlocks(
    "Not waiting yet",
    "The validated post will appear before approval is available.",
  );
}

function statusBlocks(title: string, text: string): SlackBlock[] {
  return [section(`*${title}*\n${text}`)];
}

function truncateBlockText(text: string): string {
  return text.length > 2900 ? text.slice(0, 2897) + "..." : text;
}
