import {
  createSlackWorkflowAdapter,
  type SlackWorkflowAdapter,
  type Write,
} from "@corbits/example-slack-bridge";

import { APPROVE_ACTION_ID, REJECT_ACTION_ID } from "./blocks";
import type { PostToXConfig } from "./config";
import { createPostSessions } from "./session";

export type { SlackWorkflowAdapter };

export function createPostWorkflowAdapter(opts: {
  config: PostToXConfig;
  stderr: Write;
}): SlackWorkflowAdapter {
  const sessions = createPostSessions(opts);

  return createSlackWorkflowAdapter({
    shouldStartEvent: (event) =>
      event.type === "app_mention" &&
      event.bot_id === undefined &&
      event.subtype === undefined,
    onStart: sessions.start,
    actionHandlers: {
      [APPROVE_ACTION_ID]: (action) =>
        sessions.approve(action.value, action.userId),
      [REJECT_ACTION_ID]: (action) => sessions.reject(action.value),
    },
  });
}
