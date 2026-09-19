import loadMujoco, { type MainModule } from "@mujoco/mujoco";
import { beforeAll, describe, expect, it } from "vitest";
import { flyPilot, judge } from "./episode";
import { armAngles, retargetArm, type ArmLandmarks } from "./retarget";
import { ACTUATORS, SIDES, SLOTS } from "./scene";
import { Sim } from "./sim";

let mj: MainModule;
beforeAll(async () => {
  mj = await loadMujoco();
});

const failed = (v: { gates: { id: string; pass: boolean }[] }) => v.gates.filter((g) => !g.pass).map((g) => g.id);
const unit = (v: number[]) => v.map((c) => c / Math.hypot(...v));

describe("retarget kinematics", () => {
  const cases: { upper: number[]; fore: number[] }[] = [
    { upper: [0, 0.8, -0.6], fore: [0, 0.8, -0.6] },
    { upper: [0.3, 0.5, -0.8], fore: [0.7, 0.1, 0.2] },
    { upper: [0.1, 0.9, 0.3], fore: [0.2, 0.3, 0.9] },
  ];
  for (const side of SIDES) {
    for (const [i, c] of cases.entries()) {
      it(`${side} arm reaches pose ${i} within 3 degrees`, () => {
        const m = side === "left" ? 1 : -1;
        const upper = unit([c.upper[0], c.upper[1] * m, c.upper[2]]);
        const fore = unit([c.fore[0], c.fore[1] * m, c.fore[2]]);
        const a = armAngles({ x: upper[0], y: upper[1], z: upper[2] }, { x: fore[0], y: fore[1], z: fore[2] }, side, [0, 0, 0, 0]);
        const sim = new Sim(mj, { side: side === "left" ? "right" : "left", slot: "high" }); // pedestal on the other side, out of the way
        const ctrl = ACTUATORS.map((name, j) => (name.startsWith(side) ? a[j % 4] : 0));
        for (let t = 0; t < 150; t++) sim.tick(ctrl);
        const body = (n: string) => {
          const id = mj.mj_name2id(sim.model, mj.mjtObj.mjOBJ_BODY.value, n);
          return [0, 1, 2].map((k) => sim.data.xpos[id * 3 + k]);
        };
        const siteId = mj.mj_name2id(sim.model, mj.mjtObj.mjOBJ_SITE.value, `${side}_hand`);
        const hand = [0, 1, 2].map((k) => sim.data.site_xpos[siteId * 3 + k]);
        const sh = body(`${side}_upper`), el = body(`${side}_fore`);
        const gotUpper = unit(el.map((v, k) => v - sh[k]));
        const gotFore = unit(hand.map((v, k) => v - el[k]));
        const angle = (p: number[], q: number[]) => (Math.acos(Math.min(1, p.reduce((s, v, k) => s + v * q[k], 0))) * 180) / Math.PI;
        sim.dispose();
        expect(angle(gotUpper, upper)).toBeLessThan(3);
        expect(angle(gotFore, fore)).toBeLessThan(3);
      });
    }
  }
});

describe("judge", () => {
  for (const side of SIDES) for (const slot of SLOTS) {
    it(`accepts the scripted pilot: ${side} ${slot}`, () => {
      const v = judge(mj, flyPilot(mj, { side, slot }));
      expect(failed(v)).toEqual([]);
    });
  }
  it("rejects a client that claims a success the replay does not reproduce", () => {
    const e = flyPilot(mj, { side: "left", slot: "mid" });
    e.ctrl = e.ctrl.map(() => new Array(8).fill(0));
    expect(failed(judge(mj, e))).toEqual(["success", "replay_match", "hand"]);
  });
  it("rejects a strike made with the wrong hand", () => {
    const e = flyPilot(mj, { side: "left", slot: "mid" });
    // same bob, but the episode claims it was the right hand's task
    const v = judge(mj, { ...e, task: { side: "right", slot: "mid" }, ctrl: e.ctrl });
    expect(v.accepted).toBe(false);
  });
  it("rejects an episode where the operator kept exceeding the speed cap", () => {
    const e = flyPilot(mj, { side: "right", slot: "mid" });
    e.limited = e.limited.map((_, t) => t % 3 === 0);
    expect(failed(judge(mj, e))).toEqual(["speed"]);
  });
  it("rejects an episode flown mostly blind", () => {
    const e = flyPilot(mj, { side: "right", slot: "low" });
    e.held = e.held.map((_, t) => t % 2 === 0);
    expect(failed(judge(mj, e))).toEqual(["confidence"]);
  });
  it("rejects jittery commands", () => {
    const e = flyPilot(mj, { side: "left", slot: "low" });
    e.ctrl = e.ctrl.map((r, t) => r.map((v) => v + (t % 2 ? 0.05 : -0.05)));
    expect(failed(judge(mj, e))).toContain("jerk");
  });
});

describe("retarget safety", () => {
  const arm = (x: number, vis = 0.99): ArmLandmarks => [
    { x: 0, y: 0, z: 0, visibility: vis },
    { x, y: 0.2, z: 0, visibility: vis },
    { x: x * 2, y: 0.4, z: 0, visibility: vis },
  ];
  it("holds the previous target when tracking confidence is low", () => {
    const out = retargetArm(arm(0.2, 0.3), "left", [0.1, 0.2, 0.3, 0.4]);
    expect(out.flags.held).toBe(true);
    expect(out.target).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
  it("rate limits a jump and flags it", () => {
    const out = retargetArm(arm(-0.3), "left", [0, 0, 0, 0]);
    expect(out.flags.limited).toBe(true);
    expect(Math.max(...out.target.map(Math.abs))).toBeLessThanOrEqual(6 / 50 + 1e-9);
  });
});
