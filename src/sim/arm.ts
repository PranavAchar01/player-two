/**
 * Fixed-base arm embodiments: real vendored models driven through the same fixed-step physics as the G1.
 *
 *  - so101: TheRobotStudio SO-ARM101 (vendor/so101, Apache-2.0), the official onshape-to-robot MJCF.
 *  - panda: Franka Emika Panda from MuJoCo Menagerie (vendor/franka_emika_panda, Apache-2.0).
 *
 * Nothing about a model is assumed beyond its ArmSpec: joints, actuators and the gripper are discovered from the
 * compiled model, and the inverse kinematics is numeric against the real kinematics (finite differences on a
 * scratch MjData, like Rig.solveChain), so a third arm is a spec entry and a vendor directory, not new code.
 *
 * Frames are the project's: the robot faces +X (toward the viewer), its left is +Y, up is +Z, base at the origin.
 */
import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import { DEPTH_GAIN } from "./retarget";
import { SUBSTEPS, TIMESTEP, meshFiles } from "./scene";
import type { AssetReader } from "./sim";

export type ArmRobot = "so101" | "panda";
export const ARM_ROBOTS: ArmRobot[] = ["so101", "panda"];
export const isArmRobot = (r: unknown): r is ArmRobot => ARM_ROBOTS.includes(r as ArmRobot);

type P3 = [number, number, number];

export interface ArmSpec {
  robot: ArmRobot;
  /** name shown on the render HUD */
  label: string;
  /** model directory: vendor/<dir> on disk, /<dir> when served, and /<dir> in MuJoCo's in-memory filesystem */
  dir: string;
  xml: string;
  /** end-effector site; `body` and `pos` add one to a model that ships without (the Panda) */
  ee: { site: string; body?: string; pos?: string };
  /** body whose origin is the shoulder: reach is measured from here */
  shoulder: string;
  /** body whose origin is the elbow: elbow -> end effector is what follows the human forearm */
  elbow: string;
  /** a comfortable mid-workspace pose: IK seed and weak posture preference (one value per arm joint) */
  home: number[];
  /**
   * Virtual shoulder: where the human shoulder sits in the robot's world. A table-mounted arm cannot hang its hand
   * below its own base the way a person does, so this is not the robot's real shoulder: it floats in front of and
   * above it, placed so a hanging human arm maps to the gripper reaching down at the table in front of the base and
   * a raised one maps to the arm reaching up, with sideways and forward reaches inside the workspace too.
   */
  anchor: P3;
  /** lowest end-effector target height: the table is at z = 0 */
  floor: number;
  /** targets stay out of this cylinder around the base column */
  keepOut: { radius: number; height: number };
  /** rad/s command rate limit, from the real actuators */
  maxSpeed: number;
  /** position gain override for the arm joints; the stock value stays when omitted */
  kp?: { kp: number; kv: number };
  camera: { pos: P3; look: P3 };
}

export const ARM_SPECS: Record<ArmRobot, ArmSpec> = {
  so101: {
    robot: "so101",
    label: "SO-101",
    dir: "so101",
    xml: "so101_new_calib.xml",
    ee: { site: "gripperframe" },
    shoulder: "upper_arm",
    elbow: "lower_arm",
    home: [0, -0.6, 0.9, 0.9, 0],
    anchor: [0.22, 0, 0.255],
    floor: 0.025,
    keepOut: { radius: 0.07, height: 0.14 },
    // STS3215 at 7.4 V: about 45 rpm unloaded
    maxSpeed: 4.7,
    // The MJCF's inline kp=998 asks for the full 3.35 N·m at 0.2 degrees of error, so every commanded motion reads as
    // torque saturation. This is the STS3215 gain identified in the same repo's joints_properties.xml.
    kp: { kp: 17.8, kv: 0 },
    // on the mirror axis but looking down, so a forward reach reads as one instead of hiding behind the gripper
    camera: { pos: [0.92, 0, 0.64], look: [0.13, 0, 0.19] },
  },
  panda: {
    robot: "panda",
    label: "Franka Panda",
    dir: "franka_emika_panda",
    xml: "panda.xml",
    // tool centre point between the finger pads
    ee: { site: "p2_tcp", body: "hand", pos: "0 0 0.1034" },
    shoulder: "link2",
    elbow: "link4",
    home: [0, 0, 0, -1.57079, 0, 1.57079, -0.7853],
    anchor: [0.4, 0, 0.62],
    floor: 0.05,
    keepOut: { radius: 0.2, height: 0.5 },
    // Franka datasheet: 2.175 rad/s on joints 1-4 (2.61 on the wrist joints)
    maxSpeed: 2.175,
    camera: { pos: [2.7, 0, 1.6], look: [0.25, 0, 0.52] },
  },
};

