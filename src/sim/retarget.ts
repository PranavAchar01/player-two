import { SPEED_LIMIT, TICK_HZ, type Side } from "./scene";
import type { Rig } from "./sim";

import type { Vec3 } from "./scene";
export type { Vec3 };

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

export interface RetargetFlags {
  held: boolean;
  clamped: boolean;
  limited: boolean;
}

/** Per-arm landmark triple: shoulder, elbow, wrist. */
export type ArmLandmarks = [Landmark, Landmark, Landmark];

/**
 * One control tick for one arm. Fail closed: if any landmark is below the visibility bar the
 * previous target is held. The pose is solved against the real robot kinematics, which clamps
 * to the joint range, and the result is rate limited.
 */
export function retargetArm(rig: Rig, lm: ArmLandmarks | null, side: Side, prev: number[], flip = false, maxSpeed = SPEED_LIMIT): { target: number[]; flags: RetargetFlags } {
  if (!lm || lm.some((p) => p.visibility < MIN_VISIBILITY)) return { target: prev, flags: { held: true, clamped: false, limited: false } };
  const [s, e, w] = lm;
  const upper = norm(toRobotFrame(sub(e, s), flip));
  const fore = norm(toRobotFrame(sub(w, e), flip));
  // A person's hands hang against their thighs; the G1's hips are wider, so a literal copy drives the
  // hand into the hip. Below about 30 degrees of arm raise, blend toward the robot's own rest pose.
  const raise = Math.acos(clamp(-upper.z, -1, 1));
  const k = clamp((raise - 0.2) / 0.32, 0, 1);
  const blend = k * k * (3 - 2 * k);
  const solved = rig.solve(side, upper, fore, prev);
  const want = solved.map((v, i) => rig.rest[side][i] + (v - rig.rest[side][i]) * blend);
  const range = rig.jointRange(side);
  const straight = upper.x * fore.x + upper.y * fore.y + upper.z * fore.z > 0.9;
  const maxStep = maxSpeed / TICK_HZ;
  let limited = false;
  const target = want.map((v, i) => {
    // yaw is ill-conditioned while the elbow is nearly straight, so it does not count as operator speed
    if (Math.abs(v - prev[i]) > maxStep * 1.5 && !(i === 2 && straight)) limited = true;
    return prev[i] + clamp(v - prev[i], -maxStep, maxStep);
  });
  const clamped = want.some((v, i) => v <= range[i][0] + 1e-3 || v >= range[i][1] - 1e-3);
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
  private prev: Record<Side, number[]>;
  constructor(private readonly rig: Rig) {
    this.prev = { left: rig.rest.left.slice(), right: rig.rest.right.slice() };
  }
  step(human: { left: ArmLandmarks | null; right: ArmLandmarks | null }, flip = false, maxSpeed = SPEED_LIMIT) {
    const forRobot: Record<Side, ArmLandmarks | null> = flip ? human : { left: human.right, right: human.left };
    const l = retargetArm(this.rig, forRobot.left, "left", this.prev.left, flip, maxSpeed);
    const r = retargetArm(this.rig, forRobot.right, "right", this.prev.right, flip, maxSpeed);
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
