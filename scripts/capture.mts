// Renders demo videos frame by frame from /render, so the result is deterministic and never drops frames.
// usage: tsx scripts/capture.mts <out-dir> [base-url]
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import loadMujoco from "@mujoco/mujoco";
import puppeteer from "puppeteer-core";
import { flyPilot } from "../src/sim/episode";
import { Rig, installG1 } from "../src/sim/sim";

const out = process.argv[2] ?? "media";
const base = process.argv[3] ?? "http://localhost:3218";
const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const mj = await loadMujoco();
const rig = new Rig(mj, await installG1(mj, async (f) => new Uint8Array(await readFile("vendor/unitree_g1/" + f))));
for (const [side, slot] of [["left", "high"], ["right", "high"]] as const) {
  const e = flyPilot(rig, { side, slot });
  await writeFile(`data/demos/pilot-${side}-${slot}.json`, JSON.stringify({ task: e.task, ctrl: e.ctrl }));
}
execFileSync("node", ["scripts/copy-assets.mjs"]);

// Gallery clips are shown at 720p, so CAPTURE_SIZE=1280x720 renders them more than twice as fast as full HD.
const [VIEW_W, VIEW_H] = (process.env.CAPTURE_SIZE ?? "1920x1080").split("x").map(Number);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--hide-scrollbars"], defaultViewport: { width: VIEW_W, height: VIEW_H } });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 200)));

/** Cuts the stretch of source footage an episode came from into mirrored, person-centred portrait frames. */
async function footage(demo: string) {
  const d = JSON.parse(await readFile(`data/demos/${demo}.json`, "utf8")) as { video: string; startSeconds: number; ctrl: number[][]; skeleton: ((number[] | null)[] | null)[] };
  const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", `data/sources/${d.video}.mp4`]).toString().trim().split(",").map(Number);
  const [W, H] = probe;
  const pts = d.skeleton.flatMap((f) => f ?? []).filter((p): p is number[] => p !== null);
  const xs = pts.map((p) => p[0] * W), ys = pts.map((p) => p[1] * H);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const h = Math.min(H, Math.max((Math.max(...ys) - Math.min(...ys)) * 2.1, ((Math.max(...xs) - Math.min(...xs)) * 1.15) / (730 / 1080)));
  const w = Math.min(W, h * (730 / 1080));
  const crop = { w: Math.round(w), h: Math.round(h), x: Math.round(Math.min(W - w, Math.max(0, cx - w / 2))), y: Math.round(Math.min(H - h, Math.max(0, cy - h * 0.42))) };
  const pad = (d as { task?: unknown }).task ? [30, 90] : [0, 0]; // mirror clips have no padding
  const t0 = Math.max(0, d.startSeconds - pad[0] / 50);
  const dur = (pad[0] + d.ctrl.length + pad[1]) / 50 + 0.2;
  const dir = `public/demos/${demo}-frames`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(t0), "-t", String(dur), "-i", `data/sources/${d.video}.mp4`, "-vf", `fps=25,crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},hflip,scale=${Math.round(VIEW_W * 0.38)}:${VIEW_H}`, "-q:v", "3", `${dir}/%05d.jpg`]);
  const count = (await import("node:fs")).readdirSync(dir).filter((f) => f.endsWith(".jpg")).length;
  await writeFile(`${dir}/meta.json`, JSON.stringify({ count, t0, fps: 25, W, H, crop }));
}

async function clip(demo: string, mode: "robot" | "split" | "source", name: string) {
  const dir = `${out}/.frames-${name}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await page.goto(`${base}/render?demo=${demo}&mode=${mode}`, { waitUntil: "networkidle0", timeout: 120_000 });
  await page.waitForFunction("window.p2 !== undefined", { timeout: 120_000 });
  const ticks = (await page.evaluate("window.p2.ticks")) as number;
  let i = 0;
  for (let n = 0; n < ticks; n += 2) {
    await page.evaluate(`window.p2.frame(${n})`);
    await page.screenshot({ path: `${dir}/${String(i++).padStart(5, "0")}.jpg`, type: "jpeg", quality: 93 });
  }
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "25", "-i", `${dir}/%05d.jpg`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-movflags", "+faststart", `${out}/${name}.mp4`]);
  await rm(dir, { recursive: true, force: true });
  console.log(name, "frames", i);
  return `${out}/${name}.mp4`;
}

await mkdir(out, { recursive: true });
const robotClips: string[] = [];
const splitClips: string[] = [];
const only = process.env.ONLY;
const sourceDemos = (process.env.SOURCE_DEMOS ?? "").split(",").filter(Boolean);
const sourceClips: string[] = [];
for (const demo of sourceDemos) {
  await footage(demo);
  sourceClips.push(await clip(demo, "source", `source-${demo}`));
}
if (!only) for (const demo of ["wZnsZsMywrY-right-mid", "wZnsZsMywrY-left-low", "pilot-left-high", "wZnsZsMywrY-right-low", "pilot-right-high"]) robotClips.push(await clip(demo, "robot", `robot-${demo}`));
if (!only || only === "split") for (const demo of ["wZnsZsMywrY-right-mid", "wZnsZsMywrY-left-low", "wZnsZsMywrY-right-low"]) splitClips.push(await clip(demo, "split", `split-${demo}`));
await browser.close();

for (const [list, name] of [[robotClips, "demo"], [splitClips, "skeleton-vs-robot"], [sourceClips, process.env.OUT_NAME ?? "video-to-robot"]] as const) {
  if (list.length === 0) continue;
  await writeFile(`${out}/${name}.txt`, list.map((f) => `file '${f.split("/").pop()}'`).join("\n"));
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${out}/${name}.txt`, "-c", "copy", "-movflags", "+faststart", `${out}/${name}.mp4`]);
  await rm(`${out}/${name}.txt`);
}
console.log("done");
