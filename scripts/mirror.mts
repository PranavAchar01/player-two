// Free mirror demos: the whole G1 copies a person in a pre-recorded video. No task, no acceptance claimed.
// The retargeting itself lives in src/sim/mirror.ts (shared with scripts/retarget.mts); the track handling
// (zero-phase smoothing, frame interpolation, lag-compensating preview) lives in src/sim/track.ts.
// usage: tsx scripts/mirror.mts <clip-id> [<clip-id> ...]
import { readFile, writeFile } from "node:fs/promises";
import loadMujoco from "@mujoco/mujoco";
import { clipSource, mirrorG1 } from "../src/sim/mirror";
import { MIRROR_SPEED_LIMIT, TICK_HZ } from "../src/sim/scene";
import { Rig, installG1 } from "../src/sim/sim";
import type { Track } from "../src/sim/track";

const mj = await loadMujoco();
const rig = new Rig(mj, await installG1(mj, async (f) => new Uint8Array(await readFile("vendor/unitree_g1/" + f))));
const SECONDS = 7;

for (const spec of process.argv.slice(2)) {
  // "clip" picks the most active window; "clip@start+seconds" pins it, e.g. mixkit-50759@0+6.5
  const [id, pinned] = spec.split("@");
  const [pinStart, pinSeconds] = (pinned ?? "").split("+").map(Number);
  const track = JSON.parse(await readFile(`data/tracks/${id}.json`, "utf8")) as Track;
  const pin = Boolean(pinned) && Number.isFinite(pinStart); // "clip@auto+6" keeps the automatic start
  const m = mirrorG1(rig, track, { seconds: pinSeconds || SECONDS, start: pin ? pinStart : undefined });
  const outName = pin ? `mirror-${id}-${pinStart}` : `mirror-${id}`;
  await writeFile(`data/demos/${outName}.json`, JSON.stringify({ source: clipSource(id), video: id, aspect: m.aspect, startSeconds: m.startSeconds, task: null, ctrl: m.ctrl, body: m.body, skeleton: m.skeleton, stats: m.stats }));
  const lag = m.stats.lagMsBefore;
  console.log(outName, `window ${m.startSeconds.toFixed(1)}s +${(m.ticks / TICK_HZ).toFixed(1)}s`, `| tracking lag ${lag} ms -> ${m.stats.lagMsAfter} ms with ${lag} ms of preview`, `| speed cap active ${m.stats.limited}% (was 6 rad/s, now ${MIRROR_SPEED_LIMIT})`, `| legs scale ${m.metresPerUnit.toFixed(2)} m/unit`);
}
