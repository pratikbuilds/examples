import { describe, expect, test } from "bun:test";

import {
  toSlackBlockAction,
  toSlackViewSubmission,
} from "./events";

describe("Slack interaction normalization", () => {
  test("preserves the trigger needed to open a modal", () => {
    expect(
      toSlackBlockAction(
        "T-context",
        {
          trigger_id: "trigger-1",
          user: { id: "U1" },
          channel: { id: "C1" },
          message: { ts: "100.1" },
          team: { id: "T1" },
        },
        { action_id: "draft.edit", value: "draft-1" },
      ),
    ).toEqual({
      actionId: "draft.edit",
      value: "draft-1",
      triggerId: "trigger-1",
      teamId: "T1",
      userId: "U1",
      channelId: "C1",
      messageTs: "100.1",
    });
  });

  test("normalizes modal metadata and text inputs", () => {
    expect(
      toSlackViewSubmission("T-context", {
        team: { id: "T1" },
        user: { id: "U1" },
        view: {
          callback_id: "draft.edit.submit",
          private_metadata: "opaque-revision-id",
          state: {
            values: {
              draft: {
                text: {
                  type: "plain_text_input",
                  value: "Revised follow-up",
                },
              },
            },
          },
        },
      }),
    ).toEqual({
      callbackId: "draft.edit.submit",
      privateMetadata: "opaque-revision-id",
      teamId: "T1",
      userId: "U1",
      state: {
        draft: {
          text: {
            type: "plain_text_input",
            value: "Revised follow-up",
          },
        },
      },
      textValues: { "draft.text": "Revised follow-up" },
    });
  });
});
