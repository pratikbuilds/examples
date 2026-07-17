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

export type ReplyReason =
  | "question"
  | "complaint"
  | "purchase-intent"
  | "feature-request"
  | "misinformation"
  | "high-reach-author"
  | "praise"
  | "spam";

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

export type FollowUpDraft = {
  strategy: "concise-recap" | "what-we-heard" | "next-steps";
  title: string;
  text: string;
};

export type LaunchFeedback = {
  source: {
    url: string;
    postId: string;
    authorId: string;
    authorUsername: string;
    text: string;
  };
  coverage: {
    analyzedReplies: number;
    truncated: boolean;
    nextToken?: string;
    searchWindow: "recent-7-days";
  };
  summary: string;
  themes: Array<{
    label: string;
    sentiment: "positive" | "mixed" | "negative" | "neutral";
    summary: string;
    evidenceUrls: string[];
  }>;
  faq: Array<{
    question: string;
    suggestedAnswer: string;
    evidenceUrls: string[];
  }>;
  actions: Array<{
    priority: "high" | "medium" | "low";
    owner: "product" | "support" | "marketing";
    action: string;
    evidenceUrls: string[];
  }>;
  drafts: [FollowUpDraft, FollowUpDraft, FollowUpDraft];
};

export type LaunchFeedbackTrigger = {
  url: string;
  request: string;
  slack: {
    teamId?: string;
    channel: string;
    threadTs: string;
    requestedBy?: string;
  };
};

export type DraftActionSignal =
  | ({ publish: true } & ApprovedDraft)
  | { publish: false; reason: "all-drafts-skipped" };

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
