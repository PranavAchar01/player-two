import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import { ACTUATORS, SIDES, SLOTS, SLOT_ANGLE, STRIKE_DISTANCE, SUBSTEPS, armJoints, g1Xml, meshFiles, type Side, type Slot, type TaskSpec, type Vec3 } from "./scene";

/** Reads a file of the vendored G1 model, e.g. "g1.xml" or "assets/pelvis.STL". */
export type AssetReader = (path: string) => Promise<Uint8Array>;

const installed = new WeakMap<MainModule, Promise<string>>();

/** Puts the G1 meshes into MuJoCo's in-memory filesystem once and returns the model XML. */
export function installG1(mj: MainModule, read: AssetReader): Promise<string> {
  let p = installed.get(mj);
  if (!p) {
    p = (async () => {
      const xml = new TextDecoder().decode(await read("g1.xml"));
      const fs = (mj as unknown as { FS: { mkdir(p: string): void; writeFile(p: string, d: Uint8Array): void } }).FS;
      try {
        fs.mkdir("/assets");
      } catch {
        // already there
      }
      await Promise.all(meshFiles(xml).map(async (f) => fs.writeFile(`/${f}`, await read(f))));
      return xml;
    })();
    installed.set(mj, p);
  }
  return p;
}

const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
const unit = (v: number[]) => {
  const n = Math.hypot(...v) || 1;
  return v.map((c) => c / n);
};

/** Solves dq from (J^T J + mu I) dq = -J^T r for a 6x4 Jacobian. */
function lmStep(J: number[][], r: number[], mu: number): number[] {
  const n = 4;
  const A = Array.from({ length: n }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (j < n ? J.reduce((s, row) => s + row[i] * row[j], 0) + (i === j ? mu : 0) : -J.reduce((s, row, k) => s + row[i] * r[k], 0))));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let k = c + 1; k < n; k++) if (Math.abs(A[k][c]) > Math.abs(A[p][c])) p = k;
    [A[c], A[p]] = [A[p], A[c]];
    for (let k = c + 1; k < n; k++) {
      const f = A[k][c] / A[c][c];
      for (let j = c; j <= n; j++) A[k][j] -= f * A[c][j];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) x[i] = (A[i][n] - A[i].slice(i + 1, n).reduce((s, v, j) => s + v * x[i + 1 + j], 0)) / A[i][i];
  return x;
}

/**
 * The robot, compiled once without a task. Owns the arm inverse kinematics, which is solved
 * numerically against the real G1 kinematics rather than assumed from a simplified chain.
 */
export class Rig {
  readonly model: MjModel;
  private readonly scratch: MjData;
  private readonly arm: Record<Side, { qadr: number[]; range: [number, number][]; shoulder: number; elbow: number; wrist: number }>;
  readonly rest: Record<Side, number[]>;
  readonly slots: Record<Side, Record<Slot, Vec3>>;

