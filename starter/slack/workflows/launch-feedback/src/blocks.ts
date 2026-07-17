import { header, section, type SlackBlock } from "@corbits/example-slack-bridge";

import type { ReplyTriageResult } from "./types";

export function startedBlocks(url: string): SlackBlock[] {
  return [
    section(
      `*Reply triage started*\nReading the post and recent replies for <${url}|this X post>.`,
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
        `*Coverage:* ${String(snapshot.coverage.analyzedReplies)} recent ${plural(snapshot.coverage.analyzedReplies, "reply", "replies")} analyzed · X reports ${String(snapshot.source.metrics.replies)} total ${plural(snapshot.source.metrics.replies, "reply", "replies")}`,
        "*Search window:* X recent search (up to 7 days; historical coverage is not guaranteed)",
        snapshot.coverage.truncated
          ? "*Pagination:* more recent results are available"
          : "*Pagination:* no additional page was returned",
      ].join("\n"),
    ),
    section(`*Overview*\n${boundedText(triage.overview, 2800)}`),
  ];

  if (snapshot.coverage.analyzedReplies === 0) {
    blocks.push(
      section(
        "*:warning: Incomplete coverage*\nNo replies were returned by X recent search. This does not mean the post has never received replies.",
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
