import type { MainModule } from "@mujoco/mujoco";

let mj: Promise<MainModule> | undefined;

/** The WASM build is served from /public, outside the bundler. */
export function loadMujocoBrowser(): Promise<MainModule> {
  const url = "/mujoco/mujoco.js";
  return (mj ??= import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url).then((m: { default: () => Promise<MainModule> }) => m.default()));
}
