// Quick look: renders a few chosen ticks of a demo to JPEGs without making a video. usage: tsx scripts/peek.mts <demo> <out-dir> <tick,tick,...>
import { mkdir } from "node:fs/promises";
import puppeteer from "puppeteer-core";
const [demo, out, list] = process.argv.slice(2);
const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"], defaultViewport: { width: 1920, height: 1080 } });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 200)));
await page.goto(`http://localhost:3218/render?demo=${demo}&mode=source`, { waitUntil: "networkidle0", timeout: 120_000 });
await page.waitForFunction("window.p2 !== undefined", { timeout: 120_000 });
for (const n of list.split(",").map(Number)) {
  await page.evaluate(`window.p2.frame(${n})`);
  await page.screenshot({ path: `${out}/tick-${n}.jpg`, type: "jpeg", quality: 85 });
}
await browser.close();
console.log("ok");
