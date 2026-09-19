import type { MainModule } from "@mujoco/mujoco";
import { ARM_SPECS, Arm, installArm, type ArmRobot } from "@/sim/arm";
import { Rig, installG1 } from "@/sim/sim";

let mujoco: Promise<MainModule> | undefined;
let rig: Promise<Rig> | undefined;
const arms = new Map<ArmRobot, Promise<Arm>>();

/** The WASM build and the robot models are served from /public, outside the bundler. One module serves every robot. */
function loadMujoco(): Promise<MainModule> {
  const url = "/mujoco/mujoco.js";
  return (mujoco ??= import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url).then((m: { default: () => Promise<MainModule> }) => m.default()));
}

const fetchFrom = (dir: string) => async (f: string) => new Uint8Array(await (await fetch(`/${dir}/${f}`)).arrayBuffer());

export function loadRig(): Promise<Rig> {
  return (rig ??= loadMujoco().then(async (mj) => new Rig(mj, await installG1(mj, fetchFrom("g1")))));
}

export function loadArm(robot: ArmRobot): Promise<Arm> {
  let arm = arms.get(robot);
  if (!arm) {
    const spec = ARM_SPECS[robot];
    arms.set(robot, (arm = loadMujoco().then(async (mj) => new Arm(mj, spec, await installArm(mj, spec, fetchFrom(spec.dir))))));
  }
  return arm;
}
