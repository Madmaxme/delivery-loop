import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DesignCheckProbe, FetchLike, Ticket } from "../adapters/types.ts";
import type { DesignRepo, DesignSpec } from "../schema/pack.ts";
import { GITHUB_ACTIONS_APP_ID, GITHUB_ACTIONS_APP_SLUG } from "./github-actions.ts";

const FIGMA_URL_RE =
  /https?:\/\/(?:www\.)?figma\.com\/(?:file|design|proto|board|slides)\/[A-Za-z0-9]+[^\s)<>"'`]*/gi;

export type DesignCheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  appId?: number | null;
  appSlug?: string | null;
  checkSuiteId?: number | null;
  id?: number | null;
  startedAt?: string | null;
};

export type DesignWorkflowEvidence = {
  path?: string | null;
  /** Head SHA of the workflow run. For pull_request this is the pull request head. */
  headSha?: string | null;
  /** SHA the job executed. pull_request_target uses the base revision. */
  runHeadSha?: string | null;
  baseSha?: string | null;
  event?: string | null;
  checkSuiteId?: number | null;
  headBlobSha?: string | null;
  baseBlobSha?: string | null;
};

/** `complete` is false when a list was truncated or a blob could not be read. */
export type DesignCheckEvidence = {
  complete: boolean;
  workflows: readonly DesignWorkflowEvidence[];
  /** Null when the changed-file list could not be read. */
  changedPaths: readonly string[] | null;
  /** Prefixes a pull_request may change without touching what the check executes. */
  allowPaths: readonly string[];
};

/** A workflow file under .github/workflows. Nested paths and `..` are rejected. */
export function isActionsWorkflowPath(path: string): boolean {
  return /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(path);
}

/** One Figma URL, comparable across description, comments, and attachments. */
export function normalizeFigmaUrl(raw: string): string {
  const trimmed = raw.trim().replace(/[)\].,>]+$/g, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (!/(^|\.)figma\.com$/i.test(parsed.hostname)) return trimmed;
  parsed.protocol = "https:";
  parsed.hostname = "www.figma.com";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString();
}

export function figmaUrlsFromText(text: string): string[] {
  const found = text.match(FIGMA_URL_RE) ?? [];
  const urls: string[] = [];
  for (const raw of found) {
    const url = normalizeFigmaUrl(raw);
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

/** Description, comments, and URLs the tracker already copied off attachments. */
export function ticketFigmaUrls(ticket: Ticket): string[] {
  const urls = [
    ...figmaUrlsFromText(ticket.body),
    ...ticket.comments.flatMap((comment) => figmaUrlsFromText(comment.body)),
    ...(ticket.figmaUrls ?? []).map(normalizeFigmaUrl),
  ];
  const unique: string[] = [];
  for (const url of urls) {
    if (url && !unique.includes(url)) unique.push(url);
  }
  return unique;
}

export function designSourceUrls(text: string): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\*\*Design source:\*\*/i.test(lines[i])) continue;
    const chunk = [lines[i]];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\*\*[A-Za-z]/.test(lines[j]) || /^##\s/.test(lines[j])) break;
      chunk.push(lines[j]);
    }
    chunks.push(chunk.join("\n"));
  }
  return figmaUrlsFromText(chunks.join("\n"));
}

function validationRegion(text: string): string {
  const lines = text.split("\n");
  const parts: string[] = [];
  for (const line of lines) {
    if (/\*\*Validation:\*\*/i.test(line)) parts.push(line);
  }
  const start = lines.findIndex((line) => line.trim().toLowerCase() === "## validation");
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      if (/^##\s/.test(line)) break;
      parts.push(line);
    }
  }
  return parts.join("\n");
}

export function validationIncludes(text: string, command: string): boolean {
  return validationRegion(text).includes(command);
}

export type DesignWorkStop =
  | { ok: true }
  | { ok: false; detail: "design-source" | "design-check"; comment: string };

/**
 * Present frame: the work order names one captured URL. That line is not proof.
 * No frame and a UI land repo: Validation names that repo's check command.
 * The land reads a check run either way.
 */
export function designWorkOrderStop(input: {
  ticket: Ticket;
  orderText: string;
  repos: string[];
  design: DesignSpec | undefined;
}): DesignWorkStop {
  const frames = ticketFigmaUrls(input.ticket);
  if (frames.length > 0) {
    const named = new Set(designSourceUrls(input.orderText));
    if (frames.some((url) => named.has(url))) return { ok: true };
    return {
      ok: false,
      detail: "design-source",
      comment: `Work order is missing **Design source:** naming a Figma frame on this ticket. Name one of:\n${frames.map((url) => `- ${url}`).join("\n")}`,
    };
  }
  const missing = (input.design?.repos ?? []).filter(
    (repo) => input.repos.includes(repo.name) && !validationIncludes(input.orderText, repo.check),
  );
  if (missing.length === 0) return { ok: true };
  const lines = missing.map((repo) => `- \`${repo.name}\`: \`${repo.check}\``);
  return {
    ok: false,
    detail: "design-check",
    comment: `Work order Validation is missing the UI check for a land repo with no Figma frame.\n${lines.join("\n")}`,
  };
}

