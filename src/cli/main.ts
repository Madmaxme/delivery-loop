import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

import { gitForge } from "../adapters/forge-git.js";
import { githubForge } from "../adapters/forge-github.js";
import { githubIssuesTracker, jiraTracker, linearTracker } from "../adapters/trackers.js";
import {
  claudeWorker,
  codexWorker,
  copilotWorker,
  cursorKeySlots,
  cursorWorker,
  httpWorker,
  type WorkerHttpFiles,
  type WorkerHttpIssueClient,
  type WorkerHttpToken,
} from "../adapters/workers.js";
import { createInstallationToken } from "../adapters/github-mint.js";
import { githubRepoFromUrl } from "../adapters/types.js";
import type { ForgeAdapter, LinearProgramTracker, TrackerAdapter, WorkerAdapter } from "../adapters/types.js";
import { findConnector } from "../connectors/catalog.js";
import { writeCredentialSummary } from "../engine/credential-log.js";
import { auditEligibility, deliver, repoCheckoutDir, ship, shipSweep, sweep, sweepNeedsAnotherPage } from "../engine/loop.js";
export { validateStageReceipt, type StageVerifyInput } from "../engine/loop.js";
export type { StageVerificationReceipt } from "../adapters/types.js";
import { shipInvocationDeps } from "./ship-deps.js";
import { ghaDispatchFields, planDeliveryInvocation } from "../engine/delivery-runtime.js";
import { defaultStatus, loadPack, workerKeyNames, type ProjectPack } from "../schema/pack.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function arg(name: string, argv: string[]): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function packPath(cwd: string): string {
  return resolve(cwd, "delivery-loop.yaml");
}

const managedSkillMarker = "delivery-loop-managed-skill:v2\n";
const canonicalSkills = [
  { name: "delivery-loop", source: "conduct/methodology" },
  { name: "delivery-loop-conduct", source: "conduct/conduct" },
] as const;
// The v1 installer had no ownership marker; only its exact copied files may be removed safely.
const legacySkillHashes = {
  conduct: "07254da786e41e496ebf2a0d2415e1246bced801918d38d9b0beb79d3e6f30a0",
  methodology: "d77c523d30ea5a34c7d8ba51dc51d068b9d2b451ddd64eea5e4aecbb89f9eb3b",
} as const;

function lstatIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertDirectory(path: string): void {
  const info = lstatIfPresent(path);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) {
    throw new Error(`installer collision: ${path} must be a real directory`);
  }
}

function sourceFiles(source: string): string[] {
  return readdirSync(source).map((name) => {
    const path = resolve(source, name);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`package skill source must contain regular files only: ${path}`);
    }
    return name;
  });
}

function assertSkillInstallable(target: string, source: string): void {
  const info = lstatIfPresent(target);
  if (info) {
    const marker = resolve(target, ".delivery-loop-managed");
    const markerInfo = lstatIfPresent(marker);
    if (!info.isDirectory() || info.isSymbolicLink() || !markerInfo?.isFile() ||
      markerInfo.isSymbolicLink() || readFileSync(marker, "utf8") !== managedSkillMarker) {
      throw new Error(`installer collision: refusing to replace unowned skill ${target}`);
    }
  }
  for (const name of sourceFiles(source)) {
    const destination = resolve(target, name);
    const destinationInfo = lstatIfPresent(destination);
    if (destinationInfo && (!destinationInfo.isFile() || destinationInfo.isSymbolicLink())) {
      throw new Error(`installer collision: refusing to replace unowned file ${destination}`);
    }
  }
}

function assertGeneratedSkillInstallable(target: string): void {
  const info = lstatIfPresent(target);
  if (!info) return;
  const marker = resolve(target, ".delivery-loop-managed");
  const markerInfo = lstatIfPresent(marker);
  if (!info.isDirectory() || info.isSymbolicLink() || !markerInfo?.isFile() ||
    markerInfo.isSymbolicLink() || readFileSync(marker, "utf8") !== managedSkillMarker) {
    throw new Error(`installer collision: refusing to replace unowned skill ${target}`);
  }
  const skill = lstatIfPresent(resolve(target, "SKILL.md"));
  if (skill && (!skill.isFile() || skill.isSymbolicLink())) {
    throw new Error(`installer collision: refusing to replace unowned file ${resolve(target, "SKILL.md")}`);
  }
}

