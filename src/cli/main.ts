import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

import { gitForge } from "../adapters/forge-git.js";
import { githubForge } from "../adapters/forge-github.js";
import { githubIssuesTracker, linearTracker } from "../adapters/trackers.js";
import {
  claudeWorker,
  codexWorker,
  copilotWorker,
  cursorWorker,
  httpWorker,
} from "../adapters/workers.js";
import { githubRepoFromUrl } from "../adapters/types.js";
import type { ForgeAdapter, TrackerAdapter, WorkerAdapter } from "../adapters/types.js";
import { findConnector } from "../connectors/catalog.js";
import { deliver, ship, sweep, sweepNeedsAnotherPage } from "../engine/loop.js";
import { shipInvocationDeps } from "./ship-deps.js";
import { ghaDispatchFields, planDeliveryInvocation } from "../engine/delivery-runtime.js";
import { defaultStatus, loadPack, type ProjectPack } from "../schema/pack.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function arg(name: string, argv: string[]): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function packPath(cwd: string): string {
  return resolve(cwd, "delivery-loop.yaml");
}

function copyTree(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

export function writeProject(dir: string, pack: ProjectPack): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "delivery-loop.yaml"), stringify(pack));
  const invariants = resolve(dir, pack.invariantsFile);
  if (!existsSync(invariants)) {
    mkdirSync(dirname(invariants), { recursive: true });
    writeFileSync(
      invariants,
      "# Invariants\n\n## example-rule\n\nA rule that must still be true after a change.\n",
    );
  }
  copyTree(resolve(packageRoot, "conduct"), resolve(dir, ".cursor/skills"));
  mkdirSync(resolve(dir, ".github/workflows"), { recursive: true });
  const workflow = readFileSync(resolve(packageRoot, "templates/runner.yml"), "utf8");
  writeFileSync(resolve(dir, ".github/workflows/delivery-loop.yml"), workflow);
}

export function installConnector(dir: string, name: string): void {
  const connector = findConnector(name);
  if (!connector) throw new Error(`Unknown connector: ${name}`);
  const path = packPath(dir);
  const pack = loadPack(path);
  if (!pack.connectors.includes(name)) {
    pack.connectors.push(name);
    writeFileSync(path, stringify(pack));
  }
  const skillDir = resolve(dir, ".cursor/skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    resolve(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${connector.summary}\n---\n\n${connector.skill}\n`,
  );
  const mcpPath = resolve(dir, ".cursor/mcp.json");
  const mcp = existsSync(mcpPath)
    ? (JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers?: Record<string, unknown> })
    : { mcpServers: {} };
  mcp.mcpServers = { ...(mcp.mcpServers ?? {}), [name]: connector.mcp };
  writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function adaptersFor(pack: ProjectPack): {
  tracker: TrackerAdapter;
  worker: WorkerAdapter;
  forge: ForgeAdapter;
} {
  const githubToken = () => requireEnv("GH_TOKEN");
  const forge =
    pack.forge === "git"
      ? gitForge({ cwd: process.cwd() })
      : githubForge({
          token: githubToken(),
          repo:
            pack.githubRepo ??
            githubRepoFromUrl(pack.repos[0].url).owner + "/" + githubRepoFromUrl(pack.repos[0].url).repo,
          commitActors: pack.commitActors,
        });
  const tracker =
    pack.tracker === "linear"
      ? linearTracker({
          apiKey: requireEnv("LINEAR_API_KEY"),
          team: pack.linearTeam ?? "",
          intakeState: pack.status.intake,
        })
      : githubIssuesTracker({
          token: githubToken(),
          repo: pack.githubRepo ?? "",
          intakeLabel: pack.status.intake,
        });
  const worker = workerFor(pack);
  return { tracker, worker, forge };
}

