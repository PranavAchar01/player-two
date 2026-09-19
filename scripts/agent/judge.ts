// Decides from pose numbers alone whether a clip is worth retargeting. No pixels are read here, so the verdict
// is reproducible from the track file and every rejection can quote the number that caused it.
//
// The bars encode what this project already learned the hard way about single-camera footage: 3/4-angle
// lunges, silhouettes, long dresses, dark leggings far from the camera, spins and close-ups with limbs out of
// shot all retarget badly. Frontal, whole arms in shot, steady and slow retargets well.
import type { Arm, Check, FootageMetrics, MotionSignature, Verdict } from "./types";

export interface TrackFrame {
  t: number;
  world: Record<string, number[]> | null;
  image: Record<string, number[]> | null;
}
export interface Track {
  fps: number;
  width: number;
  height: number;
  frames: TrackFrame[];
}

export const BARS = {
  minSeconds: 3,
  trackedPctClip: 50,
  trackedPctWindow: 90,
  armVisibility: 0.7,
  personHeightFrac: 0.3,
  limbsInFramePct: 90,
  frontalDeg: 35,
  facingCameraPct: 95,
  sidewaysFrac: 0.7,
  forwardFrac: 0.5,
  armExcursionM: 0.2,
  jumps: 0,
} as const;

const L = { shoulder: "11", elbow: "13", wrist: "15", hip: "23" };
const R = { shoulder: "12", elbow: "14", wrist: "16", hip: "24" };
// Landmark ids 17-22 (hands) may or may not be present depending on the extractor version. Only these are needed.
const NEEDED = ["11", "12", "13", "14", "15", "16", "23", "24"];

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mid = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const angleDeg = (a: V3, b: V3) => {
  const d = norm(a) * norm(b);
  return d < 1e-9 ? 0 : (Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / d))) * 180) / Math.PI;
};
const quantile = (values: number[], q: number) => {
  if (values.length === 0) return 0;
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const round = (v: number, d = 1) => +v.toFixed(d);

const isTracked = (f: TrackFrame) => !!f.world && !!f.image && NEEDED.every((k) => Array.isArray(f.world![k]) && f.world![k].length >= 4 && Array.isArray(f.image![k]) && f.image![k].length >= 2);

/** Counts swings between turning points that are at least `amplitude` apart. One up-and-down is two swings. */
export function countSwings(series: number[], amplitude: number): number {
  if (series.length < 2 || amplitude <= 0) return 0;
  let hi = series[0], lo = series[0], dir = 0, swings = 0;
  for (const v of series) {
    if (dir === 0) {
      // direction unknown yet: wait until the series has covered one full amplitude either way
      hi = Math.max(hi, v); lo = Math.min(lo, v);
      if (hi - lo >= amplitude) { swings++; dir = v === hi ? 1 : -1; hi = lo = v; }
    } else if (dir === 1) {
      if (v > hi) hi = v;
      else if (hi - v >= amplitude) { swings++; dir = -1; lo = v; }
    } else if (v < lo) lo = v;
    else if (v - lo >= amplitude) { swings++; dir = 1; hi = v; }
  }
  return swings;
}

/** Counts separate excursions above `threshold`. Must fall 15 below it before the next one can count. */
export function countPeaks(series: number[], threshold: number): number {
  let armed = true;
  let peaks = 0;
  for (const v of series) {
    if (armed && v >= threshold) { peaks++; armed = false; }
    else if (!armed && v < threshold - 15) armed = true;
  }
  return peaks;
}

export function parseTrack(raw: unknown): Track | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Partial<Track>;
  if (typeof t.fps !== "number" || !(t.fps > 0) || typeof t.width !== "number" || typeof t.height !== "number" || !(t.height > 0) || !Array.isArray(t.frames)) return null;
  return t as Track;
}

