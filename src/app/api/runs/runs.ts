import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { RUN_ID, type Run, type RunSummary } from "../../../../scripts/agent/types";

export const RUNS_DIR = path.resolve("data/runs");

/** Signal 0 sends nothing. It only asks whether the process is still there. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function loadRun(id: string): Promise<Run | null> {
  if (!RUN_ID.test(id)) return null; // the id becomes a directory name, so it is checked before it touches a path
  try {
    const run = JSON.parse(await readFile(path.join(RUNS_DIR, id, "run.json"), "utf8")) as Run;
    return run.schema === 1 && run.id === id ? run : null;
  } catch {
    return null;
  }
}

export async function listRuns(): Promise<RunSummary[]> {
  const ids = (await readdir(RUNS_DIR).catch(() => [] as string[])).filter((d) => RUN_ID.test(d)).sort().reverse().slice(0, 50);
  const runs = (await Promise.all(ids.map(loadRun))).filter((r): r is Run => r !== null);
  return runs.map((r) => ({
    id: r.id, task: r.task, robot: r.options.robot, startedAt: r.startedAt,
    // a run that says "running" but whose process is gone was killed before it could say otherwise
    status: r.status === "running" && !alive(r.pid) ? "crashed" : r.status,
    candidates: r.candidates.length, accepted: r.candidates.filter((c) => c.verdict?.accepted).length, episodes: r.episodes.length,
  }));
}
