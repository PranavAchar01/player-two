// Step b: find candidate videos. Everything here is sequential and paced, because the services being asked
// owe this tool nothing. A source that says no (bot check, rate limit) is recorded and left alone.
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { REQUEST_GAP_MS, type Candidate, type Licence, type SearchLog } from "./types";

const run = promisify(execFile);
// Says what this is. The Pexels file CDN serves it; nothing here pretends to be a person's browser.
export const USER_AGENT = "player-two-agent/0.1 (pose research tool; sequential, rate limited)";
const CHROME = path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const YT_CC_FILTER = "EgIwAQ%253D%253D";
export const MAX_YOUTUBE_SECONDS = 240;

export const PEXELS_LICENCE: Licence = { name: "Pexels License", url: "https://www.pexels.com/license/", redistributable: true };

/** Spaces out requests. One pacer is shared by a whole run so different steps cannot burst together. */
export class Pacer {
  private last = 0;
  async wait(): Promise<void> {
    const due = this.last + REQUEST_GAP_MS - Date.now();
    if (due > 0) await new Promise((r) => setTimeout(r, due));
    this.last = Date.now();
  }
}

// ---------------------------------------------------------------- licence rules (pure, unit tested)

export const isCreativeCommons = (license: unknown): boolean => typeof license === "string" && /creative commons/i.test(license);

export function youtubeLicence(license: unknown): Licence {
  if (isCreativeCommons(license)) return { name: "Creative Commons Attribution (CC BY)", url: "https://creativecommons.org/licenses/by/3.0/legalcode", redistributable: true };
  return { name: typeof license === "string" && license.trim() ? license.trim().slice(0, 80) : "Standard YouTube License (not stated)", url: "https://www.youtube.com/static?template=terms", redistributable: false };
}

export interface YoutubeMeta {
  id?: unknown;
  license?: unknown;
  duration?: unknown;
  is_live?: unknown;
  title?: unknown;
  uploader?: unknown;
  channel_url?: unknown;
}

/** The gate every YouTube result goes through. A missing licence field counts as not Creative Commons. */
export function keepYoutubeEntry(meta: YoutubeMeta, allowStandardLicense: boolean): { keep: boolean; reason: string | null } {
  if (typeof meta.id !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(meta.id)) return { keep: false, reason: "not a plain YouTube video id" };
  if (meta.is_live === true) return { keep: false, reason: "live stream" };
  if (typeof meta.duration !== "number" || !(meta.duration > 0)) return { keep: false, reason: "duration unknown" };
  if (meta.duration > MAX_YOUTUBE_SECONDS) return { keep: false, reason: `${Math.round(meta.duration)} s long, limit ${MAX_YOUTUBE_SECONDS} s` };
  if (!isCreativeCommons(meta.license) && !allowStandardLicense) return { keep: false, reason: `licence is "${youtubeLicence(meta.license).name}", only Creative Commons is kept` };
  return { keep: true, reason: null };
}

