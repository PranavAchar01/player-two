import { describe, expect, it } from "vitest";
import { countPeaks, countSwings, judgeBestWindow, judgeFootage, parseTrack, type Track, type TrackFrame } from "./judge";
import type { Arm, MotionSignature } from "./types";

const RAISE: { arm: Arm; signature: MotionSignature } = { arm: "both", signature: { kind: "arm_elevation", threshold: 60, minCount: 1, direction: "sideways" } };

interface Shape {
  /** picture-heights per metre: how big the person is in shot */
  scale?: number;
  visibility?: number;
  /** arm elevation in degrees at time t */
  elevation?: (t: number) => number;
  /** body turned away from the camera plane, degrees */
  yawDeg?: number | ((t: number) => number);
  /** arms go up toward the camera (a front raise) instead of out to the side */
  forward?: boolean;
  /** where the hips sit across the picture at time t (0..1) */
  centreX?: (t: number) => number;
  handLandmarks?: boolean;
  drop?: (i: number) => boolean;
}

/** A stick person facing the camera, doing a two-arm sideways raise. Same shape as scripts/extract_pose.py writes. */
function person({ scale = 0.42, visibility = 0.98, elevation = (t) => 50 + 45 * Math.sin((t * 2 * Math.PI) / 3 - Math.PI / 2), yawDeg = 0, forward = false, centreX = () => 0.5, handLandmarks = false, drop = () => false }: Shape = {}): Track {
  const fps = 30, width = 1280, height = 720, aspect = width / height;
  const frames: TrackFrame[] = [];
  for (let i = 0; i < fps * 8; i++) {
    const t = i / fps;
    if (drop(i)) { frames.push({ t, world: null, image: null }); continue; }
    const a = (elevation(t) * Math.PI) / 180;
    const yaw = ((typeof yawDeg === "number" ? yawDeg : yawDeg(t)) * Math.PI) / 180;
    const pts: Record<string, [number, number, number]> = { "0": [0, -0.68, -0.05], "11": [0.18, -0.5, 0], "12": [-0.18, -0.5, 0], "23": [0.1, 0, 0], "24": [-0.1, 0, 0], "25": [0.1, 0.42, 0], "26": [-0.1, 0.42, 0], "27": [0.1, 0.82, 0], "28": [-0.1, 0.82, 0], "29": [0.1, 0.86, 0.02], "30": [-0.1, 0.86, 0.02], "31": [0.1, 0.87, -0.1], "32": [-0.1, 0.87, -0.1] };
    for (const [side, s, e, w] of [[1, "11", "13", "15"], [-1, "12", "14", "16"]] as const) {
      // negative z is toward the camera
      const dir = forward ? [0, Math.cos(a), -Math.sin(a)] : [side * Math.sin(a), Math.cos(a), 0];
      pts[e] = [pts[s][0] + dir[0] * 0.28, pts[s][1] + dir[1] * 0.28, dir[2] * 0.28];
      pts[w] = [pts[s][0] + dir[0] * 0.54, pts[s][1] + dir[1] * 0.54, dir[2] * 0.54];
    }
    if (handLandmarks) for (const k of ["17", "18", "19", "20", "21", "22"]) pts[k] = [...pts[Number(k) % 2 ? "15" : "16"]] as [number, number, number];
    const world: Record<string, number[]> = {}, image: Record<string, number[]> = {};
    for (const [k, [x, y, z]] of Object.entries(pts)) {
      const rx = x * Math.cos(yaw) + z * Math.sin(yaw), rz = -x * Math.sin(yaw) + z * Math.cos(yaw);
      world[k] = [rx, y, rz, ["13", "14", "15", "16", "11", "12"].includes(k) ? visibility : 0.98];
      image[k] = [centreX(t) + (rx * scale) / aspect, 0.5 + y * scale];
    }
    frames.push({ t, world, image });
  }
  return { fps, width, height, frames };
}

const failed = (track: Track, plan = RAISE) => {
  const v = judgeFootage(track, plan, 6);
  return { v, names: v.checks.filter((c) => !c.pass).map((c) => c.name) };
};