export function designRepo(design: DesignSpec | undefined, name: string): DesignRepo | undefined {
  return design?.repos.find((repo) => repo.name === name);
}

function sha40(value: string | null | undefined): string | null {
  const sha = (value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

function workflowFileMatchesBase(workflow: DesignWorkflowEvidence, suiteId: number): boolean {
  if (workflow.checkSuiteId !== suiteId) return false;
  const path = workflow.path ?? "";
  if (!isActionsWorkflowPath(path)) return false;
  const headBlob = sha40(workflow.headBlobSha);
  const baseBlob = sha40(workflow.baseBlobSha);
  return Boolean(headBlob && baseBlob && headBlob === baseBlob);
}

/** A pull_request may change only these prefixes. Config and tool files are not prefixes. */
export function designChangesAreAllowlisted(
  changedPaths: readonly string[] | null,
  allowPaths: readonly string[],
): boolean {
  if (changedPaths == null || allowPaths.length === 0) return false;
  const roots = allowPaths.map((prefix) => prefix.trim().replace(/\\/g, "/").replace(/\/+$/, "")).filter(Boolean);
  if (roots.length === 0 || roots.some((root) => root.includes("..") || root.startsWith("/"))) return false;
  return changedPaths.every((path) => {
    const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
      return false;
    }
    return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
  });
}

/**
 * pull_request plus an allowlist, or pull_request_target whose run head is the base revision.
 * Any other event is not provenance.
 */
export function designWorkflowProvenance(
  workflow: DesignWorkflowEvidence,
  evidence: DesignCheckEvidence,
  head: string,
): boolean {
  const event = (workflow.event ?? "").trim();
  if (event === "pull_request_target") {
    const runHead = sha40(workflow.runHeadSha);
    const base = sha40(workflow.baseSha);
    return Boolean(runHead && base && runHead === base);
  }
  if (event !== "pull_request") return false;
  if (sha40(workflow.headSha) !== head) return false;
  return designChangesAreAllowlisted(evidence.changedPaths, evidence.allowPaths);
}

/** A success the pull request cannot forge by editing the workflow or what it executes. */
function independentDesignRun(run: DesignCheckRun, evidence: DesignCheckEvidence, head: string): boolean {
  if (run.status !== "completed" || run.conclusion !== "success") return false;
  if (sha40(run.headSha) !== head) return false;
  if (run.appId !== GITHUB_ACTIONS_APP_ID) return false;
  if (run.appSlug != null && run.appSlug !== "" && run.appSlug !== GITHUB_ACTIONS_APP_SLUG) return false;
  if (typeof run.checkSuiteId !== "number" || !Number.isInteger(run.checkSuiteId) || run.checkSuiteId <= 0) {
    return false;
  }
  return evidence.workflows.some(
    (workflow) =>
      workflowFileMatchesBase(workflow, run.checkSuiteId as number) &&
      designWorkflowProvenance(workflow, evidence, head),
  );
}

/** Newest attempt for one check name. "unordered" when several runs cannot be sorted. */
export function latestDesignCheck(runs: readonly DesignCheckRun[]): DesignCheckRun | "unordered" | null {
  if (runs.length === 0) return null;
  if (runs.length === 1) return runs[0] ?? null;
  const sortable = runs.every(
    (run) => typeof run.id === "number" && Number.isInteger(run.id) && typeof run.startedAt === "string" && run.startedAt.length > 0,
  );
  if (!sortable) return "unordered";
  return [...runs].sort((left, right) => {
    const time = (left.startedAt ?? "").localeCompare(right.startedAt ?? "");
    if (time !== 0) return time;
    return (left.id ?? 0) - (right.id ?? 0);
  }).at(-1) ?? null;
}

/**
 * A check run whose sha is not the pull request head is not a result.
 * A success also has to be GitHub Actions, tied to a workflow file that matches the base branch.
 * A missing app, suite, path, or blob is not a success.
 */
export function interpretDesignChecks(
  runs: readonly DesignCheckRun[],
  headSha: string,
  name: string,
  evidence: DesignCheckEvidence,
): DesignCheckProbe {
  const expected = name.trim();
  const head = sha40(headSha);
  if (!expected || !head) {
    return { state: "missing", detail: "design check evidence is incomplete", headSha: null };
  }
  const named = runs.filter((run) => run.name === expected);
  const fresh = named.filter((run) => sha40(run.headSha) === head);
  if (fresh.length === 0) {
    const stale = named.find((run) => run.headSha && sha40(run.headSha) !== head);
    return {
      state: "missing",
      detail: stale
        ? `stale design check ${expected} at ${stale.headSha} ignored`
        : `design check ${expected} missing on ${headSha}`,
      headSha: null,
    };
  }
  const latest = latestDesignCheck(fresh);
  if (latest === "unordered") {
    return {
      state: "failure",
      detail: `design check ${expected} attempts on ${head} cannot be ordered`,
      headSha: null,
    };
  }
  if (!latest) {
    return { state: "missing", detail: `design check ${expected} missing on ${headSha}`, headSha: null };
  }
  if (!evidence.complete) {
    return {
      state: "failure",
      detail: `design check ${expected} evidence is incomplete on ${head}`,
      headSha: null,
    };
  }
  if (latest.status !== "completed") {
    return { state: "pending", detail: `${expected} ${latest.status || "pending"}`, headSha: head };
  }
  if (latest.conclusion && latest.conclusion !== "success") {
    return { state: "failure", detail: `${expected} ${latest.conclusion}`, headSha: head };
  }
  if (independentDesignRun(latest, evidence, head)) {
    return { state: "success", detail: `${expected} success`, headSha: head };
  }
  return {
    state: "failure",
    detail: `design check ${expected} is not an independent GitHub Actions result on ${head}`,
    headSha: null,
  };
}

export function figmaTokenValue(input: {
  figmaToken?: string | null;
  design: DesignSpec | undefined;
}): string | null {
  if (input.figmaToken === null) return null;
  if (typeof input.figmaToken === "string" && input.figmaToken.trim()) return input.figmaToken.trim();
  const name = input.design?.figmaTokenEnv?.trim() || "FIGMA_ACCESS_TOKEN";
  const value = process.env[name]?.trim();
  return value || null;
}

export function parseFigmaTarget(url: string): { fileKey: string; nodeId: string | null } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  const kind = parts[0];
  if (!kind || !["file", "design", "proto", "board", "slides"].includes(kind)) return null;
  const fileKey = parts[1];
  if (!fileKey) return null;
  const node = parsed.searchParams.get("node-id");
  return { fileKey, nodeId: node ? node.replace(/-/g, ":") : null };
}

