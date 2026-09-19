/**
 * The simulated robot: a pinned humanoid upper body built from primitives, with the
 * arm joint limits and torque cap of a Unitree G1 (values from Unitree's published
 * G1 joint table; re-check before quoting them). Pelvis is fixed, like a lab gantry.
 *
 * Frames: robot faces +X (toward the viewer), its left is +Y, up is +Z.
 * Right-arm roll and yaw axes are mirrored, so both arms share one retarget formula.
 */

export type Side = "left" | "right";
export type Slot = "low" | "mid" | "high";
export interface TaskSpec {
  side: Side;
  slot: Slot;
}

export const SIDES: Side[] = ["left", "right"];
export const SLOTS: Slot[] = ["low", "mid", "high"];

export const JOINTS = ["shoulder_pitch", "shoulder_roll", "shoulder_yaw", "elbow"] as const;
export const JOINT_RANGE: Record<(typeof JOINTS)[number], [number, number]> = {
  shoulder_pitch: [-3.0892, 2.6704],
  shoulder_roll: [-1.5882, 2.2515],
  shoulder_yaw: [-2.618, 2.618],
  elbow: [-1.0472, 2.0944],
};
export const TORQUE_LIMIT = 25; // N·m
export const SPEED_LIMIT = 6; // rad/s, conservative teleoperation cap

/** Actuator order in `ctrl`: left arm joints, then right arm joints. */
export const ACTUATORS = SIDES.flatMap((s) => JOINTS.map((j) => `${s}_${j}`));

export const TIMESTEP = 0.004;
export const SUBSTEPS = 5; // control tick = 50 Hz
export const TICK_HZ = 1 / (TIMESTEP * SUBSTEPS);
export const EPISODE_SECONDS = 12;

export const SHOULDER = { x: 0, y: 0.2, z: 1.3 };
export const UPPER_ARM = 0.22;
export const FOREARM = 0.24;

/** Arm length from shoulder to the centre of the hand. */
export const REACH = UPPER_ARM + FOREARM + 0.04;
/** Each pendulum bob hangs on the arc a straight arm sweeps when raised sideways (angle from straight down). */
export const SLOT_ANGLE: Record<Slot, number> = { low: (40 * Math.PI) / 180, mid: (62 * Math.PI) / 180, high: (85 * Math.PI) / 180 };
export const BOB_RADIUS = 0.06;
export const ANCHOR_Z = SHOULDER.z + 0.75;
/** Distance the bob must move from rest for the strike to count. */
export const STRIKE_DISTANCE = 0.12;

/** Rest position of the bob centre for a task, in world coordinates. */
export function bobRest(task: TaskSpec): { x: number; y: number; z: number } {
  const s = task.side === "left" ? 1 : -1;
  const th = SLOT_ANGLE[task.slot];
  return { x: 0.02, y: s * (SHOULDER.y + REACH * Math.sin(th)), z: SHOULDER.z - REACH * Math.cos(th) };
}

function arm(side: Side): string {
  const s = side === "left" ? 1 : -1;
  const mirror = side === "left" ? "" : "-";
  const range = (j: (typeof JOINTS)[number]) => JOINT_RANGE[j].join(" ");
  return `
      <body name="${side}_upper" gravcomp="1" pos="${SHOULDER.x} ${s * SHOULDER.y} ${SHOULDER.z - 1}">
        <joint name="${side}_shoulder_pitch" axis="0 1 0" range="${range("shoulder_pitch")}"/>
        <joint name="${side}_shoulder_roll" axis="${mirror}1 0 0" range="${range("shoulder_roll")}"/>
        <joint name="${side}_shoulder_yaw" axis="0 0 ${mirror}1" range="${range("shoulder_yaw")}"/>
        <geom name="${side}_shoulder_geom" type="sphere" size="0.05" rgba="0.16 0.17 0.2 1"/>
        <geom name="${side}_upper_geom" type="capsule" fromto="0 0 0 0 0 -${UPPER_ARM}" size="0.036" rgba="0.86 0.87 0.9 1"/>
        <body name="${side}_fore" gravcomp="1" pos="0 0 -${UPPER_ARM}">
          <joint name="${side}_elbow" axis="0 -1 0" range="${range("elbow")}"/>
          <geom name="${side}_elbow_geom" type="sphere" size="0.04" rgba="0.16 0.17 0.2 1"/>
          <geom name="${side}_fore_geom" type="capsule" fromto="0 0 0 0 0 -${FOREARM}" size="0.03" rgba="0.86 0.87 0.9 1"/>
          <geom name="${side}_hand_geom" type="sphere" pos="0 0 -${FOREARM + 0.04}" size="0.05" rgba="0.98 0.62 0.2 1"/>
          <site name="${side}_hand" pos="0 0 -${FOREARM + 0.04}" size="0.01"/>
        </body>
      </body>`;
}

