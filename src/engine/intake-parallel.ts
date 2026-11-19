import type { ContractEdge } from "../schema/pack.ts";

/** How many tickets sweep may have in flight. A wider frontier is an engine change. */
export const INTAKE_PARALLEL_LIMIT = 2;

export type IntakeCandidate = {
  id: string;
  /** Null when the work order has not named land repos. That ticket runs alone. */
  repos: readonly string[] | null;
};

/** True when two recorded repo sets must not run together. */
export function intakeOverlaps(
  left: readonly string[],
  right: readonly string[],
  edges: readonly ContractEdge[],
): boolean {
  if (left.some((repo) => right.includes(repo))) return true;
  for (const edge of edges) {
    const leftProducer = left.includes(edge.producer);
    const rightProducer = right.includes(edge.producer);
    const leftConsumer = left.some((repo) => edge.consumers.includes(repo));
    const rightConsumer = right.some((repo) => edge.consumers.includes(repo));
    if ((leftProducer && rightConsumer) || (rightProducer && leftConsumer)) return true;
  }
  return false;
}

/**
 * Tickets from `pending` that may start beside `inFlight`.
 * Pending order is the start order. A ticket with no recorded repos starts
 * only when nothing is in flight, and nothing else starts with it.
 */
export function selectIntakeStarts(
  pending: readonly IntakeCandidate[],
  inFlight: readonly IntakeCandidate[],
  edges: readonly ContractEdge[] = [],
  limit = INTAKE_PARALLEL_LIMIT,
): string[] {
  const running = [...inFlight];
  const starts: string[] = [];
  if (running.some((row) => row.repos === null)) return [];
  for (const ticket of pending) {
    if (running.length >= limit) break;
    if (running.some((row) => row.repos === null)) break;
    const repos = ticket.repos;
    if (repos === null) {
      if (running.length === 0) {
        starts.push(ticket.id);
        running.push(ticket);
      }
      continue;
    }
    if (running.some((row) => row.repos !== null && intakeOverlaps(repos, row.repos, edges))) {
      continue;
    }
    starts.push(ticket.id);
    running.push({ id: ticket.id, repos });
  }
  return starts;
}
