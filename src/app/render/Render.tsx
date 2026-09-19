"use client";

import { useEffect, useRef, useState } from "react";
import { loadArm, loadRig } from "@/client/load";
import { Viewer, type Drawable } from "@/client/viewer";
import { ArmSim, isArmRobot, type ArmRobot } from "@/sim/arm";
import type { ArmStats } from "@/sim/armRetarget";
import { taskSentence, type TaskSpec } from "@/sim/scene";
import { Sim, type BodyCommand } from "@/sim/sim";

interface Demo {
  /** which embodiment the controls are for; demos recorded before the arms existed are all G1 */
  robot?: "g1" | ArmRobot;
  source?: string;
  task: TaskSpec | null;
  ctrl: number[][];
  body?: BodyCommand[];
  /** arm demos: where the human wrist maps to, per tick (drawn as a marker) */
  target?: number[][];
  stats?: Partial<ArmStats> & { tracked?: number; limited?: number };
  skeleton?: ((number[] | null)[] | null)[];
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

const TASK_PRE = 30; // ticks of rest before a task episode
const TASK_POST = 90; // ticks after it, to watch the pendulum swing
const WARMUP = 50; // unseen ticks that bring a mirror clip into its first pose before frame 0
const BONES = [[1, 3], [3, 5], [2, 4], [4, 6], [1, 2], [1, 7], [2, 8], [7, 8]];
/** the first two bones are the person's left arm, the next two the right */
const ARM_BONES = { left: [0, 1], right: [2, 3] };

/** One embodiment being replayed: `reset` rewinds to before tick 0, `tick` advances one control tick. */
interface Player {
  reset(): Drawable;
  tick(n: number): boolean;
}

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
  const [hud, setHud] = useState({ robot: "", task: "", source: "", split: false, struck: false, footage: false });

  useEffect(() => {
    void (async () => {
      const q = new URLSearchParams(window.location.search);
      const footage = q.get("mode") === "source";
      const split = footage || q.get("mode") === "split";
      const name = q.get("demo");
      const demo = (await (await fetch(`/demos/${name}.json`)).json()) as Demo;
      const meta = footage ? ((await (await fetch(`/demos/${name}-frames/meta.json`)).json()) as FramesMeta) : null;
      const viewer = new Viewer(robot.current!);
      // Fit the whole episode's skeleton to the panel once, so it neither jitters in scale nor sits tiny in a corner.
      const aspect = demo.aspect ?? 16 / 9;
      const all = (demo.skeleton ?? []).flatMap((f) => f ?? []).filter((p): p is number[] => p !== null);
      const xs = all.map((p) => (1 - p[0]) * aspect), ys = all.map((p) => p[1]);
      const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
      // a mirror clip follows the footage exactly, so it has no padding: the robot is warmed up off screen instead
      const PRE = demo.task ? TASK_PRE : 0;
      const POST = demo.task ? TASK_POST : 0;
      const last = demo.ctrl.length - 1;

      let player: Player;
      let label: string;
      let caption: string;
      if (isArmRobot(demo.robot)) {
        const arm = await loadArm(demo.robot);
        viewer.setCamera(arm.spec.camera.pos, arm.spec.camera.look);
        let sim: ArmSim;
        // an arm replay starts at rest in its first commanded pose, so it needs no warm-up
        player = {
          reset: () => (sim = new ArmSim(arm, demo.ctrl[0])),
          tick: (n) => {
            const i = Math.min(last, Math.max(0, n));
            sim.tick(demo.ctrl[i], demo.target?.[i]);
            return false;
          },
        };
        label = arm.spec.label;
        const st = demo.stats;
        caption = `Person's ${st?.armUsed ?? "?"} arm drives the gripper: wrist position, mirrored. IK p95 ${st?.ikResidualCmP95 ?? "?"} cm, speed cap ${st?.speedCapPct ?? "?"}%, lag ${st?.lagMsBefore ?? "?"} ms, ${st?.lagMsAfter ?? "?"} ms with preview.`;
      } else {
        const rig = await loadRig();
        const side = !demo.task ? 0 : demo.task.side === "left" ? 1 : -1;
        if (!demo.task) viewer.setCamera([3.3, 0, 0.95], [0, 0, 0.72]);
        else if (split) viewer.setCamera([2.35, 0.3 * side, 1.2], [0, 0.2 * side, 1.02]);
        else viewer.setCamera([1.95, 0.5 * side, 1.22], [0, 0.16 * side, 1.04]);
        const rest = [...rig.rest.left, ...rig.rest.right];
        const ctrlAt = (n: number) => (n < PRE ? rest : demo.ctrl[Math.min(last, n - PRE)]);
        const bodyAt = (n: number) => demo.body?.[Math.min(demo.body.length - 1, Math.max(0, n - PRE))];
        let sim: Sim;
        player = {
          reset: () => {
            sim = new Sim(rig, demo.task);
            if (!demo.task) for (let i = 0; i < WARMUP; i++) sim.tick(demo.ctrl[0], demo.body?.[0]);
            return sim;
          },
          tick: (n) => sim.tick(ctrlAt(n), bodyAt(n)).success,
        };
        label = "Unitree G1";
        caption = demo.task ? taskSentence(demo.task) : `Free mirror, full body, kinematic root. Arm tracking lag ${demo.stats?.lagMsBefore ?? "?"} ms, ${demo.stats?.lagMsAfter ?? "?"} ms with preview.`;
      }
      viewer.setSim(player.reset());
      let at = 0;
      setHud({ robot: label, task: caption, source: footage ? "motion source: online video, pose estimated per frame" : demo.source ? "motion source: online video, pose only" : "motion source: scripted pilot", split, struck: false, footage });
      const total = PRE + demo.ctrl.length + POST;
      const usedArm = isArmRobot(demo.robot) && demo.stats?.armUsed ? ARM_BONES[demo.stats.armUsed] : null;
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
            viewer.setSim(player.reset());
            at = 0;
          }
          let struck = false;
          for (; at <= n; at++) struck = player.tick(at);
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
          for (const [i, [a, b]] of BONES.entries()) {
            if (!pts[a] || !pts[b]) continue;
            // an arm robot follows one arm: that one is drawn in amber so the viewer knows which to watch
            ctx.strokeStyle = usedArm?.includes(i) ? "#fbbf24" : "#67e8f9";
            ctx.beginPath();
            ctx.moveTo(px(pts[a]), py(pts[a]));
            ctx.lineTo(px(pts[b]), py(pts[b]));
            ctx.stroke();
          }
          ctx.fillStyle = "#67e8f9";
          if (!pts[0]) return;
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
        <div className="absolute left-6 top-6 font-mono text-lg uppercase tracking-[0.3em] text-cyan-300">Player Two · {hud.robot} · MuJoCo</div>
        <div className="absolute bottom-6 left-6 font-mono text-base text-white/70">{hud.task}</div>
        <div className="absolute right-6 top-7 font-mono text-base text-white/40">{hud.source}</div>
        {hud.struck && <div className="absolute right-6 top-16 rounded-full bg-emerald-400 px-5 py-2 font-mono text-lg font-semibold tracking-widest text-black">STRIKE · ACCEPTED</div>}
      </div>
      {!hud.split && <canvas ref={bones} className="hidden" />}
    </main>
  );
}
