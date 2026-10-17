/**
 * Durable-parent routing for Linear delivery.
 *
 * Chat / laptop CLI is the lever. GitHub Actions is the parent that stays
 * awake. Cursor cloud VMs hibernate between conversation turns — do not run
 * the sweep/pipeline join loop there.
 */

export type DeliveryMode = "ground" | "build" | "land" | "pipeline" | "sweep";
export type DeliveryRuntime = "gha" | "local";

export type DeliveryPlan = {
  runtime: DeliveryRuntime;
  mode: DeliveryMode;
  issue: string | null;
  project: string | null;
  surface: string | null;
  noFillGraph: boolean;
  fillGraph: boolean;
  noPruneStaleGraph: boolean;
  /** Args to pass through to `npm run linear:*` when runtime is local. */
  localArgs: string[];
  reason: string;
};

const MODES = new Set<DeliveryMode>([
  "ground",
  "build",
  "land",
  "pipeline",
  "sweep",
]);

function takeValue(
  args: string[],
  i: number,
): { value: string | null; next: number } {
  const next = args[i + 1];
  if (!next || next.startsWith("--")) return { value: null, next: i };
  return { value: next, next: i + 1 };
}

export function planDeliveryInvocation(input: {
  githubActions: boolean;
  envRuntime?: string;
  mode: string;
  argv: string[];
}): DeliveryPlan {
  if (!MODES.has(input.mode as DeliveryMode)) {
    throw new Error(`Unknown mode: ${input.mode}`);
  }
  const mode = input.mode as DeliveryMode;

  let envRuntime = (input.envRuntime ?? "").trim().toLowerCase();
  if (envRuntime !== "gha" && envRuntime !== "local") envRuntime = "";

  let flagRuntime: DeliveryRuntime | null = null;
  const rest: string[] = [];
  for (let i = 0; i < input.argv.length; i++) {
    const a = input.argv[i];
    if (a === "--local") {
      flagRuntime = "local";
      continue;
    }
    if (a === "--runtime" || a.startsWith("--runtime=")) {
      const raw = a.includes("=")
        ? a.slice("--runtime=".length)
        : takeValue(input.argv, i).value;
      if (!a.includes("=")) i += 1;
      if (raw === "local" || raw === "gha") flagRuntime = raw;
      else throw new Error(`Unknown --runtime: ${raw ?? "(missing)"}`);
      continue;
    }
    rest.push(a);
  }

  let issue: string | null = null;
  let projectParts: string[] = [];
  let surface: string | null = null;
  let noFillGraph = false;
  let fillGraph = false;
  let noPruneStaleGraph = false;
  const extras: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--issue") {
      const { value, next } = takeValue(rest, i);
      issue = value ? value.toUpperCase() : null;
      i = next;
      continue;
    }
    if (a === "--project" || a === "--program") {
      projectParts = [];
      let j = i + 1;
      for (; j < rest.length; j++) {
        if (rest[j].startsWith("--")) break;
        projectParts.push(rest[j]);
      }
      i = j - 1;
      continue;
    }
    if (a === "--surface") {
      const { value, next } = takeValue(rest, i);
      surface = value;
      i = next;
      continue;
    }
    if (a === "--no-fill-graph") {
      noFillGraph = true;
      continue;
    }
    if (a === "--fill-graph") {
      fillGraph = true;
      continue;
    }
    if (a === "--no-prune-stale-graph") {
      noPruneStaleGraph = true;
      continue;
    }
    if (mode !== "sweep" && /^[A-Z][A-Z0-9]*-\d+$/i.test(a) && !issue) {
      issue = a.toUpperCase();
      continue;
    }
    extras.push(a);
  }

  const project = projectParts.length ? projectParts.join(" ") : null;
  const localArgs: string[] = [];
  if (mode === "sweep") {
    if (project) localArgs.push("--project", project);
    if (surface) localArgs.push("--surface", surface);
    if (noFillGraph) localArgs.push("--no-fill-graph");
    if (fillGraph && !noFillGraph) localArgs.push("--fill-graph");
    if (noPruneStaleGraph) localArgs.push("--no-prune-stale-graph");
  } else if (issue) {
    localArgs.push("--issue", issue);
    if (surface) localArgs.push("--surface", surface);
  }
  localArgs.push(...extras);

  const lever = mode === "sweep" || mode === "pipeline";
  let runtime: DeliveryRuntime = lever ? "gha" : "local";
  let reason = lever
    ? "default: GitHub Actions is the durable parent (chat VMs hibernate between turns)"
    : "ground/build/land stay in-process so they cannot cancel a live sweep";

  if (input.githubActions) {
    runtime = "local";
    reason = "already inside GitHub Actions — run in-process (do not re-dispatch)";
  } else if (flagRuntime === "local" || envRuntime === "local") {
    runtime = "local";
    reason = flagRuntime === "local"
      ? "--local / --runtime=local requested"
      : "QWS_DELIVERY_RUNTIME=local";
  } else if (flagRuntime === "gha" || envRuntime === "gha") {
    runtime = "gha";
    reason = "explicit GHA runtime";
  }

  return {
    runtime,
    mode,
    issue,
    project,
    surface,
    noFillGraph,
    fillGraph,
    noPruneStaleGraph,
    localArgs,
    reason,
  };
}

export function ghaDispatchFields(plan: DeliveryPlan): Record<string, string> {
  const fields: Record<string, string> = { mode: plan.mode };
  if (plan.issue) fields.issue = plan.issue;
  if (plan.project) fields.project = plan.project;
  if (plan.surface) fields.surface = plan.surface;
  if (plan.noFillGraph) fields.no_fill_graph = "true";
  if (plan.fillGraph && !plan.noFillGraph) fields.fill_graph = "true";
  if (plan.noPruneStaleGraph) fields.no_prune_stale_graph = "true";
  return fields;
}

function isMainModule(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("delivery-runtime.ts");
}

if (isMainModule()) {
  const mode = process.argv[2];
  if (!mode) {
    console.error("Usage: tsx delivery-runtime.ts <mode> [args]");
    process.exit(1);
  }
  const plan = planDeliveryInvocation({
    githubActions: process.env.GITHUB_ACTIONS === "true",
    envRuntime: process.env.QWS_DELIVERY_RUNTIME,
    mode,
    argv: process.argv.slice(3),
  });
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}
