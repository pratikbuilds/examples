# X Reply Triage Workflow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use @implement to execute this plan task-by-task.

**Goal:** Replace the approval-heavy launch-feedback workflow with a read-only two-step Interchange workflow that collects recent X replies and returns one compact Slack triage brief.

**Architecture:** Keep the existing package and Slack Socket Mode entrypoint, but replace its DAG with `collect -> triage`. The collect agent owns all X reads and returns a validated snapshot; the triage agent has no X client access and returns a validated, evidence-bound marketing triage result. Slack renders only the final triage result and maintains no approval session state.

**Tech Stack:** TypeScript, Bun, `@intx/agent`, `@intx/workflow`, `runLocal`, Slack Bolt bridge, X API v2 with OAuth 1.0a, Block Kit.

---

### Task 1: Replace launch-feedback contracts with reply-triage contracts

**Files:**
- Modify: `starter/slack/workflows/launch-feedback/src/types.ts`
- Modify: `starter/slack/workflows/launch-feedback/src/validation.ts`
- Modify: `starter/slack/workflows/launch-feedback/src/validation.test.ts`

**Step 1: Write failing contract-validation tests**

Add tests proving that triage validation:

```ts
expect(() => validateReplyTriage(snapshot, {
  overview: "Needs attention",
  priorityReplies: [{
    priority: "respond-now",
    reason: "question",
    replyUrl: unknownReplyURL,
    authorUsername: "someone",
    summary: "Question",
    recommendedOwner: "marketing",
  }],
  themes: [],
  amplificationOpportunities: [],
  counts: { respondNow: 1, respondLater: 0, noResponse: 0 },
})).toThrow("evidence");
```

Also cover count mismatches, unsupported reasons/owners, follower-count-only urgency, empty recent-search claims, and canonical URL parsing.

**Step 2: Run the focused test and verify failure**

Run:

```bash
bun test starter/slack/workflows/launch-feedback/src/validation.test.ts
```

Expected: FAIL because the reply-triage contracts and validator do not exist.

**Step 3: Implement minimal contracts and validators**

Replace draft, signal, receipt, and launch-feedback types with:

```ts
export type ReplyTriageTrigger = { /* approved design fields */ };
export type ReplySnapshot = { /* source, coverage, replies */ };
export type ReplyTriage = { /* priorities, themes, amplification, counts */ };
```

Keep `XPost`, `XUser`, and reply collection primitives needed by the reader. Implement strict record/array/enum parsing and evidence membership checks.

**Step 4: Run the focused test and verify pass**

Expected: all validation tests pass.

**Step 5: Commit**

```bash
git add starter/slack/workflows/launch-feedback/src/types.ts \
  starter/slack/workflows/launch-feedback/src/validation.ts \
  starter/slack/workflows/launch-feedback/src/validation.test.ts
git commit -m "Replace launch feedback contracts with reply triage"
```

### Task 2: Make the X client read-only

**Files:**
- Modify: `starter/slack/workflows/launch-feedback/src/x-client.ts`
- Modify: `starter/slack/workflows/launch-feedback/src/x-client.test.ts`

**Step 1: Write failing read-only client tests**

Assert that the exported client exposes only `getPost` and `getPostReplies`, normalizes reply author metrics, preserves pagination, and never defines `createPost`.

**Step 2: Run the focused test and verify failure**

```bash
bun test starter/slack/workflows/launch-feedback/src/x-client.test.ts
```

**Step 3: Remove write-mode behavior**

Delete `createPost`, post receipts, dry-run/live mode resolution, and publish-only response parsing. Keep OAuth signing, credential resolution, post lookup, recent conversation search, author expansion, pagination, and API error handling.

**Step 4: Run the focused test and verify pass**

**Step 5: Commit**

```bash
git add starter/slack/workflows/launch-feedback/src/x-client.ts \
  starter/slack/workflows/launch-feedback/src/x-client.test.ts
git commit -m "Make reply triage X client read only"
```

### Task 3: Split collection and triage tools

**Files:**
- Modify: `starter/slack/workflows/launch-feedback/src/x-tools.ts`
- Modify: `starter/slack/workflows/launch-feedback/src/x-tools.test.ts`

**Step 1: Write failing tool-boundary tests**

