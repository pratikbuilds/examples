import {
  defineTool,
  type BaseEnv,
} from "@intx/agent";

import type {
  ApprovedDraft,
  LaunchFeedback,
  PostReceipt,
  XPost,
  XReplyCollection,
} from "./types";
import {
  parseLaunchFeedback,
  parseXStatusURL,
  validatePostText,
} from "./validation";
import type { XClient } from "./x-client";

export const X_GET_POST_TOOL = "x_get_post";
export const X_GET_POST_REPLIES_TOOL = "x_get_post_replies";
export const LAUNCH_PRESENT_FEEDBACK_TOOL = "launch_present_feedback";
export const X_CREATE_POST_TOOL = "x_create_post";

export type AnalysisState = {
  sourceURL?: string;
  source?: XPost;
  replies?: XReplyCollection;
};

export function createAnalysisState(expectedURL?: string): AnalysisState {
  return expectedURL === undefined
    ? {}
    : { sourceURL: parseXStatusURL(expectedURL).canonicalURL };
}

type AnalyzeXEnv = BaseEnv & {
  xClient: XClient;
  analysisState: AnalysisState;
  feedbackSink: (feedback: LaunchFeedback) => void;
};

export function createAnalyzeXTools() {
  return defineTool<AnalyzeXEnv>({
    id: "@corbits/example-launch-feedback/analyze-x",
    requires: ["xClient", "analysisState", "feedbackSink"],
    factory: (env) => ({
      definitions: [
        {
          name: X_GET_POST_TOOL,
          description:
            "Retrieve one X post and its expanded author from a full X status URL.",
          inputSchema: urlInputSchema,
        },
        {
          name: X_GET_POST_REPLIES_TOOL,
          description:
            "Retrieve up to 100 recent replies in the conversation for the same X status URL.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string" },
              maxResults: {
                type: "integer",
                minimum: 10,
                maximum: 100,
              },
            },
            required: ["url"],
            additionalProperties: false,
          },
        },
        {
          name: LAUNCH_PRESENT_FEEDBACK_TOOL,
          description:
            "Submit the final launch analysis, evidence reply ids, actions, FAQ, and exactly three drafts.",
          inputSchema: launchFeedbackInputSchema,
        },
      ],
      async run(call, signal) {
        try {
          if (call.name === X_GET_POST_TOOL) {
            const ref = parseXStatusURL(call.arguments.url);
            assertSameSource(env.analysisState, ref.canonicalURL);
            const post = await env.xClient.getPost(ref.canonicalURL, signal);
            env.analysisState.sourceURL = ref.canonicalURL;
            env.analysisState.source = post;
            return success(call.id, post);
          }

          if (call.name === X_GET_POST_REPLIES_TOOL) {
            const ref = parseXStatusURL(call.arguments.url);
            assertSameSource(env.analysisState, ref.canonicalURL);
            if (env.analysisState.source === undefined) {
              throw new Error("Call x_get_post before x_get_post_replies");
            }
            const maxResults =
              typeof call.arguments.maxResults === "number"
                ? call.arguments.maxResults
                : 100;
            const replies = await env.xClient.getPostReplies({
              url: ref.canonicalURL,
              maxResults,
              signal,
            });
            if (replies.sourcePostId !== env.analysisState.source.id) {
              throw new Error("Reply search source does not match the loaded post");
            }
            env.analysisState.replies = replies;
            return success(call.id, replies);
          }

          if (call.name === LAUNCH_PRESENT_FEEDBACK_TOOL) {
            const source = env.analysisState.source;
            const replies = env.analysisState.replies;
            if (source === undefined || replies === undefined) {
              throw new Error(
                "Call x_get_post and x_get_post_replies before presenting feedback",
              );
            }
            const feedback = parseLaunchFeedback(call.arguments, {
              source,
              replies,
            });
            env.feedbackSink(feedback);
            return success(call.id, feedback, "Launch feedback accepted");
          }

          return errorResult(call.id, `Unknown tool: ${call.name}`);
        } catch (error) {
          return errorResult(call.id, errorMessage(error));
        }
      },
    }),
  });
}

