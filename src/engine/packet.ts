import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { InvariantHeading } from "../schema/pack.ts";

export const VERDICTS = [
  "BUILDABLE",
  "NEEDS DIAGNOSIS",
  "NEEDS RESCOPE",
  "WRONG DIAGNOSIS",
  "ALREADY SHIPPED",
] as const;

export type Verdict = (typeof VERDICTS)[number];

export type WorkOrder = {
  repos: string[];
  allowlist: string[];
  invariant: string;
  decision: string;
  symbols: string[];
  validation: string[];
  stop: string;
  connector?: string;
};

function field(text: string, name: string): string {
  const re = new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`, "i");
  return text.match(re)?.[1]?.trim() ?? "";
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

function repoNames(value: string): string[] {
  const tick = value.match(/`([^`]+)`/)?.[1] ?? value;
  return tick.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

export function parseWorkOrder(text: string): WorkOrder | null {
  const block = packetBody(text);
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
  if (!invariant || !decision || !stop || repos.length === 0) return null;
  return {
    repos,
    allowlist,
    invariant,
    decision,
    symbols,
    validation,
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
 * `ask`, a missing line, and `replaced` without a ticket id stay in intake.
 * The verdict stays BUILDABLE. Null means the line allows a build.
 */
export function priorRequestBlocksBuild(text: string): "missing" | "ask" | "replaced" | null {
  const parsed = parsePriorRequest(text);
  if (!parsed) return "missing";
  if (parsed.kind === "ask") return "ask";
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

/** Proof tokens from every `**Journey proof:**` line. A sentence without a token is empty. */
export function parseJourneyProofs(text: string): JourneyProof[] {
  const proofs: JourneyProof[] = [];
  for (const match of text.matchAll(/\*\*Journey proof:\*\*\s*(.+)/gi)) {
    const tokens = [...match[1].matchAll(/`([^`]+)`/g)].map((item) => item[1].trim());
    for (const token of tokens) {
      if (RECORDING_PROOF_RE.test(token) && RECORDING_SHAPE_RE.test(token)) {
        proofs.push({ kind: "recording", url: token });
        continue;
      }
      const route = token.match(ROUTE_TEST_PROOF_RE);
      if (route) proofs.push({ kind: "route-test", repo: route[1], path: route[2] });
    }
  }
  return proofs;
}

/**
 * `recorded` is proven only when every cited proof is real.
 * A recording URL has to be in the build receipt. A route test has to be on the commit.
 * `not-applicable` is proven. Anything else is not.
 */
export function journeyEvidenceProven(
  declared: string,
  receipt: string,
  fileOnCommit: (repo: string, path: string) => boolean,
): boolean {
  const evidence = parseJourneyEvidence(declared);
  if (evidence === "not-applicable") return true;
  if (evidence !== "recorded") return false;
  const proofs = parseJourneyProofs(`${declared}\n${receipt}`);
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
  devStatus: string;
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
    if (input.trunkCommit === true) return input.devStatus;
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
