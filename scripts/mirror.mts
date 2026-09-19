// Free mirror demos: the whole robot copies a person in a pre-recorded video. No task, no acceptance claimed.
// Because the motion is known in advance, this path can do what live teleoperation cannot: smooth with zero
// phase delay, interpolate between video frames, and command ahead of time by the measured tracking lag.
// The pelvis is a kinematic root (it follows the dancer, it is not balanced by a controller).
// usage: tsx scripts/mirror.mts <clip-id> [<clip-id> ...]
import { readFile, writeFile } from "node:fs/promises";
import loadMujoco from "@mujoco/mujoco";
import { Operator, toRobotFrame, type ArmLandmarks, type Landmark } from "../src/sim/retarget";
import { MIRROR_SPEED_LIMIT, TICK_HZ, type Side, type Vec3 } from "../src/sim/scene";
import { Rig, Sim, installG1, type BodyCommand } from "../src/sim/sim";

interface Frame { t: number; world: Record<string, number[]> | null; image: Record<string, number[]> | null }
const mj = await loadMujoco();
const rig = new Rig(mj, await installG1(mj, async (f) => new Uint8Array(await readFile("vendor/unitree_g1/" + f))));
const SECONDS = 7;
const IDS = ["0", "11", "12", "13", "14", "15", "16", "23", "24", "25", "26", "27", "28"];
const PELVIS_Z = 0.793;

