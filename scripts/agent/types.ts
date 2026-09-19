// Shared shapes for the agent trace. run.json is the contract between the CLI (writer) and the /agent page
// (reader), so everything the page shows has to be in here and nothing in here may hold a secret.

import type { Feasibility } from "./feasible";

export const ROBOTS = ["g1", "so101", "panda"] as const;
export type Robot = (typeof ROBOTS)[number];

export const SOURCES = ["pexels", "youtube-cc"] as const;
export type SourceName = (typeof SOURCES)[number];

/** Ceiling on JUDGED videos for a run started from the web page (POST /api/runs). Anyone who can open the page can start one, so it stays small. */
export const MAX_VIDEOS_CAP = 25;
/**
 * Ceiling on JUDGED videos for a run started from the command line. It is higher because a demo task wants about
 * 20 accepted clips, roughly half of judged clips are accepted, and the person typing the command owns the machine
 * and the hour it takes. The pacing, the licence checks and the one-at-a-time rule are the same as for a small run.
 */
export const CLI_MAX_VIDEOS_CAP = 80;
/** An episode is kept only if the robot followed the person for at least this share of its ticks. */
export const MIN_TRACKED_PCT = 85;
/**
 * Download attempts allowed per judged video asked for. YouTube refuses about 40 percent of media downloads
 * (HTTP 403) and those clips are dropped, not retried, so a budget of N judged needs room for about 2N attempts.
 */
export const ATTEMPTS_PER_BUDGET = 2;
/** How far down one YouTube search the agent reads. Every hit costs a paced metadata request, so this is bounded. */
export const YT_RESULTS_PER_QUERY = 30;
/** Minimum gap between two requests to the same kind of remote service. */
export const REQUEST_GAP_MS = 1500;

export const RUN_ID = /^\d{8}-\d{6}-[a-z0-9-]{1,40}-[a-f0-9]{4}$/;

export type Arm = "left" | "right" | "both" | "either";

/**
 * A motion the footage judge can check from landmarks alone. The planner may only pick from these, which is
 * what makes an LLM-written plan safe to execute: it selects and parameterises, it never supplies code.
 *  - arm_elevation: upper arm lifts away from the torso past `threshold` degrees (raises, waves, reaches)
 *  - elbow_flexion: elbow angle sweeps through at least `threshold` degrees (curls, hammering, drinking)
 *  - wrist_oscillation: wrist reverses direction with at least `threshold` centimetres per swing (stirring, waving, wiping)
 */
export const SIGNATURE_KINDS = ["arm_elevation", "elbow_flexion", "wrist_oscillation"] as const;
export type SignatureKind = (typeof SIGNATURE_KINDS)[number];

/** For arm_elevation only: a raise out to the side (in the camera plane) or toward the camera. They are different exercises. */
export const DIRECTIONS = ["sideways", "forward", "any"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export interface MotionSignature {
  kind: SignatureKind;
  threshold: number;
  minCount: number;
  direction?: Direction;
}

export interface Plan {
  planner: "gemini" | "fallback";
  model: string | null;
  /** Why the fallback was used, if it was. Never contains request headers. */
  note: string | null;
  queries: string[];
  arm: Arm;
  motionDescription: string;
  signature: MotionSignature;
  rejectionCriteria: string[];
}

export interface Licence {
  name: string;
  url: string | null;
  /** True only for licences that allow keeping and rendering the footage. */
  redistributable: boolean;
}

export interface FootageMetrics {
  frames: number;
  fps: number;
  durationS: number;
  windowStartS: number;
  windowS: number;
  trackedPctClip: number;
  trackedPctWindow: number;
  armVisibility: number;
  personHeightFrac: number;
  limbsInFramePct: number;
  frontalDeg: number;
  facingCameraPct: number;
  armExcursionM: number;
  jumps: number;
  signatureCount: number;
  signaturePeak: number;
  /** Share of the raised upper arm that points sideways rather than at the camera, 0..1. Null when not an elevation check. */
  lateralFrac: number | null;
  armUsed: "left" | "right" | "both";
}

export interface Check {
  name: string;
  pass: boolean;
  /** Human-readable, with the measured number and the bar it was held to. */
  detail: string;
}

export interface Verdict {
  /** Set when the retargeter's own "auto" window failed but another stretch of the clip passed. Seconds from the start. */
  pinnedStartS: number | null;
  windowNote: string | null;
  accepted: boolean;
  score: number;
  reasons: string[];
  checks: Check[];
  metrics: FootageMetrics | null;
}

export type CandidateStage = "found" | "skipped" | "fetching" | "extracting" | "judged" | "failed";

export interface Candidate {
  key: string;
  source: SourceName | "youtube";
  id: string;
  pageUrl: string;
  title: string | null;
  author: string | null;
  authorUrl: string | null;
  licence: Licence;
  durationS: number | null;
  query: string;
  stage: CandidateStage;
  /** Filled when stage is skipped or failed. */
  note: string | null;
  /** Direct file URL when the source hands one out (Pexels API). Otherwise resolved at fetch time. */
  downloadUrl: string | null;
  file: string | null;
  track: string | null;
  footageDeleted: boolean;
  /** Set when an earlier run already left this video's footage or pose track on disk, so nothing was downloaded again. */
  reused?: "footage" | "track";
  verdict: Verdict | null;
}

export interface Episode {
  name: string;
  rank: number;
  quality: number;
  candidateKey: string;
  robot: Robot;
  out: string;
  retargeter: "retarget.mts" | "mirror.mts";
  poseOnly: boolean;
  startSeconds: number | null;
  seconds: number;
  stats: Record<string, number>;
  provenance: { source: string; id: string; pageUrl: string; licence: Licence; author: string | null; authorUrl: string | null; title: string | null; query: string; fetchedAt: string };
}

export type StepName = "plan" | "search" | "fetch" | "judge" | "retarget" | "write";
export type StepStatus = "pending" | "running" | "done" | "failed";

export interface Step {
  name: StepName;
  status: StepStatus;
  startedAt: string | null;
  ms: number | null;
  summary: string | null;
}

export interface SearchLog {
  source: SourceName;
  query: string;
  found: number;
  kept: number;
  note: string | null;
}

export interface RunOptions {
  robot: Robot;
  maxVideos: number;
  seconds: number;
  sources: SourceName[];
  allowStandardLicense: boolean;
  /** Stop fetching once this many clips are accepted, even if the maxVideos budget is not used up. */
  targetAccepted?: number;
}

export interface Run {
  schema: 1;
  id: string;
  task: string;
  options: RunOptions;
  status: "running" | "done" | "failed";
  pid: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** Whether the task suits the robot. Absent only in runs written before this check existed. */
  feasibility?: Feasibility;
  steps: Step[];
  plan: Plan | null;
  searches: SearchLog[];
  candidates: Candidate[];
  episodes: Episode[];
  retargetFailures: { candidateKey: string; reason: string }[];
  versions: Record<string, string>;
}

export interface RunSummary {
  id: string;
  task: string;
  robot: Robot;
  status: Run["status"] | "crashed";
  startedAt: string;
  candidates: number;
  accepted: number;
  episodes: number;
}
