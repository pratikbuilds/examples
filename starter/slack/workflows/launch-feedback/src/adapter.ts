import {
  createSlackWorkflowAdapter,
  type SlackWorkflowAdapter,
  type Write,
} from "@corbits/example-slack-bridge";

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
    actionHandlers: {},
  });
}
