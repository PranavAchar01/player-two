import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_DIR } from "@/lib/store";

const run = promisify(execFile);

/** Human approval step: nothing is written to the dataset until someone asks for it here. */
export async function POST() {
  const out = path.join(DATA_DIR, "dataset");
  try {
    const { stdout } = await run("uv", ["run", "--quiet", "--python", "3.12", "--with", "lerobot[dataset]", "scripts/export_lerobot.py", path.join(DATA_DIR, "episodes"), out], { timeout: 600_000 });
    return Response.json({ ok: true, path: out, summary: JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message.slice(0, 400) : "export failed" }, { status: 500 });
  }
}
