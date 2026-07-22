import { defineAgent, type AgentDefinition } from "@intx/agent";
import {
  awaitSignal,
  defineWorkflow,
  step,
  type WorkflowDefinition,
} from "@intx/workflow";

import type { Source } from "@corbits/example-slack-agent";

export const kind = "slack-post-to-x";
export const label = "Post to X";
export const description =
  "Draft, validate, approve, and publish an X post from Slack.";
export const WORKFLOW_ID = kind;
export const APPROVAL_SIGNAL = "approve";
export const VALIDATE_POST_CAPABILITY = "post-to-x.validate-post";
export const PUBLISH_POST_CAPABILITY = "post-to-x.publish-post";

function deterministicAgent(
  id: string,
  capability: string,
): AgentDefinition {
  return defineAgent({
    id,
    description: `Deterministic operation: ${capability}`,
    systemPrompt: "",
    tools: [],
    capabilities: [capability],
    inference: { sources: [] },
  });
}

export function definePostWorkflow(source: Source): WorkflowDefinition {
  const drafter = defineAgent({
    id: "post-drafter",
    systemPrompt:
      "Write one concise X post. Return only the post text; do not publish it.",
    tools: [],
    capabilities: [],
    inference: { sources: [{ provider: source.provider, model: source.model }] },
  });

  return defineWorkflow({
    id: WORKFLOW_ID,
    trigger: { type: "manual" },
    steps: {
      draft: step({ agent: drafter, input: { from: "trigger.payload" } }),
      policy: step({
        agent: deterministicAgent("post-policy", VALIDATE_POST_CAPABILITY),
        after: ["draft"],
        input: { from: "steps.draft.output" },
      }),
      approval: awaitSignal({
        name: APPROVAL_SIGNAL,
        after: ["policy"],
      }),
      publish: step({
        agent: deterministicAgent("post-publisher", PUBLISH_POST_CAPABILITY),
        after: ["approval"],
        input: { from: "steps.policy.output" },
      }),
    },
  });
}
