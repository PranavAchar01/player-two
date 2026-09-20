// Films the public site running its own scripted demo (?film=1, window.filmDemo) in real time, and logs when
// every audible moment happened so sound effects can be laid in afterwards.
// usage: tsx scripts/film-site.mts <out-dir> [site-url]
import { mkdir, writeFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";

const out = process.argv[2] ?? "media/film";
const site = process.argv[3] ?? "https://player-two-site.vercel.app/";
const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  // the browser-level scale factor is what makes the screencast record device pixels (1920x1080), not CSS pixels
  args: ["--force-device-scale-factor=1.5", "--autoplay-policy=no-user-gesture-required", "--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--hide-scrollbars"],
  // a laptop-sized page rendered at 1.5x: the recording is 1920x1080 and the interface reads large
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1.5 },
});
const page = await browser.newPage();
const cues: { type: string; t: number }[] = [];
let t0 = 0;
await page.exposeFunction("__cue", (type: string) => cues.push({ type, t: (Date.now() - t0) / 1000 }));
await page.evaluateOnNewDocument(() => {
  window.addEventListener("film:sfx", (e) => (window as unknown as { __cue: (t: string) => void }).__cue((e as CustomEvent<{ type: string }>).detail.type));
});
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 160)));

await page.goto("about:blank");
const recorder = await page.screencast({ path: `${out}/raw.webm` });
t0 = Date.now();
await page.goto(`${site}?film=1`, { waitUntil: "networkidle0", timeout: 120_000 });
cues.push({ type: "loaded", t: (Date.now() - t0) / 1000 });
await new Promise((r) => setTimeout(r, 2600)); // let the headline resolve out of its blur

for (const which of [1, 0]) {
  cues.push({ type: `demo-start-${which}`, t: (Date.now() - t0) / 1000 });
  await page.evaluate((w) => (window as unknown as { filmDemo: (n: number) => Promise<void> }).filmDemo(w), which);
  cues.push({ type: `demo-end-${which}`, t: (Date.now() - t0) / 1000 });
  await new Promise((r) => setTimeout(r, 900));
}
await recorder.stop();
await browser.close();
await writeFile(`${out}/cues.json`, JSON.stringify(cues, null, 1));
const count = (k: string) => cues.filter((c) => c.type === k).length;
console.log("recorded", cues.at(-1)?.t.toFixed(1), "s | cues:", ["key", "click", "open", "close", "tick", "success", "hover"].map((k) => `${k} ${count(k)}`).join(", "));
