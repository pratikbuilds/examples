import {
  createSlackWorkflowAdapter,
  startSlackBridge,
} from "@corbits/example-slack-bridge";

import { APPROVE_ACTION_ID, REJECT_ACTION_ID } from "./blocks";
import { resolveConfig, SERVICE_NAME } from "./config";
import { X_POST_LIMIT } from "./post";
import { createPostSessions } from "./session";

export type MainOptions = {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  contextRoot?: string;
};

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
  opts: MainOptions = {},
): Promise<number> {
  const stdout =
    opts.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr =
    opts.stderr ?? ((text: string) => void process.stderr.write(text));

  if (argv.includes("--help") || argv.includes("-h")) {
    stdout(
      [
        "usage: bun run start",
        "",
        "Start the Slack post-to-X workflow.",
        "",
      ].join("\n"),
    );
    return 0;
  }

  const resolved = resolveConfig(env, opts.contextRoot);
  if (resolved.error !== undefined) {
    stderr(resolved.error);
    return 1;
  }

  stderr(
    `${SERVICE_NAME}: publisher=${resolved.config.publisher.mode}, limit=${String(X_POST_LIMIT)}\n`,
  );
  const sessions = createPostSessions({
    config: resolved.config,
    stderr,
  });
  const adapter = createSlackWorkflowAdapter({
    shouldStartEvent: (event) =>
      event.type === "app_mention" &&
      event.bot_id === undefined &&
      event.subtype === undefined,
    onStart: sessions.start,
    actionHandlers: {
      [APPROVE_ACTION_ID]: sessions.approve,
      [REJECT_ACTION_ID]: sessions.reject,
    },
  });

  try {
    await startSlackBridge({
      serviceName: SERVICE_NAME,
      port: resolved.config.port,
      signingSecret: resolved.config.signingSecret,
      botToken: resolved.config.botToken,
      appToken: resolved.config.appToken,
      stdout,
      stderr,
      onEvent: adapter.onEvent,
      onBlockAction: adapter.onBlockAction,
    });
  } catch (error) {
    stderr(`${errorMessage(error)}\n`);
    return 1;
  }

  return await new Promise<never>(() => undefined);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), process.env);
  if (code !== 0) process.exit(code);
}