/** Fraction of the room the robot has around the virtual shoulder that a fully extended human arm maps to. */
export const REACH_FRACTION = 0.85;
/** Targets stay inside this fraction of the measured reach: the last few percent are the straight-arm singularity. */
const REACH_LIMIT = 0.95;

/** The vendored MJCF, changed only in what the simulation needs. */
export function armXml(spec: ArmSpec, baseXml: string): string {
  let xml = baseXml
    // each robot's meshes live under their own directory of the in-memory filesystem (the G1 owns /assets)
    .replace(/meshdir="[^"]*"/, `meshdir="${spec.dir}/assets"`)
    .replace(/<option [^>]*\/>/, "")
    .replace(/<compiler [^>]*\/>/, (m) => `${m}\n  <option timestep="${TIMESTEP}" integrator="implicitfast"/>`)
    // Position servos sag under the arm's own weight. Real arms cancel gravity in the controller (the Panda) or
    // are calibrated around it; the simulation does it with gravcomp so a commanded pose is the pose reached.
    .replace(/<body name="/g, '<body gravcomp="1" name="')
    .replace("<worldbody>", `<worldbody>
    <geom name="floor" type="plane" size="4 4 0.1" rgba="0.09 0.1 0.12 1"/>
    <body name="p2_target" mocap="true" pos="0 0 -1">
      <geom name="p2_target_geom" type="sphere" size="${(spec.keepOut.radius * 0.17).toFixed(4)}" rgba="0.4 0.91 0.98 0.55" contype="0" conaffinity="0"/>
    </body>`);
  if (spec.ee.body) xml = xml.replace(new RegExp(`(<body [^>]*name="${spec.ee.body}"[^>]*>)`), `$1\n<site name="${spec.ee.site}" pos="${spec.ee.pos}" group="3"/>`);
  if (spec.kp) xml = xml.replace(/<position kp="[^"]*" kv="[^"]*"/, `<position kp="${spec.kp.kp}" kv="${spec.kp.kv}"`);
  return xml;
}

const installed = new WeakMap<MainModule, Map<string, Promise<string>>>();

/** Puts one arm's meshes into MuJoCo's in-memory filesystem once and returns the model XML. `read` is relative to the model directory. */
export function installArm(mj: MainModule, spec: ArmSpec, read: AssetReader): Promise<string> {
  let perModule = installed.get(mj);
  if (!perModule) installed.set(mj, (perModule = new Map()));
  let p = perModule.get(spec.dir);
  if (!p) {
    p = (async () => {
      const xml = new TextDecoder().decode(await read(spec.xml));
      const fs = (mj as unknown as { FS: { mkdir(p: string): void; writeFile(p: string, d: Uint8Array): void } }).FS;
      for (const d of [`/${spec.dir}`, `/${spec.dir}/assets`]) {
        try {
          fs.mkdir(d);
        } catch {
          // already there
        }
      }
      await Promise.all(meshFiles(xml).map(async (f) => fs.writeFile(`/${spec.dir}/${f}`, await read(f))));
      return xml;
    })();
    perModule.set(spec.dir, p);
  }
  return p;
}

const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
const norm = (v: number[]) => Math.hypot(...v);
const unit = (v: number[]) => {
  const n = norm(v) || 1;
  return v.map((c) => c / n);
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Solves A x = b by Gaussian elimination with partial pivoting (A is small: at most joints x joints). */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let k = c + 1; k < n; k++) if (Math.abs(M[k][c]) > Math.abs(M[p][c])) p = k;
    [M[c], M[p]] = [M[p], M[c]];
    for (let k = c + 1; k < n; k++) {
      const f = M[k][c] / M[c][c];
      for (let j = c; j <= n; j++) M[k][j] -= f * M[c][j];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) x[i] = (M[i][n] - M[i].slice(i + 1, n).reduce((s, v, j) => s + v * x[i + 1 + j], 0)) / M[i][i];
  return x;
}

