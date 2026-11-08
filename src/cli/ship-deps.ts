import { CanonicalPathError, type PreparedCredentials } from "../adapters/canonical-path.ts";
import type { ForgeAdapter, TrackerAdapter, WorkerAdapter } from "../adapters/types.js";
import { githubIssuesTracker, linearTracker } from "../adapters/trackers.js";
import { lookupRemoteHead } from "../engine/land-branches.ts";
import type { LoopDeps } from "../engine/loop.js";
import type { ProjectPack } from "../schema/pack.js";

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

function trackerFor(pack: ProjectPack, prepared: PreparedCredentials | null): TrackerAdapter {
  if (pack.tracker === "linear") {
    if (!prepared?.linear) {
      throw new CanonicalPathError("missing-policy", "linear", "missing canonical path for linear");
    }
    return linearTracker({
      credential: prepared.linear,
      team: pack.linearTeam ?? "",
      intakeState: pack.status.intake,
    });
  }
  if (!prepared?.opener) {
    throw new CanonicalPathError("missing-policy", "github", "missing canonical path for github opener");
  }
  return githubIssuesTracker({
    credential: prepared.opener,
    repo: pack.githubRepo ?? "",
    intakeLabel: pack.status.intake,
  });
}

/**
 * Ship runs pack steps. A successful run does not start the coding worker
 * and does not need tracker credentials when the pack owns prod status.
 * A failed step opens the tracker to record one owner edit, then starts
 * the worker.
 */
export function shipInvocationDeps(pack: ProjectPack, cwd: string, prepared: PreparedCredentials | null = null): LoopDeps {
  const needsTracker = pack.ship?.markStatus !== false;
  const opener = prepared?.opener;
  return {
    pack,
    cwd,
    worker: idleWorker(),
    forge: idleForge(),
    tracker: needsTracker ? trackerFor(pack, prepared) : idleTracker(),
    openTracker: () => trackerFor(pack, prepared),
    lookupHead: (repoUrl, branch) => lookupRemoteHead(repoUrl, branch, opener ?? null),
  };
}
