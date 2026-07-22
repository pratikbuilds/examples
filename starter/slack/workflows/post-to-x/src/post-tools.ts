import {
  createToolRunner,
  tool,
  type AgentToolRunner,
} from "@intx/agent";

import { requireApprovedPost, validateXPost } from "./post";
import type { Publisher } from "./x-client";

export const VALIDATE_POST_TOOL = "post_to_x_validate";
export const PUBLISH_POST_TOOL = "x_create_post";

const TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: { input: {} },
  required: ["input"],
  additionalProperties: false,
};

export function createPostToolRunner(publisher: Publisher): AgentToolRunner {
  let publishAttempted = false;

  return createToolRunner([
    tool({
      definition: {
        name: VALIDATE_POST_TOOL,
        description: "Normalize and validate a draft X post",
        inputSchema: TOOL_INPUT_SCHEMA,
      },
      handler: async (call) => ({
        callId: call.id,
        content: validateXPost(call.arguments.input),
      }),
    }),
    tool({
      definition: {
        name: PUBLISH_POST_TOOL,
        description: "Publish the exact policy-approved X post",
        inputSchema: TOOL_INPUT_SCHEMA,
      },
      handler: async (call, signal) => {
        if (signal.aborted) throw new Error("publish step was cancelled");
        if (publishAttempted) {
          throw new Error("publish step already attempted to publish");
        }
        const approvedPost = requireApprovedPost(call.arguments.input);
        publishAttempted = true;
        return {
          callId: call.id,
          content: await publisher.publish(approvedPost.text),
        };
      },
    }),
  ]);
}
