export type Ticket = {
  id: string;
  identifier: string;
  title: string;
  body: string;
  stateName: string;
  labels: string[];
  blockedBy: { identifier: string; stateName: string }[];
  comments: string[];
};

export type WorkerStart = {
  prompt: string;
  repoUrl: string;
  baseRef: string;
};

export type WorkerResult = {
  status: "running" | "finished" | "failed";
  branch?: string;
  head?: string;
  text: string;
};

export type WorkerAdapter = {
  kind: string;
  start(input: WorkerStart): Promise<{ runId: string }>;
  join(runId: string): Promise<WorkerResult>;
};

export type TrackerAdapter = {
  kind: string;
  listIntake(opts?: { project?: string }): Promise<Ticket[]>;
  get(identifier: string): Promise<Ticket>;
  comment(identifier: string, body: string): Promise<void>;
  setState(identifier: string, state: string): Promise<void>;
  addLabel(identifier: string, label: string): Promise<void>;
  removeLabel(identifier: string, label: string): Promise<void>;
};

export type PullRequest = {
  number: number;
  url: string;
  headSha: string;
  branch: string;
};

export type ForgeAdapter = {
  openPullRequest(input: {
    repoUrl: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<PullRequest>;
  quality(input: { repoUrl: string; headSha: string; workflow: string }): Promise<
    "success" | "failure" | "pending"
  >;
  squashMerge(input: { repoUrl: string; number: number }): Promise<void>;
  dispatch(input: { workflow: string; ref: string; inputs: Record<string, string> }): Promise<void>;
};

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export function githubRepoFromUrl(url: string): { owner: string; repo: string } {
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (!match) throw new Error(`Not a GitHub repo URL: ${url}`);
  return { owner: match[1], repo: match[2] };
}