export function judgeFootage(track: Track, plan: { arm: Arm; signature: MotionSignature }, seconds: number, startS: number | null = null): Verdict {
  const n = track.frames.length;
  const fps = track.fps;
  const aspect = track.width / track.height;
  const durationS = n / fps;
  const trackedFlags = track.frames.map(isTracked);
  const trackedPctClip = n ? (trackedFlags.filter(Boolean).length / n) * 100 : 0;

  if (n < 3 || durationS < BARS.minSeconds) {
    const reason = `clip is ${round(durationS)} s long, need at least ${BARS.minSeconds} s`;
    return { pinnedStartS: null, windowNote: null, accepted: false, score: 0, reasons: [reason], checks: [{ name: "length", pass: false, detail: reason }], metrics: null };
  }

  // ---- the same smoothing and "most arm-active window" rule as scripts/mirror.mts, so the stretch judged
  // here is the stretch the retargeter will pick when it is told `--start auto`.
  const smooth = (get: (f: TrackFrame) => number | null) => {
    const held: number[] = [];
    let last = 0;
    for (const f of track.frames) held.push((last = get(f) ?? last));
    const k = [0.06, 0.24, 0.4, 0.24, 0.06];
    return held.map((_, i) => k.reduce((s, w, j) => s + w * held[Math.min(n - 1, Math.max(0, i + j - 2))], 0));
  };
  const world = (key: string, c: number) => smooth((f) => f.world?.[key]?.[c] ?? null);
  const W: Record<string, number[][]> = {};
  for (const key of NEEDED) W[key] = [world(key, 0), world(key, 1), world(key, 2)];
  const vis = (key: string, i: number) => track.frames[i].world?.[key]?.[3] ?? 0;
  const p = (key: string, i: number): V3 => [W[key][0][i], W[key][1][i], W[key][2][i]];

  const win = Math.max(1, Math.min(n - 2, Math.round(seconds * fps)));
  const travel = track.frames.map((_, i) => (i === 0 ? 0 : [L.wrist, R.wrist].reduce((s, k) => s + Math.hypot(W[k][0][i] - W[k][0][i - 1], W[k][1][i] - W[k][1][i - 1]), 0) * Math.min(vis(L.wrist, i), vis(R.wrist, i))));
  let best = 0, bestScore = -Infinity, run = travel.slice(0, win).reduce((a, b) => a + b, 0);
  for (let i = 0; i + win < n; i++) { if (run > bestScore) { bestScore = run; best = i; } run += travel[i + win] - travel[i]; }
  if (startS !== null) best = Math.min(Math.max(0, n - 2 - win), Math.max(0, Math.round(startS * fps))); // a pinned window, same clamp as mirror.mts
  const idx = Array.from({ length: win }, (_, j) => best + j).filter((i) => trackedFlags[i]);
  const trackedPctWindow = (idx.length / win) * 100;

  if (idx.length < 5) {
    const reason = `no person tracked in the most active ${round(win / fps)} s (${round(trackedPctWindow)}% of frames, ${round(trackedPctClip)}% over the whole clip)`;
    return { pinnedStartS: startS, windowNote: null, accepted: false, score: 0, reasons: [reason], checks: [{ name: "tracked frames", pass: false, detail: reason }], metrics: null };
  }

  // ---- per-arm numbers
  const armStats = (a: typeof L) => {
    const visibility = mean(idx.map((i) => (vis(a.shoulder, i) + vis(a.elbow, i) + vis(a.wrist, i)) / 3));
    const rel = idx.map((i) => sub(p(a.wrist, i), p(a.shoulder, i)));
    const range = (c: number) => quantile(rel.map((v) => v[c]), 0.95) - quantile(rel.map((v) => v[c]), 0.05);
    const excursion = Math.hypot(range(0), range(1)); // depth is the noisy axis from one camera, so it does not count as motion
    const inFrame = (idx.filter((i) => [a.elbow, a.wrist].every((k) => { const [x, y] = track.frames[i].image![k]; return x > -0.02 && x < 1.02 && y > -0.02 && y < 1.02; })).length / idx.length) * 100;
    const torsoDown = (i: number) => sub(mid(p(L.hip, i), p(R.hip, i)), mid(p(L.shoulder, i), p(R.shoulder, i)));
    const elevation = idx.map((i) => angleDeg(sub(p(a.elbow, i), p(a.shoulder, i)), torsoDown(i)));
    // how much of the upper arm's horizontal reach is sideways (camera plane) rather than toward the camera
    const lateral = idx.map((i) => { const u = sub(p(a.elbow, i), p(a.shoulder, i)); const h = Math.hypot(u[0], u[2]); return h < 1e-6 ? 1 : Math.abs(u[0]) / h; });
    const flexion = idx.map((i) => angleDeg(sub(p(a.shoulder, i), p(a.elbow, i)), sub(p(a.wrist, i), p(a.elbow, i))));
    // wrist path along its own main direction in the picture plane, in centimetres
    const mx = mean(rel.map((v) => v[0])), my = mean(rel.map((v) => v[1]));
    let sxx = 0, sxy = 0, syy = 0;
    for (const v of rel) { sxx += (v[0] - mx) ** 2; sxy += (v[0] - mx) * (v[1] - my); syy += (v[1] - my) ** 2; }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const along = rel.map((v) => ((v[0] - mx) * Math.cos(theta) + (v[1] - my) * Math.sin(theta)) * 100);
    return { visibility, excursion, inFrame, elevation, lateral, flexion, along };
  };
  const stats = { left: armStats(L), right: armStats(R) };

  const signatureOf = (s: (typeof stats)["left"]): { count: number; peak: number; lateral: number | null } => {
    const sig = plan.signature;
    if (sig.kind === "arm_elevation") {
      // direction is read where the arm is highest: that is where a side raise and a front raise differ most
      const bar = Math.min(sig.threshold, quantile(s.elevation, 0.85));
      return { count: countPeaks(s.elevation, sig.threshold), peak: Math.max(...s.elevation), lateral: quantile(s.lateral.filter((_, j) => s.elevation[j] >= bar), 0.5) };
    }
    if (sig.kind === "elbow_flexion") return { count: countSwings(s.flexion, sig.threshold), peak: quantile(s.flexion, 0.98) - quantile(s.flexion, 0.02), lateral: null };
    return { count: countSwings(s.along, sig.threshold), peak: quantile(s.along, 0.98) - quantile(s.along, 0.02), lateral: null };
  };
  const sigL = signatureOf(stats.left), sigR = signatureOf(stats.right);

  const direction = plan.signature.kind === "arm_elevation" ? plan.signature.direction ?? "any" : "any";
  const directionOk = (lateral: number | null) => direction === "any" || lateral === null || (direction === "sideways" ? lateral >= BARS.sidewaysFrac : lateral <= BARS.forwardFrac);

  // "either" means one good arm is enough, which is all a single-arm robot can use. The arm is chosen by how many of
  // the per-arm bars it clears, not by which one moves more: in a two-armed video the busier arm is often the one
  // that swings out of shot or sits in shadow, and picking it would reject footage whose other arm is clean.
  // Only a tie falls back to "moves more and is actually seen".
  const cleared = (s: (typeof stats)["left"], g: typeof sigL) => [s.visibility >= BARS.armVisibility, s.excursion >= BARS.armExcursionM, s.inFrame >= BARS.limbsInFramePct, g.count >= plan.signature.minCount, directionOk(g.lateral)].filter(Boolean).length;
  const better = (): "left" | "right" => {
    const l = cleared(stats.left, sigL), r = cleared(stats.right, sigR);
    if (l !== r) return l > r ? "left" : "right";
    return stats.left.excursion * stats.left.visibility >= stats.right.excursion * stats.right.visibility ? "left" : "right";
  };
  const armUsed: "left" | "right" | "both" = plan.arm === "both" ? "both" : plan.arm === "left" || plan.arm === "right" ? plan.arm : better();
  const pick = <T,>(l: T, r: T, worst: (a: T, b: T) => T): T => (armUsed === "both" ? worst(l, r) : armUsed === "left" ? l : r);
  const armVisibility = pick(stats.left.visibility, stats.right.visibility, Math.min);
  const armExcursionM = pick(stats.left.excursion, stats.right.excursion, Math.min);
  const limbsInFramePct = pick(stats.left.inFrame, stats.right.inFrame, Math.min);
  const signature = pick(sigL, sigR, (a, b) => (a.count <= b.count ? a : b));
  // with two arms the one further from the wanted direction decides
  const lateralFrac = sigL.lateral === null || sigR.lateral === null ? null : pick(sigL.lateral, sigR.lateral, direction === "forward" ? Math.max : Math.min);

  // ---- whole-person numbers
  const img = (key: string, i: number) => track.frames[i].image![key];
  const torsoLen = (i: number) => {
    const sx = (img("11", i)[0] + img("12", i)[0]) / 2, sy = (img("11", i)[1] + img("12", i)[1]) / 2;
    const hx = (img("23", i)[0] + img("24", i)[0]) / 2, hy = (img("23", i)[1] + img("24", i)[1]) / 2;
    return Math.hypot((sx - hx) * aspect, sy - hy);
  };
  // Shoulder to hip is about 0.29 of standing height. Using the torso keeps this meaningful when legs are out of shot.
  const personHeightFrac = Math.min(3, quantile(idx.map(torsoLen), 0.5) * 3.4);
  const frontalDeg = quantile(idx.map((i) => { const s = sub(p("11", i), p("12", i)); return (Math.atan2(Math.abs(s[2]), Math.abs(s[0])) * 180) / Math.PI; }), 0.5);
  // A person facing the camera has their left shoulder on the right of the picture.
  const facingCameraPct = (idx.filter((i) => img("11", i)[0] > img("12", i)[0]).length / idx.length) * 100;

  // A cut or a second person shows up as the hips teleporting or the body changing size between frames.
  let jumps = 0;
  for (let j = 1; j < idx.length; j++) {
    const a = idx[j - 1], b = idx[j];
    const gap = Math.min(5, b - a);
    const hip = (i: number) => [((img("23", i)[0] + img("24", i)[0]) / 2) * aspect, (img("23", i)[1] + img("24", i)[1]) / 2];
    const moved = Math.hypot(hip(b)[0] - hip(a)[0], hip(b)[1] - hip(a)[1]);
    const ta = Math.max(1e-4, torsoLen(a)), tb = Math.max(1e-4, torsoLen(b));
    // A cut from a front view to a back view keeps place and size but swaps the shoulders within one frame.
    const sa = (img("11", a)[0] - img("12", a)[0]) * aspect, sb = (img("11", b)[0] - img("12", b)[0]) * aspect;
    const flipped = sa * sb < 0 && Math.min(Math.abs(sa), Math.abs(sb)) > 0.25 * Math.min(ta, tb);
    if (moved > 0.5 * ta * gap || Math.max(ta / tb, tb / ta) > 1.4 || flipped) jumps++;
  }

  const metrics: FootageMetrics = {
    frames: n, fps: round(fps, 3), durationS: round(durationS, 2), windowStartS: round(best / fps, 2), windowS: round(win / fps, 2),
    trackedPctClip: round(trackedPctClip), trackedPctWindow: round(trackedPctWindow), armVisibility: round(armVisibility, 3),
    personHeightFrac: round(personHeightFrac, 3), limbsInFramePct: round(limbsInFramePct), frontalDeg: round(frontalDeg), facingCameraPct: round(facingCameraPct),
    armExcursionM: round(armExcursionM, 3), jumps, signatureCount: signature.count, signaturePeak: round(signature.peak), lateralFrac: lateralFrac === null ? null : round(lateralFrac, 2), armUsed,
  };

  const sig = plan.signature;
  const unit = sig.kind === "wrist_oscillation" ? "cm" : "deg";
  const sigLabel = sig.kind === "arm_elevation" ? `arm raised past ${sig.threshold} deg` : sig.kind === "elbow_flexion" ? `elbow swings of ${sig.threshold} deg or more` : `wrist swings of ${sig.threshold} cm or more`;
  const checks: Check[] = [
    { name: "tracked frames (window)", pass: trackedPctWindow >= BARS.trackedPctWindow, detail: `${metrics.trackedPctWindow}% of frames tracked in the judged window, need ${BARS.trackedPctWindow}%` },
    { name: "tracked frames (clip)", pass: trackedPctClip >= BARS.trackedPctClip, detail: `${metrics.trackedPctClip}% of the whole clip tracked, need ${BARS.trackedPctClip}%` },
    { name: "arm visibility", pass: armVisibility >= BARS.armVisibility, detail: `mean ${armUsed} arm landmark visibility ${metrics.armVisibility}, need ${BARS.armVisibility}` },
    { name: "person size", pass: personHeightFrac >= BARS.personHeightFrac, detail: `person is about ${round(personHeightFrac * 100)}% of frame height, need ${BARS.personHeightFrac * 100}%` },
    { name: "limbs in frame", pass: limbsInFramePct >= BARS.limbsInFramePct, detail: `elbow and wrist inside the picture in ${metrics.limbsInFramePct}% of frames, need ${BARS.limbsInFramePct}%` },
    { name: "frontal view", pass: frontalDeg <= BARS.frontalDeg, detail: `shoulders turned ${metrics.frontalDeg} deg from the camera plane, limit ${BARS.frontalDeg} deg` },
    { name: "facing camera", pass: facingCameraPct >= BARS.facingCameraPct, detail: `facing the camera in ${metrics.facingCameraPct}% of frames, need ${BARS.facingCameraPct}%` },
    { name: "arm motion", pass: armExcursionM >= BARS.armExcursionM, detail: `wrist moved over ${round(armExcursionM * 100)} cm, need ${BARS.armExcursionM * 100} cm` },
    { name: "one continuous person", pass: jumps <= BARS.jumps, detail: `${jumps} sudden jump${jumps === 1 ? "" : "s"} in position or size (cut or second person), limit ${BARS.jumps}` },
    { name: "motion signature", pass: signature.count >= sig.minCount, detail: `${sigLabel}: seen ${signature.count} time${signature.count === 1 ? "" : "s"} (peak ${metrics.signaturePeak} ${unit}), need ${sig.minCount}` },
  ];

  if (direction !== "any" && lateralFrac !== null) {
    checks.push({ name: "motion direction", pass: directionOk(lateralFrac), detail: `raised arm points ${round(lateralFrac * 100)}% sideways, ${direction === "sideways" ? `need ${BARS.sidewaysFrac * 100}% or more for a raise out to the side (less looks like a front raise)` : `need ${BARS.forwardFrac * 100}% or less for a raise toward the camera`}` });
  }

  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const parts = [trackedPctWindow / 100, armVisibility, clamp01(1 - frontalDeg / 60), clamp01(personHeightFrac / 0.6), limbsInFramePct / 100];
  const score = round(mean(parts.map(clamp01)) * (signature.count >= sig.minCount ? 1 : 0.5), 3);
  const failed = checks.filter((c) => !c.pass);
  return { pinnedStartS: startS, windowNote: null, accepted: failed.length === 0, score, reasons: failed.map((c) => `${c.name}: ${c.detail}`), checks, metrics };
}

/**
 * Judges the window the retargeter would pick by itself. If that one fails (a cut in the busiest stretch is the
 * usual cause) every whole-second window is tried, and the best passing one is pinned. The failed first verdict
 * is kept in the note, so the trace shows why the clip was not used as found.
 */
export function judgeBestWindow(track: Track, plan: { arm: Arm; signature: MotionSignature }, seconds: number): Verdict {
  const auto = judgeFootage(track, plan, seconds);
  if (auto.accepted || !auto.metrics) return auto;
  let best: Verdict | null = null;
  for (let s = 0; s + seconds <= track.frames.length / track.fps; s++) {
    const v = judgeFootage(track, plan, seconds, s);
    if (v.accepted && (!best || v.score > best.score)) best = v;
  }
  if (!best) return auto;
  return { ...best, windowNote: `most active window (${auto.metrics.windowStartS} s) failed: ${auto.reasons.map((r) => r.split(":")[0]).join(", ")}. Window at ${best.pinnedStartS} s passes every check and is pinned instead.` };
}
