/**
 * Free mirror for the G1: the whole robot copies a person in a pre-recorded video. No task, no acceptance claimed.
 * The pelvis is a kinematic root (it follows the dancer, it is not balanced by a controller).
 */
import { Operator, toRobotFrame, type ArmLandmarks, type Landmark } from "./retarget";
import { MIRROR_SPEED_LIMIT, TICK_HZ, type Side, type Vec3 } from "./scene";
import { Rig, Sim, type BodyCommand } from "./sim";
import { SmoothTrack, lagOf, limb, pickWindow, type Track } from "./track";

/** Landmarks drawn as the skeleton, in this order (the renderer's bone list indexes into it). */
export const SKELETON_IDS = ["0", "11", "12", "13", "14", "15", "16", "23", "24", "25", "26", "27", "28"];
const PELVIS_Z = 0.793;

export interface MirrorWindow {
  /** seconds to cover */
  seconds: number;
  /** pinned start in seconds; omitted picks the most arm-active window */
  start?: number;
}

export function mirrorG1(rig: Rig, track: Track, window: MirrorWindow) {
  const st = new SmoothTrack(track, SKELETON_IDS);
  const { n, world, image, aspect } = st;
  const lerp = (series: number[], fpos: number) => st.lerp(series, fpos);
  const lm = (key: string, fpos: number) => st.lm(key, fpos);

  // ---- most arm-active window
  const win = Math.min(n - 2, Math.round(window.seconds * track.fps));
  const travel = track.frames.map((_, i) => (i === 0 ? 0 : ["15", "16"].reduce((s, k) => s + Math.hypot(world[k][0][i] - world[k][0][i - 1], world[k][1][i] - world[k][1][i - 1]), 0) * Math.min(world["15"][3][i], world["16"][3][i])));
  let best = pickWindow(travel, win).start;
  if (window.start !== undefined) best = Math.min(n - 2 - win, Math.max(0, Math.round(window.start * track.fps)));
  const startSeconds = best / track.fps;
  const ticks = Math.round((win / track.fps) * TICK_HZ);

  // image-space scale: the dancer's leg length in picture units maps to the robot's leg length
  const legLen = ["23", "24"].map((h, s) => { const a = s === 0 ? "27" : "28"; return Math.hypot((image[h][0][best] - image[a][0][best]) * aspect, image[h][1][best] - image[a][1][best]); }).reduce((a, b) => a + b, 0) / 2;
  const metresPerUnit = legLen > 0.05 ? rig.standAnkleDrop / legLen : 0;
  const hipX0 = (image["23"][0][best] + image["24"][0][best]) / 2;

  // true length of each leg segment: the longest it ever appears in the picture plane
  const fullLength: Record<string, number> = {};
  for (const [a, b] of [["24", "26"], ["26", "28"], ["23", "25"], ["25", "27"]]) fullLength[a + b] = st.fullLength(a, b);
  const sub = (a: Landmark, b: Landmark): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const rotZ = (v: Vec3, a: number): Vec3 => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a), z: v.z });

  // A seated person's thighs point at the camera. Retargeted literally that lifts the robot's legs into a lunge,
  // so when the person sits for most of the clip the robot simply stands still and only its upper body moves.
  let seatedTicks = 0;
  for (let t = 0; t < ticks; t += 5) {
    const fpos = Math.min(n - 1, (startSeconds + t / TICK_HZ) * track.fps);
    const drop = (hip: string, knee: string) => (lm(knee, fpos).y - lm(hip, fpos).y) / (fullLength[hip + knee] || 0.4);
    if (drop("24", "26") < 0.78 && drop("23", "25") < 0.78) seatedTicks += 5; // standing thighs measure about 0.9 to 1.0
  }
  const seated = seatedTicks > ticks * 0.6;

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
        if (seated || Math.min(h.visibility, k.visibility, a.visibility) < 0.5) continue; // seated or out of shot: hold
        // Pose models guess that a standing person's knees sit slightly toward the camera, which would crouch the
        // robot, so leg depth comes from foreshortening instead (see `limb`).
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
      skeleton.push(st.skeleton(SKELETON_IDS, shown));
      if (out.held) held++;
      if (out.limited) limited++;
    }
    return { ctrl, body, state, skeleton, held, limited };
  }

  // two passes: measure how far the arm joints trail the commands, then command that far ahead
  const first = fly(0);
  const lag = lagOf(first.ctrl, first.state, 8);
  const final = fly(lag);
  // residual: robot joints against the un-led human motion (what the viewer sees)
  const residual = lagOf(first.ctrl, final.state, 8);
  const pct = (v: number) => +((v / ticks) * 100).toFixed(1);
  return {
    aspect, startSeconds, ticks, metresPerUnit,
    ctrl: final.ctrl, body: final.body, skeleton: final.skeleton,
    stats: { tracked: 100 - pct(final.held), limited: pct(final.limited), lagMsBefore: lag * 20, lagMsAfter: residual * 20, seated },
  };
}

/** Attribution line for the stock clips the tracks were extracted from. */
export const clipSource = (id: string) => (id.startsWith("pexels-") ? `https://www.pexels.com/video/${id.slice(7)}/ (Pexels license)` : `https://mixkit.co (clip ${id.slice(7)}, Mixkit free license)`);