for (const spec of process.argv.slice(2)) {
  // "clip" picks the most active window; "clip@start+seconds" pins it, e.g. mixkit-50759@0+6.5
  const [id, pinned] = spec.split("@");
  const [pinStart, pinSeconds] = (pinned ?? "").split("+").map(Number);
  const track = JSON.parse(await readFile(`data/tracks/${id}.json`, "utf8")) as { fps: number; width: number; height: number; frames: Frame[] };
  const n = track.frames.length;
  const aspect = track.width / track.height;

  // ---- zero-phase smoothing over the whole clip (hold through gaps, then a centred Gaussian)
  const smoothSeries = (get: (f: Frame) => number | null) => {
    const raw: number[] = [];
    let last = 0;
    for (const f of track.frames) raw.push((last = get(f) ?? last));
    const k = [0.06, 0.24, 0.4, 0.24, 0.06];
    return raw.map((_, i) => k.reduce((s, w, j) => s + w * raw[Math.min(n - 1, Math.max(0, i + j - 2))], 0));
  };
  const world: Record<string, number[][]> = {};
  const image: Record<string, number[][]> = {};
  for (const key of IDS) {
    world[key] = [0, 1, 2].map((c) => smoothSeries((f) => f.world?.[key]?.[c] ?? null));
    world[key].push(track.frames.map((f) => f.world?.[key]?.[3] ?? 0));
    image[key] = [0, 1].map((c) => smoothSeries((f) => f.image?.[key]?.[c] ?? null));
  }
  const lerp = (series: number[], fpos: number) => {
    const i = Math.min(n - 2, Math.max(0, Math.floor(fpos)));
    const u = Math.min(1, Math.max(0, fpos - i));
    return series[i] * (1 - u) + series[i + 1] * u;
  };
  const lm = (key: string, fpos: number): Landmark => ({ x: lerp(world[key][0], fpos), y: lerp(world[key][1], fpos), z: lerp(world[key][2], fpos), visibility: lerp(world[key][3], fpos) });

  // ---- most arm-active window
  const win = Math.min(n - 2, Math.round((pinSeconds || SECONDS) * track.fps));
  const travel = track.frames.map((_, i) => (i === 0 ? 0 : ["15", "16"].reduce((s, k) => s + Math.hypot(world[k][0][i] - world[k][0][i - 1], world[k][1][i] - world[k][1][i - 1]), 0) * Math.min(world["15"][3][i], world["16"][3][i])));
  let best = 0, bestScore = -Infinity, run = travel.slice(0, win).reduce((a, b) => a + b, 0);
  for (let i = 0; i + win < n; i++) { if (run > bestScore) { bestScore = run; best = i; } run += travel[i + win] - travel[i]; }
  if (pinned && Number.isFinite(pinStart)) best = Math.min(n - 2 - win, Math.max(0, Math.round(pinStart * track.fps))); // "clip@auto+6" keeps the automatic start
  const startSeconds = best / track.fps;
  const ticks = Math.round((win / track.fps) * TICK_HZ);

  // image-space scale: the dancer's leg length in picture units maps to the robot's leg length
  const legLen = ["23", "24"].map((h, s) => { const a = s === 0 ? "27" : "28"; return Math.hypot((image[h][0][best] - image[a][0][best]) * aspect, image[h][1][best] - image[a][1][best]); }).reduce((a, b) => a + b, 0) / 2;
  const metresPerUnit = legLen > 0.05 ? rig.standAnkleDrop / legLen : 0;
  const hipX0 = (image["23"][0][best] + image["24"][0][best]) / 2;

  // true length of each leg segment: the longest it ever appears in the picture plane (90th percentile, to ignore outliers)
  const fullLength: Record<string, number> = {};
  for (const [a, b] of [["24", "26"], ["26", "28"], ["23", "25"], ["25", "27"]]) {
    const seen = track.frames.map((_, i) => Math.hypot(world[b][0][i] - world[a][0][i], world[b][1][i] - world[a][1][i])).sort((x, y) => x - y);
    fullLength[a + b] = seen[Math.floor(seen.length * 0.9)] || 0.4;
  }
  const sub = (a: Landmark, b: Landmark): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const rotZ = (v: Vec3, a: number): Vec3 => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a), z: v.z });

  function fly(leadTicks: number) {
    const sim = new Sim(rig, null);
    const op = new Operator(rig);
    const legPrev: Record<Side, number[]> = { left: [0, 0, 0, 0], right: [0, 0, 0, 0] };
    let yaw = 0;
    const ctrl: number[][] = [], body: BodyCommand[] = [], state: number[][] = [], skeleton: (number[] | null)[][] = [];
    let held = 0, limited = 0;
    for (let t = 0; t < ticks; t++) {
      const fpos = Math.min(n - 1, (startSeconds + (t + leadTicks) / TICK_HZ) * track.fps);
      const shown = Math.min(n - 1, (startSeconds + t / TICK_HZ) * track.fps);
      const arm = (ids: string[]): ArmLandmarks => ids.map((k) => lm(k, fpos)) as ArmLandmarks;
      const out = op.step({ left: arm(["11", "13", "15"]), right: arm(["12", "14", "16"]) }, false, MIRROR_SPEED_LIMIT);

      // root yaw from the hip line, damped because single-camera depth is the noisy axis
      const hips = toRobotFrame(sub(lm("24", fpos), lm("23", fpos)));
      // Hip depth from one camera is noisy enough to read a square-on person as turned 20 degrees. Ignore small
      // turns entirely and follow only clear ones, slowly.
      const rawYaw = Math.atan2(-hips.x, hips.y);
      const wantYaw = Math.abs(rawYaw) < 0.45 ? 0 : Math.max(-0.6, Math.min(0.6, (rawYaw - Math.sign(rawYaw) * 0.45) * 0.8));
      yaw += (wantYaw - yaw) * 0.06;

      // legs: mirrored like the arms. Human left leg drives the robot's right leg. Directions go into the yawed pelvis frame.
      const legs: Record<Side, { q: number[]; ankleDrop: number }> = { left: { q: legPrev.left, ankleDrop: rig.standAnkleDrop }, right: { q: legPrev.right, ankleDrop: rig.standAnkleDrop } };
      for (const [side, ids] of [["left", ["24", "26", "28"]], ["right", ["23", "25", "27"]]] as [Side, string[]][]) {
        const [h, k, a] = ids.map((key) => lm(key, fpos));
        if (Math.min(h.visibility, k.visibility, a.visibility) < 0.5) continue; // legs out of shot: hold
        // Single-camera pose models guess that a standing person's knees sit slightly toward the camera, which
        // would crouch the robot. Depth comes from foreshortening instead: a segment seen at full length lies in
        // the picture plane, and only a visibly shortened one points toward or away from the camera.
        const limb = (from: Landmark, to: Landmark, full: number): Vec3 => {
          const dx = to.x - from.x, dy = to.y - from.y;
          const planar = Math.hypot(dx, dy);
          // continuous: exactly zero at 93% of full length and growing smoothly below it, so a small change in
          // apparent length can never snap the knee from straight to bent
          const ratio = Math.min(1, planar / (0.93 * full));
          const depth = Math.sign(to.z - from.z) * full * Math.sqrt(1 - ratio * ratio);
          return { x: -depth, y: -dx, z: -dy };
        };
        // Single-camera depth also cannot tell which leg is in front when the dancer turns away, which would cross
        // the robot's legs through each other. Keep each leg on its own side of the midline.
        const outward = side === "left" ? 1 : -1;
        const keepApart = (v: Vec3): Vec3 => ({ ...v, y: outward * Math.max(-0.06, outward * v.y) });
        const thigh = keepApart(rotZ(limb(h, k, fullLength[ids[0] + ids[1]]), -yaw)), shin = keepApart(rotZ(limb(k, a, fullLength[ids[1] + ids[2]]), -yaw));
        legs[side] = rig.solveLeg(side, thigh, shin, legPrev[side]);
        legPrev[side] = legs[side].q;
      }
      const leg6 = (s: Side) => { const [hp, hr, hy, kn] = legs[s].q; return [hp, hr, hy, kn, -(hp + kn), -hr]; };
      // the lower foot stays on the floor: bend both knees and the pelvis drops, lift one foot and it rises
      const rootZ = PELVIS_Z - (rig.standAnkleDrop - Math.max(legs.left.ankleDrop, legs.right.ankleDrop));
      const hipX = (lerp(image["23"][0], fpos) + lerp(image["24"][0], fpos)) / 2;
      const rootY = Math.max(-0.7, Math.min(0.7, -(hipX - hipX0) * aspect * metresPerUnit));
      const cmd: BodyCommand = { legs: [...leg6("left"), ...leg6("right")], rootPos: [0, rootY, rootZ], rootYaw: yaw };
      const info = sim.tick(out.ctrl, cmd);
      ctrl.push(out.ctrl); body.push(cmd); state.push(info.state);
      // joints the camera cannot see are left out of the drawn skeleton rather than guessed
      skeleton.push(IDS.map((k) => (lerp(world[k][3], shown) < 0.5 ? null : [lerp(image[k][0], shown), lerp(image[k][1], shown)])));
      if (out.held) held++;
      if (out.limited) limited++;
    }
    return { ctrl, body, state, skeleton, held, limited };
  }

  // how many ticks the achieved arm joints trail the commands
  const lagOf = (cmd: number[][], got: number[][]) => {
    let bestL = 0, bestErr = Infinity;
    for (let L = 0; L <= 20; L++) {
      let err = 0, c = 0;
      for (let t = 0; t + L < cmd.length; t++) for (let j = 0; j < 8; j++) { err += (cmd[t][j] - got[t + L][j]) ** 2; c++; }
      if (err / c < bestErr) { bestErr = err / c; bestL = L; }
    }
    return bestL;
  };
  const first = fly(0);
  const lag = lagOf(first.ctrl, first.state);
  const final = fly(lag);
  // residual: robot joints against the un-led human motion (what the viewer sees)
  const residual = lagOf(first.ctrl, final.state);
  const pct = (v: number) => +((v / ticks) * 100).toFixed(1);
  const outName = pinned && Number.isFinite(pinStart) ? `mirror-${id}-${pinStart}` : `mirror-${id}`;
  await writeFile(`data/demos/${outName}.json`, JSON.stringify({ source: id.startsWith("pexels-") ? `https://www.pexels.com/video/${id.slice(7)}/ (Pexels license)` : `https://mixkit.co (clip ${id.slice(7)}, Mixkit free license)`, video: id, aspect, startSeconds, task: null, ctrl: final.ctrl, body: final.body, skeleton: final.skeleton, stats: { tracked: 100 - pct(final.held), limited: pct(final.limited), lagMsBefore: lag * 20, lagMsAfter: residual * 20 } }));
  console.log(outName, `window ${startSeconds.toFixed(1)}s +${(ticks / TICK_HZ).toFixed(1)}s`, `| tracking lag ${lag * 20} ms -> ${residual * 20} ms with ${lag * 20} ms of preview`, `| speed cap active ${pct(final.limited)}% (was 6 rad/s, now ${MIRROR_SPEED_LIMIT})`, `| legs scale ${metresPerUnit.toFixed(2)} m/unit`);
}
