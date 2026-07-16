import { describe, expect, test } from "bun:test";

import type {
  SlackBlockAction,
  SlackPostMessage,
  SlackUpdateMessage,
} from "@corbits/example-slack-bridge";
import type { WorkflowRun } from "@intx/workflow";

import {
  DRAFT_EDIT_CALLBACK_ID,
  DRAFT_PUBLISH_ACTION_ID,
  DRAFT_SKIP_ACTION_ID,
  feedbackBriefBlocks,
} from "./blocks";
import type { LaunchFeedbackConfig } from "./config";
import {
  createLaunchFeedbackSessions,
  extractXStatusURL,
  type StartWorkflow,
} from "./session";
import type { LaunchFeedback, PostReceipt } from "./types";

const feedback = {
  source: {
    postId: "123",
    url: "https://x.com/builder/status/123",
    text: "We shipped",
    authorId: "owner",
    authorUsername: "builder",
  },
  coverage: {
    analyzedReplies: 1,
    truncated: false,
    searchWindow: "recent-7-days",
  },
  summary: "People want export support.",
  themes: [
    {
      label: "Exports",
      sentiment: "neutral",
      summary: "Users asked about exports.",
      evidenceUrls: ["https://x.com/user/status/124"],
    },
  ],
  faq: [
    {
      question: "Can it export?",
      suggestedAnswer: "Exports are planned.",
      evidenceUrls: ["https://x.com/user/status/124"],
    },
  ],
  actions: [
    {
      priority: "high",
      owner: "product",
      action: "Clarify exports.",
      evidenceUrls: ["https://x.com/user/status/124"],
    },
  ],
  drafts: [
    { strategy: "concise-recap", title: "Recap", text: "Draft one" },
    { strategy: "what-we-heard", title: "What we heard", text: "Draft two" },
    { strategy: "next-steps", title: "Next steps", text: "Draft three" },
  ],
} satisfies LaunchFeedback;

