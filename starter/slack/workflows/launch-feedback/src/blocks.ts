import {
  actions,
  button,
  header,
  section,
  type SlackBlock,
} from "@corbits/example-slack-bridge";
import type { ModalView } from "@slack/types";

import type { FollowUpDraft, LaunchFeedback, PostReceipt } from "./types";

export const DRAFT_EDIT_ACTION_ID = "launch-feedback.draft.edit";
export const DRAFT_PUBLISH_ACTION_ID = "launch-feedback.draft.publish";
export const DRAFT_SKIP_ACTION_ID = "launch-feedback.draft.skip";
export const DRAFT_EDIT_CALLBACK_ID = "launch-feedback.draft.edit.submit";
export const DRAFT_TEXT_BLOCK_ID = "draft";
export const DRAFT_TEXT_ACTION_ID = "text";

export type DraftCardStatus =
  | "pending"
  | "skipped"
  | "publishing"
  | "published"
  | "expired"
  | "disabled"
  | "preview-only";

export function startedBlocks(url: string): SlackBlock[] {
  return [
    section(
      `*Launch feedback analysis started*\nReading the post and recent replies for <${url}|this X post>.`,
    ),
  ];
}

export function invalidURLBlocks(): SlackBlock[] {
  return [
    section(
      "*Full X status URL required*\nUse a URL such as `https://x.com/user/status/123`. A post ID or profile URL is not enough.",
    ),
  ];
}

export function alreadyRunningBlocks(): SlackBlock[] {
  return [
    section(
      "*Analysis already in review*\nUse the draft actions already posted in this thread.",
    ),
  ];
}

export function feedbackBriefBlocks(
  feedback: LaunchFeedback,
): SlackBlock[] {
  const blocks: SlackBlock[] = [
    header("Launch feedback brief"),
    section(
      [
        `*Source:* <${feedback.source.url}|X post>`,
        `*Coverage:* ${String(feedback.coverage.analyzedReplies)} recent ${plural(feedback.coverage.analyzedReplies, "reply", "replies")} analyzed`,
        "*Search window:* X recent search (up to 7 days; historical coverage is not guaranteed)",
        feedback.coverage.truncated
          ? "*Pagination:* more recent results are available"
          : "*Pagination:* no additional page was returned",
      ].join("\n"),
    ),
  ];

  if (feedback.coverage.analyzedReplies === 0) {
    blocks.push(
      section(
        "*:warning: Incomplete coverage*\nX recent search returned no replies in its available window. This does not mean the post has never received replies, so no reply-derived themes, FAQ, or actions are claimed.",
      ),
    );
  } else {
    blocks.push(section(`*Summary*\n${slackText(feedback.summary)}`));
    blocks.push(...feedbackSectionBlocks(feedback));
  }

  blocks.push(section("*Follow-up drafts*\nChoose one to edit or publish, or skip all three."));
  return blocks;
}

export function draftCardBlocks(input: {
  draft: FollowUpDraft;
  revision: number;
  actionToken: string;
  status: DraftCardStatus;
  actor?: string;
  receipt?: PostReceipt;
}): SlackBlock[] {
  const { draft, revision, actionToken, status } = input;
  const blocks: SlackBlock[] = [
    header(draft.title.slice(0, 150)),
    section(`>${slackText(draft.text).split("\n").join("\n>")}`),
    section(
      `*Strategy:* ${draft.strategy}  •  *Revision:* ${String(revision)}  •  *Characters:* ${String([...draft.text].length)}/280`,
    ),
  ];

  if (status === "pending") {
    blocks.push(
      actions([
        button({
          text: "Publish",
          style: "primary",
          actionId: DRAFT_PUBLISH_ACTION_ID,
          value: actionToken,
        }),
        button({
          text: "Edit",
          actionId: DRAFT_EDIT_ACTION_ID,
          value: actionToken,
        }),
        button({
          text: "Skip",
          actionId: DRAFT_SKIP_ACTION_ID,
          value: actionToken,
        }),
      ]),
    );
    return blocks;
  }

  if (status === "published" && input.receipt !== undefined) {
    const receipt = input.receipt;
    blocks.push(
      section(
        receipt.mode === "live"
          ? `*:white_check_mark: Published by <@${input.actor ?? "slack-user"}>*\n<${receipt.url}|Open the post on X> • ${receipt.postedAt}`
          : `*:white_check_mark: Dry-run publication approved by <@${input.actor ?? "slack-user"}>*\nNo X POST request was sent. Receipt: \`${receipt.postId}\``,
      ),
    );
    return blocks;
  }

  const labels: Record<Exclude<DraftCardStatus, "pending">, string> = {
    skipped: ":fast_forward: Skipped",
    publishing: ":hourglass_flowing_sand: Publishing approved text",
    expired: ":clock1: Expired — actions are disabled",
    disabled: ":no_entry_sign: Another draft was selected — actions are disabled",
    "preview-only": ":lock: Preview only — the authenticated X account does not own the source post",
    published: ":white_check_mark: Published",
  };
  blocks.push(section(`*${labels[status]}*`));
  return blocks;
}

export function editDraftModal(input: {
  actionToken: string;
  draft: FollowUpDraft;
  revision: number;
}): ModalView {
  return {
    type: "modal",
    callback_id: DRAFT_EDIT_CALLBACK_ID,
    private_metadata: input.actionToken,
    title: { type: "plain_text", text: "Edit X draft" },
    submit: { type: "plain_text", text: "Save draft" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: DRAFT_TEXT_BLOCK_ID,
        label: {
          type: "plain_text",
          text: `Draft revision ${String(input.revision)}`,
        },
        element: {
          type: "plain_text_input",
          action_id: DRAFT_TEXT_ACTION_ID,
          multiline: true,
          initial_value: input.draft.text,
        },
      },
    ],
  };
}

export function completionBlocks(): SlackBlock[] {
  return [
    section(
      "*:white_check_mark: Review complete*\nAll three drafts were skipped. Nothing was published to X.",
    ),
  ];
}

export function failedBlocks(message: string): SlackBlock[] {
  return [section(`*:x: Launch feedback failed*\n${slackText(message).slice(0, 2800)}`)];
}

function feedbackSectionBlocks(feedback: LaunchFeedback): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  if (feedback.themes.length > 0) {
    blocks.push(
      section(
        `*Themes*\n${feedback.themes
          .map(
            (theme) =>
              `• *${slackText(theme.label)}* (${theme.sentiment}) — ${slackText(theme.summary)}${evidence(theme.evidenceUrls)}`,
          )
          .join("\n")}`,
      ),
    );
  }
  if (feedback.faq.length > 0) {
    blocks.push(
      section(
        `*FAQ opportunities*\n${feedback.faq
          .map(
            (entry) =>
              `• *${slackText(entry.question)}*\n  ${slackText(entry.suggestedAnswer)}${evidence(entry.evidenceUrls)}`,
          )
          .join("\n")}`,
      ),
    );
  }
  if (feedback.actions.length > 0) {
    blocks.push(
      section(
        `*Internal actions*\n${feedback.actions
          .map(
            (entry) =>
              `• *${entry.priority.toUpperCase()} · ${entry.owner}* — ${slackText(entry.action)}${evidence(entry.evidenceUrls)}`,
          )
          .join("\n")}`,
      ),
    );
  }
  return blocks;
}

function evidence(urls: string[]): string {
  if (urls.length === 0) return "";
  return ` (${urls.map((url, index) => `<${url}|evidence ${String(index + 1)}>`).join(", ")})`;
}

function slackText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
}
