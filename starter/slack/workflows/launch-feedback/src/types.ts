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

export type ReplyTriageTrigger = {
  url: string;
  request: string;
  slack: {
    teamId?: string;
    channel: string;
    threadTs: string;
    requestedBy?: string;
  };
};

export type ReplySnapshot = {
  source: {
    url: string;
    postId: string;
    authorUsername: string;
    text: string;
    metrics: {
      replies: number;
      likes: number;
      reposts: number;
      quotes: number;
    };
  };
  coverage: {
    fetchedReplies: number;
    analyzedReplies: number;
    truncated: boolean;
    nextToken?: string;
    searchWindow: "recent-7-days";
  };
  replies: Array<{
    id: string;
    url: string;
    text: string;
    author: {
      username: string;
      followers: number;
      verified: boolean;
    };
    metrics: {
      likes: number;
      replies: number;
      reposts: number;
    };
    directReply: boolean;
  }>;
};

export type ReplyPriority = "respond-now" | "respond-later" | "no-response";

export type ReplyReason = "question" | "complaint" | "feature-request";

export type ReplyTriage = {
  overview: string;
  classifications: Array<{
    priority: ReplyPriority;
    reason: ReplyReason;
    replyURL: string;
    authorUsername: string;
    summary: string;
    recommendedOwner: "marketing" | "support" | "product";
    suggestedResponseAngle?: string;
  }>;
  themes: Array<{
    label: string;
    count: number;
    sentiment: "positive" | "mixed" | "negative" | "neutral";
    summary: string;
    evidenceURLs: string[];
  }>;
  amplificationOpportunities: Array<{
    replyURL: string;
    reason: string;
  }>;
  counts: {
    respondNow: number;
    respondLater: number;
    noResponse: number;
  };
};

export type ReplyTriageResult = {
  snapshot: ReplySnapshot;
  triage: ReplyTriage;
};

export type ReplyDraft = {
  replyId: string;
  replyURL: string;
  authorUsername: string;
  reason: ReplyReason;
  text: string;
};

export type CreateDraftsResult = {
  snapshot: ReplySnapshot;
  triage: ReplyTriage;
  drafts: ReplyDraft[];
};

export type ApprovalPayload = {
  approved: ReplyDraft[];
};

export type PostedReply = {
  replyId: string;
  replyURL: string;
  postedURL: string;
  text: string;
  mode: "live" | "dry-run";
};

export type PostRepliesResult = {
  posted: PostedReply[];
};
