import {
  actions,
  button,
  header,
  section,
  type SlackBlock,
} from "@corbits/example-slack-bridge";

import type {
  CreateDraftsResult,
  PostRepliesResult,
  ReplyDraft,
  ReplyTriageResult,
} from "./types";

export const APPROVE_ACTION_ID = "reply.approve";
export const REJECT_ACTION_ID = "reply.reject";

export type ProgressPhase =
  | "collecting"
  | "triaging"
  | "drafting"
  | "awaiting-approval"
  | "publishing"
  | "done";

export function startedBlocks(url: string): SlackBlock[] {
  return [
    section(
      `*Reply triage started*\nReading the post and recent replies for <${url}|this X post>.`,
    ),
  ];
}

export function progressBlocks(phase: ProgressPhase): SlackBlock[] {
  const steps: Array<{ id: ProgressPhase; label: string }> = [
    { id: "collecting", label: "Collect candidates from X" },
    { id: "triaging", label: "Classify questions, complaints, feature requests" },
    { id: "drafting", label: "Draft respond-now replies" },
    { id: "awaiting-approval", label: "Wait for Slack approve / reject" },
    { id: "publishing", label: "Post approved replies to X" },
  ];
  const activeIndex = steps.findIndex((step) => step.id === phase);
  const lines = steps.map((step, index) => {
    const mark =
      phase === "done" || index < activeIndex
        ? "✓"
        : index === activeIndex
          ? "…"
          : "·";
    return `${mark} ${step.label}`;
  });
  const title =
    phase === "done" ? "*Status:* done" : `*Status:* ${steps[activeIndex]?.label ?? "working"}`;
  return [section(`${title}\n${lines.join("\n")}`)];
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
      "*Reply triage already active*\nWait for the current analysis in this thread to finish.",
    ),
  ];
}

export function triageResultBlocks(result: ReplyTriageResult): SlackBlock[] {
  const { snapshot, triage } = result;
  const blocks: SlackBlock[] = [
    header("X reply triage"),
    section(
      [
        `*Source:* <${snapshot.source.url}|@${slackText(snapshot.source.authorUsername)} on X>`,
        `*Coverage:* ${String(snapshot.coverage.analyzedReplies)} candidate ${plural(snapshot.coverage.analyzedReplies, "reply", "replies")} from ${String(snapshot.coverage.fetchedReplies)} fetched · X reports ${String(snapshot.source.metrics.replies)} total ${plural(snapshot.source.metrics.replies, "reply", "replies")}`,
      ].join("\n"),
    ),
    section(`*Overview*\n${boundedText(triage.overview, 2800)}`),
  ];

  if (snapshot.coverage.fetchedReplies === 0) {
    blocks.push(
      section(
        "*:warning: Incomplete coverage*\nNo replies were returned by X recent search. This does not mean the post has never received replies.",
      ),
    );
  } else if (snapshot.coverage.analyzedReplies === 0) {
    blocks.push(
      section(
        "*:information_source: No candidates*\nReplies were fetched, but none looked like a meaningful question, complaint, or feature request.",
      ),
    );
  } else {
    blocks.push(
      ...classificationBlocks(
        "Respond now",
        triage.classifications.filter((item) => item.priority === "respond-now"),
      ),
      ...classificationBlocks(
        "Respond later",
        triage.classifications.filter(
          (item) => item.priority === "respond-later",
        ),
      ),
    );

    const themes = triage.themes.slice(0, 5).map(
      (theme) =>
        `• *${boundedText(theme.label, 160)}* · ${String(theme.count)} · ${theme.sentiment}\n  ${boundedText(theme.summary, 900)}${evidence(theme.evidenceURLs)}`,
    );
    if (themes.length > 0) blocks.push(...boundedListSections("Themes", themes));

    const amplification = triage.amplificationOpportunities
      .slice(0, 5)
      .map(
        (item) =>
          `• <${item.replyURL}|Open reply> — ${boundedText(item.reason, 900)}`,
      );
    if (amplification.length > 0) {
      blocks.push(...boundedListSections("Worth amplifying", amplification));
    }
  }

  blocks.push(
    section(
      `*Totals:* ${String(triage.counts.respondNow)} respond now · ${String(triage.counts.respondLater)} respond later · ${String(triage.counts.noResponse)} no response needed`,
    ),
  );
  return blocks;
}