export function sceneXml(task: TaskSpec): string {
  const bob = bobRest(task);
  const len = ANCHOR_Z - bob.z;
  return `
<mujoco model="player-two">
  <compiler angle="radian"/>
  <option timestep="${TIMESTEP}" integrator="implicitfast"/>
  <default>
    <joint damping="1.2" armature="0.02"/>
    <geom friction="0.9 0.01 0.002"/>
    <position kp="120" kv="5" forcerange="-${TORQUE_LIMIT} ${TORQUE_LIMIT}"/>
  </default>
  <worldbody>
    <light pos="1.5 0 3" dir="-0.4 0 -1"/>
    <geom name="floor" type="plane" size="4 4 0.1" rgba="0.09 0.1 0.12 1"/>
    <body name="torso" pos="0 0 1">
      <geom name="pelvis_geom" type="box" size="0.09 0.13 0.06" pos="0 0 -0.12" rgba="0.16 0.17 0.2 1"/>
      <geom name="torso_geom" type="capsule" fromto="0 0 -0.04 0 0 0.26" size="0.11" rgba="0.86 0.87 0.9 1"/>
      <geom name="head_geom" type="sphere" size="0.085" pos="0 0 0.5" rgba="0.16 0.17 0.2 1"/>
      <geom name="visor_geom" type="box" size="0.01 0.06 0.02" pos="0.08 0 0.51" rgba="0.2 0.85 1 1" contype="0" conaffinity="0"/>
      ${arm("left")}
      ${arm("right")}
    </body>
    <geom name="beam" type="box" size="0.02 0.9 0.015" pos="0.02 0 ${ANCHOR_Z + 0.015}" rgba="0.2 0.22 0.27 1" contype="0" conaffinity="0"/>
    <body name="pendulum" pos="${bob.x} ${bob.y} ${ANCHOR_Z}">
      <joint name="pendulum_swing" type="ball" damping="0.01" armature="0"/>
      <geom name="string_geom" type="capsule" fromto="0 0 0 0 0 -${len}" size="0.004" mass="0.005" rgba="0.5 0.52 0.58 1" contype="0" conaffinity="0"/>
      <body name="bob" pos="0 0 -${len}">
        <!-- a string can go slack: the bob may be lifted, but not pulled below its rest length -->
        <joint name="bob_slack" type="slide" axis="0 0 1" range="0 0.6" limited="true" damping="0.05" armature="0"/>
        <geom name="bob_geom" type="sphere" size="${BOB_RADIUS}" mass="0.2" rgba="0.2 0.85 1 1"/>
      </body>
    </body>
  </worldbody>
  <contact>
    <exclude body1="torso" body2="left_upper"/>
    <exclude body1="torso" body2="right_upper"/>
  </contact>
  <actuator>
    ${ACTUATORS.map((a) => `<position name="${a}" joint="${a}" ctrlrange="${JOINT_RANGE[a.replace(/^(left|right)_/, "") as (typeof JOINTS)[number]].join(" ")}"/>`).join("\n    ")}
  </actuator>
</mujoco>`;
}

export const taskSentence = (t: TaskSpec) => `Strike the ${t.slot} pendulum with the ${t.side} hand.`;
