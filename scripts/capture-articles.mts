// Screenshots real article pages for the video's B-roll: the top of each page (outlet, headline, hero image), at 2x so a
// slow push stays sharp. Pop-ups, cookie bars, sticky headers and ad frames are removed from the page before the
// shot (removed, never clicked or accepted).
// usage: tsx scripts/capture-articles.mts <out-dir> <name>=<url> [<name>=<url> ...]
import { mkdir } from "node:fs/promises";
import puppeteer from "puppeteer-core";

const [out, ...pairs] = process.argv.slice(2);
const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--hide-scrollbars", "--disable-blink-features=AutomationControlled"], defaultViewport: { width: Number(process.env.VIEW_W ?? 1280), height: Number(process.env.VIEW_H ?? 720), deviceScaleFactor: Number(process.env.DSF ?? 2.25) } });
// how far above the headline the shot starts, in CSS pixels
const OFFSET = Number(process.env.OFFSET ?? 110);

for (const pair of pairs) {
  const i = pair.indexOf("=");
  const name = pair.slice(0, i), url = pair.slice(i + 1);
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36");
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 4500)); // hero images and fonts
    const info = await page.evaluate((offset) => {
      const junk = /cookie|consent|gdpr|onetrust|didomi|truste|banner|modal|overlay|popup|paywall|subscribe|newsletter|interstitial|ad-slot|advert|piano|tp-modal|sticky/i;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        const cs = getComputedStyle(el);
        const tag = el.tagName;
        const id = `${el.id} ${typeof el.className === "string" ? el.className : ""}`;
        if (tag === "IFRAME" || ((cs.position === "fixed" || cs.position === "sticky") && tag !== "HTML") || (junk.test(id) && el.getBoundingClientRect().height < 700 && !el.querySelector("h1"))) el.remove();
      }
      document.documentElement.style.overflow = "auto";
      document.body.style.overflow = "auto";
      const h1 = document.querySelector("h1");
      const top = h1 ? h1.getBoundingClientRect().top + window.scrollY : 0;
      window.scrollTo(0, Math.max(0, top - offset));
      return { title: document.title.slice(0, 90), h1: h1?.textContent?.trim().slice(0, 90) ?? null, top: Math.round(top) };
    }, OFFSET);
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: `${out}/${name}.png` });
    console.log(name, "ok |", info.h1 ?? info.title, "| h1 at", info.top);
  } catch (err) {
    console.log(name, "FAILED", String(err).slice(0, 140));
  }
  await page.close();
}
await browser.close();