interface ArmJoint {
  name: string;
  qadr: number;
  range: [number, number];
  /** actuator id in the model */
  act: number;
  /** torque limit of that actuator, Infinity when it has none */
  limit: number;
}
interface Gripper {
  name: string;
  act: number;
  open: number;
  closed: number;
}

/** One arm, compiled once. Owns the kinematics: forward, inverse, workspace. */
export class Arm {
  readonly model: MjModel;
  readonly joints: ArmJoint[];
  readonly grippers: Gripper[];
  /** Order of the numbers in a control vector: the arm joints base to tip, then the gripper actuator(s). */
  readonly actuators: string[];
  /** shoulder origin in the world, and the farthest the end effector gets from it */
  readonly shoulderPos: number[];
  readonly reach: number;
  /** metres of end-effector travel per human arm length: REACH_FRACTION of the room around the virtual shoulder */
  readonly scale: number;
  readonly eeSite: number;
  /** bodies from the end-effector body down: the gripper, whose own fingers may touch each other */
  readonly gripperBodies = new Set<number>();
  readonly targetMocap: number;
  private readonly scratch: MjData;
  private readonly elbowBody: number;
  private data?: MjData;

  constructor(readonly mj: MainModule, readonly spec: ArmSpec, baseXml: string) {
    const model = (this.model = mj.MjModel.from_xml_string(armXml(spec, baseXml)));
    this.scratch = new mj.MjData(model);
    const id = (type: { value: number }, name: string) => {
      const i = mj.mj_name2id(model, type.value, name);
      if (i < 0) throw new Error(`${spec.robot}: no "${name}" in the model`);
      return i;
    };
    const name = (type: { value: number }, i: number) => mj.mj_id2name(model, type.value, i);
    this.eeSite = id(mj.mjtObj.mjOBJ_SITE, spec.ee.site);
    this.elbowBody = id(mj.mjtObj.mjOBJ_BODY, spec.elbow);
    this.targetMocap = model.body_mocapid[id(mj.mjtObj.mjOBJ_BODY, "p2_target")];
    const eeBody = model.site_bodyid[this.eeSite];
    const chain = new Set<number>();
    for (let b = eeBody; b > 0; b = model.body_parentid[b]) chain.add(b);
    for (let b = 1; b < model.nbody; b++) {
      for (let p = b; p > 0; p = model.body_parentid[p]) if (p === eeBody) this.gripperBodies.add(b);
    }
    // An actuator that turns a joint between the base and the end effector moves the arm. Anything else
    // (a joint past the end effector, a finger tendon) is the gripper.
    this.joints = [];
    this.grippers = [];
    const JOINT_TRANSMISSION = mj.mjtTrn.mjTRN_JOINT.value;
    for (let a = 0; a < model.nu; a++) {
      const j = model.actuator_trnid[a * 2];
      // (actuator_forcelimited is a bool array, which this embind build cannot hand over; a set range means limited)
      const limited = model.actuator_forcerange[a * 2 + 1] > model.actuator_forcerange[a * 2];
      if (model.actuator_trntype[a] === JOINT_TRANSMISSION && chain.has(model.jnt_bodyid[j])) {
        this.joints.push({ name: name(mj.mjtObj.mjOBJ_JOINT, j), qadr: model.jnt_qposadr[j], range: [model.jnt_range[j * 2], model.jnt_range[j * 2 + 1]], act: a, limit: limited ? model.actuator_forcerange[a * 2 + 1] : Infinity });
      } else {
        // both vendored grippers open toward the top of their control range
        this.grippers.push({ name: name(mj.mjtObj.mjOBJ_ACTUATOR, a), act: a, open: model.actuator_ctrlrange[a * 2 + 1], closed: model.actuator_ctrlrange[a * 2] });
      }
    }
    if (this.joints.length !== spec.home.length) throw new Error(`${spec.robot}: found ${this.joints.length} arm joints, the spec's home pose has ${spec.home.length}`);
    this.actuators = [...this.joints.map((j) => name(mj.mjtObj.mjOBJ_ACTUATOR, j.act)), ...this.grippers.map((g) => g.name)];

    const shoulder = id(mj.mjtObj.mjOBJ_BODY, spec.shoulder);
    this.fk(spec.home);
    this.shoulderPos = [0, 1, 2].map((k) => this.scratch.xpos[shoulder * 3 + k]);
    this.reach = this.measureReach();
    this.scale = REACH_FRACTION * this.room();
  }

