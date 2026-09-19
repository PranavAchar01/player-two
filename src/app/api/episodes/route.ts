import { randomBytes } from "node:crypto";
import { judge, validShape, type EpisodeUpload } from "@/sim/episode";
import { SIDES, SLOTS } from "@/sim/scene";
import { rig } from "@/lib/mujoco-server";
import { coverage, listEpisodes, saveEpisode, summarize } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const episodes = await listEpisodes();
  const board = new Map<string, number>();
  for (const e of episodes) if (e.accepted) board.set(e.nickname, (board.get(e.nickname) ?? 0) + 1);
  return Response.json({
    total: episodes.length,
    accepted: episodes.filter((e) => e.accepted).length,
    coverage: coverage(episodes),
    leaderboard: [...board.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([nickname, n]) => ({ nickname, accepted: n })),
    recent: episodes.slice(0, 12).map(summarize),
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as EpisodeUpload | null;
  const ok = body && SIDES.includes(body.task?.side) && SLOTS.includes(body.task?.slot) && (body.source === "webcam" || body.source === "pilot") && typeof body.clientSuccess === "boolean" && validShape(body);
  if (!ok) return Response.json({ error: "malformed episode" }, { status: 400 });
  const nickname = String(body.nickname ?? "").replace(/[^\w .-]/g, "").trim().slice(0, 24) || "anonymous";
  const upload: EpisodeUpload = { nickname, task: { side: body.task.side, slot: body.task.slot }, source: body.source, ctrl: body.ctrl, held: body.held.map(Boolean), clamped: body.clamped.map(Boolean), limited: body.limited.map(Boolean), dtMs: body.dtMs.map(Number), clientSuccess: body.clientSuccess };
  const verdict = judge(await rig(), upload);
  const id = randomBytes(6).toString("hex");
  await saveEpisode({ ...upload, id, createdAt: new Date().toISOString(), accepted: verdict.accepted, gates: verdict.gates, successTick: verdict.successTick, state: verdict.state });
  return Response.json({ id, accepted: verdict.accepted, gates: verdict.gates, coverage: coverage(await listEpisodes()) });
}
