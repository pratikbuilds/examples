import { describe, expect, test } from "bun:test";
import type { ModalView } from "@slack/types";
import type { WebClient } from "@slack/web-api";

import { openModal, updateMessage } from "./messages";

describe("Slack Web API helpers", () => {
  test("opens a modal with the action trigger", async () => {
    const calls: unknown[] = [];
    const client = {
      views: {
        open: async (input: unknown) => {
          calls.push(input);
          return { ok: true };
        },
      },
    } as unknown as WebClient;
    const view = {
      type: "modal",
      callback_id: "draft.edit.submit",
      title: { type: "plain_text", text: "Edit draft" },
      submit: { type: "plain_text", text: "Save" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [],
    } satisfies ModalView;

    await openModal("xoxb-test", { triggerId: "trigger-1", view }, client);

    expect(calls).toEqual([{ trigger_id: "trigger-1", view }]);
  });

  test("updates an existing Slack message", async () => {
    const calls: unknown[] = [];
    const client = {
      chat: {
        update: async (input: unknown) => {
          calls.push(input);
          return { ok: true, channel: "C1", ts: "100.1" };
        },
      },
    } as unknown as WebClient;

    await updateMessage(
      "xoxb-test",
      { channel: "C1", ts: "100.1", text: "Updated", blocks: [] },
      client,
    );

    expect(calls).toEqual([
      { channel: "C1", ts: "100.1", text: "Updated", blocks: [] },
    ]);
  });
});