  /** End-effector position, elbow position and the unit elbow -> end-effector direction at joint angles `q`. */
  fk(q: number[]) {
    this.joints.forEach((j, i) => (this.scratch.qpos[j.qadr] = q[i]));
    this.mj.mj_kinematics(this.model, this.scratch);
    const ee = [0, 1, 2].map((k) => this.scratch.site_xpos[this.eeSite * 3 + k]);
    const elbow = [0, 1, 2].map((k) => this.scratch.xpos[this.elbowBody * 3 + k]);
    return { ee, elbow, fore: unit(sub(ee, elbow)) };
  }

  /** Farthest the end effector gets from the shoulder: coordinate ascent over the joint ranges from the zero pose. */
  private measureReach(): number {
    const q = this.joints.map((j) => clamp(0, j.range[0], j.range[1]));
    const dist = () => norm(sub(this.fk(q).ee, this.shoulderPos));
    let best = dist();
    for (let round = 0; round < 4; round++) {
      this.joints.forEach((j, i) => {
        const keep = q[i];
        let bestV = keep;
        for (let s = 0; s <= 40; s++) {
          q[i] = j.range[0] + ((j.range[1] - j.range[0]) * s) / 40;
          const d = dist();
          if (d > best) {
            best = d;
            bestV = q[i];
          }
        }
        q[i] = bestV;
      });
    }
    return best;
  }

  /**
   * Room around the virtual shoulder: how far the end effector can really travel from it straight down (to the
   * table), up, to either side and forward. Measured, not modelled: along each direction the farthest point the
   * IK still reaches, found by bisection, because joint limits make the true workspace smaller than the reach
   * sphere in some directions. The smallest of those is what a fully extended human arm has to fit in: "the robot's
   * reach" as seen from where the human shoulder sits. Backward is left out: people rarely reach behind
   * themselves, and the workspace clamp covers it when they do.
   */
  private room(): number {
    const { anchor, floor } = this.spec;
    const a = sub(anchor, this.shoulderPos);
    const c = a.reduce((s, v) => s + v * v, 0) - (REACH_LIMIT * this.reach) ** 2;
    if (c >= 0) throw new Error(`${this.spec.robot}: the virtual shoulder is outside the workspace`);
    const reaches = (d: number[], t: number) => {
      const p = anchor.map((v, i) => v + d[i] * t);
      return norm(sub(this.fk(this.solve(p, d, this.spec.home, 60)).ee, p)) < 0.002;
    };
    const along = (d: number[], cap = Infinity) => {
      const b = d.reduce((s, v, i) => s + v * a[i], 0);
      let hi = Math.min(cap, -b + Math.sqrt(b * b - c)); // where the ray leaves the reach sphere, or hits the table
      if (reaches(d, hi)) return hi;
      let lo = 0;
      for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) / 2;
        if (reaches(d, mid)) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    // forward reaches arrive attenuated (DEPTH_GAIN), so forward room counts for that much more
    return Math.min(along([0, 0, -1], anchor[2] - floor), along([0, 0, 1]), along([0, 1, 0]), along([0, -1, 0]), along([1, 0, 0]) / DEPTH_GAIN);
  }

  /** The nearest point the arm can actually go: inside the reachable sphere, above the table, clear of its own base. */
  clampTarget(p: number[]): { p: number[]; clamped: boolean } {
    let out = p.slice();
    out[2] = Math.max(this.spec.floor, out[2]);
    const { radius, height } = this.spec.keepOut;
    const r = Math.hypot(out[0], out[1]);
    if (out[2] < height && r < radius) {
      // push out horizontally, forward when the point sits on the axis itself
      const [ux, uy] = r > 1e-6 ? [out[0] / r, out[1] / r] : [1, 0];
      out[0] = ux * radius;
      out[1] = uy * radius;
    }
    const fromShoulder = sub(out, this.shoulderPos);
    const d = norm(fromShoulder);
    const max = REACH_LIMIT * this.reach;
    if (d > max) {
      out = this.shoulderPos.map((s, i) => s + (fromShoulder[i] * max) / d);
      out[2] = Math.max(this.spec.floor, out[2]);
    }
    return { p: out, clamped: norm(sub(out, p)) > 1e-4 };
  }

