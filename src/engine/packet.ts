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

/** Status to move to after a non-BUILDABLE verdict. Null stays in intake. */
export function parkStateForVerdict(input: {
  verdict: Verdict;
  text: string;
  priorComments: readonly string[];
  devStatus: string;
  /** Status that does not clear blockers. Defaults to Shaping. */
  holdStatus?: string;
  /** True when this ticket's commits are already on the named trunks. */
  trunkCommit?: boolean | null;
}): string | null {
  const hold = input.holdStatus?.trim() || "Shaping";
  if (input.verdict === "WRONG DIAGNOSIS") return "Canceled";
  if (input.verdict === "NEEDS RESCOPE") {
    const cited =
      /\*\*Harness packet:\*\*/i.test(input.text) ||
      input.priorComments.some((comment) => /\*\*Harness packet:\*\*/i.test(comment));
    return cited ? hold : null;
  }
  if (input.verdict === "ALREADY SHIPPED") {
    if (parseOutsideGrant(input.text) === "open") return hold;
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
