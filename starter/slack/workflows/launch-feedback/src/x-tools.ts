import { defineTool, type BaseEnv } from "@intx/agent";

import type { ReplySnapshot, ReplyTriage, XPost, XReplyCollection } from "./types";
import {
  createReplySnapshot,
  parseReplyTriage,
  parseXStatusURL,
} from "./validation";
import {
  DEFAULT_REPLY_SAMPLE_SIZE,
  type XReadClient,
} from "./x-client";

export const X_GET_POST_TOOL = "x_get_post";
export const X_GET_POST_REPLIES_TOOL = "x_get_post_replies";
export const REPLIES_RETURN_SNAPSHOT_TOOL = "replies_return_snapshot";
export const REPLIES_PRESENT_TRIAGE_TOOL = "replies_present_triage";

export type CollectState = {
  expectedURL: string;
  source?: XPost;
  replies?: XReplyCollection;
  snapshotReturned: boolean;
};

export function createCollectState(expectedURL: string): CollectState {
  return {
    expectedURL: parseXStatusURL(expectedURL).canonicalURL,
    snapshotReturned: false,
  };
}

export type CollectEnv = BaseEnv & {
  xClient: XReadClient;
  collectState: CollectState;
  snapshotSink: (snapshot: ReplySnapshot) => void;
};

export function createCollectXTools() {
  return defineTool<CollectEnv>({
    id: "@corbits/example-reply-triage/collect",
    requires: ["xClient", "collectState", "snapshotSink"],
    factory: (env) => ({
      definitions: [
        {
          name: X_GET_POST_TOOL,
          description:
            "Retrieve the source X post and expanded author from the trigger status URL.",
          inputSchema: urlInputSchema,
        },
        {
          name: X_GET_POST_REPLIES_TOOL,
          description:
            "Retrieve a bounded sample of recent replies for the already-loaded source post.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string" },
              maxResults: {
                type: "integer",
                minimum: 10,
                maximum: DEFAULT_REPLY_SAMPLE_SIZE,
              },
            },
            required: ["url"],
            additionalProperties: false,
          },
        },
        {
          name: REPLIES_RETURN_SNAPSHOT_TOOL,
          description:
            "Return the trusted normalized source-and-replies snapshot after both X reads complete.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
      async run(call, signal) {
        try {
          if (call.name === X_GET_POST_TOOL) {
            assertTriggerURL(env.collectState, call.arguments.url);
            if (env.collectState.source !== undefined) {
              throw new Error("x_get_post may be called only once");
            }
            env.collectState.source = await env.xClient.getPost(
              env.collectState.expectedURL,
              signal,
            );
            return success(call.id, env.collectState.source);
          }

          if (call.name === X_GET_POST_REPLIES_TOOL) {
            assertTriggerURL(env.collectState, call.arguments.url);
            if (env.collectState.source === undefined) {
              throw new Error("Call x_get_post before x_get_post_replies");
            }
            if (env.collectState.replies !== undefined) {
              throw new Error("x_get_post_replies may be called only once");
            }
            env.collectState.replies = await env.xClient.getPostReplies({
              url: env.collectState.expectedURL,
              maxResults: Math.min(
                typeof call.arguments.maxResults === "number"
                  ? call.arguments.maxResults
                  : DEFAULT_REPLY_SAMPLE_SIZE,
                DEFAULT_REPLY_SAMPLE_SIZE,
              ),
              signal,
            });
            return success(call.id, env.collectState.replies);
          }

          if (call.name === REPLIES_RETURN_SNAPSHOT_TOOL) {
            if (env.collectState.snapshotReturned) {
              throw new Error("replies_return_snapshot may be called only once");
            }
            if (
              env.collectState.source === undefined ||
              env.collectState.replies === undefined
            ) {
              throw new Error(
                "Call x_get_post and x_get_post_replies before returning the snapshot",
              );
            }
            const snapshot = createReplySnapshot(
              env.collectState.source,
              env.collectState.replies,
              env.collectState.expectedURL,
            );
            env.collectState.snapshotReturned = true;
            env.snapshotSink(snapshot);
            return success(call.id, snapshot, "Reply snapshot accepted");
          }

          return failure(call.id, `Unknown tool: ${call.name}`);
        } catch (error) {
          return failure(call.id, errorMessage(error));
        }
      },
    }),
  });
}

export type TriageEnv = BaseEnv & {
  snapshot: ReplySnapshot;
  triageSink: (triage: ReplyTriage) => void;
};

export function createTriageTools() {
  return defineTool<TriageEnv>({
    id: "@corbits/example-reply-triage/present",
    requires: ["snapshot", "triageSink"],
    factory: (env) => ({
      definitions: [
        {
          name: REPLIES_PRESENT_TRIAGE_TOOL,
          description:
            "Submit one evidence-bound classification for every collected reply plus themes and amplification opportunities.",
          inputSchema: triageInputSchema,
        },
      ],
      async run(call) {
        if (call.name !== REPLIES_PRESENT_TRIAGE_TOOL) {
          return failure(call.id, `Unknown tool: ${call.name}`);
        }
        try {
          const triage = parseReplyTriage(call.arguments, env.snapshot);
          env.triageSink(triage);
          return success(call.id, triage, "Reply triage accepted");
        } catch (error) {
          return failure(call.id, errorMessage(error));
        }
      },
    }),
  });
}

function assertTriggerURL(state: CollectState, value: unknown): void {
  const actual = parseXStatusURL(value);
  const expected = parseXStatusURL(state.expectedURL);
  if (actual.postId !== expected.postId) {
    throw new Error("All collection tools must use the trigger URL");
  }
}

function success(callId: string, detail: unknown, content?: string) {
  return { callId, content: content ?? JSON.stringify(detail), detail };
}

function failure(callId: string, content: string) {
  return { callId, content, isError: true as const };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const urlInputSchema = {
  type: "object",
  properties: { url: { type: "string" } },
  required: ["url"],
  additionalProperties: false,
} as const;

const replyIdSchema = { type: "string" } as const;

const triageInputSchema = {
  type: "object",
  properties: {
    overview: { type: "string" },
    classifications: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        properties: {
          replyId: replyIdSchema,
          priority: {
            type: "string",
            enum: ["respond-now", "respond-later", "no-response"],
          },
          reason: {
            type: "string",
            enum: [
              "question",
              "complaint",
              "purchase-intent",
              "feature-request",
              "misinformation",
              "high-reach-author",
              "praise",
              "spam",
            ],
          },
          summary: { type: "string" },
          recommendedOwner: {
            type: "string",
            enum: ["marketing", "support", "product"],
          },
          suggestedResponseAngle: { type: "string" },
        },
        required: [
          "replyId",
          "priority",
          "reason",
          "summary",
          "recommendedOwner",
        ],
        additionalProperties: false,
      },
    },
    themes: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          count: { type: "integer", minimum: 1 },
          sentiment: {
            type: "string",
            enum: ["positive", "mixed", "negative", "neutral"],
          },
          summary: { type: "string" },
          evidenceReplyIds: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: replyIdSchema,
          },
        },
        required: [
          "label",
          "count",
          "sentiment",
          "summary",
          "evidenceReplyIds",
        ],
        additionalProperties: false,
      },
    },
    amplificationOpportunities: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          replyId: replyIdSchema,
          reason: { type: "string" },
        },
        required: ["replyId", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "overview",
    "classifications",
    "themes",
    "amplificationOpportunities",
  ],
  additionalProperties: false,
} as const;
