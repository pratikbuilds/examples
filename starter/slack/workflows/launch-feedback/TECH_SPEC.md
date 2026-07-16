# Launch feedback technical specification

## DAG

`src/workflow.ts` defines the runtime graph:

```text
analyze -> draftAction(awaitSignal) -> publishGate
                                      | true  -> publish
                                      ` false -> complete
```

`analyze` selects `trigger.payload`. `publish` selects the approved signal
output. The false branch receives the analysis output and deterministically
completes without instantiating any X write tool.

## Tool boundaries

| Agent | Allowed tools |
| --- | --- |
| `launch-feedback-analyze` | `x_get_post`, `x_get_post_replies`, `launch_present_feedback` |
| `launch-feedback-publish` | `x_create_post` |
| `launch-feedback-complete` | none |

The workflow authorizer also binds each step ID to its expected agent ID. The
analysis sink requires one structured result. The publishing sink requires one
typed receipt. Observer/logging errors cannot change a completed mutation into
a failed workflow result.

## Data and coverage

The trigger stores the canonical X URL, original request, Slack team/channel/
thread, and requester. The X reader performs one post lookup and one recent
conversation search with author expansion. Search results expose pagination
and always carry `source=recent-search`, `days=7`, and `complete=false`.

The analysis tool accepts evidence reply IDs only from the fetched result and
converts them to validated X URLs in the workflow output. It enforces all three
draft strategies and X-compatible text. If recent search returns zero replies,
themes, FAQ, and internal actions must be empty.

## Slack state machine

Each Slack thread owns at most one active session:

```text
analyzing -> awaiting-action -> resuming -> finished
                         `----> expired
```

Each draft has an opaque action token. Editing revokes the old token, validates
the modal text, increments the revision, generates a new token, and updates the
same Slack card without signaling Interchange. Publishing atomically revokes
all tokens before sending a validated `draft-action` signal. Duplicate or stale
button payloads become no-ops. Skipping signals `publish:false` only when no
pending draft remains.

## Exact-text publication

The publish signal is parsed at the Slack boundary and again by the StepInvoker.
The publish environment receives an immutable approval capability. The
`x_create_post` tool normalizes its input and compares it byte-for-byte with the
approved normalized text before consuming the capability. A mismatch is an
error and does not reach the X client.

The publish step has `maxAttempts: 1`. The local StepInvoker also reconciles
duplicate delivery for the same run, draft, and revision to one in-process
execution and receipt. See the README for the crash-window limitation.

## Ownership and write mode

Reads always call X. Publication defaults to dry-run unless `X_DRY_RUN=0`.
Before exposing live Publish buttons, the session resolves `/2/users/me` and
compares it with the source post author ID. A mismatch renders preview-only
cards and cancels the parked run before `x_create_post` can execute.