const str = (v: unknown, max = 120) => (typeof v === "string" && v.trim() ? v.replace(/[\x00-\x1f\x7f<>|`]/g, " ").trim().slice(0, max) : null);

const blank = (c: Pick<Candidate, "source" | "id" | "pageUrl" | "licence" | "query"> & Partial<Candidate>): Candidate => ({
  key: `${c.source}-${c.id}`, title: null, author: null, authorUrl: null, durationS: null, stage: "found", note: null, downloadUrl: null, file: null, track: null, footageDeleted: false, verdict: null, ...c,
});

// ---------------------------------------------------------------- YouTube, Creative Commons only

export async function searchYoutube(queries: string[], want: number, allowStandardLicense: boolean, pacer: Pacer, seen: Set<string>, log: (l: string) => void): Promise<{ candidates: Candidate[]; searches: SearchLog[] }> {
  const candidates: Candidate[] = [];
  const searches: SearchLog[] = [];
  const kept = () => candidates.filter((c) => c.stage === "found").length;
  for (const query of queries) {
    if (kept() >= want) break;
    // With the flag off the search itself is restricted to Creative Commons, and each hit is checked again below
    // because a search filter is a hint, not a licence.
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${allowStandardLicense ? "" : `&sp=${YT_CC_FILTER}`}`;
    const entry: SearchLog = { source: "youtube-cc", query, found: 0, kept: 0, note: null };
    searches.push(entry);
    await pacer.wait();
    let flat: { id?: unknown; duration?: unknown }[] = [];
    try {
      const { stdout } = await run("yt-dlp", ["--quiet", "--no-warnings", "--flat-playlist", "--playlist-end", "10", "-J", url], { timeout: 90_000, maxBuffer: 64 << 20 });
      flat = ((JSON.parse(stdout) as { entries?: unknown[] }).entries ?? []) as typeof flat;
    } catch {
      entry.note = "yt-dlp search failed";
      continue;
    }
    entry.found = flat.length;
    for (const f of flat) {
      if (kept() >= want) break;
      if (typeof f.id !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(f.id) || seen.has(`yt:${f.id}`)) continue;
      seen.add(`yt:${f.id}`);
      if (typeof f.duration === "number" && f.duration > MAX_YOUTUBE_SECONDS) continue; // not worth a metadata request
      await pacer.wait();
      let meta: YoutubeMeta;
      try {
        const { stdout } = await run("yt-dlp", ["--quiet", "--no-warnings", "--no-playlist", "-J", `https://www.youtube.com/watch?v=${f.id}`], { timeout: 90_000, maxBuffer: 64 << 20 });
        meta = JSON.parse(stdout) as YoutubeMeta;
      } catch {
        continue;
      }
      const gate = keepYoutubeEntry({ ...meta, id: f.id }, allowStandardLicense);
      const licence = youtubeLicence(meta.license);
      const c = blank({ source: licence.redistributable ? "youtube-cc" : "youtube", id: f.id, pageUrl: `https://www.youtube.com/watch?v=${f.id}`, licence, query, title: str(meta.title), author: str(meta.uploader), authorUrl: typeof meta.channel_url === "string" && meta.channel_url.startsWith("https://www.youtube.com/") ? meta.channel_url : null, durationS: typeof meta.duration === "number" ? meta.duration : null });
      if (!gate.keep) { c.stage = "skipped"; c.note = gate.reason; } else entry.kept++;
      candidates.push(c);
      log(`search: youtube ${f.id} ${gate.keep ? "kept" : "skipped"} (${licence.name})`);
    }
  }
  return { candidates, searches };
}

// ---------------------------------------------------------------- Pexels

interface PexelsApiVideo { id: number; url: string; duration: number; user?: { name?: string; url?: string }; video_files?: { link: string; width: number; height: number }[] }

/** Official API, used when the person running this has a (free) key. It is the route Pexels asks tools to take. */
async function searchPexelsApi(key: string, queries: string[], want: number, pacer: Pacer, seen: Set<string>): Promise<{ candidates: Candidate[]; searches: SearchLog[] }> {
  const candidates: Candidate[] = [];
  const searches: SearchLog[] = [];
  for (const query of queries) {
    if (candidates.length >= want) break;
    const entry: SearchLog = { source: "pexels", query, found: 0, kept: 0, note: "Pexels API" };
    searches.push(entry);
    await pacer.wait();
    const res = await fetch(`https://api.pexels.com/videos/search?per_page=10&query=${encodeURIComponent(query)}`, { headers: { authorization: key, "user-agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!res?.ok) { entry.note = `Pexels API answered ${res ? `HTTP ${res.status}` : "nothing"}`; if (res?.status === 429 || res?.status === 401) break; continue; }
    const videos = ((await res.json()) as { videos?: PexelsApiVideo[] }).videos ?? [];
    entry.found = videos.length;
    for (const v of videos) {
      if (candidates.length >= want || !Number.isInteger(v.id) || seen.has(`px:${v.id}`)) continue;
      seen.add(`px:${v.id}`);
      // smallest file that is still at least 540 px on its short side: enough for pose, light on their CDN
      const files = (v.video_files ?? []).filter((f) => typeof f.link === "string" && f.link.startsWith("https://videos.pexels.com/")).sort((a, b) => Math.min(a.width, a.height) - Math.min(b.width, b.height));
      const file = files.find((f) => Math.min(f.width, f.height) >= 540) ?? files.at(-1);
      if (!file) continue;
      entry.kept++;
      candidates.push(blank({ source: "pexels", id: String(v.id), pageUrl: `https://www.pexels.com/video/${v.id}/`, licence: PEXELS_LICENCE, query, author: str(v.user?.name), authorUrl: typeof v.user?.url === "string" && v.user.url.startsWith("https://www.pexels.com/") ? v.user.url : null, durationS: typeof v.duration === "number" ? v.duration : null, downloadUrl: file.link }));
    }
  }
  return { candidates, searches };
}

/** Search pages are rendered by JavaScript, so they are read with a real (headless) browser. */
async function searchPexelsPages(queries: string[], want: number, pacer: Pacer, seen: Set<string>, log: (l: string) => void): Promise<{ candidates: Candidate[]; searches: SearchLog[] }> {
  const candidates: Candidate[] = [];
  const searches: SearchLog[] = [];
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1366, height: 900 } });
  try {
    const page = await browser.newPage();
    for (const query of queries) {
      if (candidates.length >= want) break;
      const entry: SearchLog = { source: "pexels", query, found: 0, kept: 0, note: null };
      searches.push(entry);
      await pacer.wait();
      const res = await page.goto(`https://www.pexels.com/search/videos/${encodeURIComponent(query)}/`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => null);
      const title = await page.title().catch(() => "");
      if (!res || res.status() === 403 || res.status() === 429 || res.status() === 503 || /just a moment|verif/i.test(title)) {
        // A bot check is the site declining automated visits. It is not worked around: no stealth flags, no
        // challenge solving. One refusal ends Pexels for this run so the site is not asked again and again.
        entry.note = `pexels.com answered with a bot check (HTTP ${res?.status() ?? "none"}). Not bypassed. Set PEXELS_API_KEY to use the official API instead.`;
        log(`search: ${entry.note}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 2500)); // let the result grid render
      const cards = (await page.evaluate(`[...document.querySelectorAll('a[href*="/video/"]')].map((a) => { const art = a.closest("article"); const by = art && art.querySelector('a[href^="/@"]'); return { href: a.getAttribute("href"), author: by ? by.textContent : null, authorHref: by ? by.getAttribute("href") : null }; })`)) as { href: string | null; author: string | null; authorHref: string | null }[];
      const ids = new Set<string>();
      for (const card of cards) {
        const m = card.href?.match(/\/video\/(?:[a-z0-9-]+-)?(\d{4,12})\/?$/i);
        if (!m || ids.has(m[1])) continue;
        ids.add(m[1]);
        if (candidates.length >= want || seen.has(`px:${m[1]}`)) continue;
        seen.add(`px:${m[1]}`);
        entry.kept++;
        candidates.push(blank({ source: "pexels", id: m[1], pageUrl: `https://www.pexels.com/video/${m[1]}/`, licence: PEXELS_LICENCE, query, author: str(card.author), authorUrl: card.authorHref && /^\/@[\w.-]+\/?$/.test(card.authorHref) ? `https://www.pexels.com${card.authorHref}` : null }));
      }
      entry.found = ids.size;
    }
  } finally {
    await browser.close();
  }
  return { candidates, searches };
}

export async function searchPexels(queries: string[], want: number, pacer: Pacer, seen: Set<string>, log: (l: string) => void): Promise<{ candidates: Candidate[]; searches: SearchLog[] }> {
  const key = process.env.PEXELS_API_KEY?.trim();
  try {
    return key ? await searchPexelsApi(key, queries, want, pacer, seen) : await searchPexelsPages(queries, want, pacer, seen, log);
  } catch {
    return { candidates: [], searches: [{ source: "pexels", query: queries[0] ?? "", found: 0, kept: 0, note: "pexels search could not run (browser failed to start or the network is down)" }] };
  }
}

/** Finds a downloadable rendition by asking the file CDN which of the usual names exists. 403 there means "no such file". */
export async function resolvePexelsFile(id: string, pacer: Pacer): Promise<string | null> {
  const sizes = ["hd_1280_720", "hd_720_1280", "hd_1920_1080", "hd_1080_1920", "sd_960_540", "sd_540_960", "sd_640_360", "sd_360_640"];
  const names = [30, 25, 24, 60, 50].flatMap((fps) => sizes.map((s) => `${s}_${fps}fps`)).slice(0, 24); // bounded: never more than 24 probes per video
  for (const name of names) {
    await pacer.wait();
    const url = `https://videos.pexels.com/video-files/${id}/${id}-${name}.mp4`;
    const res = await fetch(url, { method: "HEAD", headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (res?.ok && (res.headers.get("content-type") ?? "").startsWith("video/")) return url;
  }
  return null;
}
