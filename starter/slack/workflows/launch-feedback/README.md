# Slack X reply triage workflow

A small, read-only `@intx/workflow` for marketing teams. Give the Slack app one
full X status URL and it returns the recent replies that need attention,
recurring themes, and positive replies worth amplifying.

```text
Slack X status URL -> collect -> triage -> complete
                       |           |
                       |           `- replies_present_triage
                       `- x_get_post
                          x_get_post_replies
                          replies_return_snapshot
```

There are no drafts, approval buttons, parked runs, or X mutations. The collect
agent can only read X. The triage agent receives the validated collect output,
has no X client, and can only submit an evidence-bound triage result.

## Setup

From the repository root:

```bash
bun install
cd starter/slack/workflows/launch-feedback
cp .env.example .env
```

Import `manifest.slack.json` into Slack, enable Socket Mode, install or reinstall
the app, and invite it to the test channel. Configure the Slack, model, and four
X OAuth credentials in `.env`. X credentials are used only for live reads.

## Run

```bash
cd starter/slack/workflows/launch-feedback
bun run start
```

Expected startup output:

```text
slack-x-reply-triage connected to Slack with Socket Mode
HTTP receiver: not required for Slack events in Socket Mode
X reader=live, mutations=disabled
```

Then mention the app with a full public status URL:

```text
@interchange-reply-triage triage the replies to https://x.com/OpenAI/status/2077446718728425686
```

Use a recent third-party post with substantial replies because X recent search
is limited to approximately the last seven days. The workflow analyzes a
bounded sample of 25 recent replies so the result stays fast and readable;
Slack shows both the sample size and X's source-level reply count. Slack first
posts a started message, then one compact result with coverage, response
priorities, owners, themes, and evidence links.

## Safety and coverage

- IDs and profile URLs fail before any model or X call.
- Both X tools are bound to the canonical trigger post ID.
- The normalized snapshot is built from trusted X responses, not model fields.
- Every collected reply is classified exactly once; counts are derived.
- Every theme and amplification link must come from the collected snapshot.
- Empty recent-search results never claim that the post historically had no replies.
- This package has no X write client or mutation tool.

## Tests and builds

```bash
bun test src
bun test ../../bridge/src

bun build src/cli.ts --target bun --outdir /tmp/reply-triage-build
```

## Local limitation

The in-flight Slack thread reservation is process-local. Restarting the process
forgets active runs, but completed output remains in Slack. The workflow itself
does not park or wait for user action.
