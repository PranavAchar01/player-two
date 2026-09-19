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

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--hide-scrollbars"], defaultViewport: { width: 1920, height: 1080 } });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 200)));

async function clip(demo: string, mode: "robot" | "split", name: string) {
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
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "25", "-i", `${dir}/%05d.jpg`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", `${out}/${name}.mp4`]);
  await rm(dir, { recursive: true, force: true });
  console.log(name, "frames", i);
  return `${out}/${name}.mp4`;
}

await mkdir(out, { recursive: true });
const robotClips: string[] = [];
const splitClips: string[] = [];
const only = process.env.ONLY;
if (only !== "split") for (const demo of ["wZnsZsMywrY-right-mid", "wZnsZsMywrY-left-low", "pilot-left-high", "wZnsZsMywrY-right-low", "pilot-right-high"]) robotClips.push(await clip(demo, "robot", `robot-${demo}`));
for (const demo of ["wZnsZsMywrY-right-mid", "wZnsZsMywrY-left-low", "wZnsZsMywrY-right-low"]) splitClips.push(await clip(demo, "split", `split-${demo}`));
await browser.close();

for (const [list, name] of [[robotClips, "demo"], [splitClips, "skeleton-vs-robot"]] as const) {
  if (list.length === 0) continue;
  await writeFile(`${out}/${name}.txt`, list.map((f) => `file '${f.split("/").pop()}'`).join("\n"));
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${out}/${name}.txt`, "-c", "copy", "-movflags", "+faststart", `${out}/${name}.mp4`]);
  await rm(`${out}/${name}.txt`);
}
console.log("done");
