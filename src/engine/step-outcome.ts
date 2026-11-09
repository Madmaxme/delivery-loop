/** Exit 75 asks the engine to wait and run the step again. */
export const TRANSIENT_EXIT = 75;

/** A park and no block. Not a green process unless `ship.parkSuccess` is set. */
export const SHIP_EXIT_PARKED = 2;

/** A block, a real step failure, or a spent transient budget. */
export const SHIP_EXIT_FAILED = 1;

export const DEFAULT_TRANSIENT_ATTEMPTS = 3;

export const DEFAULT_TRANSIENT_WAIT_MS = 60_000;

export type TicketOutcome = "COMPLETE" | "PARKED" | "BLOCKED";

export type ParsedOutcome = {
  ticket: string;
  outcome: TicketOutcome;
  reason: string;
};

const OUTCOME_LINE =
  /^delivery-loop outcome (\S+) (COMPLETE|PARKED|BLOCKED)(?:\s+(.*))?$/;

const TRANSIENT_LINE = /^delivery-loop transient(?:\s+(.*))?$/;

/** Last line for each ticket wins. Tickets stay in first-seen order. */
export function parseOutcomeLines(text: string): ParsedOutcome[] {
  const order: string[] = [];
  const byTicket = new Map<string, ParsedOutcome>();
  for (const line of text.split(/\n/)) {
    const match = OUTCOME_LINE.exec(line.trim());
    if (!match) continue;
    const ticket = match[1] ?? "";
    const outcome = match[2] as TicketOutcome;
    const reason = (match[3] ?? "").trim();
    if (!byTicket.has(ticket)) order.push(ticket);
    byTicket.set(ticket, { ticket, outcome, reason });
  }
  return order.map((ticket) => byTicket.get(ticket)!);
}

/** A non-zero exit is transient when it is exit 75 or the output says so. A zero exit is not. */
export function transientReason(status: number | null, output: string): string | null {
  if (status === 0) return null;
  let named = "";
  for (const line of output.split(/\n/)) {
    const match = TRANSIENT_LINE.exec(line.trim());
    if (match) named = (match[1] ?? "").trim();
  }
  if (status === TRANSIENT_EXIT) return named || "exit 75";
  if (named) return named;
  return null;
}

/**
 * Wait before the next attempt. The first attempt does not wait.
 * Later waits start at one second and double. Null means the attempt
 * count or the total wait is spent.
 */
export function transientWaitMs(input: {
  completedAttempts: number;
  spentMs: number;
  maxAttempts: number;
  maxWaitMs: number;
}): number | null {
  if (input.completedAttempts < 1) return 0;
  if (input.completedAttempts >= input.maxAttempts) return null;
  const remaining = input.maxWaitMs - input.spentMs;
  if (remaining <= 0) return null;
  const want = 1000 * 2 ** (input.completedAttempts - 1);
  return Math.min(want, remaining);
}

/** Zero only when every ticket is COMPLETE, or a park is allowed and nothing is BLOCKED. */
export function shipExitCode(outcomes: readonly ParsedOutcome[], parkSuccess: boolean): number {
  if (outcomes.length === 0) return 0;
  if (outcomes.some((row) => row.outcome === "BLOCKED")) return SHIP_EXIT_FAILED;
  if (outcomes.every((row) => row.outcome === "COMPLETE")) return 0;
  if (parkSuccess) return 0;
  return SHIP_EXIT_PARKED;
}

export function shipSummaryLines(outcomes: readonly ParsedOutcome[]): string[] {
  const lines = outcomes.map((row) =>
    row.reason
      ? `ship outcome ${row.ticket} ${row.outcome} ${row.reason}`
      : `ship outcome ${row.ticket} ${row.outcome}`,
  );
  const complete = outcomes.filter((row) => row.outcome === "COMPLETE").length;
  const parked = outcomes.filter((row) => row.outcome === "PARKED").length;
  const blocked = outcomes.filter((row) => row.outcome === "BLOCKED").length;
  lines.push(`ship outcomes complete=${complete} parked=${parked} blocked=${blocked}`);
  return lines;
}

export function shipSummaryMarkdown(outcomes: readonly ParsedOutcome[]): string {
  const rows = outcomes.map(
    (row) => `| ${row.ticket} | ${row.outcome} | ${row.reason || ""} |`,
  );
  const totals = shipSummaryLines(outcomes).at(-1) ?? "";
  return ["## Ship outcomes", "", "| Ticket | Outcome | Reason |", "| --- | --- | --- |", ...rows, "", totals, ""].join(
    "\n",
  );
}
