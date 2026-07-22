# Slack post-to-X workflow

Draft, validate, and approve an X post from a Slack app mention. Phase 1 is
network-free: approval produces a clearly labeled dry-run receipt and cannot
create a public X post.

The Interchange workflow owns all four stages:

```text
draft -> policy -> approval -> publish
```

- `draft` is the only inference step.
- `policy` deterministically trims and NFC-normalizes the draft, then validates
  it with X's weighted-character rules and a 280-character limit.
- `approval` waits for the Slack Approve signal. Reject cancels the run.
- `publish` deterministically passes the exact approved text to the injected
  dry-run publisher.

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

The app posts the policy-approved text and weighted length. Approve to receive
a dry-run receipt in the same thread, or Reject to cancel without publishing.
`X_LIVE=0` documents the safe mode; this version never resolves X credentials or
makes an X network request.

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
