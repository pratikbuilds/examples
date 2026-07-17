# X reply triage technical specification

## Interchange DAG

`src/workflow.ts` defines one manual trigger and exactly two `step` nodes:

```text
trigger.payload -> collect -> triage -> complete
                            steps.collect.output
```

`collect` selects `trigger.payload`. `triage` runs after `collect` and selects
`steps.collect.output`. The graph contains no `awaitSignal`, `gate`, publish
branch, or completion agent.

## Agent and environment isolation

| Agent | Tools | Environment capability |
| --- | --- | --- |
| `x-reply-collect` | `x_get_post`, `x_get_post_replies`, `replies_return_snapshot` | X read client and per-run collection state |
| `x-reply-triage` | `replies_present_triage` | Trusted snapshot and one structured-result sink |

The workflow authorizer allows only `collect` and `triage`. Each step ID is
bound to its expected agent ID. The triage environment contains no X client.
Neither agent has access to an X mutation definition.

## Trusted data path

The Slack boundary canonicalizes the full X status URL before creating the
trigger. The collect tools require that same post ID for both reads. The post
lookup must finish before the recent conversation search can run. Collection
defaults to 25 recent replies; pagination and the source post's total reply
metric remain visible so the sample is never presented as exhaustive.

`replies_return_snapshot` builds `ReplySnapshot` from the two X client results.
It validates the source post, expanded authors, public metrics, conversation
membership, unique reply IDs and URLs, analyzed count, and pagination state.
The model cannot provide or replace snapshot fields.

The invoker marks only that exact collect output as trusted. The triage step
must receive the same object through `steps.collect.output`; arbitrary or
reconstructed snapshots are rejected.

## Triage validation

`replies_present_triage` requires one classification for every collected reply
and accepts only known reply IDs. It converts those IDs to trusted evidence URLs.
Priority totals are derived from classifications rather than model input.
Themes and amplification opportunities cannot cite replies outside the snapshot.
A high-reach author alone cannot justify `respond-now`.

If recent search returns zero replies, classification, theme, and amplification
arrays must be empty. The validator supplies a fixed overview explaining that
recent-search coverage does not establish historical absence.

## Slack lifecycle

Each Slack thread has at most one in-flight run. The session reserves the thread
before posting the started message, runs the DAG, posts one final result or one
failure, and releases the reservation in every terminal path. There are no
actions, modals, message updates, approval timers, workflow signals, or draft
state.

The final Block Kit message shows coverage first, then at most five respond-now
items, respond-later items, themes, and amplification opportunities per section.
Each visible reply claim links directly to X. Totals preserve the complete
classification counts when the visible lists are capped.

## X API boundary

The package signs OAuth 1.0a GET requests for one post lookup and recent-search
pagination with author expansion. Its public X client surface is read-only:
`getPost` and `getPostReplies`. API, authentication, rate-limit, and malformed
response failures terminate the run and produce one Slack failure message.
