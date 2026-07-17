import {
  createSlackWorkflowAdapter,
  type SlackWorkflowAdapter,
  type Write,
} from "@corbits/example-slack-bridge";

import { APPROVE_ACTION_ID, REJECT_ACTION_ID } from "./blocks";
import type { ReplyTriageConfig } from "./config";
import { createReplyTriageSessions } from "./session";

export type ReplyTriageAdapter = SlackWorkflowAdapter;

export function createReplyTriageAdapter(options: {
  config: ReplyTriageConfig;
  stderr: Write;
}): ReplyTriageAdapter {
  const sessions = createReplyTriageSessions(options);
  return createSlackWorkflowAdapter({
    onStart: sessions.start,
    actionHandlers: {
      [APPROVE_ACTION_ID]: (action) => sessions.approve(action.value, action.userId),
      [REJECT_ACTION_ID]: (action) => sessions.reject(action.value, action.userId),
    },
  });
}
