// One validator for both doors into the agent: the CLI argv and POST /api/runs. The task string ends up in
// search URLs, file names and a child process argv, so it is held to a small alphabet here and nowhere else.
import { MAX_VIDEOS_CAP, ROBOTS, SOURCES, type Robot, type RunOptions, type SourceName } from "./types";

/** Starts with a letter or digit so it can never be read as a command-line flag. */
const TASK = /^[A-Za-z0-9][A-Za-z0-9 ,.'()&-]{2,119}$/;

export interface RunRequest extends RunOptions {
  task: string;
}

export type Validation = { ok: true; value: RunRequest } | { ok: false; error: string };

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * `maxVideosCap` is the one rule that differs between the two doors: the web API keeps MAX_VIDEOS_CAP, the CLI
 * passes CLI_MAX_VIDEOS_CAP. Everything else is identical on purpose.
 */
export function validateRunRequest(body: unknown, maxVideosCap: number = MAX_VIDEOS_CAP): Validation {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;

  if (typeof b.task !== "string") return { ok: false, error: "task must be a string" };
  const task = b.task.trim().replace(/ +/g, " "); // only plain spaces are folded: a tab or newline is a rejection, not something to tidy
  if (!TASK.test(task)) return { ok: false, error: "task must be 3 to 120 characters: letters, digits, spaces and , . ' ( ) & -" };

  const robot = b.robot === undefined ? "g1" : b.robot; // null is a wrong value, not a missing one
  if (typeof robot !== "string" || !(ROBOTS as readonly string[]).includes(robot)) return { ok: false, error: `robot must be one of ${ROBOTS.join(", ")}` };

  const maxVideos = b.maxVideos === undefined ? 6 : b.maxVideos;
  if (!isInt(maxVideos) || maxVideos < 1 || maxVideos > maxVideosCap) return { ok: false, error: `maxVideos must be a whole number from 1 to ${maxVideosCap}` };

  const seconds = b.seconds === undefined ? 6 : b.seconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 2 || seconds > 20) return { ok: false, error: "seconds must be a number from 2 to 20" };

  const sources = b.sources === undefined ? [...SOURCES] : b.sources;
  if (!Array.isArray(sources) || sources.length === 0 || sources.some((s) => typeof s !== "string" || !(SOURCES as readonly string[]).includes(s))) return { ok: false, error: `sources must be a non-empty list drawn from ${SOURCES.join(", ")}` };

  const allow = b.allowStandardLicense === undefined ? false : b.allowStandardLicense;
  if (typeof allow !== "boolean") return { ok: false, error: "allowStandardLicense must be true or false" };

  // Accepted clips are a subset of judged clips, so a target above the judged budget could never be met.
  const target = b.targetAccepted;
  if (target !== undefined && (!isInt(target) || target < 1 || target > maxVideos)) return { ok: false, error: `targetAccepted must be a whole number from 1 to maxVideos (${maxVideos})` };

  return { ok: true, value: { task, robot: robot as Robot, maxVideos, seconds, sources: [...new Set(sources as SourceName[])], allowStandardLicense: allow, ...(target === undefined ? {} : { targetAccepted: target }) } };
}

/** Parses the CLI argv into the same object the API accepts, so both paths share every rule above. */
export function parseArgv(argv: string[]): { request: unknown; runId: string | null; brainFile: string | null } | { error: string } {
  const positional: string[] = [];
  const body: Record<string, unknown> = {};
  let runId: string | null = null;
  let brainFile: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--robot") body.robot = next();
    else if (a === "--max-videos") body.maxVideos = Number(next());
    else if (a === "--target-accepted") body.targetAccepted = Number(next());
    else if (a === "--seconds") body.seconds = Number(next());
    else if (a === "--sources") body.sources = (next() ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--allow-standard-license") body.allowStandardLicense = true;
    else if (a === "--run-id") runId = next() ?? null;
    else if (a === "--brain") brainFile = next() ?? null;
    else if (a.startsWith("--")) return { error: `unknown flag ${a}` };
    else positional.push(a);
  }
  if (positional.length !== 1) return { error: 'usage: agent.mts "<task>" [--robot g1|so101|panda] [--max-videos N] [--target-accepted N] [--seconds S] [--sources pexels,youtube-cc] [--allow-standard-license]' };
  body.task = positional[0];
  return { request: body, runId, brainFile };
}
