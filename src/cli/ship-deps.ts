import type { ForgeAdapter, TrackerAdapter, WorkerAdapter } from "../adapters/types.js";
import { githubIssuesTracker, linearTracker } from "../adapters/trackers.js";
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

function idleTracker(): TrackerAdapter {
  return {
    kind: "ship-idle",
    listIntake: async () => {
      throw new Error("ship pack owns status");
    },
    get: async () => {
      throw new Error("ship pack owns status");
    },
    comment: async () => {
      throw new Error("ship pack owns status");
    },
    setState: async () => {
      throw new Error("ship pack owns status");
    },
    addLabel: async () => {
      throw new Error("ship pack owns status");
    },
    removeLabel: async () => {
      throw new Error("ship pack owns status");
    },
    projectSnapshot: async () => null,
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

function trackerFor(pack: ProjectPack): TrackerAdapter {
  const token = requireEnv("GH_TOKEN");
  if (pack.tracker === "linear") {
    return linearTracker({
      apiKey: requireEnv("LINEAR_API_KEY"),
      team: pack.linearTeam ?? "",
      intakeState: pack.status.intake,
    });
  }
  return githubIssuesTracker({
    token,
    repo: pack.githubRepo ?? "",
    intakeLabel: pack.status.intake,
  });
}

/**
 * Ship runs pack steps. It never starts the coding worker, so Cursor /
 * Claude / Codex keys are not required. Tracker credentials are required
 * only when the pack still asks the CLI to set the prod status.
 */
export function shipInvocationDeps(pack: ProjectPack, cwd: string): LoopDeps {
  const needsTracker = pack.ship?.markStatus !== false;
  return {
    pack,
    cwd,
    worker: idleWorker(),
    forge: idleForge(),
    tracker: needsTracker ? trackerFor(pack) : idleTracker(),
  };
}
