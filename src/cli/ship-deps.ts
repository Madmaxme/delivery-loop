import type { LegacyCapability } from "./trusted-config.ts";
import type { PreparedCredentials } from "../adapters/canonical-path.ts";
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

function envToken(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function trackerFor(
  pack: ProjectPack,
  prepared: PreparedCredentials | null,
  legacy: LegacyCapability | null,
): TrackerAdapter {
  if (pack.tracker === "linear") {
    if (prepared?.linear) {
      return linearTracker({
        credential: prepared.linear,
        team: pack.linearTeam ?? "",
        intakeState: pack.status.intake,
      });
    }
    return linearTracker({
      legacyKey: envToken("LINEAR_API_KEY"),
      legacy,
      team: pack.linearTeam ?? "",
      intakeState: pack.status.intake,
    });
  }
  if (prepared?.opener) {
    return githubIssuesTracker({
      credential: prepared.opener,
      repo: pack.githubRepo ?? "",
      intakeLabel: pack.status.intake,
    });
  }
  return githubIssuesTracker({
    legacyToken: envToken("GH_TOKEN"),
    legacy,
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
export function shipInvocationDeps(
  pack: ProjectPack,
  cwd: string,
  prepared: PreparedCredentials | null = null,
  legacy: LegacyCapability | null = null,
): LoopDeps {
  const needsTracker = pack.ship?.markStatus !== false;
  const opener = prepared?.opener;
  return {
    pack,
    cwd,
    worker: idleWorker(),
    forge: idleForge(),
    tracker: needsTracker ? trackerFor(pack, prepared, legacy) : idleTracker(),
    openTracker: () => trackerFor(pack, prepared, legacy),
    legacy,
    lookupHead: (repoUrl, branch) => lookupRemoteHead(repoUrl, branch, opener ?? null),
    credentialMode: prepared ? "canonical" : "legacy",
    githubHandle: opener ?? null,
    figmaCredential: prepared?.extensions.figma ?? null,
  };
}
