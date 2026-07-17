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
  createXReader,
  createXReplyPublisher,
  resolveCredentials,
  type XReadClient,
  type XReplyPublisher,
} from "./x-client";

export const SERVICE_NAME = "slack-x-reply-triage";

export type ReplyTriageConfig = SlackConnectionConfig & {
  source: Source;
  xClient: XReadClient;
  xPublisher: XReplyPublisher;
  contextRoot: string;
};

export function resolveConfig(
  env: NodeJS.ProcessEnv,
  contextRootOverride?: string,
):
  | { config: ReplyTriageConfig; error?: undefined }
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

  return {
    config: {
      ...slack.config,
      source: source.source,
      xClient: createXReader(credentials),
      xPublisher: createXReplyPublisher(credentials, env),
      contextRoot:
        contextRootOverride ?? join(process.cwd(), "tmp", SERVICE_NAME),
    },
  };
}
