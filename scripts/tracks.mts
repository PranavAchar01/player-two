// Turns pose tracks extracted from online videos (scripts/extract_pose.py) into robot demonstrations.
// Each track is resampled to the 50 Hz control rate and pushed through the same retarget, simulation
// and judge as a live webcam. usage: tsx scripts/tracks.mts [base-url]
//   uv run --python 3.11 --with 'mediapipe==0.10.14' --with 'numpy<2' --with opencv-python-headless \
//     python scripts/extract_pose.py <video> public/mediapipe/pose_landmarker_lite.task data/tracks/<id>.json
import { readFile, readdir, writeFile } from "node:fs/promises";
import loadMujoco from "@mujoco/mujoco";
import { judge, type EpisodeUpload } from "../src/sim/episode";
import { OneEuro, Operator, type ArmLandmarks, type Landmark } from "../src/sim/retarget";
import { SIDES, SLOTS, TICK_HZ, type TaskSpec } from "../src/sim/scene";
import { Rig, Sim, installG1 } from "../src/sim/sim";

interface Frame { t: number; world: Record<string, number[]> | null; image: Record<string, number[]> | null }
const base = process.argv[2] ?? "http://localhost:3218";
const mj = await loadMujoco();
const rig = new Rig(mj, await installG1(mj, async (f) => new Uint8Array(await readFile("vendor/unitree_g1/" + f))));
const ARMS = { left: ["11", "13", "15"], right: ["12", "14", "16"] };
const WINDOW_S = 6;

for (const file of (await readdir("data/tracks")).filter((f) => f.endsWith(".json"))) {
  const id = file.replace(".json", "");
  const track = JSON.parse(await readFile(`data/tracks/${file}`, "utf8")) as { fps: number; frames: Frame[] };
  const at = (tick: number) => track.frames[Math.min(track.frames.length - 1, Math.round((tick / TICK_HZ) * track.fps))];
  const totalTicks = Math.floor((track.frames.length / track.fps) * TICK_HZ);
  const taken = new Set<number>();
  for (const side of SIDES) for (const slot of SLOTS) {
    const task: TaskSpec = { side, slot };
    let found = false;
    for (let start = 0; start + 60 < totalTicks && !found; start += 10) {
      if ([...taken].some((s) => Math.abs(s - start) < 50)) continue; // a different stretch of video for each task
      const sim = new Sim(rig, task);
      const op = new Operator(rig);
      const filters = new Map<string, OneEuro>();
      const smooth = (key: string, v: number[]): Landmark => {
        const f = (i: number) => { const k = key + i; if (!filters.has(k)) filters.set(k, new OneEuro()); return filters.get(k)!.filter(v[i], 1 / TICK_HZ); };
        return { x: f(0), y: f(1), z: f(2), visibility: v[3] };
      };
      const e: EpisodeUpload = { nickname: `video:${id}`, task, source: "webcam", ctrl: [], held: [], clamped: [], limited: [], dtMs: [], clientSuccess: false };
      const skeleton: (number[][] | null)[] = [];
      let successAt = -1;
      for (let t = 0; t < WINDOW_S * TICK_HZ && start + t < totalTicks; t++) {
        const fr = at(start + t);
        const arm = (ids: string[], name: string): ArmLandmarks | null => (fr.world ? (ids.map((k) => smooth(name + k, fr.world![k])) as ArmLandmarks) : null);
        const out = op.step({ left: arm(ARMS.left, "l"), right: arm(ARMS.right, "r") });
        const info = sim.tick(out.ctrl);
        e.ctrl.push(out.ctrl); e.held.push(out.held); e.clamped.push(out.clamped); e.limited.push(out.limited); e.dtMs.push(1000 / TICK_HZ);
        e.clientSuccess = info.success;
        skeleton.push(fr.image ? Object.values(fr.image) : null);
        if (info.success && successAt < 0) successAt = t;
        if (successAt >= 0 && t - successAt > 45) break;
      }
      sim.dispose();
      if (!e.clientSuccess) continue;
      const verdict = judge(rig, e);
      if (!verdict.accepted) continue;
      found = true;
      taken.add(start);
      await fetch(`${base}/api/episodes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(e) }).catch(() => null);
      await writeFile(`data/demos/${id}-${side}-${slot}.json`, JSON.stringify({ source: `https://www.youtube.com/watch?v=${id}`, startSeconds: start / TICK_HZ, task, ctrl: e.ctrl, skeleton, gates: verdict.gates }));
      console.log(id, side, slot, `accepted: video ${(start / TICK_HZ).toFixed(1)}s to ${((start + e.ctrl.length) / TICK_HZ).toFixed(1)}s`);
    }
    if (!found) console.log(id, side, slot, "no stretch of this video passed every gate");
  }
}
