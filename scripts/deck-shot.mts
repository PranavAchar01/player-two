// Opens the slideshow with real media and screenshots the media slides. usage: tsx scripts/deck-shot.mts <deck-url> <out-dir>
import { mkdir } from "node:fs/promises";
import puppeteer from "puppeteer-core";

const [url, out] = [process.argv[2], process.argv[3] ?? "/tmp/deck-shots"];
const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--autoplay-policy=no-user-gesture-required"], defaultViewport: { width: 1920, height: 1080 } });
const page = await browser.newPage();
const problems: string[] = [];
page.on("pageerror", (e) => problems.push("pageerror: " + String(e).slice(0, 160)));
page.on("requestfailed", (r) => problems.push("failed: " + r.url().slice(-60)));
page.on("response", (r) => { if (r.status() >= 400) problems.push(r.status() + ": " + r.url().slice(-60)); });
for (const n of [1, 4, 8, 9]) {
  await page.goto(`${url}#${n}`, { waitUntil: "networkidle0", timeout: 60_000 });
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 3500));
  const media = await page.evaluate(() => [...document.querySelectorAll("video")].map((v) => ({ src: v.currentSrc.split("/").pop(), ready: v.readyState, playing: !v.paused, t: +v.currentTime.toFixed(2) })));
  console.log("slide", n, JSON.stringify(media));
  await page.screenshot({ path: `${out}/slide-${n}.png` });
}
await browser.close();
console.log(problems.length ? "PROBLEMS\n" + [...new Set(problems)].join("\n") : "no failed requests or page errors");
