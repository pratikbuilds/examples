import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { safePathSegment } from "@corbits/example-slack-bridge";
import type { Source } from "@corbits/example-slack-agent/source";
import {
  createAgent,
  createDefaultDirectorRegistry,
  type AgentDefinition,
  type AuthorizeFn,
  type BaseEnv,
} from "@intx/agent";
import { noopAuditStore } from "@intx/agent/testing";
import { createIsogitStore } from "@intx/storage-isogit";
import type {
  AuthorizeContext,
  StepInvoker,
  WorkflowAuthorizeFn,
} from "@intx/workflow";

import type { ApprovedDraft, LaunchFeedback, PostReceipt } from "./types";
import { validatePostText } from "./validation";
import type { XClient } from "./x-client";
import {
  createAnalysisState,
  createApprovedDraftCapability,
  LAUNCH_PRESENT_FEEDBACK_TOOL,
  X_CREATE_POST_TOOL,
  X_GET_POST_REPLIES_TOOL,
  X_GET_POST_TOOL,
  type AnalysisState,
  type ApprovedDraftCapability,
} from "./x-tools";
import {
  ANALYZE_AGENT_ID,
  COMPLETE_AGENT_ID,
  PUBLISH_AGENT_ID,
} from "./workflow";

export type LaunchFeedbackAgentEnv = BaseEnv & {
  xClient: XClient;
  analysisState: AnalysisState;
  feedbackSink: (feedback: LaunchFeedback) => void;
  approvedDraft?: ApprovedDraftCapability;
  receiptSink: (receipt: PostReceipt) => void;
};

export type RunLaunchFeedbackAgent = (
  agent: AgentDefinition,
  env: LaunchFeedbackAgentEnv,
  prompt: string,
  signal: AbortSignal,
) => Promise<{ reply: string }>;

export function createInvokeStep(options: {
  source: Source;
  xClient: XClient;
  contextRoot: string;
  authorize?: WorkflowAuthorizeFn;
  onStepDone?: (stepId: string, output: unknown) => void;
  runAgent?: RunLaunchFeedbackAgent;
  log?: (line: string) => void;
}): StepInvoker {
  const authorizeWorkflow = options.authorize ?? createWorkflowAuthorize();
  const runAgent = options.runAgent ?? runRuntimeAgent;
  const publishExecutions = new Map<string, Promise<PostReceipt>>();

  return async ({ agent, input, authzContext, signal }) => {
    const stepId = authzContext.stepId ?? agent.id;
    assertStepAgent(stepId, agent.id);
    const workflowDecision = await authorizeWorkflow(
      `workflow-step:${stepId}`,
      "invoke",
      { ...authzContext, stepId },
    );
    if (workflowDecision.effect !== "allow") {
      throw new Error(`Workflow policy denied step ${stepId}`);
    }

    if (agent.id === COMPLETE_AGENT_ID) {
      const output = { status: "completed-without-publishing" as const };
      safelyObserve(() => options.onStepDone?.(stepId, output));
      return { output };
    }

    const approved =
      agent.id === PUBLISH_AGENT_ID ? parseDraftActionSignal(input) : undefined;
    const publishKey =
      approved === undefined
        ? undefined
        : [
            authzContext.runId ?? "local-run",
            approved.draftId,
            String(approved.revision),
          ].join(":");
    const existingPublish =
      publishKey === undefined ? undefined : publishExecutions.get(publishKey);
    if (existingPublish !== undefined) {
      const output = await existingPublish;
      safelyObserve(() => options.onStepDone?.(stepId, output));
      return { output };
    }
    const publishDeferred =
      publishKey === undefined ? undefined : createDeferred<PostReceipt>();
    if (publishKey !== undefined && publishDeferred !== undefined) {
      publishExecutions.set(publishKey, publishDeferred.promise);
      void publishDeferred.promise.catch(() => undefined);
    }
    const approvedDraft =
      approved === undefined ? undefined : createApprovedDraftCapability(approved);
    const workdir = createStepWorkdir(options.contextRoot, authzContext, stepId);
    const storage = await createIsogitStore(workdir);
    let feedback: LaunchFeedback | undefined;
    let feedbackCount = 0;
    let receipt: PostReceipt | undefined;
    let receiptCount = 0;

    const env: LaunchFeedbackAgentEnv = {
      sources: [options.source],
      defaultSource: options.source.id,
      storage,
      workdir,
      audit: noopAuditStore(),
      authorize: createAgentToolAuthorize(agent.id),
      directors: createDefaultDirectorRegistry(),
      xClient: options.xClient,
      analysisState: createAnalysisState(),
      feedbackSink(value) {
        feedbackCount += 1;
        if (feedbackCount !== 1) {
          throw new Error(`${LAUNCH_PRESENT_FEEDBACK_TOOL} may be called only once`);
        }
        feedback = value;
      },
      receiptSink(value) {
        receiptCount += 1;
        if (receiptCount !== 1) {
          throw new Error(`${X_CREATE_POST_TOOL} may be called only once`);
        }
        receipt = value;
      },
      ...(approvedDraft !== undefined ? { approvedDraft } : {}),
    };

    try {
      safelyObserve(() => options.log?.(`step ${stepId}: ${agent.id} running`));
      const prompt = typeof input === "string" ? input : JSON.stringify(input);
      await runAgent(agent, env, prompt, signal);

      const output = requireStepOutput(agent.id, {
        feedback,
        feedbackCount,
        receipt,
        receiptCount,
      });
      if (publishDeferred !== undefined) {
        publishDeferred.resolve(output as PostReceipt);
      }
      safelyObserve(() => options.log?.(`step ${stepId}: done`));
      safelyObserve(() => options.onStepDone?.(stepId, output));
      return { output };
    } catch (error) {
      if (publishKey !== undefined) publishExecutions.delete(publishKey);
      publishDeferred?.reject(error);
      throw error;
    }
  };
}

