/**
 * The robot is the Unitree G1 from MuJoCo Menagerie (vendor/unitree_g1, BSD-3), unmodified except
 * for what `g1Xml` does: the floating base is removed so the pelvis is pinned like a lab gantry,
 * the arm actuators are softened for teleoperation, and the task (a pendulum) is added.
 *
 * Frames: the robot faces +X (toward the viewer), its left is +Y, up is +Z.
 */

export type Side = "left" | "right";
export type Slot = "low" | "mid" | "high";
export interface TaskSpec {
  side: Side;
  slot: Slot;
}
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const SIDES: Side[] = ["left", "right"];
export const SLOTS: Slot[] = ["low", "mid", "high"];

export const JOINTS = ["shoulder_pitch", "shoulder_roll", "shoulder_yaw", "elbow"] as const;
export const armJoints = (side: Side) => JOINTS.map((j) => `${side}_${j}_joint`);
/** Order of the 8 numbers in an action or state vector: left arm, then right arm. */
export const ACTUATORS = SIDES.flatMap(armJoints);

export const SPEED_LIMIT = 6; // rad/s, conservative cap for live teleoperation and the dataset
export const MIRROR_SPEED_LIMIT = 20; // rad/s, free mirror of pre-recorded video, where the motion is known in advance
export const LEG_JOINTS = ["hip_pitch", "hip_roll", "hip_yaw", "knee", "ankle_pitch", "ankle_roll"] as const;
export const legJoints = (side: Side) => LEG_JOINTS.map((j) => `${side}_${j}_joint`);
export const TIMESTEP = 0.004;
export const SUBSTEPS = 5; // control tick = 50 Hz
export const TICK_HZ = 1 / (TIMESTEP * SUBSTEPS);
export const EPISODE_SECONDS = 12;

/** Each pendulum bob hangs where the hand is when a straight arm is raised sideways to this angle from straight down. */
export const SLOT_ANGLE: Record<Slot, number> = { low: (50 * Math.PI) / 180, mid: (63 * Math.PI) / 180, high: (76 * Math.PI) / 180 };
export const BOB_RADIUS = 0.07;
export const ANCHOR_Z = 1.85;
/** Distance the bob must move from rest for the strike to count. */
export const STRIKE_DISTANCE = 0.08;

/** Mesh files the model references, relative to the model directory. */
export const meshFiles = (baseXml: string) => [...baseXml.matchAll(/<mesh [^>]*file="([^"]+)"/g)].map((m) => `assets/${m[1]}`);

/**
 * `mirror` builds the free-mirror variant: the pelvis becomes a mocap body whose pose is set every tick
 * from the dancer (a kinematic root, not a balancing robot), and the arms get stiffer gains.
 */
export function g1Xml(baseXml: string, bob: Vec3 | null, mirror = false): string {
  let xml = baseXml
    .replace(/<freejoint name="floating_base_joint"\s*\/>/, "")
    .replace(/<keyframe>[\s\S]*?<\/keyframe>/, "")
    .replace(/<option [^>]*\/>/, `<option timestep="${TIMESTEP}" integrator="implicitfast"/>`)
    // the stock kp=500 saturates the 25 N·m shoulder motors on any brisk human motion
    .replace(/<position class="g1" name="((?:left|right)_(?:shoulder_pitch|shoulder_roll|shoulder_yaw|elbow)_joint)"/g, `<position class="g1" kp="${mirror ? 400 : 120}" dampratio="1" name="$1"`)
    .replace(/<body name="((?:left|right)_(?:shoulder|elbow|wrist)[^"]*)"/g, '<body gravcomp="1" name="$1"');
  const task = bob
    ? `
    <geom name="beam" type="box" size="0.02 0.9 0.012" pos="${bob.x} 0 ${ANCHOR_Z + 0.012}" rgba="0.2 0.22 0.27 1" contype="0" conaffinity="0"/>
    <body name="pendulum" pos="${bob.x} ${bob.y} ${ANCHOR_Z}">
      <joint name="pendulum_swing" type="ball" damping="0.01"/>
      <geom name="string_geom" type="capsule" fromto="0 0 0 0 0 -${ANCHOR_Z - bob.z}" size="0.004" mass="0.005" rgba="0.5 0.52 0.58 1" contype="0" conaffinity="0"/>
      <body name="bob" pos="0 0 -${ANCHOR_Z - bob.z}">
        <!-- a string can go slack: the bob may be lifted, but not pulled below its rest length -->
        <joint name="bob_slack" type="slide" axis="0 0 1" range="0 0.6" damping="0.05"/>
        <geom name="bob_geom" type="sphere" size="${BOB_RADIUS}" mass="0.15" rgba="0.2 0.85 1 1"/>
      </body>
    </body>`
    : "";
  if (mirror) xml = xml.replace('<body name="pelvis"', '<body mocap="true" name="pelvis"');
  xml = xml.replace("<worldbody>", `<worldbody>\n    <geom name="floor" type="plane" size="4 4 0.1" rgba="0.09 0.1 0.12 1"/>${task}`);
  return xml;
}

export const taskSentence = (t: TaskSpec) => `Strike the ${t.slot} pendulum with the ${t.side} hand.`;
