import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  createAgent,
  createDefaultDirectorRegistry,
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

import { requireApprovedPost, validateXPost } from "./post";
import {
  PUBLISH_POST_CAPABILITY,
  VALIDATE_POST_CAPABILITY,
} from "./workflow";
import type { Publisher } from "./x-client";

export function createPostStepInvoker(opts: {
  source: Source;
  contextRoot: string;
  publisher: Publisher;
  authorize: WorkflowAuthorizeFn;
  log?: (line: string) => void;
  onStepDone?: (stepId: string, output: unknown) => void;
}): StepInvoker {
  const { source, contextRoot, publisher, authorize, log, onStepDone } = opts;

  return async ({ agent, input, authzContext, signal }) => {
    const stepId = authzContext.stepId ?? agent.id;
    await requireStepAuthorization(authorize, stepId, authzContext);
    if (signal.aborted) throw new Error(`step ${stepId} was cancelled`);

    log?.(`step ${stepId}: ${agent.id} running`);

    let output: unknown;
    if (agent.capabilities.length === 0) {
      output = await runDraftAgent({
        agent,
        input,
        source,
        contextRoot,
        authorize,
        authzContext,
      });
    } else if (
      agent.capabilities.length === 1 &&
      agent.capabilities[0] === VALIDATE_POST_CAPABILITY
    ) {
      output = validateXPost(input);
    } else if (
      agent.capabilities.length === 1 &&
      agent.capabilities[0] === PUBLISH_POST_CAPABILITY
    ) {
      if (signal.aborted) throw new Error(`step ${stepId} was cancelled`);
      const approvedPost = requireApprovedPost(input);
      output = await publisher.publish(approvedPost.text);
    } else {
      throw new Error(`unsupported step capability for ${stepId}`);
    }

    log?.(`step ${stepId}: done`);
    onStepDone?.(stepId, output);
    return { output };
  };
}

async function requireStepAuthorization(
  authorize: WorkflowAuthorizeFn,
  stepId: string,
  authzContext: AuthorizeContext,
): Promise<void> {
  const decision = await authorize(`workflow-step:${stepId}`, "invoke", {
    ...authzContext,
    stepId,
  });
  if (decision.effect !== "allow") {
    throw new Error(
      `authorization blocked workflow-step:${stepId} invoke with effect ${decision.effect ?? "null"}`,
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
