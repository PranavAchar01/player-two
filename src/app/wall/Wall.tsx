"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { loadMujocoBrowser } from "@/client/load";
import { Viewer } from "@/client/viewer";
import type { Coverage, EpisodeSummary } from "@/lib/store";
import { TICK_HZ, taskSentence, type TaskSpec } from "@/sim/scene";
import { Sim } from "@/sim/sim";

interface Feed {
  total: number;
  accepted: number;
  coverage: Coverage;
  leaderboard: { nickname: string; accepted: number }[];
  recent: EpisodeSummary[];
}

export default function Wall() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [qr, setQr] = useState("");
  const [replaying, setReplaying] = useState<{ nickname: string; task: TaskSpec } | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const latest = useRef<string | null>(null);

  useEffect(() => {
    const poll = async () => {
      const res = await fetch("/api/episodes");
      if (!res.ok) return;
      const f = (await res.json()) as Feed;
      setFeed(f);
      latest.current = f.recent.find((e) => e.accepted)?.id ?? null;
    };
    void poll();
    const timer = setInterval(poll, 2000);
    void QRCode.toDataURL(window.location.origin, { margin: 1, width: 320, color: { dark: "#0a0b0e", light: "#ffffff" } }).then(setQr);
    return () => clearInterval(timer);
  }, []);

  // Hands-off replay: loop the most recent accepted episode, straight from its recorded actions.
  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    let sim: Sim | undefined;
    let viewer: Viewer | undefined;
    void (async () => {
      const mj = await loadMujocoBrowser();
      if (cancelled || !canvas.current) return;
      viewer = new Viewer(canvas.current);
      let ctrl: number[][] = [];
      let loaded: string | null = null;
      let tick = 0;
      let acc = 0;
      let last = performance.now();
      const frame = (now: number) => {
        raf = requestAnimationFrame(frame);
        acc += Math.min(100, now - last);
        last = now;
        if (latest.current && latest.current !== loaded && tick === 0) {
          loaded = latest.current;
          void fetch(`/api/episodes/${loaded}`).then(async (r) => {
            const e = (await r.json()) as { ctrl: number[][]; task: TaskSpec; nickname: string };
            sim?.dispose();
            sim = new Sim(mj, e.task);
            viewer!.setSim(sim);
            ctrl = e.ctrl;
            setReplaying({ nickname: e.nickname, task: e.task });
          });
        }
        while (acc >= 1000 / TICK_HZ) {
          acc -= 1000 / TICK_HZ;
          if (!sim || ctrl.length === 0) continue;
          sim.tick(ctrl[Math.min(tick, ctrl.length - 1)]);
          if (++tick > ctrl.length + 40) {
            tick = 0;
            const t = sim.task;
            sim.dispose();
            sim = new Sim(mj, t);
            viewer!.setSim(sim);
          }
        }
        viewer!.render();
      };
      raf = requestAnimationFrame(frame);
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      sim?.dispose();
      viewer?.dispose();
    };
  }, []);

  async function approve() {
    setExported("exporting…");
    const res = await fetch("/api/export", { method: "POST" });
    const body = (await res.json()) as { ok: boolean; path?: string; error?: string; summary?: { accepted: number; frames: number } };
    setExported(body.ok ? `${body.summary?.accepted} episodes, ${body.summary?.frames} frames written to ${body.path}` : `export failed: ${body.error}`);
  }

  return (
    <main className="grid min-h-screen gap-6 p-6 lg:grid-cols-[1.2fr_1fr]">
      <section className="space-y-4">
        <div className="flex items-end justify-between">
          <div>
            <div className="font-mono text-xs uppercase tracking-[0.4em] text-cyan-300">Player Two · dataset wall</div>
            <div className="mt-1 text-6xl font-semibold tabular-nums">{feed?.accepted ?? 0}</div>
            <div className="text-white/50">demonstrations accepted, {feed ? feed.total - feed.accepted : 0} rejected</div>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL */}
          {qr && <img src={qr} alt="Join" className="h-36 w-36 rounded-lg" />}
        </div>
        <div className="relative aspect-video overflow-hidden rounded-2xl border border-white/10 bg-[radial-gradient(circle_at_50%_30%,#1b2230,#07080b_75%)]">
          <canvas ref={canvas} className="h-full w-full" />
          <div className="absolute left-3 top-3 rounded-full bg-black/60 px-3 py-1 font-mono text-[11px] text-white/80">{replaying ? `Replay, nobody moving · ${replaying.nickname} · ${taskSentence(replaying.task)}` : "Waiting for the first accepted demonstration"}</div>
        </div>
        <p className="rounded-xl border border-cyan-300/30 bg-cyan-300/5 p-3 text-sm text-cyan-100">{feed?.coverage.message}</p>
      </section>

      <section className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          {feed?.coverage.cells.map((c) => (
            <div key={`${c.task.side}-${c.task.slot}`} className="rounded-lg border border-white/10 bg-white/[0.03] p-2 text-center">
              <div className="text-2xl font-semibold tabular-nums">{c.accepted}</div>
              <div className="font-mono text-[10px] uppercase text-white/45">{c.task.side} · {c.task.slot}</div>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-white/10 p-3">
          <h2 className="text-xs uppercase tracking-widest text-white/40">Operators</h2>
          {feed?.leaderboard.map((l) => (
            <div key={l.nickname} className="mt-1 flex justify-between text-sm"><span>{l.nickname}</span><span className="tabular-nums text-white/60">{l.accepted}</span></div>
          ))}
        </div>
        <div className="rounded-xl border border-white/10 p-3">
          <h2 className="text-xs uppercase tracking-widest text-white/40">Latest episodes</h2>
          {feed?.recent.map((e) => (
            <div key={e.id} className="mt-1.5 text-sm">
              <span className={e.accepted ? "text-emerald-300" : "text-rose-300"}>{e.accepted ? "accepted" : "rejected"}</span> <span className="text-white/70">{e.nickname}</span> <span className="text-white/35">{e.task.side} {e.task.slot} · {(e.ticks / TICK_HZ).toFixed(1)}s</span>
              {!e.accepted && <div className="pl-4 text-xs text-rose-200/70">{e.failed.join("; ")}</div>}
            </div>
          ))}
        </div>
        <button type="button" onClick={approve} className="w-full rounded-lg bg-emerald-400 px-4 py-3 font-medium text-black">Approve batch and export LeRobot dataset</button>
        {exported && <p className="font-mono text-xs text-white/60">{exported}</p>}
      </section>
    </main>
  );
}
