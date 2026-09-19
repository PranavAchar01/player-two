// Copies the MuJoCo and MediaPipe runtimes into public/ so the browser loads them from this origin,
// and fetches the pose model once. Venue wifi should not be a dependency of the demo.
import { cp, mkdir, stat, writeFile } from "node:fs/promises";

const POSE_MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

await mkdir("public/mujoco", { recursive: true });
await mkdir("public/mediapipe", { recursive: true });
for (const f of ["mujoco.js", "mujoco.wasm"]) await cp(`node_modules/@mujoco/mujoco/${f}`, `public/mujoco/${f}`);
await cp("node_modules/@mediapipe/tasks-vision/wasm", "public/mediapipe/wasm", { recursive: true });
await cp("vendor/unitree_g1/g1.xml", "public/g1/g1.xml");
await cp("vendor/unitree_g1/assets", "public/g1/assets", { recursive: true });
await cp("data/demos", "public/demos", { recursive: true }).catch(() => null);
const model = "public/mediapipe/pose_landmarker_lite.task";
if (!(await stat(model).catch(() => null))) {
  const res = await fetch(POSE_MODEL);
  if (!res.ok) throw new Error(`pose model download failed: ${res.status}`);
  await writeFile(model, Buffer.from(await res.arrayBuffer()));
}
