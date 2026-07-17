import { defineTool, type BaseEnv } from "@intx/agent";

import type {
  ApprovalPayload,
  CreateDraftsResult,
  PostedReply,
  ReplyDraft,
  ReplySnapshot,
  ReplyTriage,
  ReplyTriageResult,
  XPost,
  XReplyCollection,
} from "./types";
import {
  createReplySnapshot,
  parseApprovalPayload,
  parseReplyDrafts,
  parseReplyTriage,
  parseXStatusURL,
  toCreateDraftsResult,
} from "./validation";
import {
  DEFAULT_REPLY_SAMPLE_SIZE,
  type XReadClient,
  type XReplyPublisher,
} from "./x-client";

export const X_GET_POST_TOOL = "x_get_post";
export const X_GET_POST_REPLIES_TOOL = "x_get_post_replies";
export const REPLIES_RETURN_CANDIDATES_TOOL = "replies_return_candidates";
/** @deprecated Use REPLIES_RETURN_CANDIDATES_TOOL */
export const REPLIES_RETURN_SNAPSHOT_TOOL = REPLIES_RETURN_CANDIDATES_TOOL;
export const REPLIES_PRESENT_TRIAGE_TOOL = "replies_present_triage";
export const REPLIES_PRESENT_DRAFTS_TOOL = "replies_present_drafts";
export const REPLIES_PUBLISH_APPROVED_TOOL = "replies_publish_approved";

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
          name: REPLIES_RETURN_CANDIDATES_TOOL,
          description:
            "Return a trusted candidate snapshot containing only the selected reply ids from the fetched set.",
          inputSchema: {
            type: "object",
            properties: {
              replyIds: {
                type: "array",
                maxItems: DEFAULT_REPLY_SAMPLE_SIZE,
                items: { type: "string" },
              },
            },
            required: ["replyIds"],
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

          if (call.name === REPLIES_RETURN_CANDIDATES_TOOL) {
            if (env.collectState.snapshotReturned) {
              throw new Error(
                `${REPLIES_RETURN_CANDIDATES_TOOL} may be called only once`,
              );
            }
            if (
              env.collectState.source === undefined ||
              env.collectState.replies === undefined
            ) {
              throw new Error(
                "Call x_get_post and x_get_post_replies before returning candidates",
              );
            }
            const replyIds = parseReplyIdList(call.arguments.replyIds);
            const snapshot = createReplySnapshot(
              env.collectState.source,
              env.collectState.replies,
              env.collectState.expectedURL,
              replyIds,
            );
            env.collectState.snapshotReturned = true;
            env.snapshotSink(snapshot);
            return success(call.id, snapshot, "Candidate snapshot accepted");
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
            "Submit one evidence-bound classification for every candidate reply plus themes and amplification opportunities.",
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

export type CreateEnv = BaseEnv & {
  triageResult: ReplyTriageResult;
  draftsSink: (drafts: ReplyDraft[]) => void;
};

export function createDraftTools() {
  return defineTool<CreateEnv>({
    id: "@corbits/example-reply-triage/drafts",
    requires: ["triageResult", "draftsSink"],
    factory: (env) => ({
      definitions: [
        {
          name: REPLIES_PRESENT_DRAFTS_TOOL,
          description:
            "Submit one short X reply draft for every respond-now classification.",
          inputSchema: draftsInputSchema,
        },
      ],
      async run(call) {
        if (call.name !== REPLIES_PRESENT_DRAFTS_TOOL) {
          return failure(call.id, `Unknown tool: ${call.name}`);
        }
        try {
          const drafts = parseReplyDrafts(call.arguments, env.triageResult);
          env.draftsSink(drafts);
          return success(call.id, drafts, "Reply drafts accepted");
        } catch (error) {
          return failure(call.id, errorMessage(error));
        }
      },
    }),
  });
}

export type PostEnv = BaseEnv & {
  approval: ApprovalPayload;
  xPublisher: XReplyPublisher;
  postSink: (posted: PostedReply[]) => void;
};

export function createPostTools() {
  return defineTool<PostEnv>({
    id: "@corbits/example-reply-triage/post",
    requires: ["approval", "xPublisher", "postSink"],
    factory: (env) => ({
      definitions: [
        {
          name: REPLIES_PUBLISH_APPROVED_TOOL,
          description:
            "Publish every Slack-approved reply draft to X. Call with an empty object.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
      async run(call, signal) {
        if (call.name !== REPLIES_PUBLISH_APPROVED_TOOL) {
          return failure(call.id, `Unknown tool: ${call.name}`);
        }
        try {
          const approval = parseApprovalPayload(env.approval);
          const posted: PostedReply[] = [];
          for (const draft of approval.approved) {
            const receipt = await env.xPublisher.reply(
              {
                text: draft.text,
                inReplyToPostId: draft.replyId,
              },
              signal,
            );
            posted.push({
              replyId: draft.replyId,
              replyURL: draft.replyURL,
              postedURL: receipt.url,
              text: receipt.text,
              mode: receipt.mode,
            });
          }
          env.postSink(posted);
          return success(call.id, posted, "Approved replies published");
        } catch (error) {
          return failure(call.id, errorMessage(error));
        }
      },
    }),
  });
}

export function buildCreateDraftsResult(
  triageResult: ReplyTriageResult,
  drafts: ReplyDraft[],
): CreateDraftsResult {
  return toCreateDraftsResult(triageResult, drafts);
}

function assertTriggerURL(state: CollectState, value: unknown): void {
  const actual = parseXStatusURL(value);
  const expected = parseXStatusURL(state.expectedURL);
  if (actual.postId !== expected.postId) {
    throw new Error("All collection tools must use the trigger URL");
  }
}

function parseReplyIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("replyIds must be an array");
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(`replyIds[${String(index)}] must be a non-empty string`);
    }
    return item.trim();
  });
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
            enum: ["question", "complaint", "feature-request"],
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

const draftsInputSchema = {
  type: "object",
  properties: {
    drafts: {
      type: "array",
      maxItems: 25,
      items: {
        type: "object",
        properties: {
          replyId: replyIdSchema,
          text: { type: "string" },
        },
        required: ["replyId", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["drafts"],
  additionalProperties: false,
} as const;
