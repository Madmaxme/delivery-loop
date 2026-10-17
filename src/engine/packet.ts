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

export function parseVerdict(text: string): Verdict | null {
  const labeled = text.match(/\*\*Verdict:\*\*\s*([A-Z][A-Z ]+)/i);
  const raw = (labeled?.[1] ?? "").trim().toUpperCase();
  if (raw && (VERDICTS as readonly string[]).includes(raw)) return raw as Verdict;
  for (const verdict of VERDICTS) {
    if (text.toUpperCase().includes(verdict)) return verdict;
  }
  return null;
}

export function parseWorkOrder(text: string): WorkOrder | null {
  const block = text.match(/BUILD_PACKET([\s\S]*?)BUILD_PACKET/i)?.[1] ?? text;
  const invariant = field(block, "Invariant").replace(/^`|`$/g, "");
  const decision = field(block, "Decision");
  const stop = field(block, "Stop");
  const repos = words(field(block, "Repos"));
  const allowlist = words(field(block, "Allowlist"));
  const symbols = words(field(block, "Symbols"));
  const validation = words(field(block, "Validation"));
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

export function invariantExists(markdown: string, id: string): boolean {
  const needle = id.trim().toLowerCase();
  if (!needle) return false;
  return markdown
    .split("\n")
    .some((line) => line.replace(/^#+\s*/, "").trim().toLowerCase() === needle);
}
