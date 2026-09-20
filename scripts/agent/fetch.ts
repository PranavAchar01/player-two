// Step c: download one candidate and turn it into a pose track. Children are started with argument arrays,
// never a shell string, because ids and paths here come from the internet.
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { USER_AGENT, resolvePexelsFile, type Pacer } from "./search";
import type { Candidate } from "./types";

const run = promisify(execFile);
const MAX_BYTES = 200 << 20;
/** Only the first minute is ever used. Longer footage costs pose-extraction time and buys nothing. */
const MAX_CLIP_SECONDS = 60;
export const MEDIAPIPE_PIN = "0.10.14";
/** The one folder the Docker sandbox can see. Created with: docker sandbox create --name <name> shell <this folder> <scripts>:ro */
export const SANDBOX_DIR = "data/sandbox";

const exists = (p: string) => stat(p).then((s) => s.size > 0, () => false);

/**
 * What an earlier run already left on disk for this video. Keys are stable across runs (`<source>-<id>`), so a
 * second run on a similar task meets many of the same videos, and asking YouTube for them again would cost their
 * bandwidth and a likely refusal for nothing. A track alone is enough: the judge and the retargeter read only
 * the track, so footage is not fetched again just to sit next to it.
 */
export async function reusable(key: string, root = "data"): Promise<{ file: string | null; track: string | null }> {
  const file = `${root}/sources/${key}.mp4`, track = `${root}/tracks/${key}.json`;
  return { file: (await exists(file)) ? file : null, track: (await exists(track)) ? track : null };
}

export async function probeDuration(file: string): Promise<number | null> {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { timeout: 30_000 });
    const d = Number(stdout.trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

/** Downloads to data/sources/<key>.mp4. A file already on disk is reused so a re-run asks the network for nothing. */
export async function fetchVideo(c: Candidate, pacer: Pacer): Promise<string> {
  await mkdir("data/sources", { recursive: true });
  const file = `data/sources/${c.key}.mp4`;
  if (await exists(file)) return file;
  // Keeps the .mp4 ending while incomplete: yt-dlp and ffmpeg both pick the container from the file name.
  const part = `data/sources/${c.key}.dl.mp4`;
  await rm(part, { force: true });

  if (c.source === "pexels") {
    const url = c.downloadUrl ?? (await resolvePexelsFile(c.id, pacer));
    if (!url || !url.startsWith("https://videos.pexels.com/")) throw new Error("no downloadable Pexels rendition found");
    await pacer.wait();
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(180_000) });
    if (!res.ok || !res.body) throw new Error(`Pexels file answered HTTP ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("file is larger than 200 MB");
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>), createWriteStream(part));
  } else {
    await pacer.wait();
    // Video only, 720p at most, h264 when offered (the pose extractor's OpenCV reads it everywhere), first minute
    // only. `--` stops a video id that begins with a dash being read as a flag. Not --quiet here: the output is
    // captured, never printed, and it is the only place the reason for a refusal (HTTP 403) shows up.
    try {
      await run("yt-dlp", ["--no-progress", "--no-warnings", "--no-playlist", "--no-part", "-f", "bv*[height<=720][vcodec^=avc1]/b[height<=720][ext=mp4]/bv*[height<=720]/b[height<=720]", "--download-sections", `*0-${MAX_CLIP_SECONDS}`, "--merge-output-format", "mp4", "--max-filesize", "200M", "-o", part, "--", `https://www.youtube.com/watch?v=${c.id}`], { timeout: 300_000, maxBuffer: 8 << 20 });
    } catch (err) {
      await rm(part, { force: true });
      const stderr = typeof err === "object" && err !== null && "stderr" in err ? String((err as { stderr: unknown }).stderr) : "";
      const lastError = stderr.split("\n").filter((l) => l.startsWith("ERROR")).at(-1) ?? stderr.trim().split("\n").at(-1) ?? "unknown error";
      // YouTube turns some media requests away. That is their call: the clip is dropped, nothing is retried around it.
      throw new Error(/403/.test(stderr) ? "YouTube refused the media download (HTTP 403). Clip dropped, no workaround attempted." : `yt-dlp could not download the clip: ${lastError.slice(0, 160)}`);
    }
  }
  if (!(await exists(part))) throw new Error("download produced no file");

  const duration = await probeDuration(part);
  if (duration !== null && duration > MAX_CLIP_SECONDS + 2) {
    const cut = `${file}.cut.mp4`;
    await run("ffmpeg", ["-y", "-loglevel", "quiet", "-i", part, "-t", String(MAX_CLIP_SECONDS), "-c", "copy", "-an", cut], { timeout: 120_000 });
    await rm(part, { force: true });
    await rename(cut, file);
  } else await rename(part, file);
  return file;
}

/**
 * The pinned extractor command from scripts/tracks.mts. mediapipe newer than this pin aborts on this Mac, so the
 * pin is part of the run's recorded versions. extract_pose.py is not ours to edit: it is called exactly as documented.
 */
export async function extractPose(video: string, key: string, sandbox: string | null = null): Promise<string> {
  await mkdir("data/tracks", { recursive: true });
  const out = `data/tracks/${key}.json`;
  if (await exists(out)) return out;
  const uv = ["run", "--quiet", "--python", "3.11", "--with", `mediapipe==${MEDIAPIPE_PIN}`, "--with", "numpy<2", "--with", "opencv-python-headless", "python"];
  if (sandbox) {
    // A video from the internet is untrusted input, and decoding it is where that matters. The file is handed to a
    // Docker sandbox through its one shared folder, decoded and tracked in there, and only the numbers come back.
    const work = path.resolve(SANDBOX_DIR), script = path.resolve("scripts/extract_pose.py");
    await mkdir(`${SANDBOX_DIR}/in`, { recursive: true });
    await mkdir(`${SANDBOX_DIR}/out`, { recursive: true });
    await mkdir(`${SANDBOX_DIR}/model`, { recursive: true });
    if (!(await exists(`${SANDBOX_DIR}/model/pose_landmarker_lite.task`))) await copyFile("public/mediapipe/pose_landmarker_lite.task", `${SANDBOX_DIR}/model/pose_landmarker_lite.task`);
    await copyFile(video, `${SANDBOX_DIR}/in/${key}.mp4`);
    try {
      await run("docker", ["sandbox", "exec", "-w", work, sandbox, "uv", ...uv, script, `in/${key}.mp4`, "model/pose_landmarker_lite.task", `out/${key}.json`], { timeout: 1_200_000, maxBuffer: 8 << 20 });
      if (!(await exists(`${SANDBOX_DIR}/out/${key}.json`))) throw new Error("the sandbox wrote no pose track");
      await copyFile(`${SANDBOX_DIR}/out/${key}.json`, out);
    } finally {
      await rm(`${SANDBOX_DIR}/in/${key}.mp4`, { force: true });
      await rm(`${SANDBOX_DIR}/out/${key}.json`, { force: true });
    }
    return out;
  }
  await run("uv", [...uv, "scripts/extract_pose.py", video, "public/mediapipe/pose_landmarker_lite.task", out], { timeout: 1_200_000, maxBuffer: 8 << 20 });
  if (!(await exists(out))) throw new Error("pose extraction wrote no track");
  return out;
}
