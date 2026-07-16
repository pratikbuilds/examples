export type XCredentials = {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
};

export type XUser = {
  id: string;
  name: string;
  username: string;
  profileImageURL?: string;
  verified?: boolean;
  publicMetrics?: {
    followers: number;
    following: number;
    posts: number;
    listed: number;
  };
};

export type XPost = {
  id: string;
  url: string;
  text: string;
  authorId: string;
  author?: XUser;
  createdAt?: string;
  conversationId?: string;
  parentPostId?: string;
  directReply: boolean;
  publicMetrics?: {
    replies: number;
    reposts: number;
    likes: number;
    quotes: number;
  };
};

export type XReplyCollection = {
  sourcePostId: string;
  replies: XPost[];
  analyzedReplies: number;
  nextToken?: string;
  truncated: boolean;
  coverage: {
    source: "recent-search";
    days: 7;
    complete: false;
  };
};

export type FollowUpDraft = {
  strategy: "concise-recap" | "what-we-heard" | "next-steps";
  title: string;
  text: string;
};

export type LaunchFeedback = {
  source: XPost;
  coverage: XReplyCollection["coverage"] & {
    analyzedReplies: number;
    truncated: boolean;
    nextToken?: string;
  };
  summary: string;
  themes: Array<{
    label: string;
    sentiment: "positive" | "mixed" | "negative" | "neutral";
    summary: string;
    evidencePostIds: string[];
  }>;
  faq: Array<{
    question: string;
    suggestedAnswer: string;
    evidencePostIds: string[];
  }>;
  actions: Array<{
    priority: "high" | "medium" | "low";
    owner: "product" | "support" | "marketing";
    action: string;
    evidencePostIds: string[];
  }>;
  drafts: [FollowUpDraft, FollowUpDraft, FollowUpDraft];
  repliesById: Record<string, XPost>;
};

export type ApprovedDraft = {
  draftId: string;
  revision: number;
  text: string;
  approvedBy: string;
  approvedAt: string;
};

export type PostReceipt = {
  mode: "live" | "dry-run";
  postId: string;
  url: string;
  text: string;
  postedAt: string;
};