export type ApprovedDraftCapability = {
  readonly approved: Readonly<ApprovedDraft>;
  readonly consumed: boolean;
  compareAndConsume: (
    normalizedText: string,
  ) => { approved: Readonly<ApprovedDraft>; error?: undefined } | { error: string };
};

export function createApprovedDraftCapability(
  approved: ApprovedDraft,
): ApprovedDraftCapability {
  const frozen = Object.freeze({ ...approved });
  let available = true;

  return {
    approved: frozen,
    get consumed() {
      return !available;
    },
    compareAndConsume(normalizedText) {
      if (!available) return { error: "Approved draft was already consumed" };
      if (normalizedText !== frozen.text) {
        return { error: "Tool text does not match the Slack-approved draft" };
      }
      available = false;
      return { approved: frozen };
    },
  };
}

type PublishXEnv = BaseEnv & {
  xClient: XClient;
  approvedDraft: ApprovedDraftCapability;
  receiptSink: (receipt: PostReceipt) => void;
};

export function createCreatePostTool() {
  return defineTool<PublishXEnv>({
    id: "@corbits/example-launch-feedback/create-post",
    requires: ["xClient", "approvedDraft", "receiptSink"],
    factory: (env) => ({
      definitions: [
        {
          name: X_CREATE_POST_TOOL,
          description:
            "Create the exact follow-up post selected and approved in Slack.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
        },
      ],
      async run(call, signal) {
        if (call.name !== X_CREATE_POST_TOOL) {
          return errorResult(call.id, `Unknown tool: ${call.name}`);
        }
        if (signal.aborted) {
          return errorResult(call.id, "Create post was cancelled");
        }
        const validation = validatePostText(call.arguments.text);
        if (validation.error !== undefined) {
          return errorResult(call.id, validation.error);
        }
        const consumed = env.approvedDraft.compareAndConsume(validation.text);
        if (consumed.error !== undefined) {
          return errorResult(call.id, consumed.error);
        }

        try {
          const receipt = await env.xClient.createPost(validation.text, signal);
          let warning: string | undefined;
          try {
            env.receiptSink(receipt);
          } catch (error) {
            warning = `receipt sink failed: ${errorMessage(error)}`;
          }
          return success(
            call.id,
            receipt,
            warning === undefined
              ? JSON.stringify(receipt)
              : `${JSON.stringify(receipt)}\nWarning: ${warning}`,
          );
        } catch (error) {
          return errorResult(call.id, errorMessage(error));
        }
      },
    }),
  });
}

function assertSameSource(state: AnalysisState, canonicalURL: string): void {
  if (state.sourceURL !== undefined && state.sourceURL !== canonicalURL) {
    throw new Error("All launch analysis tools must use the same X status URL");
  }
}

function success(callId: string, detail: unknown, content?: string) {
  return {
    callId,
    content: content ?? JSON.stringify(detail),
    detail,
  };
}

function errorResult(callId: string, content: string) {
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

const evidenceSchema = {
  type: "array",
  maxItems: 5,
  items: { type: "string" },
} as const;

const launchFeedbackInputSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    themes: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          sentiment: {
            type: "string",
            enum: ["positive", "mixed", "negative", "neutral"],
          },
          summary: { type: "string" },
          evidencePostIds: evidenceSchema,
        },
        required: ["label", "sentiment", "summary", "evidencePostIds"],
        additionalProperties: false,
      },
    },
    faq: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          suggestedAnswer: { type: "string" },
          evidencePostIds: evidenceSchema,
        },
        required: ["question", "suggestedAnswer", "evidencePostIds"],
        additionalProperties: false,
      },
    },
    actions: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          priority: { type: "string", enum: ["high", "medium", "low"] },
          owner: {
            type: "string",
            enum: ["product", "support", "marketing"],
          },
          action: { type: "string" },
          evidencePostIds: evidenceSchema,
        },
        required: ["priority", "owner", "action", "evidencePostIds"],
        additionalProperties: false,
      },
    },
    drafts: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          strategy: {
            type: "string",
            enum: ["concise-recap", "what-we-heard", "next-steps"],
          },
          title: { type: "string" },
          text: { type: "string" },
        },
        required: ["strategy", "title", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "themes", "faq", "actions", "drafts"],
  additionalProperties: false,
} as const;
