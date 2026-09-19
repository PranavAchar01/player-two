import { readFile } from "node:fs/promises";
import path from "node:path";
import loadMujoco from "@mujoco/mujoco";
import { beforeAll, describe, expect, it } from "vitest";
import { ARM_ROBOTS, ARM_SPECS, Arm, ArmSim, installArm, type ArmRobot } from "./arm";
import { retargetToArm } from "./armRetarget";
import { DEPTH_GAIN } from "./retarget";
import { SKELETON_IDS } from "./mirror";
import { lagOf, pickWindow, type Track, type TrackFrame } from "./track";

const arms = {} as Record<ArmRobot, Arm>;
beforeAll(async () => {
  const mj = await loadMujoco();
  for (const robot of ARM_ROBOTS) {
    const spec = ARM_SPECS[robot];
    arms[robot] = new Arm(mj, spec, await installArm(mj, spec, async (f) => new Uint8Array(await readFile(path.join("vendor", spec.dir, f)))));
  }
}, 120_000);

const dist = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]));

/** Where a human arm pointing along `d` (robot frame, |d| <= 1 arm length) puts the wrist target. */
const mapped = (arm: Arm, d: number[]) => arm.spec.anchor.map((a, i) => a + d[i] * arm.scale);
const DIRECTIONS: [string, number[]][] = [
  ["hanging", [0, 0, -1]],
  ["overhead", [0, 0, 1]],
  ["out to the left", [0, 1, 0]],
  ["out to the right", [0, -1, 0]],
  // depth arrives attenuated, so this is as far forward as the mapping ever asks
  ["forward", [DEPTH_GAIN, 0, 0]],
  ["up and out", [0.3, 0.65, 0.65]],
  ["folded in", [0.2, -0.2, -0.1]],
];

/**
 * A person facing the camera whose wrist draws a circle in the picture plane, as a pose track. The elbow comes
 * from two-link geometry so both segments keep their length, which is what real footage of an in-plane motion shows.
 */
function circleTrack(side: "left" | "right", opts: { hands?: "open" | "pinch-midway"; visibility?: number } = {}): Track {
  const fps = 25, frames: TrackFrame[] = [];
  const [L1, L2] = [0.28, 0.25];
  const ids = side === "left" ? { s: "11", e: "13", w: "15", i: "19", t: "21" } : { s: "12", e: "14", w: "16", i: "20", t: "22" };
  const out = side === "left" ? 1 : -1; // the subject's left is picture-right
  for (let f = 0; f < 200; f++) {
    const a = (f / 100) * 2 * Math.PI;
    const shoulder = [0.18 * out, -0.45, 0];
    // circle of radius 0.17 centred out to the side, below shoulder height: always within reach, never fully straight
    const d = [out * (0.3 + 0.17 * Math.cos(a)), 0.1 + 0.17 * Math.sin(a)];
    const r = Math.hypot(d[0], d[1]);
    const bend = Math.acos((L1 * L1 + r * r - L2 * L2) / (2 * L1 * r));
    const dir = Math.atan2(d[1], d[0]) + bend * out;
    const elbow = [shoulder[0] + L1 * Math.cos(dir), shoulder[1] + L1 * Math.sin(dir), 0];
    const wrist = [shoulder[0] + d[0], shoulder[1] + d[1], 0];
    const vis = opts.visibility ?? 0.99;
    const world: Record<string, number[]> = {};
    for (const k of SKELETON_IDS) world[k] = [0, 0, 0, vis];
    world[ids.s] = [...shoulder, vis];
    world[ids.e] = [...elbow, vis];
    world[ids.w] = [...wrist, vis];
    if (opts.hands) {
      const pinched = opts.hands === "pinch-midway" && f >= 80 && f < 140;
      world[ids.i] = [wrist[0], wrist[1] + 0.1, 0, vis];
      world[ids.t] = [wrist[0] + (pinched ? 0.02 : 0.075), wrist[1] + 0.09, 0, vis];
    }
    const image = Object.fromEntries(Object.entries(world).map(([k, v]) => [k, [0.5 + v[0] * 0.5, 0.5 + v[1] * 0.5]]));
    frames.push({ t: f / fps, world, image });
  }
  return { fps, width: 1280, height: 720, frames };
}

