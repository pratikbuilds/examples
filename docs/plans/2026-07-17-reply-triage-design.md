# X Reply Triage Workflow Design

## Problem

The existing launch-feedback workflow asks a marketing team to review a large
brief, edit one of three drafts, approve or skip it, and optionally publish to
X. That combines research, content creation, approval, and publishing into one
workflow. The result is operationally heavy and obscures the simpler marketing
question: which replies need attention, what themes repeat, and what can be
ignored?

## Goal

Replace the current launch-feedback workflow with a small Slack-triggered
Interchange DAG that reads one X post and its recent replies, then returns a
compact, evidence-linked triage brief. It must not create, edit, like, repost,
or publish anything on X.

## User experience

A marketer mentions the Slack app with a full X status URL. Slack immediately
posts a started message in the same thread. When the workflow finishes, Slack
updates that thread with one compact triage result containing:

- recent-search coverage and pagination limits;
- the replies that need a response now or later;
- an explicit reason and recommended owner for every prioritized reply;
- repeated themes with evidence links;
- positive replies worth amplifying; and
- a count of low-signal replies that need no response.

There are no draft cards, edit modals, publish buttons, approval timeouts, or
parked runs.

## Interchange DAG

```text
Slack X status URL
        |
        v
collect
  x.getPost
  x.getPostReplies
  replies.returnSnapshot
        |
        v
triage
  replies.presentTriage
        |
        v
complete
```

The workflow uses a manual trigger and two `step` nodes. It does not use
`awaitSignal` or `gate`.

## Agent and tool boundaries

### Collect agent

The collect agent receives the canonical trigger URL and can call only:

- `x_get_post`
- `x_get_post_replies`
- `replies_return_snapshot`

The final internal tool validates and returns a normalized `ReplySnapshot`.
The collect agent cannot classify replies, present Slack output, or mutate X.

### Triage agent

The triage agent receives only `steps.collect.output` and can call only:

- `replies_present_triage`

It has no X client. The presentation tool validates that every cited URL came
from the collected snapshot and that every priority has a supported reason and
owner.

## Data contracts

```ts
type ReplyTriageTrigger = {
  url: string;
  request: string;
  slack: {
    teamId?: string;
    channel: string;
    threadTs: string;
    requestedBy?: string;
  };
};

type ReplySnapshot = {
  source: {
    url: string;
    postId: string;
    authorUsername: string;
    text: string;
    metrics: {
      replies: number;
      likes: number;
      reposts: number;
      quotes: number;
    };
  };
  coverage: {
    analyzedReplies: number;
    truncated: boolean;
    nextToken?: string;
    searchWindow: "recent-7-days";
  };
  replies: Array<{
    id: string;
    url: string;
    text: string;
    author: {
      username: string;
      followers: number;
      verified: boolean;
    };
    metrics: {
      likes: number;
      replies: number;
      reposts: number;
    };
    directReply: boolean;
  }>;
};

type ReplyTriage = {
  overview: string;
  priorityReplies: Array<{
    priority: "respond-now" | "respond-later" | "no-response";
    reason:
      | "question"
      | "complaint"
      | "purchase-intent"
      | "feature-request"
      | "misinformation"
      | "high-reach-author"
      | "praise"
      | "spam";
    replyUrl: string;
    authorUsername: string;
    summary: string;
    recommendedOwner: "marketing" | "support" | "product";
    suggestedResponseAngle?: string;
  }>;
  themes: Array<{
    label: string;
    count: number;
    sentiment: "positive" | "mixed" | "negative" | "neutral";
    summary: string;
    evidenceUrls: string[];
  }>;
  amplificationOpportunities: Array<{
    replyUrl: string;
    reason: string;
  }>;
  counts: {
    respondNow: number;
    respondLater: number;
    noResponse: number;
  };
};
```

## Validation and coverage

- Only full `x.com` or `twitter.com` status URLs are accepted.
- The trigger URL is canonical and cannot be changed by either model.
- Every triage evidence URL must refer to a reply returned by the collect step.
- Counts must agree with the classified reply entries.
- Recent search is always labeled as bounded to seven days and potentially
  incomplete.
- An empty recent-search result produces an explicit incomplete-coverage
  message and no reply-derived claims.
- A high follower count alone cannot make a reply urgent.

## Slack rendering

The result is one compact message rather than a brief plus three cards. It
shows coverage first, then at most five respond-now items, five respond-later
items, five themes, and five amplification opportunities. Remaining items are
summarized in counts so every Slack block remains within platform limits.

## Error handling

- Invalid URLs fail before workflow execution.
- X authentication, rate-limit, malformed-response, and API errors produce one
  clear Slack failure message.
- Missing or invalid structured output fails the relevant step rather than
  rendering unvalidated prose.
- Slack rendering failure does not cause an X retry because the workflow is
  read-only.

## Testing

Automated tests cover the exact DAG and selectors, tool isolation, canonical
URL binding, snapshot normalization, evidence validation, count consistency,
empty and truncated coverage, X API errors, Block Kit bounds, and Slack adapter
behavior. Existing Slack bridge and Post-to-X tests remain green.

The mandatory live Slack test uses Socket Mode and a third-party post with a
substantial reply set. It verifies the started message, both workflow steps,
one compact triage message, evidence links, coverage text, and absence of X
mutation or interactive publish controls.

## Deliberate exclusions

Version one does not analyze liking users, generate publishable drafts, open an
edit modal, wait for approval, route an urgent branch, or mutate X. Those are
separate workflows or later extensions, not hidden modes of this workflow.