describe("footage judge", () => {
  it("accepts a clean frontal raise and says why in numbers", () => {
    const { v, names } = failed(person());
    expect(names).toEqual([]);
    expect(v.accepted).toBe(true);
    expect(v.metrics!.trackedPctWindow).toBe(100);
    expect(v.metrics!.frontalDeg).toBeLessThan(5);
    expect(v.metrics!.signaturePeak).toBeGreaterThan(85);
    expect(v.metrics!.signatureCount).toBeGreaterThanOrEqual(1);
    expect(v.score).toBeGreaterThan(0.9);
    expect(v.checks.every((c) => /\d/.test(c.detail))).toBe(true);
  });

  it("gives the same verdict when the extractor also writes hand landmarks 17-22", () => {
    expect(judgeFootage(person({ handLandmarks: true }), RAISE, 6)).toEqual(judgeFootage(person(), RAISE, 6));
  });

  it("rejects low arm visibility (silhouettes, dark clothes on a dark background)", () => {
    const { v, names } = failed(person({ visibility: 0.35 }));
    expect(v.accepted).toBe(false);
    expect(names).toContain("arm visibility");
    expect(v.reasons.join(" ")).toMatch(/0\.35/);
  });

  it("rejects a tiny, far-away person", () => {
    const { v, names } = failed(person({ scale: 0.1 }));
    expect(v.accepted).toBe(false);
    expect(names).toEqual(["person size"]);
  });

  it("rejects footage where the arms do not move", () => {
    const { v, names } = failed(person({ elevation: () => 12 }));
    expect(v.accepted).toBe(false);
    expect(names).toContain("arm motion");
    expect(names).toContain("motion signature");
  });

  it("rejects a 3/4 view", () => {
    const { names, v } = failed(person({ yawDeg: 55 }));
    expect(names).toContain("frontal view");
    expect(v.metrics!.frontalDeg).toBeGreaterThan(50);
  });

  it("rejects a person seen from behind", () => {
    expect(failed(person({ yawDeg: 180 })).names).toContain("facing camera");
  });

  it("tells a front raise from a lateral raise", () => {
    const front = person({ forward: true });
    const { names, v } = failed(front);
    expect(names).toContain("motion direction");
    expect(v.metrics!.lateralFrac).toBeLessThan(0.2);
    expect(judgeFootage(front, { arm: "both", signature: { ...RAISE.signature, direction: "forward" } }, 6).checks.find((c) => c.name === "motion direction")!.pass).toBe(true);
    expect(judgeFootage(front, { arm: "both", signature: { ...RAISE.signature, direction: "any" } }, 6).checks.some((c) => c.name === "motion direction")).toBe(false);
  });

  it("rejects a cut from a front view to a back view of the same person", () => {
    expect(failed(person({ yawDeg: (t) => (t < 4 ? 0 : 180) })).names).toContain("one continuous person");
  });

  it("rejects a cut to a different place in the picture", () => {
    expect(failed(person({ centreX: (t) => (t < 4 ? 0.3 : 0.7) })).names).toContain("one continuous person");
  });

  it("rejects a close-up where the raised arms leave the picture", () => {
    expect(failed(person({ scale: 1.4 })).names).toContain("limbs in frame");
  });

  it("rejects when tracking keeps dropping out", () => {
    expect(failed(person({ drop: (i) => i % 3 === 0 })).names).toContain("tracked frames (window)");
  });

  it("rejects a raise that never reaches the planned height", () => {
    const { names } = failed(person({ elevation: (t) => 25 + 20 * Math.sin(t * 2) }));
    expect(names).toEqual(["motion signature"]);
  });

  it("rejects clips that are too short, and unparseable tracks", () => {
    const t = person();
    expect(judgeFootage({ ...t, frames: t.frames.slice(0, 40) }, RAISE, 6).accepted).toBe(false);
    expect(parseTrack({ fps: 0, width: 1, height: 1, frames: [] })).toBeNull();
    expect(parseTrack("nope")).toBeNull();
  });

  it("pins a clean window when the busiest one contains a cut, and says so", () => {
    // big fast raises with a cut in the middle of them, then slower clean raises to the end of a longer clip
    const cut = person({ centreX: (t) => (t < 2 ? 0.3 : 0.6), elevation: (t) => (t < 4 ? 50 + 45 * Math.sin(t * 6) : 50 + 45 * Math.sin((t * 2 * Math.PI) / 3 - Math.PI / 2)) });
    const track: Track = { ...cut, frames: [...cut.frames, ...person().frames.map((f, i) => ({ ...f, t: 8 + i / 30, image: Object.fromEntries(Object.entries(f.image!).map(([k, [x, y]]) => [k, [x + 0.1, y]])) }))] };
    expect(judgeFootage(track, RAISE, 6).accepted).toBe(false);
    const v = judgeBestWindow(track, RAISE, 6);
    expect(v.accepted).toBe(true);
    expect(v.pinnedStartS).toBeGreaterThanOrEqual(2);
    expect(v.windowNote).toMatch(/one continuous person/);
    // a clip with no clean stretch stays rejected, with the first verdict's reasons
    expect(judgeBestWindow(person({ visibility: 0.3 }), RAISE, 6).accepted).toBe(false);
    expect(judgeBestWindow(person(), RAISE, 6).pinnedStartS).toBeNull();
  });

  it("checks an oscillation plan on the arm that is moving", () => {
    const stir = { arm: "either" as Arm, signature: { kind: "wrist_oscillation" as const, threshold: 8, minCount: 4 } };
    expect(judgeFootage(person({ elevation: (t) => 60 + 25 * Math.sin(t * 5) }), stir, 6).accepted).toBe(true);
  });
});

describe("motion counters", () => {
  it("counts swings only when they are big enough", () => {
    const wave = Array.from({ length: 200 }, (_, i) => 10 * Math.sin(i / 8));
    expect(countSwings(wave, 15)).toBeGreaterThanOrEqual(6);
    expect(countSwings(wave, 25)).toBe(0);
  });
  it("counts separate peaks, not every frame above the bar", () => {
    expect(countPeaks([0, 70, 80, 70, 30, 75, 20], 60)).toBe(2);
    expect(countPeaks([0, 70, 55, 70], 60)).toBe(1);
  });
});
