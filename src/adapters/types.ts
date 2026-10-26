import type { LinearProgramSnapshot } from "../engine/linear-harness-policy.ts";

export type TicketComment = {
  body: string;
  createdAt?: string;
};

export type Ticket = {
  id: string;
  identifier: string;
  title: string;
  body: string;
  stateName: string;
  labels: string[];
  /** Set when the tracker groups tickets into a project. */
  projectName?: string;
  blockedBy: { identifier: string; stateName: string }[];
  comments: TicketComment[];
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
  /** Every repo the agent pushed. Land matches these to the work order. */
  branches?: { repoUrl: string; branch: string }[];
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
  /**
   * Milestones, issues, and blockers for a named project.
   * Trackers without projects return null.
   */
  projectSnapshot(name: string): Promise<LinearProgramSnapshot | null>;
};

export type PullRequest = {
  number: number;
  url: string;
  headSha: string;
  branch: string;
  /** False when this call adopted a pull request that was already open. */
  created: boolean;
};

export type QualityProbe = {
  state: "success" | "failure" | "pending";
  detail: string;
  /** Present when no quality run exists for the SHA. */
  committedAt?: string;
};

/** What the forge knows before a merge. `unknown` means the host has not computed it yet. */
export type Mergeability = "clean" | "behind" | "conflict" | "blocked" | "unknown";

/**
 * `base...head` from the forge.
 * `identical` and `behind` have nothing of their own to merge.
 * `unknown` means the host did not answer; the lander still tries.
 */
export type CompareStatus = "ahead" | "behind" | "identical" | "diverged" | "unknown";

export type PullMerge = {
  state: Mergeability;
  headSha: string;
};

export type ForgeAdapter = {
  openPullRequest(input: {
    repoUrl: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<PullRequest>;
  quality(input: { repoUrl: string; headSha: string; workflow: string }): Promise<QualityProbe>;
  /**
   * One empty commit on an existing head so a pull_request workflow can start.
   * Returns the new SHA, or null when this head already requested that run.
   */
  requestQualityRun(input: {
    repoUrl: string;
    branch: string;
    headSha: string;
    message: string;
  }): Promise<string | null>;
  /** Read whether this pull request can merge. A git forge with no pull request reports `clean`. */
  mergeability(input: { repoUrl: string; number: number }): Promise<PullMerge>;
  /** Compare trunk (`base`) to the branch or commit (`head`). */
  compare(input: { repoUrl: string; base: string; head: string }): Promise<CompareStatus>;
  /**
   * Put the trunk commits onto the branch. A git forge has nothing to update
   * until `squashMerge`. An already up-to-date branch resolves.
   */
  updateBranch(input: { repoUrl: string; number: number; expectedHeadSha?: string }): Promise<void>;
  squashMerge(input: {
    repoUrl: string;
    number: number;
    /** Set for a git merge. GitHub squash uses `number`. */
    branch?: string;
    base?: string;
  }): Promise<string>;
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
