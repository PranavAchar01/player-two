// How big a run may get and when it stops. Kept apart from agent.mts (a script that runs on import) so the
// arithmetic that bounds how much the agent asks of other people's servers can be unit tested.
import { ATTEMPTS_PER_BUDGET, CLI_MAX_VIDEOS_CAP, type RunOptions } from "./types";

export interface Limits {
  /** Videos that get as far as a verdict. This is what --max-videos means. */
  budget: number;
  /** Network downloads tried, refused ones included. Footage or a track reused from disk is not an attempt. */
  maxAttempts: number;
  /** Stop early once this many clips are accepted. Null means use the whole budget. */
  targetAccepted: number | null;
}

export interface Counts {
  judged: number;
  attempts: number;
  accepted: number;
}

export function limitsFor(options: Pick<RunOptions, "maxVideos" | "targetAccepted">): Limits {
  // The validator already held maxVideos to the caller's cap. This is the last line of defence, not the rule.
  const budget = Math.max(1, Math.min(options.maxVideos, CLI_MAX_VIDEOS_CAP));
  return { budget, maxAttempts: budget * ATTEMPTS_PER_BUDGET, targetAccepted: options.targetAccepted === undefined ? null : Math.min(options.targetAccepted, budget) };
}

/** Null while the run should fetch another video, otherwise the sentence that goes into the trace. */
export function stopReason(counts: Counts, limits: Limits): string | null {
  if (limits.targetAccepted !== null && counts.accepted >= limits.targetAccepted) return `the target of ${limits.targetAccepted} accepted clips was reached`;
  if (counts.judged >= limits.budget) return `the budget of ${limits.budget} judged videos was reached`;
  if (counts.attempts >= limits.maxAttempts) return `the limit of ${limits.maxAttempts} download attempts was reached`;
  return null;
}

/**
 * How many usable candidates a search should still look for. Every YouTube hit costs a paced metadata request, so
 * the search is sized to what the run is likely to need, and topped up later only if that was not enough:
 * about half of judged clips are accepted and about 40 percent of downloads are refused, so one accepted clip
 * takes roughly four candidates, and one judged clip takes two. Never more than the attempts that are left.
 */
export function searchWant(counts: Counts, limits: Limits): number {
  const forBudget = (limits.budget - counts.judged) * ATTEMPTS_PER_BUDGET;
  const need = limits.targetAccepted === null ? forBudget : Math.min(forBudget, (limits.targetAccepted - counts.accepted) * 4);
  return Math.max(0, Math.min(need, limits.maxAttempts - counts.attempts));
}