function workerFor(pack: ProjectPack): WorkerAdapter {
  if (pack.worker === "cursor") return cursorWorker({ apiKey: requireEnv("CURSOR_API_KEY") });
  if (pack.worker === "claude") return claudeWorker({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  if (pack.worker === "codex") return codexWorker({ apiKey: requireEnv("OPENAI_API_KEY") });
  if (pack.worker === "copilot") {
    const repo = pack.githubRepo ?? "";
    const [owner, name] = repo.split("/");
    return copilotWorker({ token: requireEnv("GH_TOKEN"), owner, repo: name });
  }
  return httpWorker({
    startUrl: pack.workerHttp?.startUrl ?? "",
    statusUrl: pack.workerHttp?.statusUrl ?? "",
    token: process.env.WORKER_HTTP_TOKEN,
  });
}

function dispatchOrRun(mode: string, argv: string[]): void {
  if (mode === "ship") {
    const packRunner = existsSync(packPath(process.cwd()))
      ? loadPack(packPath(process.cwd())).runner
      : undefined;
    const local =
      packRunner === "local" ||
      process.env.GITHUB_ACTIONS === "true" ||
      process.env.DELIVERY_LOOP_RUNTIME === "local";
    if (!local) {
      const repo = process.env.GITHUB_REPOSITORY;
      if (!repo) throw new Error("GITHUB_REPOSITORY is required to dispatch the runner");
      const issue = argv.find((a) => /^[A-Z][A-Z0-9]*-\d+$/i.test(a));
      const args = ["workflow", "run", "delivery-loop.yml", "--repo", repo, "-f", "mode=ship"];
      if (issue) args.push("-f", `issue=${issue.toUpperCase()}`);
      const result = spawnSync("gh", args, { stdio: "inherit" });
      if (result.status !== 0) process.exit(result.status ?? 1);
      return;
    }
    const pack = loadPack(packPath(process.cwd()));
    const issue = argv.find((a) => /^[A-Z][A-Z0-9]*-\d+$/i.test(a));
    const extra = argv.filter((a) => a !== issue).join(" ");
    ship(shipInvocationDeps(pack, process.cwd()), issue?.toUpperCase(), extra).then(
      () => console.log("shipped"),
      (err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      },
    );
    return;
  }
  const packRunner = existsSync(packPath(process.cwd()))
    ? loadPack(packPath(process.cwd())).runner
    : undefined;
  const plan = planDeliveryInvocation({
    githubActions: process.env.GITHUB_ACTIONS === "true",
    envRuntime: packRunner === "local" ? "local" : process.env.DELIVERY_LOOP_RUNTIME,
    mode,
    argv,
  });
  if (plan.runtime === "gha") {
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo) throw new Error("GITHUB_REPOSITORY is required to dispatch the runner");
    const fields = ghaDispatchFields(plan);
    const result = spawnSync(
      "gh",
      [
        "workflow",
        "run",
        "delivery-loop.yml",
        "--repo",
        repo,
        "--ref",
        process.env.DELIVERY_LOOP_GHA_REF ?? "main",
        ...Object.entries(fields).flatMap(([key, value]) => ["-f", `${key}=${value}`]),
      ],
      { stdio: "inherit" },
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
    console.error(`[delivery-loop] runtime=gha (${plan.reason})`);
    return;
  }
  const pack = loadPack(packPath(process.cwd()));
  const started = Number(
    process.env.DELIVERY_LOOP_PAGE_STARTED_MS || "",
  );
  const deps = {
    pack,
    ...adaptersFor(pack),
    cwd: process.cwd(),
    project: plan.project,
    pageStartedAtMs: Number.isFinite(started) && started > 0 ? started : null,
  };
  if (mode === "sweep") {
    sweep(deps).then((results) => {
      console.log(JSON.stringify(results, null, 2));
      const output = process.env.GITHUB_OUTPUT;
      if (output && sweepNeedsAnotherPage(results)) {
        appendFileSync(output, "chain=true\n");
      }
    });
    return;
  }
  if (mode === "ship") {
    const extra = argv.filter((a) => a.toUpperCase() !== (plan.issue ?? "").toUpperCase()).join(" ");
    ship(deps, plan.issue ?? undefined, extra).then(() => console.log("shipped"));
    return;
  }
  const issue = plan.issue;
  if (!issue) throw new Error("deliver needs a ticket id");
  deliver(deps, issue).then((result) => console.log(JSON.stringify(result, null, 2)));
}

function init(argv: string[]): void {
  const dir = arg("--dir", argv) ?? process.cwd();
  const tracker = (arg("--tracker", argv) ?? "github") as ProjectPack["tracker"];
  const worker = (arg("--worker", argv) ?? "cursor") as ProjectPack["worker"];
  const repo = arg("--github-repo", argv) ?? "owner/repo";
  const trunk = arg("--trunk", argv) ?? "main";
  const url = arg("--repo-url", argv) ?? `https://github.com/${repo}`;
  const name = arg("--repo-name", argv) ?? repo.split("/").pop() ?? "app";
  const pack: ProjectPack = {
    tracker,
    worker,
    githubRepo: repo,
    linearTeam: arg("--linear-team", argv),
    repos: [{ name, url, trunk, packages: arg("--packages", argv)?.split(",") }],
    forge: "github",
    check: "workflow",
    runner: "gha",
    qualityCommand: arg("--quality", argv) ?? "npm test",
    qualityWorkflow: arg("--quality-workflow", argv) ?? "quality",
    invariantsFile: "invariants.md",
    status: {
      ...defaultStatus(),
      intake: tracker === "github" ? "todo" : "Todo",
    },
    connectors: [],
    dev: { steps: [] },
    ship: { steps: [] },
    workerHttp:
      worker === "http"
        ? {
            startUrl: arg("--worker-start", argv) ?? "http://127.0.0.1:9/start",
            statusUrl: arg("--worker-status", argv) ?? "http://127.0.0.1:9/status",
          }
        : undefined,
  };
  writeProject(dir, pack);
  console.log(`Installed delivery-loop in ${dir}`);
}

export function update(argv: string[]): void {
  const dir = arg("--dir", argv) ?? process.cwd();
  const yaml = readFileSync(packPath(dir), "utf8");
  const invariantsPath = resolve(dir, (parse(yaml) as ProjectPack).invariantsFile);
  const invariants = existsSync(invariantsPath) ? readFileSync(invariantsPath, "utf8") : "";
  copyTree(resolve(packageRoot, "conduct"), resolve(dir, ".cursor/skills"));
  mkdirSync(resolve(dir, ".github/workflows"), { recursive: true });
  writeFileSync(
    resolve(dir, ".github/workflows/delivery-loop.yml"),
    readFileSync(resolve(packageRoot, "templates/runner.yml"), "utf8"),
  );
  if (readFileSync(packPath(dir), "utf8") !== yaml) {
    throw new Error("update changed delivery-loop.yaml");
  }
  if (invariants && readFileSync(invariantsPath, "utf8") !== invariants) {
    throw new Error("update changed invariants");
  }
  console.log("Updated skills and runner. Project file and invariants were left in place.");
}

const argv = process.argv.slice(2);
const command = argv[0];

const isCli = (process.argv[1] ?? "").endsWith("main.ts") || (process.argv[1] ?? "").endsWith("delivery-loop.js");
if (isCli) {
  if (command === "init") init(argv.slice(1));
  else if (command === "update") update(argv.slice(1));
  else if (command === "connector" && argv[1] === "add") {
    installConnector(arg("--dir", argv) ?? process.cwd(), argv[2]);
    console.log(`Added connector ${argv[2]}`);
  } else if (command === "sweep" || command === "deliver" || command === "ship") {
    dispatchOrRun(command === "deliver" ? "pipeline" : command, argv.slice(1));
  } else {
    console.error("Usage: delivery-loop init|update|connector add <name>|sweep|deliver <id>|ship [id]");
    process.exit(command ? 1 : 0);
  }
}
