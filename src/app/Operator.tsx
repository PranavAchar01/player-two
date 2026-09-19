"use client";

import { useEffect, useRef, useState } from "react";
import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import { loadRig } from "@/client/load";
import { Viewer } from "@/client/viewer";
import { MAX_TICKS, pilotLandmarks, type EpisodeUpload, type Gate } from "@/sim/episode";
import { OneEuro, Operator as Retargeter, type ArmLandmarks, type Landmark } from "@/sim/retarget";
import { TICK_HZ, taskSentence, type TaskSpec } from "@/sim/scene";
import { Sim } from "@/sim/sim";

type Phase = "loading" | "ready" | "recording" | "judging" | "verdict";
type Source = "webcam" | "pilot";
interface Verdict {
  id: string;
  accepted: boolean;
  gates: Gate[];
}

const ARMS = { left: [11, 13, 15], right: [12, 14, 16] } as const;
const BONES = [[11, 13], [13, 15], [12, 14], [14, 16], [11, 12]] as const;
const TICK_MS = 1000 / TICK_HZ;

export default function OperatorPage({ firstTask }: { firstTask: TaskSpec }) {
  const simCanvas = useRef<HTMLCanvasElement>(null);
  const poseCanvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [source, setSource] = useState<Source>("pilot");
  const [task, setTask] = useState(firstTask);
  const [nickname, setNickname] = useState("");
  const [flip, setFlip] = useState(false);
  const [status, setStatus] = useState({ held: false, swing: 0, seconds: 0 });
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The render loop reads the latest UI state through this ref instead of re-subscribing.
  const live = useRef({ phase, source, task, flip, nickname });
  useEffect(() => {
    live.current = { phase, source, task, flip, nickname };
  }, [phase, source, task, flip, nickname]);
  const control = useRef<{ start: () => void; enableCamera: () => Promise<void> } | null>(null);

  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    let sim: Sim | undefined;
    let viewer: Viewer | undefined;
    let pose: PoseLandmarker | undefined;
    let onHidden: (() => void) | undefined;

    void (async () => {
      const rig = await loadRig();
      if (cancelled || !simCanvas.current) return;
      viewer = new Viewer(simCanvas.current);
      let retarget = new Retargeter(rig);
      let filters = new Map<string, OneEuro>();
      let episode: EpisodeUpload | null = null;
      let pilotT = 0;
      let successAt = -1;
      let acc = 0;
      let last = performance.now();
      let lastTick = last;
      let human: { left: ArmLandmarks | null; right: ArmLandmarks | null } = { left: null, right: null };

      const reset = (t: TaskSpec) => {
        sim?.dispose();
        sim = new Sim(rig, t);
        viewer!.setSim(sim);
        retarget = new Retargeter(rig);
        filters = new Map();
        pilotT = 0;
        successAt = -1;
      };
      reset(live.current.task);

      const finish = async () => {
        const done = episode!;
        episode = null;
        setPhase("judging");
        const res = await fetch("/api/episodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(done) });
        const body = (await res.json()) as Verdict & { coverage?: { next: TaskSpec }; error?: string };
        if (!res.ok) setError(body.error ?? "upload failed");
        else {
          setVerdict(body);
          if (body.coverage) setTask(body.coverage.next);
        }
        setPhase("verdict");
      };

      control.current = {
        start: () => {
          const { task: t, source: s, nickname: n } = live.current;
          reset(t);
          setVerdict(null);
          setError(null);
          episode = { nickname: n, task: t, source: s, ctrl: [], held: [], clamped: [], limited: [], dtMs: [], clientSuccess: false };
          setPhase("recording");
        },
        enableCamera: async () => {
          const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
          const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
          video.current!.srcObject = stream;
          await video.current!.play();
          const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
          pose = await PoseLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: "/mediapipe/pose_landmarker_lite.task", delegate: "GPU" }, runningMode: "VIDEO", numPoses: 1 });
          setSource("webcam");
        },
      };

      const smooth = (key: string, p: Landmark, dt: number): Landmark => {
        const f = (axis: "x" | "y" | "z") => {
          const k = key + axis;
          if (!filters.has(k)) filters.set(k, new OneEuro());
          return filters.get(k)!.filter(p[axis], dt);
        };
        return { x: f("x"), y: f("y"), z: f("z"), visibility: p.visibility };
      };

      const frame = (now: number) => {
        raf = requestAnimationFrame(frame);
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        const state = live.current;

        if (state.source === "webcam" && pose && video.current && video.current.readyState >= 2) {
          const out = pose.detectForVideo(video.current, now);
          const world = out.worldLandmarks[0];
          const arm = (ids: readonly number[], name: string): ArmLandmarks | null => (world ? (ids.map((i) => smooth(name + i, { ...world[i], visibility: world[i].visibility ?? 0 }, dt || 0.016)) as ArmLandmarks) : null);
          human = { left: arm(ARMS.left, "l"), right: arm(ARMS.right, "r") };
          drawSkeleton(poseCanvas.current, out.landmarks[0]);
        }

        acc += dt * 1000;
        let held = false;
        let swing = 0;
        while (acc >= TICK_MS && sim) {
          acc -= TICK_MS;
          if (state.source === "pilot") {
            const arm = state.phase === "recording" ? pilotLandmarks(state.task, (pilotT += 1 / TICK_HZ)) : null;
            human = state.task.side === "left" ? { left: null, right: arm } : { left: arm, right: null };
          }
          const out = retarget.step(human, state.flip);
          const info = sim.tick(out.ctrl);
          held = out.held;
          swing = info.bobSwing;
          if (episode) {
            episode.ctrl.push(out.ctrl);
            episode.held.push(out.held);
            episode.clamped.push(out.clamped);
            episode.limited.push(out.limited);
            episode.dtMs.push(now - lastTick);
            episode.clientSuccess = info.success;
            if (info.success && successAt < 0) successAt = episode.ctrl.length;
            if ((successAt > 0 && episode.ctrl.length - successAt > 30) || episode.ctrl.length >= MAX_TICKS) void finish();
          }
          lastTick = now;
        }
        viewer!.render(held && state.source === "webcam");
        setStatus((s) => (s.held === held && Math.abs(s.swing - swing) < 0.005 && !episode ? s : { held, swing, seconds: episode ? episode.ctrl.length / TICK_HZ : 0 }));
      };
      raf = requestAnimationFrame(frame);
      // A hidden tab stops animating, which would stall a recording. Discard it instead.
      onHidden = () => {
        if (document.visibilityState === "hidden" && episode) {
          episode = null;
          setError("Recording discarded because the tab was hidden. Keep this tab in front while you record.");
          setPhase("ready");
        }
      };
      document.addEventListener("visibilitychange", onHidden);
      setPhase("ready");
    })().catch((e: unknown) => setError(e instanceof Error ? e.message : "failed to start the simulator"));

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (onHidden) document.removeEventListener("visibilitychange", onHidden);
      sim?.dispose();
      viewer?.dispose();
      pose?.close();
    };
  }, []);

  const busy = phase === "loading" || phase === "recording" || phase === "judging";
  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-4 py-8 lg:grid-cols-[1.4fr_1fr]">
      <section>
        <div className="font-mono text-xs uppercase tracking-[0.4em] text-cyan-300">Player Two</div>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">You are Player One. Move, and the robot learns.</h1>
        <div className="relative mt-4 aspect-[4/3] overflow-hidden rounded-2xl border border-white/10 bg-[radial-gradient(circle_at_50%_30%,#1b2230,#07080b_75%)]">
          <canvas ref={simCanvas} className="h-full w-full" />
          <div className="absolute left-3 top-3 rounded-full bg-black/60 px-3 py-1 font-mono text-[11px] text-white/80">{taskSentence(task)}</div>
          {status.held && source === "webcam" && <div className="absolute inset-x-0 bottom-3 mx-auto w-fit rounded-full bg-rose-600/90 px-3 py-1 text-xs">Tracking confidence low: robot holding position</div>}
          {phase === "recording" && <div className="absolute right-3 top-3 rounded-full bg-rose-600 px-3 py-1 font-mono text-[11px]">REC {status.seconds.toFixed(1)}s</div>}
        </div>
      </section>

      <aside className="space-y-4">
        <div className="relative aspect-[4/3] overflow-hidden rounded-xl border border-white/10 bg-black">
          <video ref={video} className="hidden" playsInline muted />
          <canvas ref={poseCanvas} width={640} height={480} className="h-full w-full -scale-x-100" />
          {source === "pilot" && <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-white/40">Skeleton only. Your video never leaves this tab, and only joint angles are uploaded.</div>}
        </div>
        <div className="flex gap-2">
          <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={24} placeholder="Nickname" className="min-w-0 flex-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-300/70" />
          <button type="button" disabled={busy || source === "webcam"} onClick={() => control.current?.enableCamera().catch((e: unknown) => setError(e instanceof Error ? e.message : "camera unavailable"))} className="rounded-lg border border-white/15 px-3 py-2 text-sm disabled:opacity-40">
            {source === "webcam" ? "Camera on" : "Use webcam"}
          </button>
        </div>
        <button type="button" disabled={busy} onClick={() => control.current?.start()} className="w-full rounded-lg bg-cyan-300 px-4 py-3 font-medium text-black disabled:opacity-40">
          {phase === "recording" ? "Recording…" : phase === "judging" ? "Server is replaying your episode…" : source === "webcam" ? "Record a demonstration" : "Fly the scripted pilot"}
        </button>
        <label className="flex items-center gap-2 text-xs text-white/50">
          <input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} /> Arms cross over? Flip left and right
        </label>
        {error && <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p>}
        {verdict && (
          <div className={`rounded-xl border p-3 ${verdict.accepted ? "border-emerald-400/40 bg-emerald-400/5" : "border-rose-500/40 bg-rose-500/5"}`}>
            <div className={`font-semibold tracking-widest ${verdict.accepted ? "text-emerald-300" : "text-rose-300"}`}>{verdict.accepted ? "ACCEPTED INTO DATASET" : "REJECTED"}</div>
            <table className="mt-2 w-full font-mono text-[11px]">
              <tbody>
                {verdict.gates.map((g) => (
                  <tr key={g.id} className="border-t border-white/5">
                    <td className="py-1 pr-2 text-white/60">{g.label}</td>
                    <td className={`py-1 pr-2 ${g.pass ? "text-emerald-300" : "text-rose-300"}`}>{g.measured}</td>
                    <td className="py-1 text-white/35">{g.required}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </aside>
    </main>
  );
}

function drawSkeleton(canvas: HTMLCanvasElement | null, lm: { x: number; y: number }[] | undefined) {
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!lm) return;
  ctx.strokeStyle = "#67e8f9";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  for (const [a, b] of BONES) {
    ctx.beginPath();
    ctx.moveTo(lm[a].x * canvas.width, lm[a].y * canvas.height);
    ctx.lineTo(lm[b].x * canvas.width, lm[b].y * canvas.height);
    ctx.stroke();
  }
}
