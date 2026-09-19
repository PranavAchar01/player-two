import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { validateRunRequest } from "../../../../scripts/agent/validate";
import { RUNS_DIR, listRuns } from "./runs";

export const dynamic = "force-dynamic";

// A run scrapes other people's servers, so there is only ever one. This also covers the few seconds between
// spawning the CLI and its first run.json, when the run cannot be seen on disk yet.
let lastSpawn = 0;

export async function GET() {
  return Response.json({ runs: await listRuns() });
}

export async function POST(req: Request) {
  const checked = validateRunRequest(await req.json().catch(() => null));
  if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
  const { task, robot, maxVideos, seconds, sources, allowStandardLicense } = checked.value;
  // The page has no switch for this on purpose. Keeping footage out of the licence policy takes a deliberate CLI flag.
  if (allowStandardLicense) return Response.json({ error: "allowStandardLicense can only be set from the command line" }, { status: 400 });
  if (Date.now() - lastSpawn < 20_000 || (await listRuns()).some((r) => r.status === "running")) return Response.json({ error: "a run is already in progress" }, { status: 409 });
  lastSpawn = Date.now();

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "task";
  const id = `${stamp}-${slug}-${randomBytes(2).toString("hex")}`;
  await mkdir(path.join(RUNS_DIR, id), { recursive: true });

  // No shell: the task travels as one argv entry. It was checked to start with a letter or digit, so it cannot
  // be read as a flag either.
  const logFd = openSync(path.join(RUNS_DIR, id, "agent.log"), "a");
  const child = spawn("pnpm", ["dlx", "tsx", "scripts/agent/agent.mts", task, "--robot", robot, "--max-videos", String(maxVideos), "--seconds", String(seconds), "--sources", sources.join(","), "--run-id", id], { cwd: process.cwd(), detached: true, shell: false, stdio: ["ignore", logFd, logFd] });
  child.on("error", () => { lastSpawn = 0; });
  child.unref();
  closeSync(logFd);
  return Response.json({ id }, { status: 202 });
}
