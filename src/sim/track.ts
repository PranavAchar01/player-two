/**
 * Pose tracks of pre-recorded video, prepared for retargeting. Because the whole clip is known in advance,
 * this path can do what live teleoperation cannot: smooth with zero phase delay, interpolate between video
 * frames up to the 50 Hz control rate, and measure the robot's tracking lag so it can be commanded ahead.
 * Shared by every embodiment: the G1 full-body mirror and the fixed-base arms.
 */
import type { Landmark } from "./retarget";
import type { Vec3 } from "./scene";

export interface TrackFrame {
  t: number;
  /** MediaPipe world landmarks by id: [x, y, z, visibility] */
  world: Record<string, number[]> | null;
  /** normalised picture coordinates by id: [x, y] */
  image: Record<string, number[]> | null;
}
export interface Track {
  fps: number;
  width: number;
  height: number;
  frames: TrackFrame[];
}

const KERNEL = [0.06, 0.24, 0.4, 0.24, 0.06];

/** Zero-phase smoothing over the whole clip: hold through gaps, then a centred Gaussian. */
export function smoothSeries(frames: TrackFrame[], get: (f: TrackFrame) => number | null): number[] {
  const n = frames.length;
  const raw: number[] = [];
  let last = 0;
  for (const f of frames) raw.push((last = get(f) ?? last));
  return raw.map((_, i) => KERNEL.reduce((s, w, j) => s + w * raw[Math.min(n - 1, Math.max(0, i + j - 2))], 0));
}

/** Zero-phase Gaussian of any width, for channels that need more than the landmark smoothing (single-camera depth). */
export function smoothWide(series: number[], sigma: number): number[] {
  const r = Math.ceil(sigma * 3);
  const k = Array.from({ length: 2 * r + 1 }, (_, j) => Math.exp(-((j - r) ** 2) / (2 * sigma * sigma)));
  const sum = k.reduce((a, b) => a + b, 0);
  const n = series.length;
  return series.map((_, i) => k.reduce((s, w, j) => s + w * series[Math.min(n - 1, Math.max(0, i + j - r))], 0) / sum);
}

/** A track smoothed once, then sampled at any fractional frame position. */
export class SmoothTrack {
  readonly n: number;
  readonly fps: number;
  readonly aspect: number;
  /** per landmark id: x, y, z series (smoothed) and the raw visibility series */
  readonly world: Record<string, number[][]> = {};
  /** per landmark id: x, y series in picture coordinates (smoothed) */
  readonly image: Record<string, number[][]> = {};
  private readonly present = new Set<string>();

  constructor(readonly track: Track, ids: string[]) {
    this.n = track.frames.length;
    this.fps = track.fps;
    this.aspect = track.width / track.height;
    for (const key of ids) {
      this.world[key] = [0, 1, 2].map((c) => smoothSeries(track.frames, (f) => f.world?.[key]?.[c] ?? null));
      this.world[key].push(track.frames.map((f) => f.world?.[key]?.[3] ?? 0));
      this.image[key] = [0, 1].map((c) => smoothSeries(track.frames, (f) => f.image?.[key]?.[c] ?? null));
      if (track.frames.some((f) => f.world?.[key])) this.present.add(key);
    }
  }

  /** False for landmarks the track was never extracted with (older tracks lack the hand points 17-22). */
  has(key: string) {
    return this.present.has(key);
  }

  /** 24 or 30 fps video to the 50 Hz control rate: linear interpolation between smoothed frames. */
  lerp(series: number[], fpos: number): number {
    const i = Math.min(this.n - 2, Math.max(0, Math.floor(fpos)));
    const u = Math.min(1, Math.max(0, fpos - i));
    return series[i] * (1 - u) + series[i + 1] * u;
  }

  lm(key: string, fpos: number): Landmark {
    const w = this.world[key];
    return { x: this.lerp(w[0], fpos), y: this.lerp(w[1], fpos), z: this.lerp(w[2], fpos), visibility: this.lerp(w[3], fpos) };
  }

  /** Picture-plane length a segment shows at its longest (a quantile, to ignore outliers): its true length. */
  fullLength(a: string, b: string, quantile = 0.9, fallback = 0.4): number {
    const seen = this.track.frames.map((_, i) => Math.hypot(this.world[b][0][i] - this.world[a][0][i], this.world[b][1][i] - this.world[a][1][i])).sort((x, y) => x - y);
    return seen[Math.floor(seen.length * quantile)] || fallback;
  }

  /** Landmarks the camera cannot see are left out of the drawn skeleton rather than guessed. */
  skeleton(ids: string[], fpos: number): (number[] | null)[] {
    return ids.map((k) => (this.lerp(this.world[k][3], fpos) < 0.5 ? null : [this.lerp(this.image[k][0], fpos), this.lerp(this.image[k][1], fpos)]));
  }
}

/** Start of the `win`-frame window with the highest summed score (first one wins a tie). */
export function pickWindow(score: number[], win: number): { start: number; score: number } {
  let best = 0, bestScore = -Infinity, run = score.slice(0, win).reduce((a, b) => a + b, 0);
  for (let i = 0; i + win < score.length; i++) {
    if (run > bestScore) {
      bestScore = run;
      best = i;
    }
    run += score[i + win] - score[i];
  }
  return { start: best, score: bestScore };
}

/**
 * A limb segment as a robot-frame vector (x toward the camera, y mirrored, z up), with depth from foreshortening.
 * Single-camera pose models guess depth badly, but a segment seen at full length must lie in the picture plane,
 * and only a visibly shortened one points toward or away from the camera. The model's z only supplies the sign.
 * Continuous: exactly zero at 93% of full length and growing smoothly below it, so a small change in apparent
 * length can never snap a joint from straight to bent.
 */
export function limb(from: Landmark, to: Landmark, full: number): Vec3 {
  const dx = to.x - from.x, dy = to.y - from.y;
  const planar = Math.hypot(dx, dy);
  const ratio = Math.min(1, planar / (0.93 * full));
  const depth = Math.sign(to.z - from.z) * full * Math.sqrt(1 - ratio * ratio);
  return { x: -depth, y: -dx, z: -dy };
}

/** How many ticks the achieved joints trail the commanded ones: the shift with the least squared error. */
export function lagOf(cmd: number[][], got: number[][], joints = cmd[0]?.length ?? 0, maxLag = 20): number {
  let bestL = 0, bestErr = Infinity;
  for (let L = 0; L <= maxLag; L++) {
    let err = 0, c = 0;
    for (let t = 0; t + L < cmd.length; t++) for (let j = 0; j < joints; j++) {
      err += (cmd[t][j] - got[t + L][j]) ** 2;
      c++;
    }
    if (err / c < bestErr) {
      bestErr = err / c;
      bestL = L;
    }
  }
  return bestL;
}
