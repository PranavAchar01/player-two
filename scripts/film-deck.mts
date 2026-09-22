// Films the brain deck playing itself once (?film=1, window.playDeck) at a true 1920x1080, and logs when each
// slide came up so a soft transition sound can be laid in afterwards.
// usage: tsx scripts/film-deck.mts <out-dir> <deck-url>
import { mkdir, writeFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";

const out = process.argv[2] ?? "media/film-deck";
const deck = process.argv[3] ?? "http://localhost:4640/";
const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  // the browser-level scale factor is what makes the screencast record device pixels: 1280x720 at 1.5x is 1920x1080
  args: ["--force-device-scale-factor=1.5", "--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--hide-scrollbars"],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1.5 },
});
const page = await browser.newPage();
const cues: { type: string; t: number }[] = [];
let t0 = 0;
await page.exposeFunction("__cue", (type: string) => cues.push({ type, t: (Date.now() - t0) / 1000 }));
await page.evaluateOnNewDocument(() => {
  window.addEventListener("deck:slide", (e) => (window as unknown as { __cue: (t: string) => void }).__cue(`slide-${(e as CustomEvent<{ index: number }>).detail.index}`));
  // smaller moments inside a slide (a headline card landing) get their own softer sound
  window.addEventListener("deck:cue", (e) => (window as unknown as { __cue: (t: string) => void }).__cue((e as CustomEvent<{ type: string }>).detail.type));
});
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 160)));

// "load", not "networkidle0": a page with a <video> keeps a request open, and readiness is signalled by deckReady below
await page.goto(`${deck}${deck.includes("?") ? "&" : "?"}film=1`, { waitUntil: "load", timeout: 120_000 });
await page.waitForFunction("window.deckReady === true", { timeout: 60_000 });
await page.evaluate(() => document.fonts.ready);
const recorder = await page.screencast({ path: `${out}/raw.webm` });
t0 = Date.now();
await new Promise((r) => setTimeout(r, 400));
await page.evaluate(() => (window as unknown as { playDeck: () => Promise<void> }).playDeck());
cues.push({ type: "done", t: (Date.now() - t0) / 1000 });
await new Promise((r) => setTimeout(r, 1500)); // a tail, so the join has room for its cross-fade
await recorder.stop();
await browser.close();
await writeFile(`${out}/cues.json`, JSON.stringify(cues, null, 1));
console.log("recorded", cues.at(-1)?.t.toFixed(1), "s |", cues.map((c) => `${c.type}@${c.t.toFixed(1)}`).join(" "));