Cover:

- collect tools expose `x_get_post`, `x_get_post_replies`, and `replies_return_snapshot`;
- triage tools expose only `replies_present_triage`;
- reply lookup cannot run before the source lookup;
- the trigger URL is immutable;
- snapshot output may be submitted exactly once;
- triage evidence must belong to the snapshot; and
- neither tool set exposes X mutation.

**Step 2: Run the focused test and verify failure**

```bash
bun test starter/slack/workflows/launch-feedback/src/x-tools.test.ts
```

**Step 3: Implement collection state and tools**

Use a per-step state object:

```ts
type CollectState = {
  expectedURL: string;
  source?: XPost;
  replies?: XReplyCollection;
};
```

`replies_return_snapshot` builds the normalized snapshot from state rather than trusting model-provided source data.

**Step 4: Implement the triage presentation tool**

The tool accepts model classification fields, validates them against the input snapshot, calls a single output sink, and returns `Reply triage accepted`.

**Step 5: Run the focused test and verify pass**

**Step 6: Commit**

```bash
git add starter/slack/workflows/launch-feedback/src/x-tools.ts \
  starter/slack/workflows/launch-feedback/src/x-tools.test.ts
git commit -m "Add collection and triage tool boundaries"
```

### Task 4: Replace the workflow DAG and step invoker

**Files:**
- Modify: `starter/slack/workflows/launch-feedback/src/workflow.ts`
- Modify: `starter/slack/workflows/launch-feedback/src/workflow.test.ts`
- Modify: `starter/slack/workflows/launch-feedback/src/invoke-step.ts`
- Modify: `starter/slack/workflows/launch-feedback/src/invoke-step.test.ts`

**Step 1: Write failing DAG tests**

Assert the exact graph:

```ts
expect(definition.steps.collect.input).toEqual({ from: "trigger.payload" });
expect(definition.steps.triage.after).toEqual(["collect"]);
expect(definition.steps.triage.input).toEqual({ from: "steps.collect.output" });
```

Assert there are exactly two steps and no signal, gate, publish, or complete agent.

**Step 2: Run workflow and invoker tests and verify failure**

```bash
bun test starter/slack/workflows/launch-feedback/src/workflow.test.ts \
  starter/slack/workflows/launch-feedback/src/invoke-step.test.ts
```

**Step 3: Define focused agents**

```ts
return defineWorkflow({
  id: "slack-x-reply-triage",
  trigger: { type: "manual" },
  steps: {
    collect: step({
      agent: collectAgent,
      input: { from: "trigger.payload" },
    }),
    triage: step({
      agent: triageAgent,
      after: ["collect"],
      input: { from: "steps.collect.output" },
    }),
  },
});
```

**Step 4: Simplify the invoker**

Remove approved-draft capabilities, receipt reconciliation, publish dedupe, complete-step special cases, and signal parsing. Provide collect state and snapshot sink only to the collect agent; provide the validated snapshot and triage sink only to the triage agent. Authorize tools and workflow steps by exact agent/step ID.

**Step 5: Run tests and verify pass**

**Step 6: Commit**

```bash
git add starter/slack/workflows/launch-feedback/src/workflow.ts \
  starter/slack/workflows/launch-feedback/src/workflow.test.ts \
  starter/slack/workflows/launch-feedback/src/invoke-step.ts \
  starter/slack/workflows/launch-feedback/src/invoke-step.test.ts
git commit -m "Replace launch workflow with collect and triage DAG"
```

### Task 5: Replace Slack session state and Block Kit output

**Files:**
- Modify: `starter/slack/workflows/launch-feedback/src/session.ts`
- Modify: `starter/slack/workflows/launch-feedback/src/session.test.ts`
- Modify: `starter/slack/workflows/launch-feedback/src/blocks.ts`
- Modify: `starter/slack/workflows/launch-feedback/src/adapter.ts`

**Step 1: Write failing Slack behavior tests**

Cover URL rejection before `runLocal`, one started reply, one final triage message, respond-now/respond-later/theme/amplification sections, coverage warnings, Block Kit limits, concurrent duplicate starts, and failure rendering. Assert there are no buttons, modals, session expiry timers, or workflow signals.

**Step 2: Run focused tests and verify failure**

