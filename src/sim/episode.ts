import type { MainModule } from "@mujoco/mujoco";
import { ACTUATORS, EPISODE_SECONDS, FOREARM, SLOT_ANGLE, TICK_HZ, UPPER_ARM, type TaskSpec } from "./scene";
import { Operator, type ArmLandmarks, type Landmark } from "./retarget";
import { Sim } from "./sim";

export const MAX_TICKS = Math.round(EPISODE_SECONDS * TICK_HZ);

/** What a client uploads. Only joint-space numbers: no video, no landmarks, no pixels. */
export interface EpisodeUpload {
  nickname: string;
  task: TaskSpec;
  source: "webcam" | "pilot";
  ctrl: number[][]; // [tick][8] joint targets that were sent to the robot
  held: boolean[]; // tick held because tracking confidence was low
  clamped: boolean[]; // operator asked for a pose outside the joint range
  limited: boolean[]; // operator moved faster than the speed cap
  dtMs: number[]; // wall-clock time between control ticks
  clientSuccess: boolean;
}

export interface Gate {
  id: string;
  label: string;
  pass: boolean;
  measured: string;
  required: string;
}

export interface Verdict {
  accepted: boolean;
  gates: Gate[];
  successTick: number | null;
  state: number[][]; // observation.state from the server replay
}

const ratio = (flags: boolean[]) => (flags.length ? flags.filter(Boolean).length / flags.length : 0);
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const gate = (id: string, label: string, pass: boolean, measured: string, required: string): Gate => ({ id, label, pass, measured, required });

export const LIMITS = { held: 0.2, clamped: 0.15, limited: 0.1, torque: 0.1, dropped: 0.1, jerk: 0.02, minTicks: 25 };

export function validShape(e: EpisodeUpload): boolean {
  const n = e.ctrl?.length ?? 0;
  return (
    n >= 1 && n <= MAX_TICKS &&
    e.ctrl.every((row) => Array.isArray(row) && row.length === ACTUATORS.length && row.every(Number.isFinite)) &&
    [e.held, e.clamped, e.limited, e.dtMs].every((a) => Array.isArray(a) && a.length === n)
  );
}

/**
 * The server never trusts the client's claim of success. It replays the uploaded joint targets
 * through the same deterministic simulation and measures everything again.
 */
export function judge(mj: MainModule, e: EpisodeUpload): Verdict {
  const sim = new Sim(mj, e.task);
  const state: number[][] = [];
  let successTick: number | null = null;
  let torqueTicks = 0;
  let collisionTicks = 0;
  let firstTouch: string | null = null;
  for (let t = 0; t < e.ctrl.length; t++) {
    const info = sim.tick(e.ctrl[t]);
    state.push(info.state);
    if (info.torqueSaturated) torqueTicks++;
    if (info.selfCollision) collisionTicks++;
    firstTouch = info.firstTouch;
    if (info.success && successTick === null) successTick = t;
  }
  sim.dispose();

  let jerkSum = 0;
  let jerkN = 0;
  for (let t = 3; t < e.ctrl.length; t++) {
    for (let j = 0; j < ACTUATORS.length; j++) {
      jerkSum += Math.abs(e.ctrl[t][j] - 3 * e.ctrl[t - 1][j] + 3 * e.ctrl[t - 2][j] - e.ctrl[t - 3][j]);
      jerkN++;
    }
  }
  const jerk = jerkN ? jerkSum / jerkN : 0;
  const dropped = ratio(e.dtMs.map((d) => d > 60));
  const n = e.ctrl.length;

  const gates = [
    gate("length", "Episode length", n >= LIMITS.minTicks, `${(n / TICK_HZ).toFixed(1)}s`, `>= ${(LIMITS.minTicks / TICK_HZ).toFixed(1)}s`),
    gate("success", "Task success (server replay)", successTick !== null, successTick === null ? "bob not struck" : `at ${(successTick / TICK_HZ).toFixed(1)}s`, "bob moved >= 0.12 m"),
    gate("replay_match", "Client and replay agree", e.clientSuccess === (successTick !== null), e.clientSuccess ? "client: success" : "client: no success", "same outcome"),
    gate("hand", "Correct hand made first contact", firstTouch === e.task.side, firstTouch ?? "no contact", e.task.side),
    gate("confidence", "Ticks held for low tracking confidence", ratio(e.held) <= LIMITS.held, pct(ratio(e.held)), `<= ${pct(LIMITS.held)}`),
    gate("joint_range", "Ticks outside the robot's joint range", ratio(e.clamped) <= LIMITS.clamped, pct(ratio(e.clamped)), `<= ${pct(LIMITS.clamped)}`),
    gate("speed", "Ticks over the joint speed cap", ratio(e.limited) <= LIMITS.limited, pct(ratio(e.limited)), `<= ${pct(LIMITS.limited)}`),
    gate("torque", "Ticks at the torque limit", torqueTicks / n <= LIMITS.torque, pct(torqueTicks / n), `<= ${pct(LIMITS.torque)}`),
    gate("self_collision", "Self-collision ticks", collisionTicks === 0, String(collisionTicks), "0"),
    gate("jerk", "Command jerk (mean |3rd difference|)", jerk <= LIMITS.jerk, `${jerk.toFixed(4)} rad`, `<= ${LIMITS.jerk} rad`),
    gate("dropped", "Dropped control frames", dropped <= LIMITS.dropped, pct(dropped), `<= ${pct(LIMITS.dropped)}`),
  ];
  return { accepted: gates.every((g) => g.pass), gates, successTick, state };
}