  /**
   * Joint angles that put the end effector at `target`, starting from `prev`. Damped least squares on a
   * finite-difference Jacobian of the real model. End-effector POSITION is the task; the forearm direction
   * (`fore`, may be null) and a weak pull toward the home pose only act in the null space of the position task,
   * so they shape the arm without costing accuracy. Joint limits are hard: a joint pressed against its limit is
   * locked for the step so the others take over.
   */
  solve(target: number[], fore: number[] | null, prev: number[], iterations = 6): number[] {
    const n = this.joints.length;
    const foreTarget = fore ? unit(fore) : null;
    const EPS = 1e-4, DAMPING = 1e-3, W_POSTURE = 0.06, MAX_STEP = 0.35, MAX_PULL = 0.12;
    let q = prev.map((v, i) => clamp(v, this.joints[i].range[0], this.joints[i].range[1]));
    for (let it = 0; it < iterations; it++) {
      const k0 = this.fk(q);
      const Jp = [0, 1, 2].map(() => new Array<number>(n).fill(0));
      const Jd = [0, 1, 2].map(() => new Array<number>(n).fill(0));
      for (let j = 0; j < n; j++) {
        const qe = q.slice();
        // step inward at an upper limit so the probe itself stays inside the joint range
        const h = q[j] + EPS > this.joints[j].range[1] ? -EPS : EPS;
        qe[j] += h;
        const k = this.fk(qe);
        for (let r = 0; r < 3; r++) {
          Jp[r][j] = (k.ee[r] - k0.ee[r]) / h;
          Jd[r][j] = (k.fore[r] - k0.fore[r]) / h;
        }
      }
      let e = sub(target, k0.ee);
      const eLen = norm(e);
      if (eLen > MAX_PULL) e = e.map((v) => (v * MAX_PULL) / eLen); // far targets are approached, not jumped at
      // secondary residual: forearm direction, then posture
      const r2 = [...(foreTarget ? sub(foreTarget, k0.fore) : [0, 0, 0]), ...q.map((v, i) => W_POSTURE * (this.spec.home[i] - v))];
      const locked = new Array<boolean>(n).fill(false);
      let dq = new Array<number>(n).fill(0);
      for (let attempt = 0; attempt <= n; attempt++) {
        const free = (row: number[]) => row.map((v, j) => (locked[j] ? 0 : v));
        const J = Jp.map(free);
        const JJt = J.map((a) => J.map((b) => a.reduce((s, v, j) => s + v * b[j], 0)));
        // damping relative to the Jacobian's own size, so a 0.4 m arm and a 0.9 m arm are conditioned alike
        const size = (JJt[0][0] + JJt[1][1] + JJt[2][2]) / 3;
        const pinv = (v: number[], damping: number) => {
          const y = solveLinear(JJt.map((row, i) => row.map((c, k) => c + (i === k ? damping * size + 1e-12 : 0))), v);
          return Array.from({ length: n }, (_, j) => J.reduce((s, row, i) => s + row[j] * y[i], 0));
        };
        const dq1 = pinv(e, DAMPING);
        const J2 = [...Jd.map(free), ...q.map((_, i) => Array.from({ length: n }, (__, j) => (i === j && !locked[j] ? W_POSTURE : 0)))];
        const A2 = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => J2.reduce((s, row) => s + row[i] * row[j], 0) + (i === j ? 1e-3 : 0)));
        const dq2 = solveLinear(A2, Array.from({ length: n }, (_, i) => J2.reduce((s, row, k) => s + row[i] * r2[k], 0)));
        // Project the secondary step into the null space of the position task: dq2 - J^+ (J dq2). The projector is
        // all but undamped: damping here would let the forearm preference leak into position near full stretch.
        const back = pinv(J.map((row) => row.reduce((s, v, j) => s + v * dq2[j], 0)), 1e-6);
        dq = dq1.map((v, j) => (locked[j] ? 0 : v + dq2[j] - back[j]));
        const pressed = dq.findIndex((v, j) => !locked[j] && ((q[j] <= this.joints[j].range[0] + 1e-9 && v < 0) || (q[j] >= this.joints[j].range[1] - 1e-9 && v > 0)));
        if (pressed < 0) break;
        locked[pressed] = true;
      }
      const big = Math.max(...dq.map(Math.abs));
      const s = big > MAX_STEP ? MAX_STEP / big : 1; // scale, do not clip per joint: clipping would bend the step's direction
      q = q.map((v, j) => clamp(v + dq[j] * s, this.joints[j].range[0], this.joints[j].range[1]));
    }
    return q;
  }

  /** One simulation state per arm, reset for each run: the WASM heap cannot afford a fresh MjData per replay. */
  freshData(): MjData {
    this.data ??= new this.mj.MjData(this.model);
    this.mj.mj_resetData(this.model, this.data);
    return this.data;
  }

  /** Full control vector (see `actuators`) from arm joint targets and a gripper opening in 0 (closed) .. 1 (open). */
  ctrl(q: number[], open = 1): number[] {
    return [...q, ...this.grippers.map((g) => g.closed + (g.open - g.closed) * open)];
  }
}

