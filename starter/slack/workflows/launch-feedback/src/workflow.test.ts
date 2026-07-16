import { describe, expect, test } from "bun:test";

import { runLocal, type StepInvoker } from "@intx/workflow";

import type { LaunchFeedback, PostReceipt } from "./types";
import {
  ANALYZE_AGENT_ID,
  COMPLETE_AGENT_ID,
  DRAFT_ACTION_SIGNAL,
  PUBLISH_AGENT_ID,
  defineLaunchFeedbackWorkflow,
} from "./workflow";

const source = {
  id: "openai:test",
  provider: "openai",
  baseURL: "https://api.openai.com/v1",
  apiKey: "test",
  model: "test",
};

const feedback = {
  source: {
    postId: "123",
    url: "https://x.com/builder/status/123",
    text: "We shipped",
    authorId: "u1",
    authorUsername: "builder",
  },
  coverage: {
    analyzedReplies: 0,
    truncated: false,
    searchWindow: "recent-7-days",
  },
  summary: "No replies yet",
  themes: [],
  faq: [],
  actions: [],
  drafts: [
    { strategy: "concise-recap", title: "One", text: "One" },
    { strategy: "what-we-heard", title: "Two", text: "Two" },
    { strategy: "next-steps", title: "Three", text: "Three" },
  ],
} satisfies LaunchFeedback;

const receipt: PostReceipt = {
  mode: "dry-run",
  postId: "p1",
  url: "https://x.com/i/web/status/p1",
  text: "One",
  postedAt: "2026-07-16T00:00:00.000Z",
};

describe("launch feedback workflow definition", () => {
  test("defines analyze -> signal -> gate -> publish or complete", () => {
    const definition = defineLaunchFeedbackWorkflow(source);

    expect(definition.steps.analyze?.kind).toBe("step");
    expect(definition.steps.draftAction).toMatchObject({
      kind: "awaitSignal",
      name: DRAFT_ACTION_SIGNAL,
      after: ["analyze"],
    });
    expect(definition.steps.publishGate).toMatchObject({
      kind: "gate",
      after: ["draftAction"],
      then: "publish",
      else: "complete",
    });
    expect(definition.steps.publish).toMatchObject({
      kind: "step",
      after: ["publishGate"],
      retry: { maxAttempts: 1, initialBackoffMs: 0 },
    });
  });

  test("keeps createPost out of the analysis agent", () => {
    const definition = defineLaunchFeedbackWorkflow(source);
    const analyze = definition.steps.analyze;
    const publish = definition.steps.publish;
    if (analyze?.kind !== "step" || publish?.kind !== "step") {
      throw new Error("expected agent steps");
    }

    expect(analyze.agent.id).toBe(ANALYZE_AGENT_ID);
    expect(analyze.agent.toolFactories.map((factory) => factory.id)).toEqual([
      "@corbits/example-launch-feedback/analyze-x",
    ]);
    expect(publish.agent.id).toBe(PUBLISH_AGENT_ID);
    expect(publish.agent.toolFactories.map((factory) => factory.id)).toEqual([
      "@corbits/example-launch-feedback/create-post",
    ]);
  });
});

describe("launch feedback workflow routing", () => {
  test("publishes only after a true draft-action signal", async () => {
    const invoked: string[] = [];
    const invokeStep: StepInvoker = async ({ agent }) => {
      invoked.push(agent.id);
      if (agent.id === ANALYZE_AGENT_ID) return { output: feedback };
      if (agent.id === PUBLISH_AGENT_ID) return { output: receipt };
      return { output: { status: "completed-without-publishing" } };
    };
    const run = runLocal(defineLaunchFeedbackWorkflow(source), {
      triggerPayload: { url: feedback.source.url, request: "analyze" },
      invokeStep,
    });

    await waitFor(() => invoked.includes(ANALYZE_AGENT_ID));
    let completed = false;
    void run.complete.then(() => {
      completed = true;
    });
    await Bun.sleep(5);
    expect(invoked).toEqual([ANALYZE_AGENT_ID]);
    expect(completed).toBe(false);

    const signal = {
      publish: true,
      draftId: "d1",
      revision: 1,
      text: "One",
      approvedBy: "U1",
      approvedAt: "2026-07-16T00:00:00.000Z",
    };
    await Promise.all([
      run.signal(DRAFT_ACTION_SIGNAL, signal, "slack-action-1"),
      run.signal(DRAFT_ACTION_SIGNAL, signal, "slack-action-1"),
    ]);
    const result = await run.complete;

    expect(result.terminalStatus).toBe("completed");
    expect(invoked).toEqual([ANALYZE_AGENT_ID, PUBLISH_AGENT_ID]);
    expect(result.outputs.publish).toEqual(receipt);
    expect(result.outputs.complete).toBeUndefined();
  });

  test("completes without instantiating publish when all drafts are skipped", async () => {
    const invoked: string[] = [];
    const invokeStep: StepInvoker = async ({ agent }) => {
      invoked.push(agent.id);
      if (agent.id === ANALYZE_AGENT_ID) return { output: feedback };
      return { output: { status: "completed-without-publishing" } };
    };
    const run = runLocal(defineLaunchFeedbackWorkflow(source), {
      triggerPayload: { url: feedback.source.url, request: "analyze" },
      invokeStep,
    });

    await run.signal(DRAFT_ACTION_SIGNAL, {
      publish: false,
      reason: "all-drafts-skipped",
    });
    const result = await run.complete;

    expect(result.terminalStatus).toBe("completed");
    expect(invoked).toEqual([ANALYZE_AGENT_ID, COMPLETE_AGENT_ID]);
    expect(result.outputs.publish).toBeUndefined();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition was not reached");
}
