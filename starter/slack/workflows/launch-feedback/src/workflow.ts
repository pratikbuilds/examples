import { defineAgent } from "@intx/agent";
import type { Source } from "@corbits/example-slack-agent/source";
import {
  awaitSignal,
  defineWorkflow,
  gate,
  step,
  type WorkflowDefinition,
} from "@intx/workflow";

import {
  createAnalyzeXTools,
  createCreatePostTool,
} from "./x-tools";

export const WORKFLOW_ID = "slack-launch-feedback";
export const DRAFT_ACTION_SIGNAL = "draft-action";
export const ANALYZE_AGENT_ID = "launch-feedback-analyze";
export const PUBLISH_AGENT_ID = "launch-feedback-publish";
export const COMPLETE_AGENT_ID = "launch-feedback-complete";

const ANALYZE_PROMPT = [
  "You analyze recent replies to one company launch post.",
  "The input contains one X status URL and the user's request.",
  "Call x_get_post once with input.url.",
  "Call x_get_post_replies once with the same URL.",
  "Then call launch_present_feedback exactly once.",
  "Use only reply ids returned by x_get_post_replies as evidencePostIds.",
  "Return an executive summary, themes, FAQ, prioritized actions, and exactly three drafts.",
  "The draft strategies are concise-recap, what-we-heard, and next-steps.",
  "Recent search is bounded and may be incomplete; never claim historical completeness.",
].join("\n");

const PUBLISH_PROMPT = [
  "The input is one exact Slack-approved draft.",
  "Call x_create_post exactly once using input.text unchanged.",
  "Do not rewrite, trim, normalize, or retry the text.",
].join("\n");

export function defineLaunchFeedbackWorkflow(
  source: Source,
): WorkflowDefinition {
  const analyzeAgent = defineAgent({
    id: ANALYZE_AGENT_ID,
    systemPrompt: ANALYZE_PROMPT,
    tools: [createAnalyzeXTools()],
    capabilities: [],
    inference: {
      sources: [{ provider: source.provider, model: source.model }],
    },
  });
  const publishAgent = defineAgent({
    id: PUBLISH_AGENT_ID,
    systemPrompt: PUBLISH_PROMPT,
    tools: [createCreatePostTool()],
    capabilities: [],
    inference: {
      sources: [{ provider: source.provider, model: source.model }],
    },
  });
  const completeAgent = defineAgent({
    id: COMPLETE_AGENT_ID,
    systemPrompt: "Complete the run without publishing.",
    tools: [],
    capabilities: [],
    inference: {
      sources: [{ provider: source.provider, model: source.model }],
    },
  });

  return defineWorkflow({
    id: WORKFLOW_ID,
    trigger: { type: "manual" },
    steps: {
      analyze: step({
        agent: analyzeAgent,
        input: { from: "trigger.payload" },
      }),
      draftAction: awaitSignal({
        name: DRAFT_ACTION_SIGNAL,
        after: ["analyze"],
      }),
      publishGate: gate({
        after: ["draftAction"],
        when: { from: "steps.draftAction.output.publish" },
        then: "publish",
        else: "complete",
      }),
      publish: step({
        agent: publishAgent,
        after: ["publishGate"],
        input: { from: "steps.draftAction.output" },
        retry: { maxAttempts: 1, initialBackoffMs: 0 },
      }),
      complete: step({
        agent: completeAgent,
        after: ["publishGate"],
        input: { from: "steps.analyze.output" },
      }),
    },
  });
}
