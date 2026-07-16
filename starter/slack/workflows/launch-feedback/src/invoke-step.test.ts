import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LaunchFeedback, PostReceipt } from "./types";
import type { XClient } from "./x-client";
import {
  createAgentToolAuthorize,
  createInvokeStep,
  parseDraftActionSignal,
} from "./invoke-step";
import {
  ANALYZE_AGENT_ID,
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
    id: "123",
    url: "https://x.com/builder/status/123",
    text: "We shipped",
    authorId: "u1",
    directReply: false,
  },
  coverage: {
    source: "recent-search",
    days: 7,
    complete: false,
    analyzedReplies: 0,
    truncated: false,
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
  repliesById: {},
} satisfies LaunchFeedback;

const client = {
  writeMode: "dry-run",
  getMe: async () => ({ id: "u1", name: "Builder", username: "builder" }),
  getPost: async () => feedback.source,
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
} satisfies XClient;

describe("StepInvoker", () => {
  test("returns the structured analysis sink and denies publish tools", async () => {
    const definition = defineLaunchFeedbackWorkflow(source);
    const analyze = definition.steps.analyze;
    if (analyze?.kind !== "step") throw new Error("missing analyze step");
    const outputs: unknown[] = [];
    const invoke = createInvokeStep({
      source,
      xClient: client,
      contextRoot: join(tmpdir(), `launch-invoke-${randomUUID()}`),
      onStepDone: (_stepId, output) => outputs.push(output),
      runAgent: async (_agent, env) => {
        expect(
          (await env.authorize("tool:x_create_post", "invoke")).effect,
        ).toBe("deny");
        env.feedbackSink?.(feedback);
        return { reply: "ignored" };
      },
    });

    const result = await invoke({
      agent: analyze.agent,
      input: { url: feedback.source.url, request: "analyze" },
      authzContext: { runId: "run-1", stepId: "analyze", attempt: 1 },
      signal: new AbortController().signal,
    });

    expect(result.output).toEqual(feedback);
    expect(outputs).toEqual([feedback]);
  });

  test("fails when the analysis agent does not submit structured output", async () => {
    const definition = defineLaunchFeedbackWorkflow(source);
    const analyze = definition.steps.analyze;
    if (analyze?.kind !== "step") throw new Error("missing analyze step");
    const invoke = createInvokeStep({
      source,
      xClient: client,
      contextRoot: join(tmpdir(), `launch-invoke-${randomUUID()}`),
      onStepDone: () => undefined,
      runAgent: async () => ({ reply: "free-form only" }),
    });

    await expect(
      invoke({
        agent: analyze.agent,
        input: { url: feedback.source.url, request: "analyze" },
        authzContext: { runId: "run-2", stepId: "analyze", attempt: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("launch_present_feedback");
  });

  test("returns the receipt sink for the publish step", async () => {
    const definition = defineLaunchFeedbackWorkflow(source);
    const publish = definition.steps.publish;
    if (publish?.kind !== "step") throw new Error("missing publish step");
    const receipt: PostReceipt = {
      mode: "dry-run",
      postId: "p1",
      url: "https://x.com/i/web/status/p1",
      text: "Approved",
      postedAt: "2026-07-16T00:00:00.000Z",
    };
    const invoke = createInvokeStep({
      source,
      xClient: client,
      contextRoot: join(tmpdir(), `launch-invoke-${randomUUID()}`),
      onStepDone: () => undefined,
      runAgent: async (_agent, env) => {
        expect(
          (await env.authorize("tool:x_get_post", "invoke")).effect,
        ).toBe("deny");
        env.receiptSink?.(receipt);
        return { reply: "ignored" };
      },
    });

    const result = await invoke({
      agent: publish.agent,
      input: {
        publish: true,
        draftId: "d1",
        revision: 1,
        text: "Approved",
        approvedBy: "U1",
        approvedAt: "2026-07-16T00:00:00.000Z",
      },
      authzContext: { runId: "run-3", stepId: "publish", attempt: 1 },
      signal: new AbortController().signal,
    });

    expect(result.output).toEqual(receipt);
  });
});

describe("workflow input boundaries", () => {
  test("parses only a complete publish signal", () => {
    expect(
      parseDraftActionSignal({
        publish: true,
        draftId: "d1",
        revision: 1,
        text: "Approved",
        approvedBy: "U1",
        approvedAt: "2026-07-16T00:00:00.000Z",
      }),
    ).toMatchObject({ draftId: "d1", revision: 1, text: "Approved" });
    expect(() => parseDraftActionSignal({ publish: true })).toThrow(
      "draftId",
    );
  });

  test("authorizes tools per agent step and denies by default", async () => {
    const analyze = createAgentToolAuthorize(ANALYZE_AGENT_ID);
    const publish = createAgentToolAuthorize(PUBLISH_AGENT_ID);

    expect((await analyze("tool:x_get_post", "invoke")).effect).toBe("allow");
    expect((await analyze("tool:x_create_post", "invoke")).effect).toBe(
      "deny",
    );
    expect((await publish("tool:x_create_post", "invoke")).effect).toBe(
      "allow",
    );
  });
});