for (const robot of ARM_ROBOTS) {
  describe(`${robot}: model and inverse kinematics`, () => {
    it("discovers the arm joints and a separate gripper actuator", () => {
      const arm = arms[robot];
      expect(arm.joints.length).toBe(arm.spec.home.length);
      expect(arm.grippers.length).toBe(1);
      expect(arm.actuators.length).toBe(arm.joints.length + 1);
      // radians, not a degrees model read as radians: every joint has a usable range
      for (const j of arm.joints) expect(j.range[1] - j.range[0]).toBeGreaterThan(1);
      expect(arm.reach).toBeGreaterThan(robot === "panda" ? 0.8 : 0.35);
    });

    for (const [name, d] of DIRECTIONS) {
      it(`reaches the target of a human arm ${name} within 1 cm, in kinematics and in physics`, () => {
        const arm = arms[robot];
        const { p, clamped } = arm.clampTarget(mapped(arm, d));
        expect(clamped).toBe(false); // the whole mapped sphere is inside the workspace by construction
        const q = arm.solve(p, d, arm.spec.home, 80);
        expect(dist(arm.fk(q).ee, p)).toBeLessThan(0.01);
        const sim = new ArmSim(arm);
        let info = sim.tick(arm.ctrl(q));
        let collisions = 0;
        for (let t = 0; t < 200; t++) {
          info = sim.tick(arm.ctrl(q));
          if (info.selfCollision) collisions++;
        }
        expect(dist(info.ee, p)).toBeLessThan(0.01);
        expect(collisions).toBe(0);
      });
    }

    it("respects the joint limits, also for targets it cannot reach", () => {
      const arm = arms[robot];
      const far = [[2, 0, 0.3], [-1, 1, 0.2], [0, -2, 2], [0.05, 0, -0.5], [0, 0, 3]];
      for (const target of far) {
        let q = arm.spec.home.slice();
        for (let i = 0; i < 20; i++) q = arm.solve(target, [0, 0, -1], q);
        q.forEach((v, i) => {
          expect(v).toBeGreaterThanOrEqual(arm.joints[i].range[0]);
          expect(v).toBeLessThanOrEqual(arm.joints[i].range[1]);
        });
        const { p, clamped } = arm.clampTarget(target);
        expect(clamped).toBe(true);
        expect(p[2]).toBeGreaterThanOrEqual(arm.spec.floor);
        expect(dist(p, arm.shoulderPos)).toBeLessThanOrEqual(arm.reach);
      }
    });

    it("retargets a synthetic wrist circle with p95 residual under 2 cm and follows it in physics", () => {
      const arm = arms[robot];
      const demo = retargetToArm(arm, circleTrack("right"), { arm: "auto", seconds: 6, start: 0.5 });
      expect(demo.stats.armUsed).toBe("right");
      expect(demo.stats.trackedPct).toBe(100);
      expect(demo.stats.ikResidualCmP95).toBeLessThan(2);
      expect(demo.stats.reachClampedPct).toBe(0);
      expect(demo.stats.selfCollisionTicks).toBe(0);
      expect(demo.stats.trackingErrorCmP95).toBeLessThan(3);
      expect(demo.ctrl.length).toBe(300);
      expect(demo.ctrl[0].length).toBe(arm.actuators.length);
      // mirrored: the person's right arm is on picture-left, which the mirror puts at the robot's +Y (screen-right)
      expect(Math.min(...demo.target.map((p) => p[1]))).toBeGreaterThan(0);
      // in the picture plane: no invented depth
      for (const p of demo.target) expect(Math.abs(p[0] - arm.spec.anchor[0])).toBeLessThan(0.02);
      // the circle survives: both in-plane axes sweep about 2 x 0.17 arm-lengths... scaled to the robot
      const span = (k: number) => Math.max(...demo.target.map((p) => p[k])) - Math.min(...demo.target.map((p) => p[k]));
      const expected = (2 * 0.17 * arm.scale) / 0.53;
      expect(span(1)).toBeGreaterThan(expected * 0.85);
      expect(span(2)).toBeGreaterThan(expected * 0.85);
      // the speed cap holds on every commanded step
      const maxStep = arm.spec.maxSpeed / 50 + 1e-4;
      for (let t = 1; t < demo.ctrl.length; t++) for (let j = 0; j < arm.joints.length; j++) expect(Math.abs(demo.ctrl[t][j] - demo.ctrl[t - 1][j])).toBeLessThanOrEqual(maxStep);
    });
  });
}

describe("arm retargeting: which arm, gripper, fail-closed", () => {
  it("auto picks the arm that moves", () => {
    expect(retargetToArm(arms.so101, circleTrack("left"), { arm: "auto", seconds: 4 }).stats.armUsed).toBe("left");
  });

  it("keeps the gripper open on tracks extracted without hand landmarks", () => {
    const arm = arms.so101;
    const demo = retargetToArm(arm, circleTrack("right"), { arm: "right", seconds: 6, start: 0 });
    const open = arm.grippers[0].open;
    expect(demo.stats.handLandmarks).toBe(false);
    expect(demo.stats.gripperClosedPct).toBe(0);
    for (const c of demo.ctrl) expect(c[c.length - 1]).toBeCloseTo(open, 4);
  });

  it("closes the gripper while the index and thumb are pinched, and reopens after", () => {
    const arm = arms.panda;
    const demo = retargetToArm(arm, circleTrack("right", { hands: "pinch-midway" }), { arm: "right", seconds: 7, start: 0 });
    const g = arm.grippers[0];
    const grip = demo.ctrl.map((c) => c[c.length - 1]);
    expect(demo.stats.handLandmarks).toBe(true);
    expect(grip[50]).toBeCloseTo(g.open, 4); // frame 25: open hand
    expect(grip[220]).toBeCloseTo(g.closed, 4); // frame 110: pinched
    expect(grip[330]).toBeCloseTo(g.open, 4); // frame 165: released
    expect(demo.stats.gripperClosedPct).toBeGreaterThan(25);
  });

  it("holds the last target while the arm is not seen well enough", () => {
    const demo = retargetToArm(arms.so101, circleTrack("right", { visibility: 0.3 }), { arm: "right", seconds: 4, start: 0 });
    expect(demo.stats.trackedPct).toBe(0);
    for (const c of demo.ctrl) expect(c).toEqual(demo.ctrl[0]);
  });
});

describe("track helpers", () => {
  it("measures how many ticks a response trails its command", () => {
    const cmd = Array.from({ length: 200 }, (_, t) => [Math.sin(t / 9), Math.cos(t / 13)]);
    const got = cmd.map((_, t) => cmd[Math.max(0, t - 4)]);
    expect(lagOf(cmd, got)).toBe(4);
  });
  it("picks the busiest window", () => {
    const score = Array.from({ length: 100 }, (_, i) => (i >= 60 && i < 70 ? 1 : 0));
    expect(pickWindow(score, 10).start).toBe(60);
  });
});
