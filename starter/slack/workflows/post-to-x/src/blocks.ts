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
  approvalId: string,
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
        value: approvalId,
      }),
      button({
        text: "Reject",
        style: "danger",
        actionId: REJECT_ACTION_ID,
        value: approvalId,
      }),
    ]),
  ];
}

export function alreadyRunningBlocks(): SlackBlock[] {
  return statusBlocks(
    "Workflow already running",
    "Use the approval card already posted in this thread.",
  );
}

export function decisionRecordedBlocks(decision: string): SlackBlock[] {
  return statusBlocks(
    `${decision} recorded`,
    "This approval card cannot be used again.",
  );
}

export function rejectedBlocks(): SlackBlock[] {
  return statusBlocks("Rejected", "Workflow cancelled. Nothing was posted.");
}

export function receiptBlocks(receipt: PostReceipt): SlackBlock[] {
  if (receipt.mode === "live") {
    if (receipt.url === undefined) {
      throw new Error("live X receipt is missing its URL");
    }
    return [
      header("Posted to X"),
      section(`<${receipt.url}|View post>`),
      section(truncateBlockText(receipt.text)),
    ];
  }

  return [
    header("Dry run complete"),
    section("No X post was created."),
    section(truncateBlockText(receipt.text)),
    section(`Synthetic receipt: \`${receipt.postID}\``),
  ];
}

export function failedBlocks(message: string): SlackBlock[] {
  return statusBlocks("Post-to-X workflow failed", truncateBlockText(message));
}

export function terminalStatusBlocks(status: string): SlackBlock[] {
  return statusBlocks("Workflow ended", `Status: \`${status}\``);
}

function statusBlocks(title: string, text: string): SlackBlock[] {
  return [section(`*${title}*\n${text}`)];
}

function truncateBlockText(text: string): string {
  return text.length > 2900 ? text.slice(0, 2897) + "..." : text;
}
