# Slack post-to-X workflow

Draft, validate, approve, and optionally publish an X post from a Slack app
mention. Dry-run is the safe default and cannot create a public X post.

The Interchange workflow owns all four stages:

```text
draft -> policy -> approval -> publish
```

- `draft` is the only inference step.
- `policy` deterministically trims and NFC-normalizes the draft, then validates
  it with a 280-character limit.
- `approval` waits for the Slack Approve signal. Reject cancels the run.
- `publish` deterministically passes the exact approved text to the selected
  publisher. It does not run another model turn or accept replacement Slack
  text.

Slack only transports the mention, approval action, and terminal response. The
workflow definition contains no Slack data, credentials, or publisher
functions.

## Setup

From the repository root:

```bash
bun install
cd starter/slack/workflows/post-to-x
cp .env.example .env
```

Fill in the three Slack values and one supported model-provider key. Import
`manifest.slack.json` into Slack, enable Socket Mode, install the app, then run:

```bash
bun run start
```

Mention the app in a channel:

```text
@interchange-social write a concise launch post for our new workflow demo
```

The app posts the policy-approved text and character count. Approve to receive
a receipt in the same thread, or Reject to cancel without publishing.

## Publisher mode

Dry-run is selected unless `X_LIVE=1` and all four OAuth 1.0a values are
non-empty:

```dotenv
X_LIVE=0
X_API_KEY=
X_API_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_TOKEN_SECRET=
```

Missing or incomplete credentials remain dry-run even when `X_LIVE=1`. Startup
prints only `publisher=dry-run` or `publisher=live`; it never logs credential
values.

For live mode, create an X developer app with read and write permission and use
its OAuth 1.0a consumer key/secret and access token/secret. Set `X_LIVE=1` only
for a separately authorized live run. Approval sends the exact normalized text
shown in Slack to `POST /2/tweets`.

Each workflow run permits one live publish attempt. It does not automatically
retry an X request because a timeout or process crash can leave the write
outcome unknown, and X does not provide an idempotency key for this endpoint.
After an uncertain outcome, inspect X before starting a new run.

Socket Mode does not need a public tunnel. Each Slack thread can have one active
run. An approval card is bound to that exact workflow run, Slack team, channel,
and approval-message timestamp. Its opaque button value contains neither the
post text nor the run ID.

Approvals do not expire with time. A button becomes unusable after the first
Approve or Reject click; duplicate, stale, mismatched, and cross-thread actions
cannot signal or cancel another run. Reject cancels the waiting run instead of
creating a second workflow branch.

Pending approvals are process-local and are lost when the worker stops. Restart
the request after a worker restart; durable approval recovery is outside this
example.
