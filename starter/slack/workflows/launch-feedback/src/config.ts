import { join } from "node:path";

import {
  resolveSource,
  type Source,
} from "@corbits/example-slack-agent/source";
import {
  resolveSlackConnection,
  type SlackConnectionConfig,
} from "@corbits/example-slack-bridge";

import {
  createXClient,
  resolveCredentials,
  resolveWriteMode,
  type XClient,
} from "./x-client";

export const SERVICE_NAME = "slack-launch-feedback";

export type LaunchFeedbackConfig = SlackConnectionConfig & {
  source: Source;
  xClient: XClient;
  contextRoot: string;
  approvalTimeoutMs: number;
};

export function resolveConfig(
  env: NodeJS.ProcessEnv,
  contextRootOverride?: string,
):
  | { config: LaunchFeedbackConfig; error?: undefined }
  | { config?: undefined; error: string } {
  const slack = resolveSlackConnection(env);
  if (slack.error !== undefined) return { error: slack.error };
  const source = resolveSource(env);
  if (source.error !== undefined) return { error: source.error };
  const credentials = resolveCredentials(env);
  if (credentials === undefined) {
    return {
      error:
        "X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, and X_ACCESS_TOKEN_SECRET are required.\n",
    };
  }
  const writeMode = resolveWriteMode(env.X_DRY_RUN);
  if (writeMode.error !== undefined) return { error: writeMode.error + "\n" };

  return {
    config: {
      ...slack.config,
      source: source.source,
      xClient: createXClient({ credentials, writeMode: writeMode.mode }),
      contextRoot:
        contextRootOverride ?? join(process.cwd(), "tmp", SERVICE_NAME),
      approvalTimeoutMs: positiveInteger(env.APPROVAL_TIMEOUT_MS, 300_000),
    },
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
