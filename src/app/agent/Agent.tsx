"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { EMBODIMENTS, checkFeasibility, type Feasibility } from "../../../scripts/agent/feasible";
import { MAX_VIDEOS_CAP, ROBOTS, SOURCES, type Candidate, type Robot, type Run, type RunSummary, type SourceName, type Step } from "../../../scripts/agent/types";

const STEP_LABEL: Record<Step["name"], string> = { plan: "Plan", search: "Search", fetch: "Fetch and extract pose", judge: "Judge footage", retarget: "Retarget", write: "Write run" };
const tone = (status: string) => (status === "done" || status === "accepted" ? "text-emerald-300" : status === "running" || status === "fetching" || status === "extracting" ? "text-cyan-300" : status === "failed" || status === "crashed" || status === "rejected" ? "text-rose-300" : "text-white/40");
const dot = (status: string) => (status === "done" ? "bg-emerald-400" : status === "running" ? "animate-pulse bg-cyan-300" : status === "failed" ? "bg-rose-400" : "bg-white/15");

/** run.json is written by our own CLI, but a link is still only a link when it is plain https. */
function Out({ href, children }: { href: string | null; children: React.ReactNode }) {
  if (!href || !href.startsWith("https://")) return <span>{children}</span>;
  return <a href={href} target="_blank" rel="noreferrer noopener" className="text-cyan-300 underline decoration-cyan-300/30 underline-offset-2 hover:decoration-cyan-300">{children}</a>;
}

