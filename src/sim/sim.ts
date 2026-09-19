import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import { ACTUATORS, STRIKE_DISTANCE, SUBSTEPS, TORQUE_LIMIT, bobRest, sceneXml, type Side, type TaskSpec } from "./scene";

export interface TickInfo {
  /** arm joint positions, same order as ACTUATORS */
  state: number[];
  /** distance of the bob from its rest position, metres */
  bobSwing: number;
  success: boolean;
  torqueSaturated: boolean;
  selfCollision: boolean;
  /** side of the first arm geom that touched the bob, once it has happened */
  firstTouch: Side | null;
}

/** A deterministic, fixed-step simulation of one task. The same code runs in the browser and on the server. */
export class Sim {
  readonly model: MjModel;
  readonly data: MjData;
  private readonly bobGeom: number;
  private readonly armGeoms = new Map<number, Side>();
  private readonly bodyGeoms = new Set<number>();
  private readonly qadr: number[];
  private firstTouch: Side | null = null;
  private succeeded = false;

  constructor(private readonly mj: MainModule, readonly task: TaskSpec) {
    this.model = mj.MjModel.from_xml_string(sceneXml(task));
    this.data = new mj.MjData(this.model);
    const id = (type: { value: number }, name: string) => mj.mj_name2id(this.model, type.value, name);
    this.bobGeom = id(mj.mjtObj.mjOBJ_GEOM, "bob_geom");
    for (const side of ["left", "right"] as Side[]) {
      for (const part of ["shoulder", "upper", "elbow", "fore", "hand"]) this.armGeoms.set(id(mj.mjtObj.mjOBJ_GEOM, `${side}_${part}_geom`), side);
    }
    for (const g of ["pelvis_geom", "torso_geom", "head_geom"]) this.bodyGeoms.add(id(mj.mjtObj.mjOBJ_GEOM, g));
    this.qadr = ACTUATORS.map((a) => this.model.jnt_qposadr[id(mj.mjtObj.mjOBJ_JOINT, a)]);
    mj.mj_forward(this.model, this.data);
  }

  /** Advance one control tick (SUBSTEPS physics steps) with the given joint targets. */
  tick(ctrl: number[]): TickInfo {
    const { mj, model, data } = this;
    for (let i = 0; i < ctrl.length; i++) data.ctrl[i] = ctrl[i];
    let torqueSaturated = false;
    let selfCollision = false;
    for (let s = 0; s < SUBSTEPS; s++) {
      mj.mj_step(model, data);
      for (let i = 0; i < model.nu; i++) if (Math.abs(data.actuator_force[i]) >= TORQUE_LIMIT * 0.98) torqueSaturated = true;
      for (let c = 0; c < data.ncon; c++) {
        const con = data.contact.get(c);
        if (!con) continue;
        const a = this.armGeoms.get(con.geom1);
        const b = this.armGeoms.get(con.geom2);
        if ((a && (this.bodyGeoms.has(con.geom2) || (b && b !== a))) || (b && this.bodyGeoms.has(con.geom1))) selfCollision = true;
        if (!this.firstTouch) {
          if (con.geom1 === this.bobGeom && b) this.firstTouch = b;
          else if (con.geom2 === this.bobGeom && a) this.firstTouch = a;
        }
      }
    }
    const rest = bobRest(this.task);
    const bobSwing = Math.hypot(data.geom_xpos[this.bobGeom * 3] - rest.x, data.geom_xpos[this.bobGeom * 3 + 1] - rest.y, data.geom_xpos[this.bobGeom * 3 + 2] - rest.z);
    if (bobSwing >= STRIKE_DISTANCE && this.firstTouch) this.succeeded = true;
    return { state: this.qadr.map((q) => data.qpos[q]), bobSwing, success: this.succeeded, torqueSaturated, selfCollision, firstTouch: this.firstTouch };
  }

  dispose() {
    this.data.delete();
    this.model.delete();
  }
}