describe("launch feedback Slack sessions", () => {
  test("rejects raw ids and profile URLs before starting a workflow", async () => {
    const harness = createHarness();
    await harness.sessions.start(startInput("analyze 1234567890"));
    await harness.sessions.start(startInput("analyze https://x.com/example"));

    expect(harness.starts).toHaveLength(0);
    expect(harness.messages).toHaveLength(2);
    expect(harness.messages.every((message) => message.text.includes("full X status URL"))).toBe(true);
  });

  test("renders one brief and exactly three actionable draft cards", async () => {
    const harness = createHarness();
    await harness.sessions.start(startInput());
    harness.onStepDone("analyze", feedback);
    await settle();

    expect(harness.starts[0]?.triggerPayload.url).toBe(feedback.source.url);
    expect(harness.messages).toHaveLength(5);
    expect(harness.messages[1]?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "header" }),
      ]),
    );
    expect(
      harness.messages.slice(2).map((message) =>
        findAction(message.blocks, DRAFT_PUBLISH_ACTION_ID),
      ),
    ).toEqual([expect.any(String), expect.any(String), expect.any(String)]);
    expect(harness.signals).toHaveLength(0);
  });

  test("atomically reserves a thread during concurrent starts", async () => {
    const harness = createHarness({ sendDelayMs: 5 });
    await Promise.all([
      harness.sessions.start(startInput()),
      harness.sessions.start(startInput()),
    ]);

    expect(harness.starts).toHaveLength(1);
    expect(harness.messages).toHaveLength(2);
    expect(
      harness.messages.some((message) =>
        message.text.includes("already active"),
      ),
    ).toBe(true);
  });

  test("edits a draft in a modal and publishes the exact new revision once", async () => {
    const harness = createHarness();
    await harness.sessions.start(startInput());
    harness.onStepDone("analyze", feedback);
    await settle();
    const draftMessage = harness.messages[3]!;
    const originalToken = findAction(
      draftMessage.blocks,
      "launch-feedback.draft.edit",
    )!;

    await harness.sessions.edit(action(originalToken, draftMessage.ts!, {
      triggerId: "trigger-1",
    }));
    expect(harness.modals).toHaveLength(1);
    expect(JSON.stringify(harness.modals[0])).toContain("Draft two");

    const submission = harness.sessions.submitEdit({
      callbackId: DRAFT_EDIT_CALLBACK_ID,
      privateMetadata: originalToken,
      teamId: "T1",
      userId: "U2",
      state: {},
      textValues: { "draft.text": "Edited approved text" },
    });
    expect(submission.errors).toBeUndefined();
    await submission.afterAck?.();
    const updated = harness.updates.at(-1)!;
    expect(JSON.stringify(updated.blocks)).toContain("*Revision:* 2");
    expect(JSON.stringify(updated.blocks)).toContain("Edited approved text");
    const publishToken = findAction(updated.blocks, DRAFT_PUBLISH_ACTION_ID)!;

    await harness.sessions.publish(action(publishToken, draftMessage.ts!));
    await harness.sessions.publish(action(publishToken, draftMessage.ts!));

    expect(harness.signals).toHaveLength(1);
    expect(harness.signals[0]).toMatchObject({
      name: "draft-action",
      payload: {
        publish: true,
        revision: 2,
        text: "Edited approved text",
        approvedBy: "U1",
      },
    });

    const receipt: PostReceipt = {
      mode: "dry-run",
      postId: "dryrun-1",
      url: "https://x.com/i/web/status/dryrun-1",
      text: "Edited approved text",
      postedAt: "2026-07-16T00:00:00.000Z",
    };
    harness.finish({ publish: receipt });
    await settle();
    expect(JSON.stringify(harness.updates.at(-1)?.blocks)).toContain(
      "Dry-run publication approved",
    );
  });

  test("returns inline modal errors without changing the card", async () => {
    const harness = createHarness();
    await harness.sessions.start(startInput());
    harness.onStepDone("analyze", feedback);
    await settle();
    const draftMessage = harness.messages[2]!;
    const token = findAction(
      draftMessage.blocks,
      "launch-feedback.draft.edit",
    )!;
    const result = harness.sessions.submitEdit({
      callbackId: DRAFT_EDIT_CALLBACK_ID,
      privateMetadata: token,
      teamId: "T1",
      userId: "U1",
      state: {},
      textValues: { "draft.text": "x".repeat(400) },
    });

    expect(result.errors?.draft).toContain("280");
    expect(result.afterAck).toBeUndefined();
    expect(harness.updates).toHaveLength(0);
  });

  test("signals publish false only after all three drafts are skipped", async () => {
    const harness = createHarness();
    await harness.sessions.start(startInput());
    harness.onStepDone("analyze", feedback);
    await settle();
    for (const message of harness.messages.slice(2)) {
      const token = findAction(message.blocks, DRAFT_SKIP_ACTION_ID)!;
      await harness.sessions.skip(action(token, message.ts!));
    }

    expect(harness.signals).toEqual([
      {
        name: "draft-action",
        payload: { publish: false, reason: "all-drafts-skipped" },
      },
    ]);
    harness.finish({ complete: { status: "completed-without-publishing" } });
    await settle();
    expect(harness.messages.at(-1)?.text).toBe(
      "Review completed without publishing.",
    );
  });

  test("signals approval even when Slack card updates fail", async () => {
    const harness = createHarness({ failUpdates: true });
    await harness.sessions.start(startInput());
    harness.onStepDone("analyze", feedback);
    await settle();
    const draftMessage = harness.messages[2]!;
    const token = findAction(
      draftMessage.blocks,
      DRAFT_PUBLISH_ACTION_ID,
    )!;

    await harness.sessions.publish(action(token, draftMessage.ts!));
    expect(harness.signals).toHaveLength(1);
    expect(harness.signals[0]?.payload).toMatchObject({ publish: true });
  });

  test("expires cards, cancels the parked run, and ignores stale actions", async () => {
    const harness = createHarness({ approvalTimeoutMs: 5 });
    await harness.sessions.start(startInput());
    harness.onStepDone("analyze", feedback);
    await settle();
    const draftMessage = harness.messages[2]!;
    const token = findAction(draftMessage.blocks, DRAFT_PUBLISH_ACTION_ID)!;
    await Bun.sleep(15);

    expect(harness.cancellations).toEqual([
      {
        origin: "supervisor-operator",
        reason: "Slack draft actions expired",
      },
    ]);
    await harness.sessions.publish(action(token, draftMessage.ts!));
    expect(harness.signals).toHaveLength(0);
    expect(JSON.stringify(harness.updates)).toContain("Expired");
  });

  test("makes non-owned live posts preview-only and cancels before publish", async () => {
    const harness = createHarness({ writeMode: "live", authenticatedId: "other" });
    await harness.sessions.start(startInput());
    harness.onStepDone("analyze", feedback);
    await settle();

    expect(harness.cancellations[0]?.reason).toContain("does not own");
    expect(JSON.stringify(harness.messages.slice(2))).toContain("Preview only");
    expect(JSON.stringify(harness.messages.slice(2))).not.toContain(
      DRAFT_PUBLISH_ACTION_ID,
    );
    expect(harness.signals).toHaveLength(0);
  });
});

describe("feedback Block Kit bounds", () => {
  test("keeps every dynamic section within Slack limits", () => {
    const long = "<&>".repeat(2000);
    const oversized: LaunchFeedback = {
      ...feedback,
      summary: long,
      themes: Array.from({ length: 8 }, (_, index) => ({
        label: `Theme ${String(index)}`,
        sentiment: "mixed" as const,
        summary: long,
        evidenceUrls: ["https://x.com/user/status/124"],
      })),
      faq: Array.from({ length: 8 }, (_, index) => ({
        question: `Question ${String(index)}`,
        suggestedAnswer: long,
        evidenceUrls: ["https://x.com/user/status/124"],
      })),
      actions: Array.from({ length: 8 }, (_, index) => ({
        priority: "medium" as const,
        owner: "product" as const,
        action: `${String(index)} ${long}`,
        evidenceUrls: ["https://x.com/user/status/124"],
      })),
    };
    const blocks = feedbackBriefBlocks(oversized);
    const sectionLengths = blocks.flatMap((block) => {
      if (block.type !== "section") return [];
      const value = "text" in block ? block.text?.text : undefined;
      return typeof value === "string" ? [value.length] : [];
    });

    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(Math.max(...sectionLengths)).toBeLessThanOrEqual(3000);
  });
});

