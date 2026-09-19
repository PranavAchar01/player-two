// Step a: turn a task in plain words into search queries and a checkable description of the motion.
// The model only fills in a fixed form. Whatever comes back is treated as untrusted text: it is cleaned,
// range-checked and topped up from the deterministic fallback, and it can never name a file, a URL or a command.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { armForRobot, embodimentBrief, isSingleArm } from "./feasible";
import { DIRECTIONS, SIGNATURE_KINDS, type Arm, type Direction, type MotionSignature, type Plan, type Robot, type SignatureKind } from "./types";

const MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"];
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const ARMS: Arm[] = ["left", "right", "both", "either"];
const RANGE: Record<SignatureKind, [number, number]> = { arm_elevation: [20, 150], elbow_flexion: [20, 140], wrist_oscillation: [3, 60] };

/** The key is read here and handed straight to the request header. It is never returned, logged or stored. */
async function readGeminiKey(): Promise<string | null> {
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  // The web server that spawns this CLI is usually not started from a login shell, so the export in
  // ~/.zshrc is not in its environment. Reading the one line is simpler than asking people to restart it.
  const rc = await readFile(path.join(os.homedir(), ".zshrc"), "utf8").catch(() => "");
  const m = rc.match(/^\s*export\s+GEMINI_API_KEY=(["']?)([^"'\s#]+)\1/m);
  return m ? m[2] : null;
}

const cleanText = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\x00-\x1f\x7f<>|`\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const cleanQuery = (v: unknown) => (typeof v === "string" ? v.replace(/[^A-Za-z0-9 '-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) : "");

function guessSignature(task: string): MotionSignature {
  const t = task.toLowerCase();
  if (/\b(stir|wipe|scrub|shake|wave|saw|brush|polish|whisk)/.test(t)) return { kind: "wrist_oscillation", threshold: 8, minCount: 4 };
  if (/\b(curl|drink|hammer|sip|eat|knock)/.test(t)) return { kind: "elbow_flexion", threshold: 50, minCount: 2 };
  if (/\b(raise|lift|reach|press|salute|point|stretch|jumping jack)/.test(t)) return { kind: "arm_elevation", threshold: 60, minCount: 1, direction: /\b(lateral|side|jumping jack)/.test(t) ? "sideways" : /\b(front|forward)/.test(t) ? "forward" : "any" };
  return { kind: "wrist_oscillation", threshold: 10, minCount: 2 };
}

export function fallbackPlan(task: string, note: string | null): Plan {
  const signature = guessSignature(task);
  return {
    planner: "fallback", model: null, note,
    queries: [`${task} front view`, `person doing ${task} full body`, `${task} one person plain background`, `how to ${task} demonstration`, `${task} slow motion`].map(cleanQuery),
    arm: "either",
    motionDescription: signature.kind === "arm_elevation" ? `arm rises away from the body past ${signature.threshold} degrees at least once` : signature.kind === "elbow_flexion" ? `elbow bends and straightens through ${signature.threshold} degrees at least twice` : `wrist moves back and forth, ${signature.threshold} cm or more per swing`,
    signature,
    rejectionCriteria: ["more than one person in shot", "side or 3/4 view instead of frontal", "arms leave the frame", "person small or far from the camera", "cuts, spins or fast camera motion", "silhouette, loose clothing or dark clothing against a dark background"],
  };
}

/**
 * Accepts only what fits the form. Returns null when too little survives to be worth using.
 * The robot matters for one field: a single arm never gets arm "both", whatever the model answered.
 */
export function validatePlan(raw: unknown, task: string, model: string, seconds: number, robot: Robot = "g1"): Plan | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const base = fallbackPlan(task, null);

  const seen = new Set<string>();
  const queries: string[] = [];
  for (const q of Array.isArray(r.queries) ? r.queries : []) {
    const c = cleanQuery(q);
    if (c.length < 3 || seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase());
    queries.push(c);
  }
  if (queries.length < 2) return null;
  for (const q of base.queries) if (queries.length < 4 && !seen.has(q.toLowerCase())) queries.push(q);

  const sigRaw = (typeof r.signature === "object" && r.signature !== null ? r.signature : {}) as Record<string, unknown>;
  const kind = (SIGNATURE_KINDS as readonly string[]).includes(sigRaw.kind as string) ? (sigRaw.kind as SignatureKind) : null;
  let signature = base.signature;
  if (kind && typeof sigRaw.threshold === "number" && Number.isFinite(sigRaw.threshold)) {
    const [lo, hi] = RANGE[kind];
    const count = typeof sigRaw.minCount === "number" && Number.isFinite(sigRaw.minCount) ? Math.round(sigRaw.minCount) : 1;
    // The check runs on one window of `seconds`. A model that asks for more repetitions than fit in it would reject
    // every clip, so the count is capped by what a slow, clean performance can show in that time.
    const most = kind === "arm_elevation" ? Math.max(1, Math.floor(seconds / 3)) : Math.max(2, Math.floor(seconds));
    signature = { kind, threshold: Math.max(lo, Math.min(hi, Math.round(sigRaw.threshold))), minCount: Math.max(1, Math.min(most, count)) };
    if (kind === "arm_elevation") {
      signature.direction = (DIRECTIONS as readonly string[]).includes(sigRaw.direction as string) ? (sigRaw.direction as Direction) : "any";
      // The planner once called a shoulder press "forward" and the judge then rejected eight good clips for pointing
      // sideways. A forward claim must be backed by the task's own words, otherwise direction is left unchecked.
      if (signature.direction === "forward" && !/\b(front|forward|toward|towards|reach|punch|push)/i.test(task)) signature.direction = "any";
    }
  }

  const criteria = (Array.isArray(r.rejectionCriteria) ? r.rejectionCriteria : []).map((c) => cleanText(c, 160)).filter((c) => c.length >= 3).slice(0, 8);
  return {
    planner: "gemini", model, note: null,
    queries: queries.slice(0, 6),
    arm: armForRobot(ARMS.includes(r.arm as Arm) ? (r.arm as Arm) : "either", robot),
    motionDescription: cleanText(r.motionDescription, 240) || base.motionDescription,
    signature,
    rejectionCriteria: criteria.length ? criteria : base.rejectionCriteria,
  };
}

/** For a single arm "both" is not even offered to the model. validatePlan still checks, because a schema is a request, not a guarantee. */
export const planSchema = (robot: Robot) => ({
  type: "OBJECT",
  properties: {
    queries: { type: "ARRAY", minItems: 4, maxItems: 6, items: { type: "STRING" } },
    arm: { type: "STRING", enum: ARMS.filter((a) => !(isSingleArm(robot) && a === "both")) },
    motionDescription: { type: "STRING" },
    signature: { type: "OBJECT", properties: { kind: { type: "STRING", enum: [...SIGNATURE_KINDS] }, threshold: { type: "NUMBER" }, minCount: { type: "INTEGER" }, direction: { type: "STRING", enum: [...DIRECTIONS] } }, required: ["kind", "threshold", "minCount", "direction"] },
    rejectionCriteria: { type: "ARRAY", maxItems: 8, items: { type: "STRING" } },
  },
  required: ["queries", "arm", "motionDescription", "signature", "rejectionCriteria"],
});

/** What the model is told about this run. Exported so a test can hold the single-arm wording in place. */
export const planRequestText = (task: string, seconds: number, robot: Robot) => `Task: ${task}\nRobot: ${embodimentBrief(robot)}\nThe machine check runs on one ${seconds} second window of the clip, so minCount must fit in ${seconds} seconds of slow, clean motion.`;

const SYSTEM = `You plan video searches for a tool that copies human arm motion onto a robot from ONE ordinary camera.
Footage only works when there is exactly one person, seen from the front, upper body or full body in shot, arms never leaving the frame, plain steady motion, steady camera, no cuts.
Return JSON only.
- queries: 4 to 6 short stock-video or YouTube search queries (plain words, no quotes, no operators) tuned to find such footage of the task. Vary the wording. Prefer words like "front view", "demonstration", "full body", "one person".
- arm: which of the PERSON'S arms matters: left, right, both, or either. The user message says what the robot is. When it is ONE arm, never answer "both": answer "either" unless the task names a side.
- motionDescription: one sentence saying what the motion must look like in measurable terms.
- signature: pick ONE machine check. kind "arm_elevation" = upper arm lifts away from the torso past threshold DEGREES (0 is hanging down, 90 is horizontal); kind "elbow_flexion" = elbow angle swings through threshold DEGREES, minCount counts swings (one bend and straighten is 2); kind "wrist_oscillation" = wrist goes back and forth with threshold CENTIMETRES per swing, minCount counts swings. Be lenient: set the threshold about 25 percent below the ideal motion. direction (used for arm_elevation only): "sideways" when the arm goes out to the side in the camera plane (lateral raise, jumping jack), "forward" ONLY when the task itself says front, forward, toward or reaching (front raise, reaching forward, punch); an overhead or shoulder press, a wave, and anything else moves in the camera plane or is unclear, so use "any". When unsure use "any": a wrong direction rejects good footage. Keep minCount at 1 unless the task is rhythmic (jumping jacks, waving), because clips are only a few seconds long.
- rejectionCriteria: up to 8 short reasons footage of this task would be unusable.`;

export async function planTask(task: string, seconds: number, robot: Robot, log: (line: string) => void): Promise<Plan> {
  const key = await readGeminiKey();
  if (!key) return fallbackPlan(task, "no GEMINI_API_KEY in the environment or ~/.zshrc");
  const notes: string[] = [];
  for (const model of MODELS) {
    try {
      const res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: planRequestText(task, seconds, robot) }] }], generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: planSchema(robot) } }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) {
        // Only the status is kept. The response body of an auth error can echo request details.
        notes.push(`${model}: HTTP ${res.status}`);
        log(`plan: ${model} answered HTTP ${res.status}`);
        if (res.status === 429 || res.status === 503) continue;
        break;
      }
      const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
      const text = (body.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
      const plan = validatePlan(JSON.parse(text), task, model, seconds, robot);
      if (plan) return { ...plan, note: notes.length ? notes.join("; ") : null };
      notes.push(`${model}: answer did not fit the plan form`);
    } catch (err) {
      notes.push(`${model}: ${err instanceof SyntaxError ? "answer was not JSON" : err instanceof Error && err.name === "TimeoutError" ? "timed out" : "request failed"}`);
    }
  }
  return fallbackPlan(task, notes.join("; "));
}