```bash
bun test starter/slack/workflows/launch-feedback/src/session.test.ts
```

**Step 3: Implement stateless run lifecycle**

Keep only a small in-flight thread reservation to avoid duplicate concurrent starts. Start `runLocal`, render collect progress only in logs, render the final triage result when `triage` completes, and release the reservation on completion or failure.

**Step 4: Implement compact bounded blocks**

Render coverage first, then cap visible respond-now, respond-later, themes, and amplification lists at five items each. Show overflow in counts. Every item with a claim includes an X evidence link.

**Step 5: Run focused tests and verify pass**

**Step 6: Commit**

```bash
git add starter/slack/workflows/launch-feedback/src/session.ts \
  starter/slack/workflows/launch-feedback/src/session.test.ts \
  starter/slack/workflows/launch-feedback/src/blocks.ts \
  starter/slack/workflows/launch-feedback/src/adapter.ts
git commit -m "Simplify Slack launch workflow to reply triage"
```

### Task 6: Remove publish configuration and update package documentation

**Files:**
- Modify: `starter/slack/workflows/launch-feedback/src/config.ts`
- Modify: `starter/slack/workflows/launch-feedback/src/cli.ts`
- Modify: `starter/slack/workflows/launch-feedback/src/index.ts`
- Modify: `starter/slack/workflows/launch-feedback/.env.example`
- Modify: `starter/slack/workflows/launch-feedback/manifest.slack.json`
- Modify: `starter/slack/workflows/launch-feedback/README.md`
- Modify: `starter/slack/workflows/launch-feedback/TECH_SPEC.md`
- Modify: `starter/slack/workflows/launch-feedback/package.json`

**Step 1: Remove write-only configuration**

Delete dry-run/write-mode startup reporting, approval timeout, and X publishing descriptions. Keep Slack, model, and X read credentials.

**Step 2: Update naming and startup output**

Use `slack-x-reply-triage` for workflow/runtime IDs while retaining the existing package directory. Startup should clearly report `X reader=live, mutations=disabled`.

**Step 3: Document the two-step workflow and manual test**

Include one copy-paste Socket Mode command and one high-reply third-party X URL example. State that the workflow never mutates X.

**Step 4: Run package tests**

```bash
bun test starter/slack/workflows/launch-feedback/src
```

Expected: all package tests pass.

**Step 5: Commit**

```bash
git add starter/slack/workflows/launch-feedback
git commit -m "Document the Slack X reply triage workflow"
```

### Task 7: Regression builds and live Slack validation

**Files:**
- Evidence only: `tmp/reply-triage-evidence/`

**Step 1: Run all required automated suites**

```bash
bun test starter/slack/workflows/launch-feedback/src
bun test starter/slack/bridge/src
bun test starter/slack/workflows/post-to-x/src
```

Expected: all pass.

**Step 2: Build both workflow entrypoints**

```bash
bun build starter/slack/workflows/launch-feedback/src/cli.ts \
  --target bun --outdir /tmp/reply-triage-build
bun build starter/slack/workflows/post-to-x/src/cli.ts \
  --target bun --outdir /tmp/post-to-x-build
```

Expected: both build successfully.

**Step 3: Start Socket Mode with real X reads**

```bash
cd starter/slack/workflows/launch-feedback
bun run start
```

Expected startup evidence:

```text
slack-x-reply-triage connected to Slack with Socket Mode
HTTP receiver: not required for Slack events in Socket Mode
X reader=live, mutations=disabled
```

**Step 4: Exercise a real high-reply post**

Send a third-party X status URL in Slack. Verify visibly:

- started message appears in the same thread;
- terminal logs `collect` then `triage`;
- one X post lookup and one successful recent conversation search occur;
- one compact final triage message appears;
- prioritized replies include reasons, owners, and evidence links;
- coverage and pagination limitations are visible;
- no draft cards, buttons, modal, signal, or X mutation occur.

**Step 5: Exercise invalid and empty-coverage cases**

Verify raw IDs/profile URLs fail before workflow execution and an old post does not claim historical completeness.

**Step 6: Capture evidence and final review**

Save terminal logs, screenshots, Slack links, test/build output, and a final code review. Fix any actionable findings and rerun affected tests.
