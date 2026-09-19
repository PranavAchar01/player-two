// Video pose track -> robot demo, for any supported embodiment.
// usage: tsx scripts/retarget.mts --track data/tracks/<id>.json --robot so101|panda|g1 [--arm left|right|auto]
//          [--start <seconds>|auto] [--seconds <n>] --out data/demos/<name>.json
// stdout carries exactly one line, the JSON result {"out","robot","stats"}; everything else goes to stderr.
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import loadMujoco from "@mujoco/mujoco";
import { ARM_SPECS, Arm, installArm, isArmRobot } from "../src/sim/arm";
import { retargetToArm } from "../src/sim/armRetarget";
import { clipSource, mirrorG1 } from "../src/sim/mirror";
import { Rig, installG1 } from "../src/sim/sim";
import type { Track } from "../src/sim/track";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "");
const fail = (msg: string): never => {
  console.error(`retarget: ${msg}`);
  process.exit(2);
};
const trackPath = args.get("track") ?? fail("--track is required");
const robot = args.get("robot") ?? fail("--robot is required");
const out = args.get("out") ?? fail("--out is required");
const armArg = args.get("arm") ?? "auto";
if (armArg !== "left" && armArg !== "right" && armArg !== "auto") fail(`--arm must be left, right or auto, got "${armArg}"`);
const startArg = args.get("start") ?? "auto";
const start = startArg === "auto" ? undefined : Number(startArg);
if (start !== undefined && !Number.isFinite(start)) fail(`--start must be a number of seconds or auto, got "${startArg}"`);
const seconds = Number(args.get("seconds") ?? 7);
if (!(seconds > 0)) fail(`--seconds must be positive, got "${args.get("seconds")}"`);
if (robot !== "g1" && !isArmRobot(robot)) fail(`--robot must be one of so101, panda, g1, got "${robot}"`);

const track = await readFile(trackPath, "utf8").then((s) => JSON.parse(s) as Track, (e: Error) => fail(`cannot read ${trackPath}: ${e.message}`));
if (!track.frames?.some((f) => f.world)) fail(`${trackPath} has no tracked frames`);
const id = path.basename(trackPath, ".json");
const stock = /^(pexels|mixkit)-/.test(id);
const hasVideo = Boolean(await stat(`data/sources/${id}.mp4`).catch(() => null));
const provenance = { ...(stock ? { source: clipSource(id) } : {}), ...(hasVideo ? { video: id } : {}) };

// MuJoCo's own warnings must not land on stdout, which belongs to the result line
const mj = await loadMujoco({ print: (s: string) => console.error(s), printErr: (s: string) => console.error(s) } as never);
let demo: { stats: object } & Record<string, unknown>;
if (isArmRobot(robot)) {
  const spec = ARM_SPECS[robot];
  const arm = new Arm(mj, spec, await installArm(mj, spec, async (f) => new Uint8Array(await readFile(`vendor/${spec.dir}/${f}`))));
  const { robot: r, ...rest } = retargetToArm(arm, track, { arm: armArg as "left" | "right" | "auto", seconds, start });
  demo = { robot: r, ...provenance, ...rest };
} else {
  const rig = new Rig(mj, await installG1(mj, async (f) => new Uint8Array(await readFile("vendor/unitree_g1/" + f))));
  const m = mirrorG1(rig, track, { seconds, start });
  demo = { robot: "g1", ...provenance, aspect: m.aspect, startSeconds: m.startSeconds, task: null, hz: 50, ctrl: m.ctrl, body: m.body, skeleton: m.skeleton, stats: m.stats };
}
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(demo));
// /render reads demos from public/demos; keep it in step so the new demo can be rendered right away
if (path.resolve(path.dirname(out)) === path.resolve("data/demos")) {
  await mkdir("public/demos", { recursive: true });
  await copyFile(out, `public/demos/${path.basename(out)}`);
}
console.log(JSON.stringify({ out, robot, stats: demo.stats }));
