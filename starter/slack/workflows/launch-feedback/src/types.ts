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
