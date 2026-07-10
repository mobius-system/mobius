export interface ThreadItem {
  id: string;
  workspace: string;
  title: string;
  age?: string;
  additions?: number;
  deletions?: number;
  external?: boolean;
  muted?: boolean;
}

export const threadGroups: Array<{ workspace: string; threads: ThreadItem[] }> = [
  {
    workspace: "paicoding-admin",
    threads: [
      {
        id: "author-copy",
        workspace: "paicoding-admin",
        title: "http://127.0.0.1:3301/#/author/zsx...",
        age: "1h",
      },
    ],
  },
  {
    workspace: "paicoding",
    threads: [
      {
        id: "ssl-automation",
        workspace: "paicoding",
        title: "更新 ssl 证书自动化请求 包括...",
        age: "18m",
        external: true,
      },
      {
        id: "expire-time",
        workspace: "paicoding",
        title: "Fix table expireTime display",
        age: "44m",
        additions: 8,
        deletions: 2,
      },
    ],
  },
  {
    workspace: "PaiAgent-one",
    threads: [],
  },
  {
    workspace: "PaiAgent",
    threads: [],
  },
];
