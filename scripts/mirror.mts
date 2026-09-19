// Free mirror demos: the robot copies a person in a video with nothing to strike and no claim of acceptance.
// Picks the most arm-active stretch of each clip. usage: tsx scripts/mirror.mts <clip-id> [<clip-id> ...]
import { readFile, writeFile } from "node:fs/promises";
import loadMujoco from "@mujoco/mujoco";
import { OneEuro, Operator, type ArmLandmarks, type Landmark } from "../src/sim/retarget";
import { TICK_HZ } from "../src/sim/scene";
import { Rig, Sim, installG1 } from "../src/sim/sim";

interface Frame { t: number; world: Record<string, number[]> | null; image: Record<string, number[]> | null }
const mj = await loadMujoco();
const rig = new Rig(mj, await installG1(mj, async (f) => new Uint8Array(await readFile("vendor/unitree_g1/" + f))));
const SECONDS = 7;

for (const id of process.argv.slice(2)) {
  const track = JSON.parse(await readFile(`data/tracks/${id}.json`, "utf8")) as { fps: number; width: number; height: number; frames: Frame[] };
  const n = track.frames.length;
  const win = Math.min(n - 1, Math.round(SECONDS * track.fps));
  // wrist travel per frame, zero where tracking is missing or weak
  const travel = track.frames.map((f, i) => {
    const p = track.frames[i - 1];
    if (!f.world || !p?.world || [13, 14, 15, 16].some((k) => f.world![k][3] < 0.6)) return -0.02;
    return [15, 16].reduce((s, k) => s + Math.hypot(f.world![k][0] - p.world![k][0], f.world![k][1] - p.world![k][1]), 0);
  });
  let best = 0, bestScore = -Infinity, run = travel.slice(0, win).reduce((a, b) => a + b, 0);
  for (let i = 0; i + win < n; i++) {
    if (run > bestScore) { bestScore = run; best = i; }
    run += travel[i + win] - travel[i];
  }
  const startSeconds = best / track.fps;
  const sim = new Sim(rig, null);
  const op = new Operator(rig);
  const filters = new Map<string, OneEuro>();
  const ctrl: number[][] = [];
  const skeleton: (number[][] | null)[] = [];
  let held = 0, limited = 0, clamped = 0;
  const ticks = Math.round((win / track.fps) * TICK_HZ);
  for (let t = 0; t < ticks; t++) {
    const fr = track.frames[Math.min(n - 1, Math.round((startSeconds + t / TICK_HZ) * track.fps))];
    const arm = (ids: string[], name: string): ArmLandmarks | null => (fr.world ? (ids.map((k) => {
      const v = fr.world![k];
      const f = (i: number) => { const key = name + k + i; if (!filters.has(key)) filters.set(key, new OneEuro()); return filters.get(key)!.filter(v[i], 1 / TICK_HZ); };
      return { x: f(0), y: f(1), z: f(2), visibility: v[3] } as Landmark;
    }) as ArmLandmarks) : null);
    const out = op.step({ left: arm(["11", "13", "15"], "l"), right: arm(["12", "14", "16"], "r") });
    sim.tick(out.ctrl);
    ctrl.push(out.ctrl);
    skeleton.push(fr.image ? Object.values(fr.image) : null);
    if (out.held) held++;
    if (out.limited) limited++;
    if (out.clamped) clamped++;
  }
  const pct = (v: number) => +((v / ticks) * 100).toFixed(1);
  await writeFile(`data/demos/mirror-${id}.json`, JSON.stringify({ source: `https://mixkit.co (clip ${id.slice(7)}, Mixkit free license)`, video: id, aspect: track.width / track.height, startSeconds, task: null, ctrl, skeleton, stats: { tracked: 100 - pct(held), limited: pct(limited), clamped: pct(clamped) } }));
  console.log(id, `window ${startSeconds.toFixed(1)}s to ${(startSeconds + SECONDS).toFixed(1)}s`, `tracked ${100 - pct(held)}%`, `speed-limited ${pct(limited)}%`, `at joint limit ${pct(clamped)}%`);
}