export interface ArmTickInfo {
  /** arm joint positions, same order as the first entries of Arm.actuators */
  state: number[];
  /** achieved end-effector position, metres */
  ee: number[];
  torqueSaturated: boolean;
  selfCollision: boolean;
  tableContact: boolean;
}

/** Deterministic fixed-step simulation of one arm: 250 Hz physics, 50 Hz control, same code in browser and Node. */
export class ArmSim {
  readonly model: MjModel;
  readonly data: MjData;

  /** Starts at rest in the pose of `start` (a control vector), so a replay needs no run-in from the home pose. */
  constructor(private readonly arm: Arm, start?: number[]) {
    this.model = arm.model;
    this.data = arm.freshData();
    const first = start ?? arm.ctrl(arm.spec.home);
    arm.joints.forEach((j, i) => (this.data.qpos[j.qadr] = first[i]));
    arm.actuators.forEach((_, i) => (this.data.ctrl[this.actuatorId(i)] = first[i]));
    arm.mj.mj_forward(this.model, this.data);
  }

  private actuatorId(i: number) {
    const { joints, grippers } = this.arm;
    return i < joints.length ? joints[i].act : grippers[i - joints.length].act;
  }

  /** Advance one control tick (SUBSTEPS physics steps). `target` only moves the marker that shows where the human wrist maps to. */
  tick(ctrl: number[], target?: number[] | null): ArmTickInfo {
    const { arm, model, data } = this;
    const mj = arm.mj;
    if (target) target.forEach((v, k) => (data.mocap_pos[arm.targetMocap * 3 + k] = v));
    const from = ctrl.map((_, i) => data.ctrl[this.actuatorId(i)]);
    let torqueSaturated = false, selfCollision = false, tableContact = false;
    for (let s = 0; s < SUBSTEPS; s++) {
      // A 50 Hz staircase into a stiff position servo is a torque spike every tick. Real arm controllers
      // interpolate the setpoint at their own rate; so does this, linearly across the physics steps.
      ctrl.forEach((v, i) => (data.ctrl[this.actuatorId(i)] = from[i] + ((v - from[i]) * (s + 1)) / SUBSTEPS));
      mj.mj_step(model, data);
      for (const j of arm.joints) if (Math.abs(data.actuator_force[j.act]) >= j.limit * 0.98) torqueSaturated = true;
      const ncon = data.ncon;
      const contacts = ncon > 0 ? data.contact : null;
      for (let c = 0; c < ncon; c++) {
        // embind hands back a C++ copy per contact; without delete() the WASM heap fills within minutes
        const con = contacts!.get(c);
        if (!con) continue;
        const b1 = model.geom_bodyid[con.geom1];
        const b2 = model.geom_bodyid[con.geom2];
        con.delete();
        if (b1 === 0 || b2 === 0) tableContact = true;
        // fingers closing on each other are the gripper working, not the arm hitting itself
        else if (!(arm.gripperBodies.has(b1) && arm.gripperBodies.has(b2))) selfCollision = true;
      }
      contacts?.delete(); // the contact list itself is handed over as a copy too
    }
    return { state: arm.joints.map((j) => data.qpos[j.qadr]), ee: [0, 1, 2].map((k) => data.site_xpos[arm.eeSite * 3 + k]), torqueSaturated, selfCollision, tableContact };
  }
}