describe("extractXStatusURL", () => {
  test("extracts and canonicalizes a Slack-formatted status URL", () => {
    expect(
      extractXStatusURL(
        "analyze <https://twitter.com/builder/status/123|twitter.com/builder/status/123>",
      ),
    ).toBe("https://x.com/builder/status/123");
  });
});

function createHarness(options: {
  approvalTimeoutMs?: number;
  writeMode?: "live" | "dry-run";
  authenticatedId?: string;
  sendDelayMs?: number;
  failUpdates?: boolean;
} = {}) {
  const messages: Array<SlackPostMessage & { ts?: string }> = [];
  const updates: SlackUpdateMessage[] = [];
  const modals: unknown[] = [];
  const signals: Array<{ name: string; payload: unknown }> = [];
  const cancellations: Array<{ origin: string; reason: string }> = [];
  const starts: Parameters<StartWorkflow>[0][] = [];
  let onStepDone: Parameters<StartWorkflow>[0]["onStepDone"] = () => undefined;
  const complete = deferred<Awaited<WorkflowRun["complete"]>>();
  const run: WorkflowRun = {
    runId: "run-1",
    complete: complete.promise,
    async signal(name, payload) {
      signals.push({ name, payload });
    },
    async cancel(origin, reason) {
      cancellations.push({ origin, reason });
    },
  };
  const config = {
    port: 3001,
    signingSecret: "secret",
    botToken: "xoxb-test",
    source: {
      id: "openai:test",
      provider: "openai",
      baseURL: "https://api.openai.com/v1",
      apiKey: "test",
      model: "test",
    },
    contextRoot: "/tmp/launch-feedback-test",
    approvalTimeoutMs: options.approvalTimeoutMs ?? 60_000,
    xClient: {
      writeMode: options.writeMode ?? "dry-run",
      getMe: async () => ({
        id: options.authenticatedId ?? "owner",
        name: "User",
        username: "user",
      }),
      getPost: async () => ({
        id: feedback.source.postId,
        url: feedback.source.url,
        text: feedback.source.text,
        authorId: feedback.source.authorId,
        author: {
          id: feedback.source.authorId,
          name: "Builder",
          username: feedback.source.authorUsername,
        },
        directReply: false,
      }),
      getPostReplies: async () => ({
        sourcePostId: "123",
        replies: [],
        analyzedReplies: 0,
        truncated: false,
        coverage: { source: "recent-search", days: 7, complete: false },
      }),
      createPost: async () => {
        throw new Error("not used");
      },
    },
  } satisfies LaunchFeedbackConfig;
  const sessions = createLaunchFeedbackSessions({
    config,
    stderr: () => undefined,
    startWorkflow(input) {
      starts.push(input);
      onStepDone = input.onStepDone;
      return run;
    },
    async sendMessage(_token, message) {
      if (options.sendDelayMs !== undefined) {
        await Bun.sleep(options.sendDelayMs);
      }
      const ts = `m${String(messages.length + 1)}`;
      messages.push({ ...message, ts });
      return { channel: message.channel, ts };
    },
    async updateMessage(_token, message) {
      updates.push(message);
      if (options.failUpdates === true) {
        throw new Error("Slack update unavailable");
      }
      return { channel: message.channel, ts: message.ts };
    },
    async openModal(_token, input) {
      modals.push(input.view);
    },
  });

  return {
    sessions,
    messages,
    updates,
    modals,
    signals,
    cancellations,
    starts,
    get onStepDone() {
      return onStepDone;
    },
    finish(outputs: Record<string, unknown>) {
      complete.resolve({
        runId: "run-1",
        terminalStatus: "completed",
        outputs,
        events: [],
      });
    },
  };
}

function startInput(prompt = "analyze https://x.com/builder/status/123") {
  return {
    teamId: "T1",
    channel: "C1",
    threadTs: "100.1",
    prompt,
    userId: "U1",
  };
}

function action(
  value: string,
  messageTs: string,
  overrides: Partial<SlackBlockAction> = {},
) {
  return {
    actionId: "test",
    value,
    teamId: "T1",
    userId: "U1",
    channelId: "C1",
    messageTs,
    ...overrides,
  };
}

function findAction(blocks: unknown, actionId: string): string | undefined {
  if (!Array.isArray(blocks)) return undefined;
  for (const block of blocks) {
    if (block === null || typeof block !== "object") continue;
    const elements = (block as { elements?: unknown }).elements;
    if (!Array.isArray(elements)) continue;
    for (const element of elements) {
      if (
        element !== null &&
        typeof element === "object" &&
        (element as { action_id?: unknown }).action_id === actionId
      ) {
        return (element as { value?: string }).value;
      }
    }
  }
  return undefined;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await Bun.sleep(0);
  await Bun.sleep(0);
}
