// Step e: hand an accepted track to the retargeter. scripts/retarget.mts belongs to another engineer and is
// called only through its command-line contract. While it does not exist (or when it fails for the G1), the
// older scripts/mirror.mts does the same job for the G1 and nothing else.
import { execFile } from "node:child_process";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Candidate, Robot } from "./types";

const run = promisify(execFile);
const exists = (p: string) => stat(p).then(() => true, () => false);

export interface Retargeted {
  out: string;
  retargeter: "retarget.mts" | "mirror.mts";
  stats: Record<string, number>;
  startSeconds: number | null;
}

const numeric = (o: unknown): Record<string, number> => Object.fromEntries(Object.entries(typeof o === "object" && o !== null ? o : {}).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1])));
const short = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 240);

async function viaContract(trackKey: string, robot: Robot, seconds: number, out: string, start: number | null): Promise<Retargeted> {
  const { stdout } = await run("pnpm", ["dlx", "tsx", "scripts/retarget.mts", "--track", `data/tracks/${trackKey}.json`, "--robot", robot, "--start", start === null ? "auto" : String(start), "--seconds", String(seconds), "--out", out], { timeout: 600_000, maxBuffer: 16 << 20 });
  const last = stdout.trim().split("\n").at(-1) ?? "";
  const parsed = JSON.parse(last) as { out?: unknown; robot?: unknown; stats?: unknown };
  if (parsed.robot !== robot || typeof parsed.out !== "string") throw new Error("retarget.mts did not end with the agreed JSON line");
  if (!(await exists(out))) throw new Error("retarget.mts reported success but wrote no file");
  return { out, retargeter: "retarget.mts", stats: numeric(parsed.stats), startSeconds: null };
}

/** Exported so the fallback can be exercised on its own while retarget.mts exists. */
export async function viaMirror(trackKey: string, seconds: number, out: string, start: number | null): Promise<Retargeted> {
  // mirror.mts always writes data/demos/mirror-<id>.json. Hand-made demos may already live under that name, so
  // an existing file is set aside first and put back afterwards, and the agent's result moves to its own name.
  // (a pinned start goes into the name mirror.mts chooses: mirror-<id>-<start>.json)
  const fixed = start === null ? `data/demos/mirror-${trackKey}.json` : `data/demos/mirror-${trackKey}-${start}.json`;
  const aside = `${fixed}.agent-aside`;
  if ((await exists(aside)) && !(await exists(fixed))) await rename(aside, fixed); // a run killed mid-way left one set aside
  const had = await exists(fixed);
  if (had) await rename(fixed, aside);
  try {
    await run("pnpm", ["dlx", "tsx", "scripts/mirror.mts", `${trackKey}@${start === null ? "auto" : start}+${seconds}`], { timeout: 600_000, maxBuffer: 16 << 20 });
    await rename(fixed, out);
  } finally {
    await rm(fixed, { force: true });
    if (had) await rename(aside, fixed);
  }
  return { out, retargeter: "mirror.mts", stats: {}, startSeconds: null };
}

export async function retargetClip(c: Candidate, robot: Robot, seconds: number, runId: string, poseOnly: boolean, start: number | null): Promise<Retargeted> {
  const out = `data/demos/agent-${robot}-${c.key}.json`;
  let result: Retargeted;
  if (await exists("scripts/retarget.mts")) {
    try {
      result = await viaContract(c.key, robot, seconds, out, start);
    } catch (err) {
      if (robot !== "g1") throw new Error(`retarget.mts failed: ${short(err)}`);
      result = await viaMirror(c.key, seconds, out, start);
    }
  } else if (robot === "g1") result = await viaMirror(c.key, seconds, out, start);
  else throw new Error(`scripts/retarget.mts does not exist yet and the mirror.mts fallback only drives the g1, not the ${robot}`);

  // The demo file is data, so it can carry its own provenance. mirror.mts guesses the source from the id prefix
  // and gets YouTube wrong, which is one more reason to write the real one here.
  const demo = JSON.parse(await readFile(result.out, "utf8")) as Record<string, unknown>;
  if (Object.keys(result.stats).length === 0) result.stats = numeric(demo.stats);
  result.startSeconds = typeof demo.startSeconds === "number" ? demo.startSeconds : null;
  demo.source = `${c.pageUrl} (${c.licence.name})`;
  demo.provenance = { runId, source: c.source, id: c.id, pageUrl: c.pageUrl, licence: c.licence, author: c.author, authorUrl: c.authorUrl, title: c.title };
  // poseOnly demos have no footage on disk and must never be rendered next to their source video.
  if (poseOnly) { demo.poseOnly = true; delete demo.video; }
  await writeFile(result.out, JSON.stringify(demo));
  return result;
}
