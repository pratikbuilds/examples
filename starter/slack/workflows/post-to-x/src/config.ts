import { join } from "node:path";

import {
  resolveSource,
  type Source,
} from "@corbits/example-slack-agent";
import {
  resolveSlackConnection,
  type SlackConnectionConfig,
} from "@corbits/example-slack-bridge";

import { kind } from "./workflow";
import { createDryRunPublisher, type Publisher } from "./x-client";

export const SERVICE_NAME = kind;

export type PostToXConfig = SlackConnectionConfig & {
  source: Source;
  contextRoot: string;
  publisher: Publisher;
};

export type ResolveConfigResult =
  | { config: PostToXConfig; error?: undefined }
  | { config?: undefined; error: string };

export function resolveConfig(
  env: NodeJS.ProcessEnv,
  contextRootOverride?: string,
): ResolveConfigResult {
  const slack = resolveSlackConnection(env);
  if (slack.error !== undefined) return { error: slack.error };

  const model = resolveSource(env);
  if (model.error !== undefined) return { error: model.error };

  return {
    config: {
      ...slack.config,
      source: model.source,
      contextRoot: contextRootOverride ?? join(process.cwd(), "tmp", kind),
      publisher: createDryRunPublisher(),
    },
  };
}