  constructor(readonly mj: MainModule, readonly baseXml: string) {
    this.model = mj.MjModel.from_xml_string(g1Xml(baseXml, null));
    this.scratch = new mj.MjData(this.model);
    const id = (type: { value: number }, name: string) => mj.mj_name2id(this.model, type.value, name);
    const arm = (side: Side) => {
      const jids = armJoints(side).map((j) => id(mj.mjtObj.mjOBJ_JOINT, j));
      return {
        qadr: jids.map((j) => this.model.jnt_qposadr[j]),
        range: jids.map((j) => [this.model.jnt_range[j * 2], this.model.jnt_range[j * 2 + 1]] as [number, number]),
        shoulder: id(mj.mjtObj.mjOBJ_BODY, `${side}_shoulder_pitch_link`),
        elbow: id(mj.mjtObj.mjOBJ_BODY, `${side}_elbow_link`),
        wrist: id(mj.mjtObj.mjOBJ_BODY, `${side}_wrist_yaw_link`),
      };
    };
    this.arm = { left: arm("left"), right: arm("right") };
    // Menagerie's "stand" keyframe has the arms hanging clear of the hips; use it as the rest pose and IK seed.
    const stand = /<key name="stand"[^>]*qpos="([^"]+)"/.exec(baseXml)?.[1].trim().split(/\s+/).map(Number) ?? [];
    const standArm = (first: number) => (stand.length >= first + 4 ? stand.slice(first, first + 4) : [0.2, 0.2, 0, 1.28]);
    this.rest = { left: standArm(7 + 15), right: standArm(7 + 22) };
    const slot = (side: Side, s: Slot): Vec3 => {
      const th = SLOT_ANGLE[s];
      const dir = { x: 0, y: (side === "left" ? 1 : -1) * Math.sin(th), z: -Math.cos(th) };
      const { wrist, fore } = this.fk(side, this.solve(side, dir, dir, this.rest[side], 25));
      return { x: wrist[0] + fore[0] * 0.09, y: wrist[1] + fore[1] * 0.09, z: wrist[2] + fore[2] * 0.09 };
    };
    this.slots = Object.fromEntries(SIDES.map((side) => [side, Object.fromEntries(SLOTS.map((s) => [s, slot(side, s)]))])) as Record<Side, Record<Slot, Vec3>>;
  }

  private readonly compiled = new Map<string, MjModel>();

  /** Compiling the meshed model is expensive, so each task's model is built once and shared. */
  modelFor(task: TaskSpec | null): MjModel {
    if (!task) return this.model; // free mirror: the bare robot, no pendulum
    const key = `${task.side}-${task.slot}`;
    let m = this.compiled.get(key);
    if (!m) this.compiled.set(key, (m = this.mj.MjModel.from_xml_string(g1Xml(this.baseXml, this.slots[task.side][task.slot]))));
    return m;
  }

  private readonly datas = new Map<MjModel, MjData>();

  /**
   * One simulation state per task model, reset for each new episode. The WASM heap cannot afford a
   * fresh MjData per episode for a meshed humanoid, and episodes of one task never overlap.
   */
  freshData(model: MjModel): MjData {
    let d = this.datas.get(model);
    if (!d) this.datas.set(model, (d = new this.mj.MjData(model)));
    this.mj.mj_resetData(model, d);
    return d;
  }

  jointRange(side: Side) {
    return this.arm[side].range;
  }

  private fk(side: Side, q: number[]) {
    const a = this.arm[side];
    a.qadr.forEach((adr, i) => (this.scratch.qpos[adr] = q[i]));
    this.mj.mj_kinematics(this.model, this.scratch);
    const pos = (b: number) => [0, 1, 2].map((k) => this.scratch.xpos[b * 3 + k]);
    const [s, e, w] = [pos(a.shoulder), pos(a.elbow), pos(a.wrist)];
    return { upper: unit(sub(e, s)), fore: unit(sub(w, e)), wrist: w };
  }

  /** Joint angles whose upper-arm and forearm directions best match the targets, starting from `prev`. */
  solve(side: Side, upper: Vec3, fore: Vec3, prev: number[], iterations = 4): number[] {
    const target = [...unit([upper.x, upper.y, upper.z]), ...unit([fore.x, fore.y, fore.z])];
    const residual = (q: number[]) => {
      const k = this.fk(side, q);
      return sub([...k.upper, ...k.fore], target);
    };
    const range = this.arm[side].range;
    let q = prev.slice();
    for (let it = 0; it < iterations; it++) {
      const r = residual(q);
      const J = r.map(() => new Array<number>(4).fill(0));
      for (let j = 0; j < 4; j++) {
        const qe = q.slice();
        qe[j] += 1e-3;
        residual(qe).forEach((v, k) => (J[k][j] = (v - r[k]) / 1e-3));
      }
      const dq = lmStep(J, r, 1e-3);
      q = q.map((v, j) => Math.min(range[j][1], Math.max(range[j][0], v + Math.min(0.6, Math.max(-0.6, dq[j])))));
    }
    return q;
  }
}

export interface TickInfo {
  /** arm joint positions, same order as ACTUATORS */
  state: number[];
  /** distance of the bob from its rest position, metres */
  bobSwing: number;
  success: boolean;
  torqueSaturated: boolean;
  selfCollision: boolean;
  /** side of the first arm link that touched the bob, once it has happened */
  firstTouch: Side | null;
}

/** A deterministic, fixed-step simulation of one task. The same code runs in the browser and on the server. */
export class Sim {
  readonly model: MjModel;
  readonly data: MjData;
  private readonly mj: MainModule;
  private readonly rest: Vec3 | null;
  private readonly bobGeom: number;
  private readonly armBody = new Map<number, Side>();
  private readonly forearm = new Set<number>();
  private readonly taskBodies = new Set<number>();
  private readonly act: { ctrl: number; qadr: number; dof: number; limit: number }[];
  private firstTouch: Side | null = null;
  private succeeded = false;