/** Short frame description. The token is not copied into the text. */
export async function readFigmaFrame(url: string, token: string, fetchImpl: FetchLike): Promise<string> {
  const target = parseFigmaTarget(url);
  if (!target) return `unreadable figma url ${url}`;
  const path = target.nodeId
    ? `/v1/files/${target.fileKey}/nodes?ids=${encodeURIComponent(target.nodeId)}`
    : `/v1/files/${target.fileKey}?depth=1`;
  const response = await fetchImpl(`https://api.figma.com${path}`, {
    headers: { "X-Figma-Token": token },
  });
  if (!response.ok) return `figma read failed: ${response.status}`;
  const json = (await response.json()) as {
    name?: string;
    document?: { name?: string; type?: string };
    nodes?: Record<string, { document?: { id?: string; name?: string; type?: string } } | null>;
  };
  if (json.nodes) {
    const lines = Object.entries(json.nodes).map(([id, node]) => {
      const doc = node?.document;
      return `${doc?.type ?? "NODE"} ${doc?.name ?? id} (${doc?.id ?? id})`;
    });
    return lines.join("\n") || "figma read returned no nodes";
  }
  const name = json.document?.name ?? json.name ?? target.fileKey;
  return `${json.document?.type ?? "DOCUMENT"} ${name}`;
}

const TOKEN_READ_MAX = 20_000;

export function tokenFileText(repoDir: string, tokenFile: string): string {
  const abs = join(repoDir, tokenFile);
  if (!existsSync(abs)) return `Token file missing: ${tokenFile}`;
  const body = readFileSync(abs, "utf8");
  if (body.length <= TOKEN_READ_MAX) return `Token file: ${tokenFile}\n${body}`;
  return `Token file: ${tokenFile}\n${body.slice(0, TOKEN_READ_MAX)}\n…`;
}

export async function designRepairText(input: {
  ticket: Ticket;
  design: DesignSpec | undefined;
  repoName: string;
  repoDir: string;
  figmaToken?: string | null;
  figmaFetch?: FetchLike;
}): Promise<string> {
  const frames = ticketFigmaUrls(input.ticket);
  if (frames.length > 0) {
    const token = figmaTokenValue({ figmaToken: input.figmaToken, design: input.design });
    const fetchImpl = input.figmaFetch ?? fetch;
    const blocks: string[] = [];
    for (const url of frames) {
      const read = token ? await readFigmaFrame(url, token, fetchImpl).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return `figma read failed: ${message}`;
      }) : "missing-credential: figma";
      blocks.push(`${url}\n${read}`);
    }
    return blocks.join("\n\n");
  }
  const spec = designRepo(input.design, input.repoName);
  if (!spec) return "";
  return tokenFileText(input.repoDir, spec.tokenFile);
}
