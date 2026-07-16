import { describe, expect, test } from "bun:test";

import { createSlackWorkflowAdapter } from "./workflow-adapter";

describe("Slack workflow adapter", () => {
  test("preserves the requesting Slack user on event and assistant starts", async () => {
    const starts: unknown[] = [];
    const adapter = createSlackWorkflowAdapter({
      onStart: (input) => void starts.push(input),
      actionHandlers: {},
    });

    await adapter.onEvent("T1", {
      type: "app_mention",
      channel: "C1",
      ts: "100.1",
      user: "U1",
      text: "<@UBOT> analyze https://x.com/user/status/123",
    });
    await adapter.onAssistantUserMessage({
      teamId: "T1",
      channel: "C2",
      threadTs: "200.1",
      userId: "U2",
      prompt: "analyze https://x.com/user/status/456",
    });

    expect(starts).toEqual([
      expect.objectContaining({ userId: "U1" }),
      expect.objectContaining({ userId: "U2" }),
    ]);
  });
});
