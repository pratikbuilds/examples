import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  createAgent,
  createDefaultDirectorRegistry,
  type AgentToolRunner,
  type AgentDefinition,
  type BaseEnv,
} from "@intx/agent";
import { noopAuditStore } from "@intx/agent/testing";
import { createIsogitStore } from "@intx/storage-isogit";
import {
  type AuthorizeContext,
  type StepInvoker,
  type WorkflowAuthorizeFn,
} from "@intx/workflow";

import type { Source } from "@corbits/example-slack-agent";

import {
  DETERMINISTIC_TOOL_KIND,
  runDeterministicToolStep,
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
} from "./deterministic-tool-step";

export function createPostStepInvoker(opts: {
  source: Source;
  contextRoot: string;
  toolRunner: AgentToolRunner;
  authorize: WorkflowAuthorizeFn;
  log?: (line: string) => void;
  onStepDone?: (stepID: string, output: unknown) => void;
}): StepInvoker {
  const {
    source,
    contextRoot,
    toolRunner,
    authorize,
    log,
    onStepDone,
  } = opts;
  return async ({ agent, input, authzContext, signal }) => {
    const stepID = authzContext.stepId ?? agent.id;
    try {
      await requireStepAuthorization(authorize, stepID, authzContext);
      if (signal.aborted) throw new Error(`step ${stepID} was cancelled`);

      log?.(`step ${stepID}: ${agent.id} running`);

      let output: unknown;
      const toolName = agent.tags?.[STEP_TOOL_TAG];
      if (
        agent.tags?.[STEP_KIND_TAG] === DETERMINISTIC_TOOL_KIND &&
        toolName !== undefined
      ) {
        if (
          agent.capabilities.length !== 1 ||
          agent.capabilities[0] !== toolName
        ) {
          throw new Error(`deterministic step ${stepID} has invalid capabilities`);
        }
        output = await runDeterministicToolStep({
          runner: toolRunner,
          stepId: stepID,
          toolName,
          input,
          signal,
        });
      } else if (agent.capabilities.length === 0) {
        output = await runDraftAgent({
          agent,
          input,
          source,
          contextRoot,
          authorize,
          authzContext,
        });
      } else {
        throw new Error(`unsupported step configuration for ${stepID}`);
      }

      log?.(`step ${stepID}: done`);
      onStepDone?.(stepID, output);
      return { output };
    } catch (error) {
      log?.(`step ${stepID}: failed: ${errorMessage(error)}`);
      throw error;
    }
  };
}

async function requireStepAuthorization(
  authorize: WorkflowAuthorizeFn,
  stepID: string,
  authzContext: AuthorizeContext,
): Promise<void> {
  const decision = await authorize(`workflow-step:${stepID}`, "invoke", {
    ...authzContext,
    stepId: stepID,
  });
  if (decision.effect !== "allow") {
    throw new Error(
      `authorization blocked workflow-step:${stepID} invoke with effect ${decision.effect ?? "null"}`,
    );
  }
}

async function runDraftAgent(opts: {
  agent: AgentDefinition<BaseEnv>;
  input: unknown;
  source: Source;
  contextRoot: string;
  authorize: WorkflowAuthorizeFn;
  authzContext: AuthorizeContext;
}): Promise<string> {
  const workdir = join(opts.contextRoot, opts.authzContext.stepId ?? opts.agent.id);
  mkdirSync(workdir, { recursive: true });
  const storage = await createIsogitStore(workdir);
  const authorize: BaseEnv["authorize"] = (resource, action) =>
    opts.authorize(resource, action, opts.authzContext);
  const runtimeAgent = await createAgent(opts.agent, {
    sources: [opts.source],
    defaultSource: opts.source.id,
    storage,
    workdir,
    audit: noopAuditStore(),
    authorize,
    directors: createDefaultDirectorRegistry(),
  });

  try {
    const prompt =
      typeof opts.input === "string"
        ? opts.input
        : JSON.stringify(opts.input);
    const { reply } = await runtimeAgent.send(prompt);
    return reply;
  } finally {
    await runtimeAgent.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
