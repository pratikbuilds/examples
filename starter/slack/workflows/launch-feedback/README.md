# Slack launch feedback workflow

A real `@intx/workflow` that turns one X launch-post URL into a recent-reply
brief, three follow-up drafts, and a Slack-controlled optional publication.

```text
Slack URL -> analyze -> awaitSignal("draft-action") -> gate
                                                    |-> publish -> x_create_post
                                                    `-> complete without posting
```

The analysis agent has `x_get_post`, `x_get_post_replies`, and
`launch_present_feedback`. It cannot call `x_create_post`. The publishing agent
is instantiated only after a Slack Publish action resumes the workflow, and it
receives only `x_create_post`.

## Setup

From the repository root:

```bash
bun install
cd starter/slack/workflows/launch-feedback
cp .env.example .env
```

Import `manifest.slack.json` into Slack, enable Socket Mode and interactivity,
install or reinstall the app, and invite it to the test channel. Configure all
four X credentials because post and reply reads are live even when publication
is dry-run.

## Run safely

```bash
X_DRY_RUN=1 bun run start
```

Expected startup output includes:

```text
slack-launch-feedback connected to Slack with Socket Mode
HTTP receiver: not required for Slack events in Socket Mode
X reader=live, publisher=dry-run
```

Then send a full status URL:

```text
@interchange-launch-feedback analyze the replies to https://x.com/user/status/123
```

Slack renders the coverage limitation, brief, evidence links, and exactly three
draft cards. Edit updates only local draft state and increments its revision.
Skip signals the workflow only after all three cards are skipped. Publish sends
the selected text and revision through `draft-action`; the create tool rejects
any model-modified text.

## Safety properties

- URL-only input: IDs and profile URLs fail before model or X calls.
- Recent-search coverage is always labeled as incomplete and limited to seven
  days; an empty result never claims that no replies exist historically.
- Action values are opaque, one-shot tokens bound to Slack team, channel, and
  message timestamp.
- Publish-step delivery is deduplicated in the local process by workflow run,
  draft ID, and revision.
- `X_DRY_RUN` defaults to safe mode; only the exact value `0` enables writes.
- Live publication is disabled when the authenticated X account does not own
  the source post.
- Pending cards expire and cancel the parked local workflow.

## Tests and builds

```bash
bun test src
bun test ../../bridge/src
bun test ../post-to-x/src

bun build src/cli.ts --target bun --outdir /tmp/launch-feedback-build
bun build ../post-to-x/src/cli.ts --target bun --outdir /tmp/post-to-x-build
```

## Local limitation

The Slack session registry, pending signal, and publish-delivery deduplication
are process-local. Restarting the process loses pending approvals. X does not
provide an idempotency key for create-post requests, so a crash after X accepts
a post but before the receipt is stored cannot be made exactly-once by this
local example. A hosted version needs durable session and receipt storage plus
operator reconciliation.
