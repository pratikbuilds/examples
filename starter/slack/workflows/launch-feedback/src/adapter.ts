import {
  createSlackWorkflowAdapter,
  type SlackViewSubmission,
  type SlackViewSubmissionResult,
  type SlackWorkflowAdapter,
  type Write,
} from "@corbits/example-slack-bridge";

import {
  DRAFT_EDIT_ACTION_ID,
  DRAFT_PUBLISH_ACTION_ID,
  DRAFT_SKIP_ACTION_ID,
} from "./blocks";
import type { LaunchFeedbackConfig } from "./config";
import { createLaunchFeedbackSessions } from "./session";

export type LaunchFeedbackAdapter = SlackWorkflowAdapter & {
  onViewSubmission: (
    submission: SlackViewSubmission,
  ) => SlackViewSubmissionResult;
};

export function createLaunchFeedbackAdapter(options: {
  config: LaunchFeedbackConfig;
  stderr: Write;
}): LaunchFeedbackAdapter {
  const sessions = createLaunchFeedbackSessions(options);
  const adapter = createSlackWorkflowAdapter({
    onStart: sessions.start,
    actionHandlers: {
      [DRAFT_EDIT_ACTION_ID]: sessions.edit,
      [DRAFT_PUBLISH_ACTION_ID]: sessions.publish,
      [DRAFT_SKIP_ACTION_ID]: sessions.skip,
    },
  });
  return { ...adapter, onViewSubmission: sessions.submitEdit };
}
