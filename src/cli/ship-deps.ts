import type { ForgeAdapter, LinearProgramTracker, TrackerAdapter, WorkerAdapter } from "../adapters/types.js";
import { githubIssuesTracker, jiraTracker, linearTracker } from "../adapters/trackers.js";
import type { LoopDeps } from "../engine/loop.js";
import type { ProjectPack } from "../schema/pack.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function idleWorker(): WorkerAdapter {
  return {
    kind: "ship-idle",
    start: async () => {
      throw new Error("ship does not start a worker");
    },
    join: async () => {
      throw new Error("ship does not start a worker");
    },
  };
}


function idleForge(): ForgeAdapter {
  return {
    openPullRequest: async () => {
      throw new Error("ship does not open pull requests");
    },
    quality: async () => {
      throw new Error("ship does not open pull requests");
    },
    requestQualityRun: async () => {
      throw new Error("ship does not open pull requests");
    },
    mergeability: async () => {
      throw new Error("ship does not open pull requests");
    },
    updateBranch: async () => {
      throw new Error("ship does not open pull requests");
    },
    directLand: async () => { throw new Error("ship does not land branches"); },
    compare: async () => {
      throw new Error("ship does not open pull requests");
    },
    squashMerge: async () => {
      throw new Error("ship does not open pull requests");
    },
    dispatch: async () => {
      throw new Error("ship does not open pull requests");
    },
  };
}

function trackerFor(
  pack: ProjectPack,
  github?: { token: string; slot: "mint" | "gh-token" },
): TrackerAdapter & Partial<LinearProgramTracker> {
  if (pack.tracker === "jira") {
    if (!pack.jira) throw new Error("Jira tracker configuration is missing");
    return jiraTracker(pack.jira);
  }
  if (pack.tracker === "linear") {
    return linearTracker({
      apiKey: requireEnv("LINEAR_API_KEY"),
      team: pack.linearTeam ?? "",
      intakeState: pack.status.intake,
    });
  }
  const auth = github ?? (pack.identity === "mint"
    ? undefined
    : { token: requireEnv("GH_TOKEN"), slot: "gh-token" as const });
  if (!auth) throw new Error("ship: DELIVERY_LOOP_GITHUB_MINT is required");
  return githubIssuesTracker({
    token: auth.token,
    slot: auth.slot,
    repo: pack.githubRepo ?? "",
    intakeLabel: pack.status.intake,
  });
}

/** Ship uses the tracker for stage receipts and the ticket's current revision. */
export function shipInvocationDeps(
  pack: ProjectPack,
  cwd: string,
  github?: { token: string; slot: "mint" | "gh-token" },
): LoopDeps {
  return {
    pack,
    cwd,
    worker: idleWorker(),
    forge: idleForge(),
    tracker: trackerFor(pack, github),
  };
}
