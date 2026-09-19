import { describe, expect, it } from "vitest";
import { EMBODIMENTS, armForRobot, checkFeasibility, embodimentBrief, isSingleArm } from "./feasible";
import { planRequestText, planSchema, validatePlan } from "./plan";
import { renderReport } from "./report";
import type { Run } from "./types";

const ARMS = ["so101", "panda"] as const;

describe("capability model", () => {
  it("says what each robot is, honestly", () => {
    expect(EMBODIMENTS.g1).toMatchObject({ kind: "humanoid", arms: 2, legs: true, torso: true, fingers: false });
    for (const r of ARMS) {
      expect(EMBODIMENTS[r]).toMatchObject({ kind: "single-arm", arms: 1, legs: false, torso: false, gripper: true, fingers: false });
      expect(EMBODIMENTS[r].notes.join(" ")).toMatch(/open hand from a fist/);
      expect(isSingleArm(r)).toBe(true);
    }
    expect(isSingleArm("g1")).toBe(false);
  });
});

describe("checkFeasibility, single arm", () => {
  it("refuses tasks that need two hands or a body, quoting the words that did it", () => {
    const refused = [
      "do jumping jacks", "jumping jack", "clap both hands", "clap", "lift a box with two hands", "wave with both arms", "bodyweight squat", "walking lunges",
      "walk across the room", "run on the spot", "dance to music", "jump up and down", "burpees", "push up", "push-ups", "pushups", "pull up on a bar", "pull-up",
      "kick a ball", "fold a shirt", "tie shoelaces", "tie a knot", "open a jar", "unscrew the lid", "barbell overhead press", "deadlift", "sit ups", "touch your toes",
    ];
    for (const robot of ARMS) for (const task of refused) {
      const f = checkFeasibility(task, robot);
      expect(f.level, `${task} on ${robot}`).toBe("refuse");
      expect(f.reasons.length).toBeGreaterThanOrEqual(2);
      expect(f.reasons[0]).toMatch(/^"/); // the matched words, in quotes
      expect(f.reasons.at(-1)).toMatch(/one fixed-base arm/);
      expect(f.suggestion).toMatch(/g1/);
      expect(f.suggestion).toMatch(/one-arm version/);
    }
  });

  it("names the offending words once, not once per overlapping rule", () => {
    const f = checkFeasibility("do jumping jacks", "so101");
    expect(f.reasons.filter((r) => /jump/.test(r))).toEqual(['"jumping jacks" needs two arms and legs']);
  });

  it("warns on grasp-dependent tasks and says only the arm path is learned", () => {
    for (const robot of ARMS) for (const task of ["pick up a cup", "grab the bottle", "pour water into a glass", "stack blocks", "place the block on the shelf", "hand over a pen", "hand it over"]) {
      const f = checkFeasibility(task, robot);
      expect(f.level, `${task} on ${robot}`).toBe("warn");
      expect(f.reasons.join(" ")).toMatch(/open hand from a fist/);
      expect(f.reasons.join(" ")).toMatch(/only the path of the arm/);
    }
    expect(checkFeasibility("pick up a cup", "so101").reasons[0]).toBe('"pick up" depends on the gripper closing at the right moment');
  });

  it("lets plain one-arm motions through untouched", () => {
    for (const robot of ARMS) for (const task of ["raise one arm out to the side and lower it", "wave hello", "dumbbell lateral raise", "stir a pot", "wipe a table", "reach forward", "bicep curl", "salute", "raise one arm and hold it there"]) {
      expect(checkFeasibility(task, robot), `${task} on ${robot}`).toEqual({ level: "ok", reasons: [] });
    }
  });

  it("does not trip on words that only contain a keyword", () => {
    // elbow contains "bow", bowl contains "bow", runway contains "run", replace contains "place", necktie is not "tie"
    for (const task of ["bend the elbow", "stir a bowl", "point at the runway", "replace nothing, just wave", "straighten a necktie with one hand"]) expect(checkFeasibility(task, "panda").level, task).toBe("ok");
  });

  it("refusal wins over a warning", () => {
    expect(checkFeasibility("pick up a box with both hands", "so101").level).toBe("refuse");
  });
});

describe("checkFeasibility, g1", () => {
  it("refuses nothing", () => {
    for (const task of ["do jumping jacks", "clap both hands", "squat", "walk forward", "fold a shirt", "open a jar", "barbell squat", "pick up a cup", "burpees"]) expect(checkFeasibility(task, "g1").level, task).not.toBe("refuse");
    expect(checkFeasibility("do jumping jacks", "g1")).toEqual({ level: "ok", reasons: [] });
    expect(checkFeasibility("pick up a cup", "g1").level).toBe("ok");
  });

  it("warns on finger tasks", () => {
    for (const task of ["type on a keyboard", "typing", "play piano", "thread a needle", "snap your fingers"]) {
      const f = checkFeasibility(task, "g1");
      expect(f.level, task).toBe("warn");
      expect(f.reasons.join(" ")).toMatch(/no finger motion/);
    }
  });
});

describe("the planner is told the embodiment", () => {
  it("tells the model a single arm is ONE arm and never offers it both", () => {
    for (const robot of ARMS) {
      const text = planRequestText("raise one arm", 6, robot);
      expect(text).toMatch(/ONE fixed-base arm/);
      expect(text).toMatch(/never "both"/);
      expect(text).toMatch(/both arms are fine/);
      expect(planSchema(robot).properties.arm.enum).toEqual(["left", "right", "either"]);
    }
    expect(embodimentBrief("g1")).toMatch(/humanoid/);
    expect(planSchema("g1").properties.arm.enum).toContain("both");
  });

  it("turns a both-arms answer into either for a single arm, and leaves the g1 alone", () => {
    const raw = { queries: ["lateral raise front view", "person lateral raise full body", "side raise demonstration", "dumbbell side raise one person"], arm: "both", motionDescription: "arms rise sideways", signature: { kind: "arm_elevation", threshold: 65, minCount: 1, direction: "sideways" }, rejectionCriteria: ["two people"] };
    expect(validatePlan(raw, "lateral raise", "m", 6, "so101")!.arm).toBe("either");
    expect(validatePlan(raw, "lateral raise", "m", 6, "panda")!.arm).toBe("either");
    expect(validatePlan({ ...raw, arm: "left" }, "lateral raise", "m", 6, "so101")!.arm).toBe("left");
    expect(validatePlan(raw, "lateral raise", "m", 6, "g1")!.arm).toBe("both");
    expect(validatePlan(raw, "lateral raise", "m", 6)!.arm).toBe("both");
    expect(armForRobot("both", "panda")).toBe("either");
    expect(armForRobot("right", "panda")).toBe("right");
    expect(armForRobot("both", "g1")).toBe("both");
  });
});

describe("the report shows the feasibility record", () => {
  const base: Run = {
    schema: 1, id: "20260919-000000-pick-up-a-cup-abcd", task: "pick up a cup", options: { robot: "so101", maxVideos: 6, seconds: 6, sources: ["youtube-cc"], allowStandardLicense: false, targetAccepted: 3 },
    status: "done", pid: 1, startedAt: "2026-09-19T00:00:00.000Z", finishedAt: null, error: null, steps: [], plan: null, searches: [], candidates: [], episodes: [], retargetFailures: [], versions: {},
  };

  it("prints the level, the reasons and the robot's limits", () => {
    const md = renderReport({ ...base, feasibility: checkFeasibility(base.task, "so101") });
    expect(md).toMatch(/Feasibility: \*\*warn\*\*/);
    expect(md).toMatch(/"pick up" depends on the gripper/);
    expect(md).toMatch(/SO-101 arm: One arm on a fixed base/);
    expect(md).toMatch(/stopping early at 3 accepted/);
    expect(md).not.toMatch(/—/); // no em-dashes in anything a person reads
  });

  it("says ok plainly, and says nothing for runs from before the check existed", () => {
    expect(renderReport({ ...base, task: "wave hello", feasibility: { level: "ok", reasons: [] } })).toMatch(/Feasibility: \*\*ok\*\*/);
    expect(renderReport(base)).not.toMatch(/Feasibility/);
  });
});
