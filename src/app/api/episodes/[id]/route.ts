import { loadEpisode } from "@/lib/store";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const e = await loadEpisode((await params).id);
  if (!e) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ id: e.id, nickname: e.nickname, task: e.task, accepted: e.accepted, gates: e.gates, ctrl: e.ctrl });
}
