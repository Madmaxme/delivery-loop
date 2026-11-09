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
  /**
   * Figma URLs from the description, comments, and tracker attachments.
   * The engine also reads URLs still sitting in the text.
   */
  figmaUrls?: string[];
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

/** A named check on one commit. `headSha` null means no run for that commit. */
export type DesignCheckProbe = {
  state: "success" | "failure" | "pending" | "missing";
  detail: string;
  headSha: string | null;
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

/** One pull request on a head branch. `merged` carries the squash commit. */
export type ListedPull = {
  number: number;
  url: string;
  headSha: string;
  branch: string;
  base: string;
  state: "open" | "merged" | "closed";
  mergedSha: string | null;
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
   * One check run on `headSha`. A run recorded on another sha is not a result.
   * Forges that have no check API omit this.
   */
  designCheck?(input: { repoUrl: string; headSha: string; name: string }): Promise<DesignCheckProbe>;
  /**
   * One startup read of each configured credential. A forge with nothing to
   * probe omits this. A failed probe is logged and does not stop the run.
   */
  probeCredentials?(): Promise<void>;
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
   * Pull requests for one head branch. Forges without a pull-request list omit this.
   */
  listPullRequests?(input: {
    repoUrl: string;
    head: string;
    base: string;
  }): Promise<ListedPull[]>;
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
    /** Current pull request head. GitHub rejects the merge when it moved. */
    headSha?: string;
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