function assertNativeSkillLink(path: string, target: string): void {
  const info = lstatIfPresent(path);
  if (!info) return;
  if (!info.isSymbolicLink() || resolve(dirname(path), readlinkSync(path)) !== target) {
    throw new Error(`installer collision: refusing to replace unowned skill path ${path}`);
  }
}

function assertLegacyAliasRemovable(path: string, hash: string): void {
  const info = lstatIfPresent(path);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`installer collision: refusing to remove unowned legacy skill ${path}`);
  }
  const entries = readdirSync(path);
  const skill = resolve(path, "SKILL.md");
  const skillInfo = lstatIfPresent(skill);
  const actualHash = skillInfo?.isFile() && !skillInfo.isSymbolicLink()
    ? createHash("sha256").update(readFileSync(skill)).digest("hex")
    : "";
  if (entries.length !== 1 || entries[0] !== "SKILL.md" || actualHash !== hash) {
    throw new Error(`installer collision: refusing to remove unowned legacy skill ${path}`);
  }
}

function assertHarnessInstallable(dir: string): void {
  const directories = [
    ".agents", ".agents/skills", ".cursor", ".cursor/skills", ".cursor/rules",
    ".claude", ".claude/skills", ".github", ".github/workflows",
  ];
  for (const path of directories) assertDirectory(resolve(dir, path));

  for (const skill of canonicalSkills) {
    const source = resolve(packageRoot, skill.source);
    const target = resolve(dir, ".agents/skills", skill.name);
    assertSkillInstallable(target, source);
    for (const client of [".cursor", ".claude"]) {
      assertNativeSkillLink(resolve(dir, client, "skills", skill.name), target);
    }
  }
  assertLegacyAliasRemovable(resolve(dir, ".cursor/skills/conduct"), legacySkillHashes.conduct);
  assertLegacyAliasRemovable(resolve(dir, ".cursor/skills/methodology"), legacySkillHashes.methodology);
}

function installSkill(dir: string, name: string, source: string): void {
  const target = resolve(dir, ".agents/skills", name);
  mkdirSync(target, { recursive: true });
  for (const file of sourceFiles(source)) {
    copyFileSync(resolve(source, file), resolve(target, file));
  }
  writeFileSync(resolve(target, ".delivery-loop-managed"), managedSkillMarker);
}

function installNativeSkillLink(dir: string, client: string, name: string): void {
  const target = resolve(dir, ".agents/skills", name);
  const link = resolve(dir, client, "skills", name);
  if (lstatIfPresent(link)) return;
  const linkTarget = process.platform === "win32" ? target : relative(dirname(link), target);
  symlinkSync(linkTarget, link, process.platform === "win32" ? "junction" : "dir");
}

/** The runner installs the tag of the package that wrote the workflow. Clients do not install main. */
export function runnerWorkflowText(): string {
  const version = (JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as { version: string }).version;
  return readFileSync(resolve(packageRoot, "templates/runner.yml"), "utf8").replaceAll(
    "__DELIVERY_LOOP_REF__",
    `v${version}`,
  );
}

export function failForPolicyErrors(results: readonly { outcome: string }[]): void {
  if (results.some((result) => result.outcome === "policy-error")) process.exitCode = 1;
}

function installHarnessFiles(dir: string): void {
  assertHarnessInstallable(dir);
  mkdirSync(resolve(dir, ".agents/skills"), { recursive: true });
  mkdirSync(resolve(dir, ".cursor/skills"), { recursive: true });
  mkdirSync(resolve(dir, ".claude/skills"), { recursive: true });
  for (const skill of canonicalSkills) {
    installSkill(dir, skill.name, resolve(packageRoot, skill.source));
    installNativeSkillLink(dir, ".cursor", skill.name);
    installNativeSkillLink(dir, ".claude", skill.name);
  }
  rmSync(resolve(dir, ".cursor/skills/conduct"), { recursive: true, force: true });
  rmSync(resolve(dir, ".cursor/skills/methodology"), { recursive: true, force: true });
  mkdirSync(resolve(dir, ".cursor/rules"), { recursive: true });
  copyFileSync(
    resolve(packageRoot, ".cursor/rules/delivery-loop.mdc"),
    resolve(dir, ".cursor/rules/delivery-loop.mdc"),
  );
  mkdirSync(resolve(dir, ".github/workflows"), { recursive: true });
  writeFileSync(resolve(dir, ".github/workflows/delivery-loop.yml"), runnerWorkflowText());
}

