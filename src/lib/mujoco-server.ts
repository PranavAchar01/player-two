import loadMujoco, { type MainModule } from "@mujoco/mujoco";

let instance: Promise<MainModule> | undefined;
export const mujoco = () => (instance ??= loadMujoco());
