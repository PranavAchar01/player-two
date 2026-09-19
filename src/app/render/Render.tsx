"use client";

import { useEffect, useRef, useState } from "react";
import { loadRig } from "@/client/load";
import { Viewer } from "@/client/viewer";
import { taskSentence, type TaskSpec } from "@/sim/scene";
import { Sim } from "@/sim/sim";

interface Demo {
  source?: string;
  task: TaskSpec;
  ctrl: number[][];
  skeleton?: (number[][] | null)[];
}

const PRE = 30; // ticks of rest before the motion
const POST = 90; // ticks after it, to watch the pendulum swing
const BONES = [[1, 3], [3, 5], [2, 4], [4, 6], [1, 2], [1, 7], [2, 8], [7, 8]];

declare global {
  interface Window {
    p2?: { ticks: number; frame: (n: number) => void };
  }
}

/** Deterministic frame-by-frame renderer for video capture: /render?demo=<name>&mode=robot|split */
export default function Render() {
  const robot = useRef<HTMLCanvasElement>(null);
  const bones = useRef<HTMLCanvasElement>(null);
  const [hud, setHud] = useState({ task: "", source: "", split: false, struck: false });

  useEffect(() => {
    void (async () => {
      const q = new URLSearchParams(window.location.search);
      const split = q.get("mode") === "split";
      const demo = (await (await fetch(`/demos/${q.get("demo")}.json`)).json()) as Demo;
      const rig = await loadRig();
      const viewer = new Viewer(robot.current!);
      const side = demo.task.side === "left" ? 1 : -1;
      viewer.setCamera([1.95, 0.5 * side, 1.22], [0, 0.16 * side, 1.04]);
      const rest = [...rig.rest.left, ...rig.rest.right];
      let sim = new Sim(rig, demo.task);
      viewer.setSim(sim);
      let at = 0;
      setHud({ task: taskSentence(demo.task), source: demo.source ? "motion source: online video, pose only" : "motion source: scripted pilot", split, struck: false });
      const total = PRE + demo.ctrl.length + POST;
      const ctrlAt = (n: number) => (n < PRE ? rest : demo.ctrl[Math.min(demo.ctrl.length - 1, n - PRE)]);
      window.p2 = {
        ticks: total,
        frame: (n: number) => {
          if (n < at) {
            sim = new Sim(rig, demo.task);
            viewer.setSim(sim);
            at = 0;
          }
          let struck = false;
          for (; at <= n; at++) struck = sim.tick(ctrlAt(at)).success;
          viewer.render();
          setHud((h) => (h.struck === struck ? h : { ...h, struck }));
          const c = bones.current;
          const ctx = c?.getContext("2d");
          if (!c || !ctx) return;
          ctx.clearRect(0, 0, c.width, c.height);
          const pts = demo.skeleton?.[Math.min(demo.skeleton.length - 1, Math.max(0, n - PRE))];
          if (!pts) return;
          ctx.strokeStyle = "#67e8f9";
          ctx.lineWidth = 10;
          ctx.lineCap = "round";
          for (const [a, b] of BONES) {
            ctx.beginPath();
            ctx.moveTo((1 - pts[a][0]) * c.width, pts[a][1] * c.height);
            ctx.lineTo((1 - pts[b][0]) * c.width, pts[b][1] * c.height);
            ctx.stroke();
          }
          ctx.fillStyle = "#67e8f9";
          ctx.beginPath();
          ctx.arc((1 - pts[0][0]) * c.width, pts[0][1] * c.height, 26, 0, Math.PI * 2);
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
          <canvas ref={bones} width={720} height={960} className="h-full w-full object-contain" />
          <div className="absolute left-6 top-6 font-mono text-lg uppercase tracking-[0.3em] text-cyan-300">Player One · pose only</div>
        </div>
      )}
      <div className="relative flex-1">
        <canvas ref={robot} className="h-full w-full" />
        <div className="absolute left-6 top-6 font-mono text-lg uppercase tracking-[0.3em] text-cyan-300">Player Two · Unitree G1 · MuJoCo</div>
        <div className="absolute bottom-6 left-6 font-mono text-base text-white/70">{hud.task}</div>
        <div className="absolute bottom-6 right-6 font-mono text-base text-white/40">{hud.source}</div>
        {hud.struck && <div className="absolute right-6 top-6 rounded-full bg-emerald-400 px-5 py-2 font-mono text-lg font-semibold tracking-widest text-black">STRIKE · ACCEPTED</div>}
      </div>
      {!hud.split && <canvas ref={bones} className="hidden" />}
    </main>
  );
}