export function parseDraftActionSignal(value: unknown): ApprovedDraft {
  const input = requiredRecord(value, "draft action signal");
  if (input.publish !== true) {
    throw new Error("draft action signal.publish must be true");
  }
  const draftId = requiredString(input.draftId, "draftId");
  const revision = input.revision;
  if (!Number.isInteger(revision) || Number(revision) < 1) {
    throw new Error("revision must be a positive integer");
  }
  const textValidation = validatePostText(input.text);
  if (textValidation.error !== undefined) throw new Error(textValidation.error);
  const approvedBy = requiredString(input.approvedBy, "approvedBy");
  const approvedAt = requiredString(input.approvedAt, "approvedAt");
  if (Number.isNaN(Date.parse(approvedAt))) {
    throw new Error("approvedAt must be an ISO timestamp");
  }
  return {
    draftId,
    revision: Number(revision),
    text: textValidation.text,
    approvedBy,
    approvedAt,
  };
}

export function createAgentToolAuthorize(agentId: string): AuthorizeFn {
  const allowed = new Set(
    agentId === ANALYZE_AGENT_ID
      ? [X_GET_POST_TOOL, X_GET_POST_REPLIES_TOOL, LAUNCH_PRESENT_FEEDBACK_TOOL]
      : agentId === PUBLISH_AGENT_ID
        ? [X_CREATE_POST_TOOL]
        : [],
  );
  return async (resource, action) => {
    const name = resource.startsWith("tool:") ? resource.slice(5) : "";
    if (action === "invoke" && allowed.has(name)) {
      const grant = grantFor(resource, "allow", agentId);
      return { effect: "allow", matchingGrants: [grant], resolvedBy: grant };
    }
    const grant = grantFor(resource, "deny", agentId);
    return { effect: "deny", matchingGrants: [grant], resolvedBy: grant };
  };
}

export function createWorkflowAuthorize(): WorkflowAuthorizeFn {
  const allowedSteps = new Set(["analyze", "publish", "complete"]);
  return async (resource, action) => {
    const stepId = resource.startsWith("workflow-step:")
      ? resource.slice("workflow-step:".length)
      : "";
    const allowed = action === "invoke" && allowedSteps.has(stepId);
    const grant = grantFor(resource, allowed ? "allow" : "deny", "workflow");
    return {
      effect: allowed ? "allow" : "deny",
      matchingGrants: [grant],
      resolvedBy: grant,
    };
  };
}

async function runRuntimeAgent(
  definition: AgentDefinition,
  env: LaunchFeedbackAgentEnv,
  prompt: string,
  signal: AbortSignal,
): Promise<{ reply: string }> {
  const agent = await createAgent(definition, env);
  try {
    return await agent.send(prompt, { signal });
  } finally {
    await agent.close();
  }
}

function createStepWorkdir(
  contextRoot: string,
  context: AuthorizeContext,
  stepId: string,
): string {
  const workdir = join(
    contextRoot,
    safePathSegment(context.runId ?? "local-run"),
    safePathSegment(stepId),
    String(context.attempt ?? 1),
  );
  mkdirSync(workdir, { recursive: true });
  return workdir;
}

function requireStepOutput(
  agentId: string,
  captured: {
    feedback?: LaunchFeedback;
    feedbackCount: number;
    receipt?: PostReceipt;
    receiptCount: number;
  },
): LaunchFeedback | PostReceipt {
  if (agentId === ANALYZE_AGENT_ID) {
    if (captured.feedbackCount !== 1 || captured.feedback === undefined) {
      throw new Error(
        `Analysis must call ${LAUNCH_PRESENT_FEEDBACK_TOOL} exactly once`,
      );
    }
    return captured.feedback;
  }
  if (agentId === PUBLISH_AGENT_ID) {
    if (captured.receiptCount !== 1 || captured.receipt === undefined) {
      throw new Error(`Publishing must call ${X_CREATE_POST_TOOL} exactly once`);
    }
    return captured.receipt;
  }
  throw new Error(`Unsupported workflow agent: ${agentId}`);
}

function grantFor(
  resource: string,
  effect: "allow" | "deny",
  owner: string,
) {
  return {
    id: `${owner}-${effect}`,
    resource,
    action: "invoke",
    effect,
    origin: effect === "allow" ? ("invoker" as const) : ("system" as const),
    specificity: effect === "allow" ? 100 : 0,
  };
}

function assertStepAgent(stepId: string, agentId: string): void {
  const expected: Record<string, string> = {
    analyze: ANALYZE_AGENT_ID,
    publish: PUBLISH_AGENT_ID,
    complete: COMPLETE_AGENT_ID,
  };
  if (expected[stepId] !== agentId) {
    throw new Error(
      `Workflow step ${stepId} cannot invoke agent ${agentId}`,
    );
  }
}

function safelyObserve(callback: () => void): void {
  try {
    callback();
  } catch {
    // Logs and UI observers cannot change the result of a completed step.
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}