// ---------------------------------------------------------------- scripted pilot

const lm = (x: number, y: number, z: number): Landmark => ({ x, y, z, visibility: 0.99 });


/**
 * Synthetic operator: a straight-arm sideways raise that sweeps through the bob and follows
 * through. Emits MediaPipe-frame landmarks for the human arm that mirrors the robot arm under
 * test, so it exercises the same retarget path a webcam does.
 */
export function pilotLandmarks(task: TaskSpec, seconds: number, speed = 1): ArmLandmarks {
  const end = Math.min(2.2, SLOT_ANGLE[task.slot] + (32 * Math.PI) / 180);
  const u = Math.min(1, Math.max(0, (seconds * speed) / 3));
  const th = 0.08 + (end - 0.08) * u * u * (3 - 2 * u);
  const dir = { y: Math.sin(th), z: -Math.cos(th) };
  // robot frame (y out from this arm's shoulder, z up) to MediaPipe frame for the mirrored human arm
  const m = task.side === "left" ? 1 : -1;
  const toMp = (r: number) => lm(-dir.y * r * m, -dir.z * r, 0);
  return [toMp(0), toMp(UPPER_ARM), toMp(UPPER_ARM + FOREARM)];
}

/** Runs the scripted pilot through the real retarget path and returns what a browser would upload. */
export function flyPilot(mj: MainModule, task: TaskSpec, nickname = "pilot", speed = 1): EpisodeUpload {
  const sim = new Sim(mj, task);
  const op = new Operator();
  const e: EpisodeUpload = { nickname, task, source: "pilot", ctrl: [], held: [], clamped: [], limited: [], dtMs: [], clientSuccess: false };
  for (let t = 0; t < MAX_TICKS; t++) {
    const arm = pilotLandmarks(task, t / TICK_HZ, speed);
    const out = op.step(task.side === "left" ? { left: null, right: arm } : { left: arm, right: null });
    const info = sim.tick(out.ctrl);
    e.ctrl.push(out.ctrl);
    e.held.push(false);
    e.clamped.push(out.clamped);
    e.limited.push(out.limited);
    e.dtMs.push(1000 / TICK_HZ);
    e.clientSuccess = info.success;
    if (info.success && t > 40 && e.ctrl.length > 60) break;
  }
  sim.dispose();
  return e;
}
