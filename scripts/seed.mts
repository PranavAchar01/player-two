// Flies the scripted pilot for every task and uploads the episodes, plus two deliberately bad ones,
// so the wall and the export have something real to show. usage: tsx scripts/seed.mts [base-url]
import { readFile } from "node:fs/promises";
import loadMujoco from "@mujoco/mujoco";
import { Rig, installG1 } from "../src/sim/sim";
import { flyPilot, type EpisodeUpload } from "../src/sim/episode";
import { SIDES, SLOTS } from "../src/sim/scene";

const base = process.argv[2] ?? "http://localhost:3218";
const mj = await loadMujoco();
const rig = new Rig(mj, await installG1(mj, async (f) => new Uint8Array(await readFile("vendor/unitree_g1/" + f))));
const post = async (e: EpisodeUpload, note: string) => {
  const res = await fetch(`${base}/api/episodes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(e) });
  const v = (await res.json()) as { accepted: boolean; gates: { pass: boolean; label: string }[] };
  console.log(note.padEnd(34), v.accepted ? "accepted" : "REJECTED: " + v.gates.filter((g) => !g.pass).map((g) => g.label).join("; "));
};
let n = 0;
for (const side of SIDES) for (const slot of SLOTS) await post(flyPilot(rig, { side, slot }, `pilot-${String(++n).padStart(2, "0")}`), `${side} ${slot}`);
const jitter = flyPilot(rig, { side: "left", slot: "mid" }, "shaky-hands");
jitter.ctrl = jitter.ctrl.map((r, t) => r.map((v) => v + (t % 2 ? 0.05 : -0.05)));
await post(jitter, "jittery commands");
const liar = flyPilot(rig, { side: "right", slot: "high" }, "claims-success");
liar.ctrl = liar.ctrl.map(() => [...rig.rest.left, ...rig.rest.right]);
await post(liar, "claims success, robot never moved");