  /** `task` null is free mirror mode: the robot copies the operator with nothing to strike. */
  constructor(rig: Rig, readonly task: TaskSpec | null) {
    const mj = (this.mj = rig.mj);
    this.rest = task ? rig.slots[task.side][task.slot] : null;
    this.model = rig.modelFor(task);
    this.data = rig.freshData(this.model);
    const id = (type: { value: number }, name: string) => mj.mj_name2id(this.model, type.value, name);
    this.bobGeom = task ? id(mj.mjtObj.mjOBJ_GEOM, "bob_geom") : -1;
    if (task) for (const b of ["pendulum", "bob"]) this.taskBodies.add(id(mj.mjtObj.mjOBJ_BODY, b));
    for (let b = 1; b < this.model.nbody; b++) {
      const name = mj.mj_id2name(this.model, mj.mjtObj.mjOBJ_BODY.value, b);
      const m = /^(left|right)_(shoulder|elbow|wrist)/.exec(name);
      if (m) this.armBody.set(b, m[1] as Side);
      if (m && m[2] !== "shoulder") this.forearm.add(b);
    }
    this.act = ACTUATORS.map((name) => {
      const j = id(mj.mjtObj.mjOBJ_JOINT, name);
      return { ctrl: id(mj.mjtObj.mjOBJ_ACTUATOR, name), qadr: this.model.jnt_qposadr[j], dof: this.model.jnt_dofadr[j], limit: this.model.jnt_actfrcrange[j * 2 + 1] };
    });
    // start with the arms hanging, not in the model's bent-elbow zero pose
    const restQ = [...rig.rest.left, ...rig.rest.right];
    this.act.forEach((a, i) => {
      this.data.qpos[a.qadr] = restQ[i];
      this.data.ctrl[a.ctrl] = restQ[i];
    });
    mj.mj_forward(this.model, this.data);
  }

  /** Advance one control tick (SUBSTEPS physics steps) with the given arm joint targets. */
  tick(ctrl: number[]): TickInfo {
    const { mj, model, data } = this;
    this.act.forEach((a, i) => (data.ctrl[a.ctrl] = ctrl[i]));
    let torqueSaturated = false;
    let selfCollision = false;
    for (let s = 0; s < SUBSTEPS; s++) {
      mj.mj_step(model, data);
      for (const a of this.act) if (Math.abs(data.qfrc_actuator[a.dof]) >= a.limit * 0.98) torqueSaturated = true;
      const ncon = data.ncon;
      const contacts = ncon > 0 ? data.contact : null;
      for (let c = 0; c < ncon; c++) {
        // embind hands back a C++ copy per contact; without delete() the WASM heap fills within minutes
        const con = contacts!.get(c);
        if (!con) continue;
        const g1 = con.geom1;
        const g2 = con.geom2;
        con.delete();
        const b1 = model.geom_bodyid[g1];
        const b2 = model.geom_bodyid[g2];
        const a1 = this.armBody.get(b1);
        const a2 = this.armBody.get(b2);
        const robot = (b: number) => b !== 0 && !this.taskBodies.has(b);
        // The shoulder housings sit against the torso shell in normal poses, so only the forearm and hand
        // count against the body. Any contact between the two arms counts.
        const hits = (arm: Side | undefined, armB: number, other: number, otherArm: Side | undefined) =>
          arm !== undefined && robot(other) && otherArm !== arm && (otherArm !== undefined || this.forearm.has(armB));
        if (hits(a1, b1, b2, a2) || hits(a2, b2, b1, a1)) selfCollision = true;
        if (!this.firstTouch) {
          if (g1 === this.bobGeom && a2) this.firstTouch = a2;
          else if (g2 === this.bobGeom && a1) this.firstTouch = a1;
        }
      }
      contacts?.delete(); // the contact list itself is handed over as a copy too
    }
    const g = this.bobGeom * 3;
    const bobSwing = this.rest ? Math.hypot(data.geom_xpos[g] - this.rest.x, data.geom_xpos[g + 1] - this.rest.y, data.geom_xpos[g + 2] - this.rest.z) : 0;
    if (bobSwing >= STRIKE_DISTANCE && this.firstTouch) this.succeeded = true;
    return { state: this.act.map((a) => data.qpos[a.qadr]), bobSwing, success: this.succeeded, torqueSaturated, selfCollision, firstTouch: this.firstTouch };
  }

  /** Kept for call-site symmetry: the rig owns and reuses the underlying MuJoCo objects. */
  dispose() {}
}