export function writeProject(dir: string, pack: ProjectPack): void {
  assertHarnessInstallable(dir);
  if (lstatIfPresent(packPath(dir))) {
    throw new Error(`installer collision: refusing to overwrite ${packPath(dir)}; use update`);
  }
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
  installHarnessFiles(dir);
}

export function installConnector(dir: string, name: string): void {
  const connector = findConnector(name);
  if (!connector) throw new Error(`Unknown connector: ${name}`);
  const path = packPath(dir);
  const packText = readFileSync(path, "utf8");
  const pack = loadPack(path);
  const skillDir = resolve(dir, ".agents/skills", name);
  for (const directory of [
    ".agents", ".agents/skills", ".cursor", ".cursor/skills", ".claude", ".claude/skills",
  ]) assertDirectory(resolve(dir, directory));
  assertGeneratedSkillInstallable(skillDir);
  for (const client of [".cursor", ".claude"]) {
    assertNativeSkillLink(resolve(dir, client, "skills", name), skillDir);
  }

  const mcpPath = resolve(dir, ".cursor/mcp.json");
  const mcpInfo = lstatIfPresent(mcpPath);
  if (mcpInfo && (!mcpInfo.isFile() || mcpInfo.isSymbolicLink())) {
    throw new Error(`installer collision: refusing to replace unowned MCP config ${mcpPath}`);
  }
  const mcp = mcpInfo
    ? JSON.parse(readFileSync(mcpPath, "utf8")) as Record<string, unknown>
    : {};
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) {
    throw new Error(`invalid MCP config: ${mcpPath}`);
  }
  const configuredServers = mcp.mcpServers;
  if (configuredServers !== undefined &&
    (!configuredServers || typeof configuredServers !== "object" || Array.isArray(configuredServers))) {
    throw new Error(`invalid MCP servers in ${mcpPath}`);
  }
  const servers = (configuredServers ?? {}) as Record<string, unknown>;
  const existingServer = servers[name];
  if (existingServer !== undefined) {
    if (!existingServer || typeof existingServer !== "object" || Array.isArray(existingServer) ||
      !Object.entries(connector.mcp).every(([key, value]) =>
        (existingServer as Record<string, unknown>)[key] === value)) {
      throw new Error(`installer collision: refusing to replace existing MCP server ${name}`);
    }
  }

  mkdirSync(skillDir, { recursive: true });
  writeFileSync(resolve(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${connector.summary}\n---\n\n${connector.skill}\n`);
  writeFileSync(resolve(skillDir, ".delivery-loop-managed"), managedSkillMarker);
  for (const client of [".cursor", ".claude"]) installNativeSkillLink(dir, client, name);
  if (existingServer === undefined) {
    mcp.mcpServers = { ...servers, [name]: connector.mcp };
    writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
  }
  if (!pack.connectors.includes(name)) {
    const rawPack = parse(packText) as Record<string, unknown>;
    rawPack.connectors = [...pack.connectors, name];
    writeFileSync(path, stringify(rawPack));
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Named owners come from the fetched trunk file. The working copy is not the allowlist. */
export function commitActorsFromTrustedRef(pack: ProjectPack): ProjectPack["commitActors"] {
  const trunk = pack.agent?.trunk ?? "main";
  const ref = `origin/${trunk}:delivery-loop.yaml`;
  const shown = spawnSync("git", ["show", ref], { cwd: process.cwd(), encoding: "utf8" });
  if (shown.status !== 0 || !shown.stdout?.trim()) {
    throw new Error(`commitActors must be read from ${ref}, not the working tree`);
  }
  const parsed = parse(shown.stdout) as { commitActors?: ProjectPack["commitActors"] };
  return parsed.commitActors ?? [];
}

function trackerFor(pack: ProjectPack): TrackerAdapter & Partial<LinearProgramTracker> {
  if (pack.tracker === "linear") {
    return linearTracker({
      apiKey: requireEnv("LINEAR_API_KEY"),
      team: pack.linearTeam ?? "",
      intakeState: pack.status.intake,
    });
  }
  if (pack.tracker === "github") {
    return githubIssuesTracker({
      token: requireEnv("GH_TOKEN"),
      repo: pack.githubRepo ?? "",
      intakeLabel: pack.status.intake,
    });
  }
  if (!pack.jira) throw new Error("Jira tracker configuration is missing");
  return jiraTracker(pack.jira);
}

function openForge(pack: ProjectPack, withActors: boolean): {
  forge: ForgeAdapter;
  tokens: WorkerHttpToken;
} {
  const checkoutDir = (repoUrl: string) => {
    const spec = pack.repos.find((repo) => repo.url === repoUrl);
    if (!spec) throw new Error(`No repository is configured for ${repoUrl}`);
    return repoCheckoutDir(process.cwd(), spec, pack);
  };
  // The generic Git forge relies on caller-configured remote auth; Actions credentials are not persisted in the checkout.
  const forgeToken = pack.forge === "git" ? "" : requireEnv("GH_TOKEN");
  const installation = createInstallationToken({
    command: () => process.env.DELIVERY_LOOP_GITHUB_MINT?.trim() ?? "",
    fallbackToken: forgeToken,
  });
  const forge =
    pack.forge === "git"
      ? gitForge({ cwd: process.cwd(), checkoutDir })
      : githubForge({
          token: forgeToken,
          installation,
          repo: pack.githubRepo ?? `${githubRepoFromUrl(pack.repos[0].url).owner}/${githubRepoFromUrl(pack.repos[0].url).repo}`,
          ...(withActors ? { commitActors: commitActorsFromTrustedRef(pack) } : {}),
        });
  return {
    forge,
    tokens: {
      mint: () => installation.get(),
      forge: () => ({ token: forgeToken, slot: "gh-token" }),
    },
  };
}

export function adaptersFor(pack: ProjectPack): {
  tracker: TrackerAdapter & Partial<LinearProgramTracker>;
  worker: WorkerAdapter;
  forge: ForgeAdapter;
} {
  const { forge, tokens } = openForge(pack, true);
  const tracker = trackerFor(pack);
  const worker = workerFor(pack, tokens, forge);
  return { tracker, worker, forge };
}

function httpTokens(explicit?: WorkerHttpToken): WorkerHttpToken {
  if (explicit) return explicit;
  const token = process.env.GH_TOKEN ?? "";
  const installation = createInstallationToken({
    command: () => process.env.DELIVERY_LOOP_GITHUB_MINT?.trim() ?? "",
    fallbackToken: token,
  });
  return {
    mint: () => installation.get(),
    forge: () => ({ token, slot: "gh-token" }),
  };
}

function issuesFromForge(forge: ForgeAdapter | undefined): WorkerHttpIssueClient | undefined {
  if (!forge?.createIssue || !forge.assignIssue || !forge.actorLogin) return undefined;
  const createIssue = forge.createIssue.bind(forge);
  const assignIssue = forge.assignIssue.bind(forge);
  const actorLogin = forge.actorLogin.bind(forge);
  return {
    open(input) {
      return createIssue({ ...input, endpoint: "worker-request-issue" });
    },
    assign(input) {
      return assignIssue({ ...input, endpoint: "worker-request-assign" });
    },
    actor() {
      return actorLogin();
    },
  };
}

function filesFromForge(forge: ForgeAdapter | undefined): WorkerHttpFiles | undefined {
  if (!forge?.writeTextFile || !forge.readTextFile) return undefined;
  const writeTextFile = forge.writeTextFile.bind(forge);
  const readTextFile = forge.readTextFile.bind(forge);
  return {
    write(input) {
      return writeTextFile({
        repo: input.repo,
        branch: input.branch,
        path: input.path,
        text: input.text,
        message: input.message ?? "record a pending worker result",
        endpoint: "worker-http-seed",
      });
    },
    read(input) {
      return readTextFile({ ...input, endpoint: "worker-http-status" });
    },
  };
}

function workerFor(pack: ProjectPack, tokens?: WorkerHttpToken, forge?: ForgeAdapter): WorkerAdapter {
  if (pack.worker === "cursor") {
    const names = workerKeyNames(pack);
    const primary = process.env[names.primary];
    if (!primary?.trim()) throw new Error(`${names.primary} is required`);
    return cursorWorker({
      slots: cursorKeySlots(primary, process.env[names.fallback]),
      model: pack.workerModel,
    });
  }
  if (pack.worker === "claude") return claudeWorker({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  if (pack.worker === "codex") return codexWorker({ apiKey: requireEnv("OPENAI_API_KEY") });
  if (pack.worker === "copilot") {
    const repo = pack.githubRepo ?? "";
    const [owner, name] = repo.split("/");
    return copilotWorker({ token: requireEnv("GH_TOKEN"), owner, repo: name });
  }
  if (pack.worker === "http") {
    return httpWorker({
      startUrl: pack.workerHttp?.startUrl ?? "",
      statusUrl: pack.workerHttp?.statusUrl ?? "",
      model: pack.workerModel,
      pollMs: pack.workerHttp?.pollMs,
      maxWaitMs: pack.workerHttp?.maxWaitMs,
      startHeaders: pack.workerHttp?.startHeaders,
      statusHeaders: pack.workerHttp?.statusHeaders,
      statusStore: pack.workerHttp?.statusStore,
      request: pack.workerHttp?.request,
      files: filesFromForge(forge),
      issues: issuesFromForge(forge),
      token: process.env.WORKER_HTTP_TOKEN,
      tokens: httpTokens(tokens),
    });
  }
  throw new Error(`worker ${pack.worker} is not a launcher`);
}

function dispatchOrRun(mode: string, argv: string[]): void {
  if (mode === "ship") {
    const packRunner = existsSync(packPath(process.cwd()))
      ? loadPack(packPath(process.cwd())).runner
      : undefined;
    const sweepMode = argv.includes("sweep");
    const continueMode = argv.includes("continue");
    const rest = argv.filter((item) => item !== "continue" && item !== "sweep");
    const shipAction = sweepMode ? "sweep" : continueMode ? "continue" : "ship";
    const plan = planDeliveryInvocation({
      githubActions: process.env.GITHUB_ACTIONS === "true",
      envRuntime: packRunner === "local" ? "local" : process.env.DELIVERY_LOOP_RUNTIME,
      mode: "ship",
      argv: rest,
      shipAction,
    });
    if (plan.runtime === "gha") {
      const repo = process.env.GITHUB_REPOSITORY;
      if (!repo) throw new Error("GITHUB_REPOSITORY is required to dispatch the runner");
      const fields = ghaDispatchFields(plan);
      const result = spawnSync(
        "gh",
        ["workflow", "run", "delivery-loop.yml", "--repo", repo, ...Object.entries(fields).flatMap(([key, value]) => ["-f", `${key}=${value}`])],
        { stdio: "inherit" },
      );
      if (result.status !== 0) process.exit(result.status ?? 1);
      return;
    }
    const pack = loadPack(packPath(process.cwd()));
    const issue = plan.issue;
    const action = plan.shipAction ?? "ship";
    if (action === "ship" && !issue) throw new Error("ship needs a ticket id");
    const deps = shipInvocationDeps(pack, process.cwd());
    deps.ownerHeal = async (input) => {
      const side = pack.workerHttp?.statusStore ? openForge(pack, false) : undefined;
      const worker = workerFor(pack, side?.tokens, side?.forge);
      const started = await worker.start(input);
      const joined = await worker.join(started.runId);
      if (joined.status === "failed") throw new Error(joined.text || "owner edit failed");
      return joined.text;
    };
    const run = action === "sweep" ? shipSweep(deps) : ship(deps, issue ?? undefined, action === "continue" ? "continue" : "ship");
    run.then(
      (result) => {
        for (const line of result.lines) console.log(line);
        if (result.exitCode !== 0) process.exitCode = result.exitCode;
        else if (result.parked) console.log("ship parked");
        else if (result.shipped !== false) console.log("shipped");
      },
      (err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      },
    ).finally(() => {
      writeCredentialSummary();
    });
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
  if (mode === "audit") {
    auditEligibility({
      pack,
      tracker: trackerFor(pack),
      cwd: process.cwd(),
      project: plan.project,
    })
      .then((results) => {
        console.log(JSON.stringify(results, null, 2));
        failForPolicyErrors(results);
      })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
    return;
  }
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
    sweep(deps)
      .then((results) => {
        console.log(JSON.stringify(results, null, 2));
        failForPolicyErrors(results);
        const output = process.env.GITHUB_OUTPUT;
        if (output && sweepNeedsAnotherPage(results)) {
          appendFileSync(output, "chain=true\n");
        }
      })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      })
      .finally(() => {
        writeCredentialSummary();
      });
    return;
  }
  const issue = plan.issue;
  if (!issue) throw new Error("deliver needs a ticket id");
  const until = mode === "ground" ? "ground" : undefined;
  deliver(deps, issue, until ? { until } : undefined)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      failForPolicyErrors([result]);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(() => {
      writeCredentialSummary();
    });
}

function requiredArg(name: string, argv: string[]): string {
  const value = arg(name, argv)?.trim();
  if (!value) throw new Error(`init requires ${name}`);
  return value;
}

function jiraConfigFromArgs(argv: string[]): NonNullable<ProjectPack["jira"]> {
  const apiBaseUrl = requiredArg("--jira-api-base-url", argv);
  const authHeaderEnv = requiredArg("--jira-auth-header-env", argv);
  const intakeJql = requiredArg("--jira-intake-jql", argv);
  const approvalFieldId = requiredArg("--jira-approval-field-id", argv);
  let base: URL;
  try {
    base = new URL(apiBaseUrl);
  } catch {
    throw new Error("init requires --jira-api-base-url to be an HTTPS URL");
  }
  if (base.protocol !== "https:" || !base.host || base.username || base.password || base.search || base.hash) {
    throw new Error("init requires --jira-api-base-url to be HTTPS without credentials, query, or fragment");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(authHeaderEnv)) {
    throw new Error("init requires --jira-auth-header-env to name an environment variable");
  }
  if (!intakeJql) throw new Error("init requires non-empty --jira-intake-jql");
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(approvalFieldId)) {
    throw new Error("init requires --jira-approval-field-id to be a Jira field ID");
  }
  return {
    apiBaseUrl: base.toString().replace(/\/$/, ""),
    authHeaderEnv,
    intakeJql,
    approvalFieldId,
  };
}

export function init(argv: string[]): void {
  const dir = arg("--dir", argv) ?? process.cwd();
  const trackerName = arg("--tracker", argv) ?? "github";
  if (!["linear", "github", "jira"].includes(trackerName)) {
    throw new Error("init --tracker must be linear, github, or jira");
  }
  const tracker = trackerName as ProjectPack["tracker"];
  const workerName = arg("--worker", argv) ?? "cursor";
  if (!["cursor", "claude", "codex", "copilot", "http"].includes(workerName)) {
    throw new Error("init --worker must be cursor, claude, codex, copilot, or http");
  }
  const worker = workerName as ProjectPack["worker"];
  const eligibilityMode = arg("--eligibility", argv);
  if (eligibilityMode !== "none" && eligibilityMode !== "command") {
    throw new Error("init requires --eligibility none or command");
  }
  const eligibility: ProjectPack["eligibility"] = eligibilityMode === "none"
    ? { mode: "none" }
    : { mode: "command", command: requiredArg("--eligibility-command", argv) };
  const jira = tracker === "jira" ? jiraConfigFromArgs(argv) : undefined;
  const repo = arg("--github-repo", argv) ?? "owner/repo";
  const trunk = arg("--trunk", argv) ?? "main";
  const url = arg("--repo-url", argv) ?? `https://github.com/${repo}`;
  const name = arg("--repo-name", argv) ?? repo.split("/").pop() ?? "app";
  const pack: ProjectPack = {
    schemaVersion: 2,
    tracker,
    worker,
    githubRepo: tracker === "github" ? repo : undefined,
    jira,
    linearTeam: arg("--linear-team", argv),
    repos: [{ name, url, trunk, packages: arg("--packages", argv)?.split(",") }],
    forge: "github",
    check: "workflow",
    runner: "gha",
    qualityCommand: arg("--quality", argv) ?? "npm test",
    qualityWorkflow: arg("--quality-workflow", argv) ?? "quality",
    invariantsFile: "invariants.md",
    eligibility,
    landingStrategy: "pull-request",
    promotionStages: [],
    status: {
      ...defaultStatus(),
      intake: tracker === "github" ? "todo" : "Todo",
      complete: "Complete",
    },
    connectors: [],
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
  installHarnessFiles(dir);
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
  } else if (command === "sweep" || command === "audit" || command === "deliver" || command === "ground" || command === "ship") {
    dispatchOrRun(command === "deliver" ? "pipeline" : command, argv.slice(1));
  } else {
    console.error(
      "Usage: delivery-loop init|update|connector add <name>|audit|sweep|deliver <id>|ground <id>|ship [continue] <id>|ship sweep",
    );
    process.exit(command ? 1 : 0);
  }
}