export function draftApprovalBlocks(
  draft: ReplyDraft,
  approvalKey: string,
): SlackBlock[] {
  return [
    header("Draft reply ready"),
    section(
      [
        `*In reply to:* <${draft.replyURL}|@${slackText(draft.authorUsername)}>`,
        `*Reason:* ${draft.reason}`,
        `*Draft:*\n${boundedText(draft.text, 2800)}`,
      ].join("\n"),
    ),
    actions([
      button({
        text: "Approve",
        style: "primary",
        actionId: APPROVE_ACTION_ID,
        value: approvalKey,
      }),
      button({
        text: "Reject",
        style: "danger",
        actionId: REJECT_ACTION_ID,
        value: approvalKey,
      }),
    ]),
  ];
}

export function draftDecisionBlocks(
  draft: ReplyDraft,
  decision: "approved" | "rejected",
): SlackBlock[] {
  return [
    section(
      [
        decision === "approved"
          ? `*:white_check_mark: Approved reply to* <${draft.replyURL}|@${slackText(draft.authorUsername)}>`
          : `*:x: Rejected reply to* <${draft.replyURL}|@${slackText(draft.authorUsername)}>`,
        boundedText(draft.text, 2800),
      ].join("\n"),
    ),
  ];
}

export function postedResultBlocks(result: PostRepliesResult): SlackBlock[] {
  if (result.posted.length === 0) {
    return [
      section(
        "*No replies posted*\nNothing was approved, or there were no respond-now drafts.",
      ),
    ];
  }
  const lines = result.posted.map(
    (item) =>
      `• <${item.postedURL}|Posted> → <${item.replyURL}|original> · ${item.mode}\n  ${boundedText(item.text, 900)}`,
  );
  return [header("Posted to X"), ...boundedListSections("Replies", lines)];
}

export function createReadyBlocks(result: CreateDraftsResult): SlackBlock[] {
  if (result.drafts.length === 0) {
    return [
      section(
        "*No drafts to approve*\nThere were no respond-now candidates, so nothing will be posted.",
      ),
    ];
  }
  return [
    section(
      `*${String(result.drafts.length)} draft ${plural(result.drafts.length, "reply", "replies")} ready*\nApprove or reject each draft below. Publishing starts after every draft is decided.`,
    ),
  ];
}

export function failedBlocks(message: string): SlackBlock[] {
  return [
    section(`*:x: Reply triage failed*\n${boundedText(message, 2800)}`),
  ];
}

function classificationBlocks(
  title: string,
  entries: ReplyTriageResult["triage"]["classifications"],
): SlackBlock[] {
  const visible = entries.slice(0, 5).map((entry) =>
    [
      `• *<${entry.replyURL}|@${slackText(entry.authorUsername)}>* · ${entry.reason} · ${entry.recommendedOwner}`,
      `  ${boundedText(entry.summary, 800)}`,
      entry.suggestedResponseAngle === undefined
        ? undefined
        : `  _Response angle:_ ${boundedText(entry.suggestedResponseAngle, 700)}`,
    ]
      .filter((value): value is string => value !== undefined)
      .join("\n"),
  );
  if (entries.length > visible.length) {
    visible.push(`• _${String(entries.length - visible.length)} more not shown_`);
  }
  return visible.length === 0 ? [] : boundedListSections(title, visible);
}

function boundedListSections(title: string, entries: string[]): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  let body = "";
  for (const entry of entries) {
    if (body !== "" && body.length + entry.length + 1 > 2850) {
      blocks.push(section(`*${title}*\n${body}`));
      body = "";
    }
    body += `${body === "" ? "" : "\n"}${entry}`;
  }
  if (body !== "") blocks.push(section(`*${title}*\n${body}`));
  return blocks;
}

function evidence(urls: string[]): string {
  return urls.length === 0
    ? ""
    : ` (${urls.map((url, index) => `<${url}|evidence ${String(index + 1)}>`).join(", ")})`;
}

function boundedText(value: string, limit: number): string {
  const escaped = slackText(value);
  return escaped.length <= limit ? escaped : `${escaped.slice(0, limit - 1)}…`;
}

function slackText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
}
