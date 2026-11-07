import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DesignCheckProbe, FetchLike, Ticket } from "../adapters/types.ts";
import type { DesignRepo, DesignSpec } from "../schema/pack.ts";

const FIGMA_URL_RE =
  /https?:\/\/(?:www\.)?figma\.com\/(?:file|design|proto|board|slides)\/[A-Za-z0-9]+[^\s)<>"'`]*/gi;

export type DesignCheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
  headSha: string;
};

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
 * Present frame: the work order names one captured URL.
 * No frame and a UI land repo: Validation names that repo's check command.
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

/** A check run whose sha is not the pull request head is not a result. */
export function interpretDesignChecks(
  runs: readonly DesignCheckRun[],
  headSha: string,
  name: string,
): DesignCheckProbe {
  const named = runs.filter((run) => run.name === name);
  const fresh = named.filter((run) => run.headSha === headSha);
  if (fresh.length === 0) {
    const stale = named.find((run) => run.headSha && run.headSha !== headSha);
    return {
      state: "missing",
      detail: stale
        ? `stale design check ${name} at ${stale.headSha} ignored`
        : `design check ${name} missing on ${headSha}`,
      headSha: null,
    };
  }
  const completed = fresh.filter((run) => run.status === "completed");
  const success = completed.find((run) => run.conclusion === "success");
  if (success) return { state: "success", detail: `${name} success`, headSha };
  const failure = completed.find((run) => run.conclusion && run.conclusion !== "success");
  if (failure) {
    return {
      state: "failure",
      detail: `${name} ${failure.conclusion}`,
      headSha,
    };
  }
  return { state: "pending", detail: `${name} ${fresh[0]?.status ?? "pending"}`, headSha };
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
