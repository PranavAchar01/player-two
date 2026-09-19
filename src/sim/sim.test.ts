import { readFile } from "node:fs/promises";
import path from "node:path";
import loadMujoco from "@mujoco/mujoco";
import { beforeAll, describe, expect, it } from "vitest";
import { flyPilot, judge } from "./episode";
import { retargetArm, type ArmLandmarks } from "./retarget";
import { ACTUATORS, SIDES, SLOTS } from "./scene";
import { Rig, Sim, installG1 } from "./sim";

let rig: Rig;
beforeAll(async () => {
  const mj = await loadMujoco();
  rig = new Rig(mj, await installG1(mj, async (f) => new Uint8Array(await readFile(path.join("vendor/unitree_g1", f)))));
}, 60_000);

const failed = (v: { gates: { id: string; pass: boolean }[] }) => v.gates.filter((g) => !g.pass).map((g) => g.id);
const unit = (v: number[]) => v.map((c) => c / Math.hypot(...v));
const angle = (p: number[], q: number[]) => (Math.acos(Math.min(1, p.reduce((s, v, k) => s + v * q[k], 0))) * 180) / Math.PI;

describe("G1 arm solver, checked in physics", () => {
  const cases = [
    { upper: [0, 0.8, -0.6], fore: [0, 0.8, -0.6] },
    { upper: [0.3, 0.5, -0.8], fore: [0.7, 0.1, 0.2] },
    { upper: [0.2, 0.7, -0.1], fore: [0.6, 0.2, 0.5] },
  ];
  for (const side of SIDES) {
    for (const [i, c] of cases.entries()) {
      it(`${side} arm reaches pose ${i} within 4 degrees`, () => {
        const m = side === "left" ? 1 : -1;
        const upper = unit([c.upper[0], c.upper[1] * m, c.upper[2]]);
        const fore = unit([c.fore[0], c.fore[1] * m, c.fore[2]]);
        const q = rig.solve(side, { x: upper[0], y: upper[1], z: upper[2] }, { x: fore[0], y: fore[1], z: fore[2] }, rig.rest[side], 30);
        const sim = new Sim(rig, { side: side === "left" ? "right" : "left", slot: "high" }); // pendulum on the other side
        const rest = [...rig.rest.left, ...rig.rest.right];
        const ctrl = ACTUATORS.map((name, j) => (name.startsWith(side) ? q[j % 4] : rest[j]));
        for (let t = 0; t < 200; t++) sim.tick(ctrl);
        const mj = rig.mj;
        const body = (n: string) => {
          const id = mj.mj_name2id(sim.model, mj.mjtObj.mjOBJ_BODY.value, n);
          return [0, 1, 2].map((k) => sim.data.xpos[id * 3 + k]);
        };
        const [sh, el, wr] = [body(`${side}_shoulder_pitch_link`), body(`${side}_elbow_link`), body(`${side}_wrist_yaw_link`)];
        sim.dispose();
        expect(angle(unit(el.map((v, k) => v - sh[k])), upper)).toBeLessThan(4);
        expect(angle(unit(wr.map((v, k) => v - el[k])), fore)).toBeLessThan(4);
      });
    }
  }
  it("rests with the arms hanging and no self-collision", () => {
    const sim = new Sim(rig, { side: "left", slot: "mid" });
    let collisions = 0;
    for (let t = 0; t < 100; t++) if (sim.tick([...rig.rest.left, ...rig.rest.right]).selfCollision) collisions++;
    sim.dispose();
    expect(collisions).toBe(0);
  });
});

describe("judge", () => {
  for (const side of SIDES) for (const slot of SLOTS) {
    it(`accepts the scripted pilot: ${side} ${slot}`, () => expect(failed(judge(rig, flyPilot(rig, { side, slot })))).toEqual([]));
  }
  it("rejects a client that claims a success the replay does not reproduce", () => {
    const e = flyPilot(rig, { side: "left", slot: "mid" });
    e.ctrl = e.ctrl.map(() => [...rig.rest.left, ...rig.rest.right]);
    expect(failed(judge(rig, e))).toEqual(["success", "replay_match", "hand"]);
  });
  it("rejects a strike made with the wrong hand", () => {
    const e = flyPilot(rig, { side: "left", slot: "mid" });
    expect(judge(rig, { ...e, task: { side: "right", slot: "mid" } }).accepted).toBe(false);
  });
  it("rejects an episode where the operator kept exceeding the speed cap", () => {
    const e = flyPilot(rig, { side: "right", slot: "mid" });
    e.limited = e.limited.map((_, t) => t % 3 === 0);
    expect(failed(judge(rig, e))).toEqual(["speed"]);
  });
  it("rejects an episode flown mostly blind", () => {
    const e = flyPilot(rig, { side: "right", slot: "low" });
    e.held = e.held.map((_, t) => t % 2 === 0);
    expect(failed(judge(rig, e))).toEqual(["confidence"]);
  });
  it("rejects jittery commands", () => {
    const e = flyPilot(rig, { side: "left", slot: "low" });
    e.ctrl = e.ctrl.map((r, t) => r.map((v) => v + (t % 2 ? 0.05 : -0.05)));
    expect(failed(judge(rig, e))).toContain("jerk");
  });
});

describe("retarget safety", () => {
  const arm = (x: number, vis = 0.99): ArmLandmarks => [
    { x: 0, y: 0, z: 0, visibility: vis },
    { x, y: 0.2, z: 0, visibility: vis },
    { x: x * 2, y: 0.4, z: 0, visibility: vis },
  ];
  it("holds the previous target when tracking confidence is low", () => {
    const out = retargetArm(rig, arm(0.2, 0.3), "left", [0.1, 0.2, 0.3, 0.4]);
    expect(out.flags.held).toBe(true);
    expect(out.target).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
  it("rate limits a jump and flags it", () => {
    const prev = rig.rest.left;
    const out = retargetArm(rig, arm(-0.6), "left", prev);
    expect(out.flags.limited).toBe(true);
    expect(Math.max(...out.target.map((v, i) => Math.abs(v - prev[i])))).toBeLessThanOrEqual(6 / 50 + 1e-9);
  });
});
