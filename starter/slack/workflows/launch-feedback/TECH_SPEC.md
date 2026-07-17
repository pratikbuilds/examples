# X reply triage technical specification

## Interchange DAG

```text
trigger.payload -> collect -> triage -> create -> approval -> post -> complete
```

`approval` is an `awaitSignal("approve")`. `post` resumes only after Slack
delivers that signal with the approved draft payload.

## Agent isolation

| Agent | Tools | Capability |
| --- | --- | --- |
| `x-reply-collect` | `x_get_post`, `x_get_post_replies`, `replies_return_candidates` | X read + candidate selection |
| `x-reply-triage` | `replies_present_triage` | Classify question / complaint / feature-request |
| `x-reply-create` | `replies_present_drafts` | Draft one reply per respond-now |
| `x-reply-post` | `replies_publish_approved` | X write after Slack approval |

## Candidate path

Collect fetches a bounded recent-reply sample, then returns only selected reply
ids as the trusted candidate snapshot (`fetchedReplies` vs `analyzedReplies`).
Triage classifies every candidate. Create drafts only for `respond-now`.
Slack Approve/Reject settles each draft; when all are decided the session signals
`approve` with `{ approved: ReplyDraft[] }`. Post publishes only that set.

Set `X_DRY_RUN=1` to skip live X writes.
