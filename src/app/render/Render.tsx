"use client";

import { useEffect, useRef, useState } from "react";
import { loadRig } from "@/client/load";
import { Viewer } from "@/client/viewer";
import { taskSentence, type TaskSpec } from "@/sim/scene";
import { Sim, type BodyCommand } from "@/sim/sim";

interface Demo {
  source?: string;
  task: TaskSpec | null;
  ctrl: number[][];
  body?: BodyCommand[];
  stats?: { tracked: number; limited: number; lagMsBefore?: number; lagMsAfter?: number };
  skeleton?: (number[][] | null)[];
  aspect?: number;
  video?: string;
  startSeconds?: number;
}

interface FramesMeta {
  count: number;
  t0: number;
  fps: number;
  W: number;
  H: number;
  crop: { x: number; y: number; w: number; h: number };
}

const PRE = 30; // ticks of rest before the motion
const POST = 90; // ticks after it, to watch the pendulum swing
const BONES = [[1, 3], [3, 5], [2, 4], [4, 6], [1, 2], [1, 7], [2, 8], [7, 8]];

declare global {
  interface Window {
    p2?: { ticks: number; frame: (n: number) => Promise<void> };
  }
}

/** Deterministic frame-by-frame renderer for video capture: /render?demo=<name>&mode=robot|split */
export default function Render() {
  const robot = useRef<HTMLCanvasElement>(null);
  const bones = useRef<HTMLCanvasElement>(null);
  const photo = useRef<HTMLImageElement>(null);
  const [hud, setHud] = useState({ task: "", source: "", split: false, struck: false, footage: false });

  useEffect(() => {
    void (async () => {
      const q = new URLSearchParams(window.location.search);
      const footage = q.get("mode") === "source";
      const split = footage || q.get("mode") === "split";
      const name = q.get("demo");
      const demo = (await (await fetch(`/demos/${name}.json`)).json()) as Demo;
      const meta = footage ? ((await (await fetch(`/demos/${name}-frames/meta.json`)).json()) as FramesMeta) : null;
      const rig = await loadRig();
      const viewer = new Viewer(robot.current!);
      const side = !demo.task ? 0 : demo.task.side === "left" ? 1 : -1;
      if (!demo.task) viewer.setCamera([3.3, 0, 0.95], [0, 0, 0.72]);
      else if (split) viewer.setCamera([2.35, 0.3 * side, 1.2], [0, 0.2 * side, 1.02]);
      else viewer.setCamera([1.95, 0.5 * side, 1.22], [0, 0.16 * side, 1.04]);
      // Fit the whole episode's skeleton to the panel once, so it neither jitters in scale nor sits tiny in a corner.
      const aspect = demo.aspect ?? 16 / 9;
      const all = (demo.skeleton ?? []).flatMap((f) => f ?? []);
      const xs = all.map((p) => (1 - p[0]) * aspect), ys = all.map((p) => p[1]);
      const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
      const rest = [...rig.rest.left, ...rig.rest.right];
      let sim = new Sim(rig, demo.task);
      viewer.setSim(sim);
      let at = 0;
      setHud({ task: demo.task ? taskSentence(demo.task) : `Free mirror, full body, kinematic root. Arm tracking lag ${demo.stats?.lagMsBefore ?? "?"} ms, ${demo.stats?.lagMsAfter ?? "?"} ms with preview.`, source: footage ? "motion source: stock video, pose estimated per frame" : demo.source ? "motion source: online video, pose only" : "motion source: scripted pilot", split, struck: false, footage });
      const total = PRE + demo.ctrl.length + POST;
      const ctrlAt = (n: number) => (n < PRE ? rest : demo.ctrl[Math.min(demo.ctrl.length - 1, n - PRE)]);
      const bodyAt = (n: number) => demo.body?.[Math.min(demo.body.length - 1, Math.max(0, n - PRE))];
      window.p2 = {
        ticks: total,
        frame: async (n: number) => {
          if (meta && photo.current) {
            const t = (demo.startSeconds ?? 0) + (n - PRE) / 50;
            const idx = Math.min(meta.count, Math.max(1, Math.round((t - meta.t0) * meta.fps) + 1));
            photo.current.src = `/demos/${name}-frames/${String(idx).padStart(5, "0")}.jpg`;
            await photo.current.decode().catch(() => undefined);
          }
          if (n < at) {
            sim = new Sim(rig, demo.task);
            viewer.setSim(sim);
            at = 0;
          }
          let struck = false;
          for (; at <= n; at++) struck = sim.tick(ctrlAt(at), bodyAt(at)).success;
          viewer.render();
          setHud((h) => (h.struck === struck ? h : { ...h, struck }));
          const c = bones.current;
          const ctx = c?.getContext("2d");
          if (!c || !ctx) return;
          ctx.clearRect(0, 0, c.width, c.height);
          const pts = demo.skeleton?.[Math.min(demo.skeleton.length - 1, Math.max(0, n - PRE))];
          if (!pts) return;
          const scale = meta ? (c.height / meta.crop.h) * meta.H : Math.min((c.width * 0.84) / (box.x1 - box.x0), (c.height * 0.7) / (box.y1 - box.y0));
          // over footage the skeleton sits on the person (crop space, mirrored like the picture); alone it is fitted to the panel
          const px = meta ? (p: number[]) => (1 - (p[0] * meta.W - meta.crop.x) / meta.crop.w) * c.width : (p: number[]) => c.width / 2 + ((1 - p[0]) * aspect - (box.x0 + box.x1) / 2) * scale;
          const py = meta ? (p: number[]) => ((p[1] * meta.H - meta.crop.y) / meta.crop.h) * c.height : (p: number[]) => c.height * 0.54 + (p[1] - (box.y0 + box.y1) / 2) * scale;
          ctx.strokeStyle = "#67e8f9";
          ctx.lineWidth = meta ? 7 : 12;
          ctx.globalAlpha = meta ? 0.9 : 1;
          ctx.lineCap = "round";
          for (const [a, b] of BONES) {
            ctx.beginPath();
            ctx.moveTo(px(pts[a]), py(pts[a]));
            ctx.lineTo(px(pts[b]), py(pts[b]));
            ctx.stroke();
          }
          ctx.fillStyle = "#67e8f9";
          ctx.beginPath();
          ctx.arc(px(pts[0]), py(pts[0]), meta ? 9 : scale * 0.055, 0, Math.PI * 2);
          ctx.fill();
        },
      };
    })();
  }, []);

  return (
    <main className="fixed inset-0 flex bg-[radial-gradient(circle_at_50%_30%,#1b2230,#07080b_75%)]">
      <style>{"nextjs-portal{display:none}"}</style>
      {hud.split && (
        <div className="relative w-[38%] border-r border-white/10 bg-black/60">
          {/* eslint-disable-next-line @next/next/no-img-element -- frames are swapped per captured tick */}
          {hud.footage && <img ref={photo} alt="" className="absolute inset-0 h-full w-full object-cover" />}
          <canvas ref={bones} width={730} height={1080} className="absolute inset-0 h-full w-full" />
          <div className="absolute left-6 top-6 rounded bg-black/50 px-2 font-mono text-lg uppercase tracking-[0.3em] text-cyan-300">{hud.footage ? "Player One · any video" : "Player One · pose only"}</div>
        </div>
      )}
      <div className="relative flex-1">
        <canvas ref={robot} className="h-full w-full" />
        <div className="absolute left-6 top-6 font-mono text-lg uppercase tracking-[0.3em] text-cyan-300">Player Two · Unitree G1 · MuJoCo</div>
        <div className="absolute bottom-6 left-6 font-mono text-base text-white/70">{hud.task}</div>
        <div className="absolute right-6 top-7 font-mono text-base text-white/40">{hud.source}</div>
        {hud.struck && <div className="absolute right-6 top-16 rounded-full bg-emerald-400 px-5 py-2 font-mono text-lg font-semibold tracking-widest text-black">STRIKE · ACCEPTED</div>}
      </div>
      {!hud.split && <canvas ref={bones} className="hidden" />}
    </main>
  );
}
