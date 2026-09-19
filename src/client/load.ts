import type { MainModule } from "@mujoco/mujoco";
import { Rig, installG1 } from "@/sim/sim";

let rig: Promise<Rig> | undefined;

/** The WASM build and the G1 model are served from /public, outside the bundler. */
export function loadRig(): Promise<Rig> {
  const url = "/mujoco/mujoco.js";
  return (rig ??= import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url).then(async (m: { default: () => Promise<MainModule> }) => {
    const mj = await m.default();
    return new Rig(mj, await installG1(mj, async (f) => new Uint8Array(await (await fetch(`/g1/${f}`)).arrayBuffer())));
  }));
}