/** The same rules the CLI and the API apply, shown while typing and again on the finished run. */
function FeasibilityNote({ f, className = "" }: { f: Feasibility; className?: string }) {
  if (f.level === "ok") return null;
  const refused = f.level === "refuse";
  return (
    <div className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${refused ? "border-rose-300/40 bg-rose-300/5 text-rose-100/90" : "border-amber-300/40 bg-amber-300/5 text-amber-100/90"} ${className}`}>
      <div className="font-mono text-[10px] uppercase tracking-widest">{refused ? "Not possible for this robot" : "Heads up"}</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">{f.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      {f.suggestion && <p className="mt-1 text-white/70">{f.suggestion}</p>}
    </div>
  );
}

function verdictOf(c: Candidate): string {
  if (c.verdict) return c.verdict.accepted ? "accepted" : "rejected";
  return c.stage;
}

export default function Agent() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [live, setLive] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<{ task: string; robot: Robot; maxVideos: number; seconds: number; sources: SourceName[] }>({ task: "", robot: "g1", maxVideos: 6, seconds: 6, sources: [...SOURCES] });
  const [message, setMessage] = useState<string | null>(null);
  // what the server said when it refused a robot and task combination (HTTP 422)
  const [refusal, setRefusal] = useState<Feasibility | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);

  useEffect(() => {
    const poll = async () => {
      const res = await fetch("/api/runs").catch(() => null);
      if (res?.ok) {
        const list = ((await res.json()) as { runs: RunSummary[] }).runs;
        setRuns(list);
        if (!selectedRef.current && list[0]) { selectedRef.current = list[0].id; setSelected(list[0].id); }
      }
      const id = selectedRef.current;
      if (!id) return;
      const one = await fetch(`/api/runs/${id}`).catch(() => null);
      // A run that was only just started has no run.json for a second or two. Keep whatever is on screen until it does.
      if (!one?.ok || selectedRef.current !== id) return;
      const body = (await one.json()) as { run: Run; live: boolean };
      setRun(body.run);
      setLive(body.live);
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, []);

  function pick(id: string) {
    selectedRef.current = id;
    setSelected(id);
    setRun(null);
  }

  // Checked while typing so nobody has to press the button to learn that an arm cannot do jumping jacks.
  const fit = useMemo(() => (form.task.trim().length >= 3 ? checkFeasibility(form.task, form.robot) : null), [form.task, form.robot]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setMessage("starting…");
    setRefusal(null);
    const res = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
    const body = (await res.json()) as { id?: string; error?: string; reasons?: string[]; suggestion?: string | null };
    if (res.status === 422 && Array.isArray(body.reasons)) setRefusal({ level: "refuse", reasons: body.reasons, suggestion: body.suggestion ?? undefined });
    if (!res.ok || !body.id) return setMessage(body.error ?? "could not start the run");
    setMessage("run started, the timeline fills in as it goes");
    pick(body.id);
  }

  const crashed = run?.status === "running" && !live;
  const status = run ? (crashed ? "crashed" : run.status) : "";
  const judged = run?.candidates.filter((c) => c.verdict) ?? [];
  const input = "w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm outline-none focus:border-cyan-300/60";

  return (
    <main className="grid min-h-screen gap-6 p-6 lg:grid-cols-[340px_1fr]">
      <aside className="space-y-4">
        <div>
          <div className="font-mono text-xs uppercase tracking-[0.4em] text-cyan-300">Player Two · agent</div>
          <p className="mt-2 text-sm text-white/50">Name a task. The agent finds videos of people doing it, keeps the footage one camera can be trusted on, and retargets it onto a robot. Every clip keeps its source and licence.</p>
        </div>

        <form onSubmit={start} className="space-y-3 rounded-xl border border-white/10 p-3">
          <h2 className="text-xs uppercase tracking-widest text-white/40">New run</h2>
          <input className={input} placeholder="dumbbell lateral raise" value={form.task} maxLength={120} onChange={(e) => { setRefusal(null); setForm({ ...form, task: e.target.value }); }} aria-label="Task" />
          <div className="grid grid-cols-3 gap-2">
            <label className="text-[11px] uppercase text-white/40">Robot
              <select className={`${input} mt-1`} value={form.robot} onChange={(e) => { setRefusal(null); setForm({ ...form, robot: e.target.value as Robot }); }}>{ROBOTS.map((r) => <option key={r} value={r} className="bg-[#0a0b0e]">{r}</option>)}</select>
            </label>
            <label className="text-[11px] uppercase text-white/40">Videos
              <input type="number" min={1} max={MAX_VIDEOS_CAP} className={`${input} mt-1`} value={form.maxVideos} onChange={(e) => setForm({ ...form, maxVideos: Number(e.target.value) })} />
            </label>
            <label className="text-[11px] uppercase text-white/40">Seconds
              <input type="number" min={2} max={20} className={`${input} mt-1`} value={form.seconds} onChange={(e) => setForm({ ...form, seconds: Number(e.target.value) })} />
            </label>
          </div>
          <div className="flex gap-4 text-sm text-white/70">
            {SOURCES.map((s) => (
              <label key={s} className="flex items-center gap-1.5">
                <input type="checkbox" checked={form.sources.includes(s)} onChange={(e) => setForm({ ...form, sources: e.target.checked ? [...form.sources, s] : form.sources.filter((x) => x !== s) })} />{s}
              </label>
            ))}
          </div>
          <p className="text-[11px] leading-relaxed text-white/45">{EMBODIMENTS[form.robot].label}: {EMBODIMENTS[form.robot].notes.join(" ")}</p>
          {fit && <FeasibilityNote f={fit} />}
          <button type="submit" className="w-full rounded-lg bg-cyan-300 px-4 py-2.5 text-sm font-medium text-black disabled:opacity-40" disabled={form.task.trim().length < 3 || form.sources.length === 0 || fit?.level === "refuse"}>Start run</button>
          {message && <p className="font-mono text-xs text-white/60">{message}</p>}
          {refusal && fit?.level !== "refuse" && <FeasibilityNote f={refusal} />}
          <p className="text-[11px] leading-relaxed text-white/35">Pexels licence and Creative Commons YouTube only. One run at a time, requests at least 1.5 s apart, at most {MAX_VIDEOS_CAP} judged videos from this page (the command line allows bigger runs).</p>
        </form>

        <div className="rounded-xl border border-white/10 p-3">
          <h2 className="text-xs uppercase tracking-widest text-white/40">Runs</h2>
          {runs.length === 0 && <p className="mt-2 text-sm text-white/40">No runs yet.</p>}
          {runs.map((r) => (
            <button type="button" key={r.id} onClick={() => pick(r.id)} className={`mt-2 block w-full rounded-lg border px-3 py-2 text-left ${selected === r.id ? "border-cyan-300/50 bg-cyan-300/5" : "border-white/10 bg-white/[0.03] hover:border-white/25"}`}>
              <div className="flex items-baseline justify-between gap-2 text-sm"><span className="truncate">{r.task}</span><span className={`font-mono text-[11px] ${tone(r.status)}`}>{r.status}</span></div>
              <div className="font-mono text-[10px] uppercase text-white/40">{r.robot} · {r.candidates} found · {r.accepted} accepted · {r.episodes} episodes</div>
              <div className="font-mono text-[10px] text-white/25">{r.startedAt.replace("T", " ").slice(0, 19)}</div>
            </button>
          ))}
        </div>
      </aside>

      <section className="min-w-0 space-y-4">
        {!run && <div className="rounded-2xl border border-white/10 p-10 text-center text-white/40">{selected ? "Waiting for the run to write its first trace…" : "Start a run, or pick one on the left."}</div>}
        {run && (
          <>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className={`font-mono text-xs uppercase tracking-[0.3em] ${tone(status)}`}>{status}{run.error ? ` · ${run.error}` : ""}</div>
                <h1 className="mt-1 text-4xl font-semibold">{run.task}</h1>
                <div className="mt-1 font-mono text-xs text-white/40">{run.id} · robot {run.options.robot} · {run.options.seconds} s per episode · up to {run.options.maxVideos} judged{run.options.targetAccepted ? `, stops at ${run.options.targetAccepted} accepted` : ""} · {run.options.sources.join(" + ")}</div>
              </div>
              <div className="grid grid-cols-4 gap-2 text-center">
                {([["found", run.candidates.length], ["judged", judged.length], ["accepted", judged.filter((c) => c.verdict!.accepted).length], ["episodes", run.episodes.length]] as const).map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2"><div className="text-2xl font-semibold tabular-nums">{v}</div><div className="font-mono text-[10px] uppercase text-white/45">{k}</div></div>
                ))}
              </div>
            </div>

            <ol className="grid gap-2 md:grid-cols-3 xl:grid-cols-6">
              {run.steps.map((s, i) => (
                <li key={s.name} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                  <div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${dot(s.status)}`} /><span className="font-mono text-[10px] uppercase tracking-widest text-white/45">{i + 1} · {STEP_LABEL[s.name]}</span></div>
                  <div className={`mt-1 text-sm ${tone(s.status)}`}>{s.status}{s.ms !== null ? ` · ${(s.ms / 1000).toFixed(1)} s` : ""}</div>
                  {s.summary && <div className="mt-1 text-xs leading-snug text-white/55">{s.summary}</div>}
                </li>
              ))}
            </ol>

            {run.feasibility && (run.feasibility.level === "ok"
              ? <p className="font-mono text-xs text-white/40">task suits the {run.options.robot}: no capability it lacks is asked for</p>
              : <FeasibilityNote f={run.feasibility} />)}

            {run.plan && (
              <div className="grid gap-4 rounded-xl border border-cyan-300/30 bg-cyan-300/5 p-4 lg:grid-cols-2">
                <div>
                  <h2 className="text-xs uppercase tracking-widest text-cyan-200/70">Plan · {run.plan.planner}{run.plan.model ? ` · ${run.plan.model}` : ""}</h2>
                  <p className="mt-2 text-sm text-cyan-50">{run.plan.motionDescription}</p>
                  <p className="mt-2 font-mono text-xs text-cyan-100/70">arm: {run.plan.arm} · check: {run.plan.signature.kind} past {run.plan.signature.threshold}{run.plan.signature.kind === "wrist_oscillation" ? " cm" : " deg"}, {run.plan.signature.minCount} time{run.plan.signature.minCount === 1 ? "" : "s"}{run.plan.signature.direction && run.plan.signature.direction !== "any" ? `, ${run.plan.signature.direction}` : ""}</p>
                  {run.plan.note && <p className="mt-2 text-xs text-amber-200/80">{run.plan.note}</p>}
                  <ul className="mt-3 space-y-0.5 text-xs text-white/55">{run.plan.rejectionCriteria.map((c) => <li key={c}>reject: {c}</li>)}</ul>
                </div>
                <div>
                  <h2 className="text-xs uppercase tracking-widest text-cyan-200/70">Queries</h2>
                  <table className="mt-2 w-full text-xs">
                    <thead><tr className="text-left font-mono uppercase text-white/35"><th className="py-1 font-normal">source</th><th className="font-normal">query</th><th className="pl-3 text-right font-normal">found</th><th className="pl-3 text-right font-normal">kept</th></tr></thead>
                    <tbody>
                      {run.searches.map((s, i) => (
                        <tr key={`${s.source}-${i}`} className="border-t border-white/5 align-top"><td className="py-1 pr-2 font-mono text-white/45">{s.source}</td><td className="pr-2 text-white/80">{s.query}{s.note && <div className="text-amber-200/80">{s.note}</div>}</td><td className="text-right tabular-nums text-white/60">{s.found}</td><td className="text-right tabular-nums text-white/60">{s.kept}</td></tr>
                      ))}
                      {/* a source stops searching once it has enough candidates. Later queries are only spent if the fetch step runs out of videos */}
                      {run.plan.queries.filter((q) => !run.searches.some((s) => s.query === q)).map((q) => <tr key={q} className="border-t border-white/5"><td className="py-1 pr-2 font-mono text-white/30">{run.status === "running" && !crashed ? "queued" : "not needed"}</td><td className="text-white/45" colSpan={3}>{q}</td></tr>)}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="rounded-xl border border-white/10 p-4">
              <h2 className="text-xs uppercase tracking-widest text-white/40">Episodes, ranked by quality</h2>
              {run.episodes.length === 0 && <p className="mt-2 text-sm text-white/40">{run.status === "running" && !crashed ? "None yet." : "No clip passed every footage check, so nothing was retargeted."}</p>}
              {run.episodes.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="mt-2 w-full text-sm">
                    <thead><tr className="text-left font-mono text-[10px] uppercase text-white/35"><th className="py-1 font-normal">#</th><th className="font-normal">episode</th><th className="font-normal">quality</th><th className="font-normal">window</th><th className="font-normal">retarget stats</th><th className="font-normal">source, licence, author</th></tr></thead>
                    <tbody>
                      {run.episodes.map((e) => (
                        <tr key={e.name} className="border-t border-white/5 align-top">
                          <td className="py-1.5 pr-3 tabular-nums text-white/50">{e.rank || ""}</td>
                          <td className="pr-3"><span className="font-mono text-xs text-emerald-300">{e.out}</span><div className="text-xs text-white/40">{e.robot} via {e.retargeter}{e.poseOnly ? " · pose only, never rendered" : ""}</div></td>
                          <td className="pr-3 tabular-nums">{e.quality.toFixed(3)}</td>
                          <td className="pr-3 font-mono text-xs text-white/60">{e.startSeconds === null ? "auto" : `${e.startSeconds.toFixed(1)} s`} +{e.seconds} s</td>
                          <td className="pr-3 font-mono text-xs text-white/60">{Object.entries(e.stats).map(([k, v]) => `${k} ${v}`).join(" · ") || "none reported"}</td>
                          <td className="text-xs"><Out href={e.provenance.pageUrl}>{e.provenance.source} {e.provenance.id}</Out><div className="text-white/45">{e.provenance.licence.name} · {e.provenance.author ?? "author unknown"}</div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {run.retargetFailures.map((f) => <p key={f.candidateKey} className="mt-2 text-xs text-rose-200/80">retarget failed for {f.candidateKey}: {f.reason}</p>)}
            </div>

            <div className="rounded-xl border border-white/10 p-4">
              <h2 className="text-xs uppercase tracking-widest text-white/40">Candidates</h2>
              {run.candidates.length === 0 && <p className="mt-2 text-sm text-white/40">None yet.</p>}
              {run.candidates.map((c) => {
                const v = verdictOf(c);
                return (
                  <div key={c.key} className="mt-2 border-t border-white/5 pt-2 text-sm">
                    <button type="button" className="flex w-full flex-wrap items-baseline gap-x-3 text-left" onClick={() => setOpen(open === c.key ? null : c.key)}>
                      <span className={`w-20 font-mono text-xs ${tone(v)}`}>{v}</span>
                      <span className="font-mono text-xs text-white/80">{c.key}</span>
                      <span className="min-w-0 flex-1 truncate text-white/55">{c.title ?? c.query}</span>
                      <span className="font-mono text-[11px] text-white/40">{c.licence.name} · {c.author ?? "author unknown"}{c.durationS !== null ? ` · ${Math.round(c.durationS)} s` : ""}{c.verdict ? ` · score ${c.verdict.score}` : ""}{c.reused ? ` · ${c.reused} reused` : ""}</span>
                    </button>
                    {c.verdict && !c.verdict.accepted && <div className="pl-[5.75rem] text-xs text-rose-200/70">{c.verdict.reasons.join("; ")}</div>}
                    {c.verdict?.windowNote && <div className="pl-[5.75rem] text-xs text-amber-200/70">{c.verdict.windowNote}</div>}
                    {!c.verdict && c.note && <div className="pl-[5.75rem] text-xs text-white/40">{c.note}</div>}
                    {open === c.key && (
                      <div className="mt-2 space-y-1 pl-[5.75rem] text-xs">
                        <div><Out href={c.pageUrl}>{c.pageUrl}</Out>{c.authorUrl && <> · <Out href={c.authorUrl}>author page</Out></>}{c.footageDeleted ? " · footage deleted after pose extraction" : ""}</div>
                        <div className="text-white/35">found with: {c.query}</div>
                        {c.verdict?.checks.map((k) => <div key={k.name} className={k.pass ? "text-white/50" : "text-rose-200/80"}>{k.pass ? "pass" : "FAIL"} · {k.name}: {k.detail}</div>)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="text-xs leading-relaxed text-white/35">These are retargeted kinematic demonstrations. No policy is trained here, and video carries no object state or contact forces. Full trace: data/runs/{run.id}/run.json, summary: data/runs/{run.id}/REPORT.md. Versions: {Object.entries(run.versions).map(([k, v]) => `${k} ${v}`).join(", ")}.</p>
          </>
        )}
      </section>
    </main>
  );
}
