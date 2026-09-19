import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SIDES, SLOTS, type TaskSpec } from "@/sim/scene";
import type { EpisodeUpload, Gate } from "@/sim/episode";

export const DATA_DIR = path.resolve(process.env.PLAYER_TWO_DATA_DIR ?? ".player-two");
const EPISODES = path.join(DATA_DIR, "episodes");
const ID = /^[a-f0-9]{12}$/;

export interface StoredEpisode extends EpisodeUpload {
  id: string;
  createdAt: string;
  accepted: boolean;
  gates: Gate[];
  successTick: number | null;
  state: number[][];
}

export type EpisodeSummary = Pick<StoredEpisode, "id" | "createdAt" | "nickname" | "task" | "source" | "accepted" | "successTick"> & { ticks: number; failed: string[] };

export async function saveEpisode(e: StoredEpisode): Promise<void> {
  await mkdir(EPISODES, { recursive: true });
  await writeFile(path.join(EPISODES, `${e.id}.json`), JSON.stringify(e));
}

export async function loadEpisode(id: string): Promise<StoredEpisode | null> {
  if (!ID.test(id)) return null;
  try {
    return JSON.parse(await readFile(path.join(EPISODES, `${id}.json`), "utf8")) as StoredEpisode;
  } catch {
    return null;
  }
}

export async function listEpisodes(): Promise<StoredEpisode[]> {
  const files = await readdir(EPISODES).catch(() => [] as string[]);
  const all = await Promise.all(files.filter((f) => f.endsWith(".json")).map((f) => loadEpisode(f.slice(0, -5))));
  return all.filter((e): e is StoredEpisode => e !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const summarize = (e: StoredEpisode): EpisodeSummary => ({
  id: e.id, createdAt: e.createdAt, nickname: e.nickname, task: e.task, source: e.source, accepted: e.accepted, successTick: e.successTick,
  ticks: e.ctrl.length, failed: e.gates.filter((g) => !g.pass).map((g) => g.label),
});

export interface Coverage {
  cells: { task: TaskSpec; accepted: number }[];
  next: TaskSpec;
  message: string;
}

/** Steers collection toward the least-covered task so the dataset stays balanced. */
export function coverage(episodes: StoredEpisode[]): Coverage {
  const cells = SIDES.flatMap((side) => SLOTS.map((slot) => ({ task: { side, slot }, accepted: episodes.filter((e) => e.accepted && e.task.side === side && e.task.slot === slot).length })));
  const next = [...cells].sort((a, b) => a.accepted - b.accepted)[0].task;
  const bySide = (s: string) => cells.filter((c) => c.task.side === s).reduce((n, c) => n + c.accepted, 0);
  return { cells, next, message: `${bySide("left")} left-hand and ${bySide("right")} right-hand demonstrations accepted. Next contributor: ${next.side} hand, ${next.slot} pendulum.` };
}
