import { readFile } from "node:fs/promises";
import path from "node:path";
import loadMujoco from "@mujoco/mujoco";
import { Rig, installG1 } from "@/sim/sim";

const G1_DIR = path.resolve("vendor/unitree_g1");
let instance: Promise<Rig> | undefined;

export const rig = () =>
  (instance ??= (async () => {
    const mj = await loadMujoco();
    return new Rig(mj, await installG1(mj, async (f) => new Uint8Array(await readFile(path.join(G1_DIR, f)))));
  })());
