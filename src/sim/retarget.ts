import { JOINT_RANGE, JOINTS, SPEED_LIMIT, TICK_HZ, type Side } from "./scene";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** MediaPipe pose world landmark subset. `visibility` is 0..1. */
export interface Landmark extends Vec3 {
  visibility: number;
}

export const MIN_VISIBILITY = 0.6;
/** Single-camera depth is the noisiest axis, so it is attenuated before it becomes motion. */
export const DEPTH_GAIN = 0.6;

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const norm = (v: Vec3): Vec3 => {
  const n = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / n, y: v.y / n, z: v.z / n };
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * MediaPipe world frame (x toward the subject's left, y down, z away from the camera) to the
 * robot frame (x forward, y left, z up), mirrored so the robot moves like a reflection.
 */
export const toRobotFrame = (v: Vec3, flip = false): Vec3 => ({ x: -v.z * DEPTH_GAIN, y: flip ? v.x : -v.x, z: -v.y });

/**
 * Joint angles [pitch, roll, yaw, elbow] that point the upper arm along `upper` and the
 * forearm along `fore` (unit vectors in the robot frame). Works for both arms because the
 * right arm's roll and yaw axes are mirrored in the model.
 */
export function armAngles(upper: Vec3, fore: Vec3, side: Side, prev: number[]): [number, number, number, number] {
  const m = side === "left" ? 1 : -1;
  const d = norm({ x: upper.x, y: upper.y * m, z: upper.z });
  const f = norm({ x: fore.x, y: fore.y * m, z: fore.z });

  // d = (-sin p cos r, sin r, -cos p cos r) has two solutions. Raising the arm sideways past
  // horizontal must come out as roll > 90 degrees, not as a half-turn of pitch, so take the
  // solution nearest the previous pose.
  const r1 = Math.asin(clamp(d.y, -1, 1));
  const p1 = Math.atan2(-d.x, -d.z);
  const r2 = (d.y >= 0 ? Math.PI : -Math.PI) - r1;
  const p2 = Math.atan2(d.x, d.z);
  const cost = (p: number, r: number) => Math.abs(p - prev[0]) + Math.abs(r - prev[1]) + (r < JOINT_RANGE.shoulder_roll[0] || r > JOINT_RANGE.shoulder_roll[1] ? 10 : 0);
  const [pitch, roll] = cost(p1, r1) <= cost(p2, r2) ? [p1, r1] : [p2, r2];

  // forearm in the frame after pitch and roll: R0^T f, with R0 = Ry(pitch) Rx(roll)
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  const ax = cp * f.x - sp * f.z; // Ry^T
  const az = sp * f.x + cp * f.z;
  const lx = ax;
  const ly = cr * f.y + sr * az; // Rx^T
  const lz = -sr * f.y + cr * az;
  const elbow = Math.acos(clamp(-lz, -1, 1));
  const yaw = Math.sin(elbow) > 0.2 ? Math.atan2(ly, lx) : prev[2];
  return [pitch, roll, yaw, elbow];
}

export interface RetargetFlags {
  held: boolean;
  clamped: boolean;
  limited: boolean;
}

/** Per-arm landmark triple: shoulder, elbow, wrist. */
export type ArmLandmarks = [Landmark, Landmark, Landmark];

/**
 * One control tick for one arm. Fail closed: if any landmark is below the visibility bar the
 * previous target is held. Targets are clamped to the joint range and rate limited.
 */
export function retargetArm(lm: ArmLandmarks | null, side: Side, prev: number[], flip = false): { target: number[]; flags: RetargetFlags } {
  if (!lm || lm.some((p) => p.visibility < MIN_VISIBILITY)) return { target: prev, flags: { held: true, clamped: false, limited: false } };
  const [s, e, w] = lm;
  const raw = armAngles(toRobotFrame(sub(e, s), flip), toRobotFrame(sub(w, e), flip), side, prev);
  let clamped = false;
  let limited = false;
  const maxStep = SPEED_LIMIT / TICK_HZ;
  const target = raw.map((v, i) => {
    const [lo, hi] = JOINT_RANGE[JOINTS[i]];
    const c = clamp(v, lo, hi);
    if (Math.abs(c - v) > 0.02) clamped = true;
    const step = clamp(c - prev[i], -maxStep, maxStep);
    // yaw is ill-conditioned while the elbow is nearly straight, so it does not count as operator speed
    if (Math.abs(c - prev[i]) > maxStep * 1.5 && !(i === 2 && raw[3] < 0.5)) limited = true;
    return prev[i] + step;
  });
  return { target, flags: { held: false, clamped, limited } };
}

/** One Euro filter for a landmark coordinate stream. */
export class OneEuro {
  private x?: number;
  private dx = 0;
  constructor(private minCutoff = 1.2, private beta = 0.3, private dCutoff = 1) {}
  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(value: number, dt: number): number {
    if (this.x === undefined) {
      this.x = value;
      return value;
    }
    const dxRaw = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dxRaw - this.dx);
    this.x += OneEuro.alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt) * (value - this.x);
    return this.x;
  }
}

/**
 * Both arms for one control tick. Mirrored by default: the human's left arm drives the
 * robot's right arm, like a reflection. An arm with no landmarks simply holds.
 */
export class Operator {
  private prev: Record<Side, number[]> = { left: [0, 0, 0, 0], right: [0, 0, 0, 0] };
  step(human: { left: ArmLandmarks | null; right: ArmLandmarks | null }, flip = false) {
    const forRobot: Record<Side, ArmLandmarks | null> = flip ? human : { left: human.right, right: human.left };
    const l = retargetArm(forRobot.left, "left", this.prev.left, flip);
    const r = retargetArm(forRobot.right, "right", this.prev.right, flip);
    this.prev = { left: l.target, right: r.target };
    const tracked = [forRobot.left && l.flags, forRobot.right && r.flags].filter((f): f is RetargetFlags => Boolean(f));
    return {
      ctrl: [...l.target, ...r.target],
      held: tracked.length === 0 || tracked.some((f) => f.held),
      clamped: tracked.some((f) => f.clamped),
      limited: tracked.some((f) => f.limited),
    };
  }
}
