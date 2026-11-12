import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { matchesJourneySpec } from "../../scripts/journey-proof.mjs";
import type { InvariantHeading } from "../schema/pack.ts";

export const VERDICTS = [
  "BUILDABLE",
  "NEEDS DIAGNOSIS",
  "NEEDS RESCOPE",
  "WRONG DIAGNOSIS",
  "ALREADY SHIPPED",
] as const;

export type Verdict = (typeof VERDICTS)[number];

export type AcceptanceCriterion = {
  id: string;
  text: string;
  source: string;
  /** Stage ids this criterion applies to. Omitted means every stage. */
  stages?: string[];
  /** Repo names this criterion applies to. Omitted means every repo that stage landed. */
  repos?: string[];
};

export type WorkOrder = {
  repos: string[];
  allowlist: string[];
  invariant: string;
  decision: string;
  symbols: string[];
  validation: string[];
  criteria: AcceptanceCriterion[];
  stop: string;
  connector?: string;
};

function field(text: string, name: string): string {
  const re = new RegExp(`\\*\\*${name}:\\*\\*[ \\t]*(.*)`, "i");
  const line = text.match(re)?.[1] ?? "";
  return line.trim();
}

function words(value: string): string[] {
  const ticks = [...value.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
  if (ticks.length) return ticks.filter(Boolean);
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const HANDOFF_RE =
  /<!--\s*GROUNDING_HANDOFF\s*([\s\S]*?)\s*GROUNDING_HANDOFF\s*-->/i;

/** Verdict only from a labeled line. A mention of the word is not a verdict. */
export function parseVerdict(text: string): Verdict | null {
  const handoff = text.match(HANDOFF_RE)?.[1] ?? text;
  const labeled = handoff.match(/^(?:\*\*Verdict:\*\*|VERDICT:)\s*([A-Z][A-Z ]+)/im);
  const raw = (labeled?.[1] ?? "").trim().toUpperCase();
  if (raw && (VERDICTS as readonly string[]).includes(raw)) return raw as Verdict;
  return null;
}

function packetBody(text: string): string {
  const handoff = text.match(HANDOFF_RE)?.[1];
  if (handoff) {
    const split = handoff.split(/^BUILD_PACKET:\s*\n?/m);
    if (split[1]?.trim()) return split[1];
  }
  const wrapped = text.match(/<!--\s*BUILD_PACKET\s*([\s\S]*?)\s*BUILD_PACKET\s*-->/i)?.[1];
  return wrapped?.trim() ? wrapped : text;
}

function section(text: string, name: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${name.toLowerCase()}`);
  if (start < 0) return "";
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    body.push(line);
  }
  return body.join("\n").trim();
}

function scopeNames(cell: string): string[] | null {
  const names = cell.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  if (new Set(names).size !== names.length) return null;
  return names;
}

function acceptanceCriteria(text: string): AcceptanceCriterion[] | null {
  const rows = section(text, "Acceptance criteria").split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"));
  const cells = (row: string) => row.slice(1, -1).split("|").map((cell) => cell.trim());
  const headers = cells(rows[0] ?? "").map((cell) => cell.toLowerCase());
  const divider = cells(rows[1] ?? "");
  const extra = headers.slice(3);
  if (rows.length < 3 || headers.slice(0, 3).join(",") !== "id,text,source" ||
    extra.some((name, index) => (name !== "stages" && name !== "repos") || extra.indexOf(name) !== index) ||
    divider.length !== headers.length || divider.some((cell) => !/^:?-{3,}:?$/.test(cell))) return null;
  const criteria: AcceptanceCriterion[] = [];
  const ids = new Set<string>();
  const stagesIndex = headers.indexOf("stages");
  const reposIndex = headers.indexOf("repos");
  for (const row of rows.slice(2)) {
    const values = cells(row);
    const id = values[0]?.replace(/^`|`$/g, "").trim() ?? "";
    const criterionText = values[1]?.trim() ?? "";
    const source = values[2]?.replace(/^`|`$/g, "").trim() ?? "";
    const key = id.toLowerCase();
    if (!id || !criterionText || !source || values.length !== headers.length || ids.has(key)) return null;
    const criterion: AcceptanceCriterion = { id, text: criterionText, source };
    if (stagesIndex >= 0) {
      const names = scopeNames(values[stagesIndex] ?? "");
      if (!names) return null;
      if (names.length) criterion.stages = names;
    }
    if (reposIndex >= 0) {
      const names = scopeNames(values[reposIndex] ?? "");
      if (!names) return null;
      if (names.length) criterion.repos = names;
    }
    ids.add(key);
    criteria.push(criterion);
  }
  return criteria.length ? criteria : null;
}

/** Every name in a Repos field. Separate backticks and a comma-separated tick are the same list. */
export function repoNames(value: string): string[] {
  const ticks = [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim()).filter(Boolean);
  const parts = ticks.length > 0 ? ticks : [value];
  const names: string[] = [];
  for (const part of parts) {
    for (const name of part.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

export function parseWorkOrder(text: string): WorkOrder | null {
  const block = packetBody(text);
  const criteria = acceptanceCriteria(block);
  const invariant = field(block, "Invariant").replace(/^`|`$/g, "");
  const decision = field(block, "Decision");
  const stop = field(block, "Stop") || section(block, "Stop").split("\n")[0]?.trim() || "";
  const repos = repoNames(field(block, "Repos"));
  const allowlist = words(field(block, "Allowlist"));
  if (allowlist.length === 0) {
    for (const line of section(block, "Allowlist").split("\n")) {
      const tick = line.match(/`([^`]+)`/)?.[1];
      if (tick) allowlist.push(tick);
    }
  }
  const symbols = words(field(block, "Symbols"));
  const validation = words(field(block, "Validation"));
  const fence = section(block, "Validation").match(/```(?:bash|sh)?\n([\s\S]*?)```/i)?.[1];
  if (fence) {
    for (const line of fence.split("\n")) {
      const command = line.trim();
      if (command && !command.startsWith("#")) validation.push(command);
    }
  }
  const connector = field(block, "Connector").replace(/^`|`$/g, "") || undefined;
  if (!criteria || !invariant || !decision || !stop || repos.length === 0) return null;
  return {
    repos,
    allowlist,
    invariant,
    decision,
    symbols,
    validation,
    criteria,
    stop,
    connector,
  };
}

/**
 * `none` means the done-state is code this repo can land.
 * `open` means the done-state is something this repo cannot obtain.
 * A missing line is null. The runner does not treat that as dev-done.
 */
export function parseOutsideGrant(text: string): "none" | "open" | null {
  const kind = text.match(/\*\*Outside grant:\*\*\s*(none|open)\b/i)?.[1]?.toLowerCase();
  if (kind === "none" || kind === "open") return kind;
  return null;
}

export type PriorRequest =
  | { kind: "none" }
  | { kind: "kept" }
  | { kind: "replaced"; identifier: string }
  | { kind: "ask" };

const PRIOR_REQUEST_RE =
  /\*\*Prior request:\*\*\s*(none|kept|replaced|ask)\b(?:\s+([A-Za-z][A-Za-z0-9]*-\d+))?/i;

/** The fresh handoff line. A missing line is null. Ticket ids are not project-specific. */
export function parsePriorRequest(text: string): PriorRequest | null {
  const match = text.match(PRIOR_REQUEST_RE);
  if (!match?.[1]) return null;
  const kind = match[1].toLowerCase();
  const identifier = match[2]?.toUpperCase() ?? "";
  if (kind === "replaced") return { kind: "replaced", identifier };
  if (kind === "none" || kind === "kept" || kind === "ask") return { kind };
  return null;
}

/**
 * Why a BUILDABLE handoff must not build.
 * A missing line, and `replaced` without a ticket id, stay in intake.
 * `ask` does not block: the runner records `kept`. With no symbols, the
 * ticket is already done. With symbols, the same land path continues.
 * Null means the line allows a build.
 */
export function priorRequestBlocksBuild(text: string): "missing" | "replaced" | null {
  const parsed = parsePriorRequest(text);
  if (!parsed) return "missing";
  if (parsed.kind === "replaced" && !parsed.identifier) return "replaced";
  return null;
}

export type JourneyEvidence = "recorded" | "not-applicable" | "blocked";

const JOURNEY_EVIDENCE_RE =
  /\*\*Journey evidence:\*\*\s*(recorded|not-applicable|blocked)\b/i;

/**
 * `not-applicable` means the done-state is not a journey a person walks.
 * `recorded` means it is, and dev-done waits on a proof token.
 * `blocked` means that proof cannot be produced in this run.
 * A missing line is null. The runner does not build and does not mark dev-done.
 */
export function parseJourneyEvidence(text: string): JourneyEvidence | null {
  const kind = text.match(JOURNEY_EVIDENCE_RE)?.[1]?.toLowerCase();
  if (kind === "recorded" || kind === "not-applicable" || kind === "blocked") return kind;
  return null;
}

/** Why a BUILDABLE handoff must not build. Null means the line allows a build. */
export function journeyEvidenceBlocksBuild(text: string): "missing" | "blocked" | null {
  const parsed = parseJourneyEvidence(text);
  if (!parsed) return "missing";
  if (parsed === "blocked") return "blocked";
  return null;
}

const RECORDING_PROOF_RE = /^https:\/\/\S+$/i;
const RECORDING_SHAPE_RE = /\.(?:png|jpe?g|webp|gif|mp4|webm|mov)(?:[?#]\S*)?$|\/artifacts\//i;
const ROUTE_TEST_PROOF_RE =
  /^([^/\s]+)\/(\S*(?:_test\.dart|\.test\.tsx?|\.spec\.tsx?|\.test\.js|\.spec\.js))$/;

export type JourneyProof =
  | { kind: "recording"; url: string }
  | { kind: "route-test"; repo: string; path: string };

/**
 * Proof tokens from every `**Journey proof:**` line. A sentence without a token is empty.
 * A route test counts when its path matches `journeySpec`.
 * A spec outside that pattern is not proof.
 */
export type StructuredJourneyProof = { repo: string; path: string; sha: string };

/**
 * Journey command stdout. A JSON list of `{ repo, path, sha }` is the proof.
 * Any other text is not a structured list. Task prose is not read here.
 */
export function parseStructuredJourneyProof(text: string): StructuredJourneyProof[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const proofs: StructuredJourneyProof[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "path,repo,sha") return null;
    if (typeof record.repo !== "string" || typeof record.path !== "string" || typeof record.sha !== "string") return null;
    const repo = record.repo.trim();
    const path = record.path.trim().replaceAll("\\", "/").replace(/^\/+/, "");
    const sha = record.sha.trim();
    if (!repo || !path || !sha || path.split("/").includes("..")) return null;
    proofs.push({ repo, path, sha });
  }
  return proofs;
}

export function parseJourneyProofs(text: string, journeySpec?: string): JourneyProof[] {
  const proofs: JourneyProof[] = [];
  for (const match of text.matchAll(/\*\*Journey proof:\*\*\s*(.+)/gi)) {
    const tokens = [...match[1].matchAll(/`([^`]+)`/g)].map((item) => item[1].trim());
    for (const token of tokens) {
      if (RECORDING_PROOF_RE.test(token) && RECORDING_SHAPE_RE.test(token)) {
        proofs.push({ kind: "recording", url: token });
        continue;
      }
      const route = token.match(ROUTE_TEST_PROOF_RE);
      if (route && matchesJourneySpec(route[2], journeySpec)) {
        proofs.push({ kind: "route-test", repo: route[1], path: route[2] });
      }
    }
  }
  return proofs;
}

/**
 * `recorded` is proven when every cited proof is real.
 * A recording URL is in the build receipt. A route test is on the commit and matches `journeySpec`.
 * A spec outside that pattern is not proof. `not-applicable` is proven.
 */
export function journeyEvidenceProven(
  declared: string,
  receipt: string,
  fileOnCommit: (repo: string, path: string) => boolean,
  journeySpec?: string,
): boolean {
  const evidence = parseJourneyEvidence(declared);
  if (evidence === "not-applicable") return true;
  if (evidence !== "recorded") return false;
  const proofs = parseJourneyProofs(`${declared}\n${receipt}`, journeySpec);
  if (proofs.length === 0) return false;
  return proofs.every((proof) => {
    if (proof.kind === "recording") return receipt.includes(proof.url);
    return fileOnCommit(proof.repo, proof.path);
  });
}

/** Status to move to after a non-BUILDABLE verdict. Null stays in intake. */
export function parkStateForVerdict(input: {
  verdict: Verdict;
  text: string;
  priorComments: readonly string[];
  completeStatus: string;
  /** Status that does not clear blockers. Defaults to Hold. */
  holdStatus?: string;
  /** True when this ticket's commits are already on the named trunks. */
  trunkCommit?: boolean | null;
  /** True when recorded journey proof is already on the trunk or in the audit receipt. */
  journeyProven?: boolean | null;
}): string | null {
  const hold = input.holdStatus?.trim() || "Hold";
  if (input.verdict === "WRONG DIAGNOSIS") return "Canceled";
  if (input.verdict === "NEEDS RESCOPE") {
    const cited =
      /\*\*Harness packet:\*\*/i.test(input.text) ||
      input.priorComments.some((comment) => /\*\*Harness packet:\*\*/i.test(comment));
    return cited ? hold : null;
  }
  if (input.verdict === "ALREADY SHIPPED") {
    if (parseOutsideGrant(input.text) === "open") return hold;
    const journey = parseJourneyEvidence(input.text);
    if (journey !== "not-applicable" && journey !== "recorded") return null;
    if (journey === "recorded" && input.journeyProven !== true) return null;
    const repos = words(field(input.text, "Repos"));
    if (repos.length === 0) return "Canceled";
    if (input.trunkCommit === true) return input.completeStatus;
    if (input.trunkCommit === false) return "Canceled";
    return null;
  }
  return null;
}

function headingSlug(heading: string): string {
  return heading
    .replace(/\{#[^}]+\}/g, "")
    .replace(/\([^)]*\)/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function headingMatches(markdown: string, id: string): boolean {
  const needle = id.trim().toLowerCase();
  if (!needle) return false;
  const slug = headingSlug(id);
  return markdown.split("\n").some((line) => {
    const heading = line.replace(/^#+\s*/, "").trim();
    if (!heading || heading === line.trim()) return false;
    const text = heading.toLowerCase();
    return text === needle || headingSlug(heading) === slug;
  });
}

/** `prefix/slug` against a heading file the install listed. */
export function resolveInvariantHeading(
  id: string,
  root: string,
  headings: InvariantHeading[] = [],
): string | null {
  const wanted = id.trim().toLowerCase();
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(wanted)) return null;
  for (const heading of headings) {
    if (!heading.prefix || !heading.file) continue;
    const file = join(root, heading.file);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    if (text.includes(`{#${wanted}}`)) return heading.file;
    for (const match of text.matchAll(/^#{1,4}\s+(.+)$/gm)) {
      if (`${heading.prefix}/${headingSlug(match[1])}`.toLowerCase() === wanted) {
        return heading.file;
      }
    }
  }
  return null;
}

export function invariantExists(
  markdown: string,
  id: string,
  root?: string,
  headings: InvariantHeading[] = [],
): boolean {
  if (headingMatches(markdown, id)) return true;
  if (root && resolveInvariantHeading(id, root, headings)) return true;
  return false;
}
