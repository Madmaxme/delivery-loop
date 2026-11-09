import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

/**
 * Journey specs live under this pattern when the pack omits `journeySpec`.
 * A path outside the pattern is not journey proof.
 */
export const DEFAULT_JOURNEY_SPEC = "{e2e,integration_test,journey}/**";

/** A directory name is the tree under that directory. A glob is used as written. */
export function journeySpecPattern(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return DEFAULT_JOURNEY_SPEC;
  if (!/[*?{]/.test(text)) return `${text.replace(/\/+$/, "")}/**`;
  return text;
}

function braceExpand(pattern) {
  const match = /\{([^{}]+)\}/.exec(pattern);
  if (!match) return [pattern];
  const parts = match[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const out = [];
  for (const part of parts) out.push(...braceExpand(pattern.replace(match[0], part)));
  return out;
}

function globToRegExp(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 3;
      continue;
    }
    if (glob.startsWith("**", i)) {
      re += ".*";
      i += 2;
      continue;
    }
    const ch = glob[i];
    if (ch === "*") {
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`${re}$`);
}

/**
 * `path` is the path inside the repo.
 * The pattern is the pack `journeySpec`, or the default journey tree.
 */
export function matchesJourneySpec(path, pattern = DEFAULT_JOURNEY_SPEC) {
  const normalized = String(path ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..")) return false;
  const spec = journeySpecPattern(pattern);
  return braceExpand(spec).some((glob) => globToRegExp(glob).test(normalized));
}

const ROUTE_SUFFIX = /(?:_test\.dart|\.test\.tsx?|\.spec\.tsx?|\.test\.js|\.spec\.js)$/;
const RECORDING = /^https:\/\/\S+$/i;
const RECORDING_SHAPE = /\.(?:png|jpe?g|webp|gif|mp4|webm|mov)(?:[?#]\S*)?$|\/artifacts\//i;

/**
 * Proof lines for tokens named in `text`.
 * A route token counts when its path matches the journey-spec pattern.
 * A spec outside that pattern is left out. A recording URL is kept.
 */
export function proofLinesFor(text, pattern = DEFAULT_JOURNEY_SPEC) {
  const lines = [];
  const seen = new Set();
  for (const match of String(text ?? "").matchAll(/`([^`]+)`/g)) {
    const token = match[1].trim();
    if (!token || seen.has(token)) continue;
    if (RECORDING.test(token) && RECORDING_SHAPE.test(token)) {
      seen.add(token);
      lines.push(`**Journey proof:** \`${token}\``);
      continue;
    }
    const slash = token.indexOf("/");
    if (slash <= 0 || !ROUTE_SUFFIX.test(token)) continue;
    const path = token.slice(slash + 1);
    if (!matchesJourneySpec(path, pattern)) continue;
    seen.add(token);
    lines.push(`**Journey proof:** \`${token}\``);
  }
  return lines;
}

/** The pack key `journeySpec` in `delivery-loop.yaml`. Absent uses the default pattern. */
export function readJourneySpec(cwd) {
  const file = join(cwd, "delivery-loop.yaml");
  if (!existsSync(file)) return DEFAULT_JOURNEY_SPEC;
  try {
    const raw = parse(readFileSync(file, "utf8"));
    const value = raw && typeof raw === "object" ? raw.journeySpec : undefined;
    return journeySpecPattern(value);
  } catch {
    return DEFAULT_JOURNEY_SPEC;
  }
}

function main() {
  const pattern = readJourneySpec(process.cwd());
  const args = process.argv.slice(2).filter((arg) => arg && !arg.startsWith("-"));
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
  const named = args.map((arg) => `\`${arg}\``).join("\n");
  const lines = proofLinesFor(`${stdin}\n${named}`, pattern);
  if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) main();
