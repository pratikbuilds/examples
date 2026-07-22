import { defineAgent, type AgentToolRunner } from "@intx/agent";
import {
  step,
  type Selector,
  type StepPrimitive,
} from "@intx/workflow";

export function deterministicToolStep(opts: {
  id: string;
  tool: string;
  input?: Selector;
  after?: readonly string[];
}): StepPrimitive {
  const agent = defineAgent({
    id: opts.id,
    description: `Deterministic tool call: ${opts.tool}`,
    systemPrompt: "",
    tools: [],
    capabilities: [opts.tool],
    inference: { sources: [] },
  });

  return step({
    agent,
    ...(opts.input === undefined ? {} : { input: opts.input }),
    ...(opts.after === undefined ? {} : { after: opts.after }),
  });
}

export async function runDeterministicToolStep(opts: {
  runner: AgentToolRunner;
  stepId: string;
  toolName: string;
  input: unknown;
  signal: AbortSignal;
}): Promise<unknown> {
  const result = await opts.runner.run(
    {
      id: `${opts.stepId}-tool-call`,
      name: opts.toolName,
      arguments: { input: opts.input },
    },
    opts.signal,
  );
  if (result.isError === true) {
    const message =
      typeof result.content === "string"
        ? result.content
        : JSON.stringify(result.content);
    throw new Error(`deterministic tool ${opts.toolName} failed: ${message}`);
  }

  return result.content;
}
