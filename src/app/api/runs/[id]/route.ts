import { alive, loadRun } from "../runs";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const run = await loadRun((await params).id);
  if (!run) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ run, live: run.status === "running" && alive(run.pid) });
}
