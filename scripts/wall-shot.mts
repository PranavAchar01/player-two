// Screenshot of the live dataset wall, for the slideshow. usage: tsx scripts/wall-shot.mts <out.png> [base-url]
import puppeteer from "puppeteer-core";

const out = process.argv[2] ?? "media/wall.png";
const base = process.argv[3] ?? "http://localhost:3218";
const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"], defaultViewport: { width: 1920, height: 1080 } });
const page = await browser.newPage();
await page.goto(`${base}/wall`, { waitUntil: "networkidle0", timeout: 120_000 });
await page.addStyleTag({ content: "nextjs-portal{display:none}" });
await new Promise((r) => setTimeout(r, 9000)); // let the replay load and reach mid-strike
await page.screenshot({ path: out, type: "png" });
await browser.close();
console.log("wrote", out);
