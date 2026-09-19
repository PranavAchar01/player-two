/**
 * Human arm in a video -> fixed-base robot arm. A person and a table-mounted arm share no joints, so this maps the
 * TASK SPACE, not the angles:
 *
 *  1. Pick one human arm (`left`, `right`, or auto = the one whose wrist travels most while well seen).
 *  2. Wrist relative to shoulder, as upper-arm + forearm vectors. Single-camera depth is the noisy axis, so each
 *     segment's depth comes from foreshortening (track.ts `limb`): a segment seen at full length lies in the picture
 *     plane. "Full length" is the 90th percentile of its picture-plane length over the clip.
 *  3. Normalise by the person's arm length (upper + fore), so a tall and a short person drive the robot alike,
 *     and scale to Arm.scale: REACH_FRACTION (0.85) of the room the robot has around its virtual shoulder.
 *  4. Mirror it the way the project mirrors everything (`limb` returns y = -x_image): the robot faces the viewer
 *     and moves like a reflection, so a hand moving to screen-right moves the gripper to screen-right.
 *  5. Anchor at the robot's virtual shoulder (ArmSpec.anchor) and clamp into the workspace. A hanging human arm
 *     becomes the gripper reaching down to the table in front of the base; a raised arm reaches up.
 *  6. Position IK, with the human forearm direction as the soft preference for where the robot's elbow goes,
 *     seeded from the previous tick; then the actuator speed limit.
 *  7. Gripper from the pose model's index and thumb landmarks (pinch distance over hand size, with hysteresis).
 *     Tracks extracted before those landmarks were saved, or hands the camera cannot see, leave the gripper open.
 *
 * Like the G1 mirror it runs twice: once to measure how far the joints trail the commands, once commanding that
 * far ahead, which pre-recorded video allows.
 */
import { Arm, ArmSim } from "./arm";
import { SKELETON_IDS } from "./mirror";
import { DEPTH_GAIN, MIN_VISIBILITY } from "./retarget";
import { TICK_HZ, type Side } from "./scene";
import { SmoothTrack, lagOf, limb, pickWindow, smoothWide, type Track } from "./track";

const ARM_IDS: Record<Side, [string, string, string]> = { left: ["11", "13", "15"], right: ["12", "14", "16"] };
const HAND_IDS: Record<Side, { index: string; thumb: string }> = { left: { index: "19", thumb: "21" }, right: { index: "20", thumb: "22" } };
/**
 * Pinch distance over hand size (wrist to index knuckle), in world landmarks so hand orientation cancels out.
 * Closes below the first, reopens above the second. The pose model's hand points are coarse: on the stock clips the
 * ratio sits at 0.70-0.87 for open hands and for fists around dumbbells alike, so the bar is set well below that
 * band and only a clearly pinched hand closes the gripper.
 */
export const PINCH_CLOSE = 0.55;
export const PINCH_OPEN = 0.66;
/** width of the extra zero-phase smoothing on depth */
const DEPTH_SIGMA_SECONDS = 0.14;
/** ticks for the gripper command to travel fully open <-> closed */
const GRIPPER_TICKS = 10;

export interface ArmRetargetOptions {
  arm: Side | "auto";
  seconds: number;
  /** pinned start in seconds; omitted picks the window where the chosen arm moves most */
  start?: number;
}

export interface ArmStats {
  trackedPct: number;
  armUsed: Side;
  reachClampedPct: number;
  ikResidualCmMean: number;
  ikResidualCmP95: number;
  jointLimitPct: number;
  speedCapPct: number;
  selfCollisionTicks: number;
  lagMsBefore: number;
  lagMsAfter: number;
  /** extras: physics, not just kinematics */
  torqueSaturatedPct: number;
  trackingErrorCmMean: number;
  trackingErrorCmP95: number;
  tableContactTicks: number;
  gripperClosedPct: number;
  handLandmarks: boolean;
}

const quantile = (v: number[], q: number) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * q))] ?? 0;
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / (v.length || 1);

export function retargetToArm(arm: Arm, track: Track, opts: ArmRetargetOptions) {
  const st = new SmoothTrack(track, [...SKELETON_IDS, "17", "18", "19", "20", "21", "22"]);
  const { n, world } = st;
  const win = Math.min(n - 2, Math.round(opts.seconds * track.fps));

  // ---- which arm, and which stretch of the clip: wrist travel in the picture plane, discounted by how well the arm is seen
  const activity = (side: Side) => {
    const [s, e, w] = ARM_IDS[side];
    return track.frames.map((_, i) => (i === 0 ? 0 : Math.hypot(world[w][0][i] - world[w][0][i - 1], world[w][1][i] - world[w][1][i - 1]) * Math.min(world[s][3][i], world[e][3][i], world[w][3][i])));
  };
  const pinned = opts.start === undefined ? undefined : Math.min(n - 2 - win, Math.max(0, Math.round(opts.start * track.fps)));
  const candidate = (side: Side) => {
    const a = activity(side);
    return pinned === undefined ? pickWindow(a, win) : { start: pinned, score: a.slice(pinned, pinned + win).reduce((x, y) => x + y, 0) };
  };
  const sides: Side[] = opts.arm === "auto" ? ["left", "right"] : [opts.arm];
  const picked = sides.map((side) => ({ side, ...candidate(side) })).sort((a, b) => b.score - a.score)[0];
  const side = picked.side;
  const startSeconds = picked.start / track.fps;
  const ticks = Math.round((win / track.fps) * TICK_HZ);

  const [S, E, W] = ARM_IDS[side];
  const fullUpper = st.fullLength(S, E, 0.9, 0.28), fullFore = st.fullLength(E, W, 0.9, 0.25);
  const armLength = fullUpper + fullFore;
  const hand = HAND_IDS[side];
  const handLandmarks = st.has(hand.index) && st.has(hand.thumb);
  const maxStep = arm.spec.maxSpeed / TICK_HZ;
  const nj = arm.joints.length;

  // ---- the arm as two robot-frame vectors per video frame. Depth (x) comes from foreshortening, which near full
  // length turns a percent of apparent-length noise into centimetres, harmless for the G1's leg directions but not
  // for a position target. So depth alone gets the project's depth attenuation and a wider zero-phase smoothing.
  const segment = (a: string, b: string, full: number) => {
    const v = track.frames.map((_, i) => limb(st.lm(a, i), st.lm(b, i), full));
    const depth = smoothWide(v.map((p) => p.x * DEPTH_GAIN), DEPTH_SIGMA_SECONDS * track.fps);
    return [depth, v.map((p) => p.y), v.map((p) => p.z)];
  };
  const upperSeries = segment(S, E, fullUpper), foreSeries = segment(E, W, fullFore);
  const seen = [S, E, W].map((k) => world[k][3]);

  function fly(leadTicks: number) {
    const at = (t: number) => Math.min(n - 1, (startSeconds + (t + leadTicks) / TICK_HZ) * track.fps);
    // wrist target and forearm direction for one tick, or null while the arm is not seen well enough
    const want = (fpos: number) => {
      if (Math.min(...seen.map((v) => st.lerp(v, fpos))) < MIN_VISIBILITY) return null;
      const upper = upperSeries.map((c) => st.lerp(c, fpos)), fore = foreSeries.map((c) => st.lerp(c, fpos));
      const k = arm.scale / armLength;
      return { ...arm.clampTarget(arm.spec.anchor.map((a, i) => a + (upper[i] + fore[i]) * k)), fore };
    };
    // Start where the clip starts (first tick the arm is seen), solved to convergence from the home pose.
    let first = null;
    for (let t = 0; t < ticks && !first; t++) first = want(at(t));
    let q = first ? arm.solve(first.p, first.fore, arm.spec.home, 60) : arm.spec.home.slice();
    let target = first?.p ?? arm.fk(q).ee;
    let fore: number[] | null = first?.fore ?? null;
    let closed = false, opening = 1;
    const sim = new ArmSim(arm, arm.ctrl(q, opening));

    const ctrl: number[][] = [], state: number[][] = [], targets: number[][] = [], skeleton: (number[] | null)[][] = [];
    const residual: number[] = [];
    let held = 0, clampedTicks = 0, limited = 0, atLimit = 0, collisions = 0, saturated = 0, closedTicks = 0, table = 0;
    for (let t = 0; t < ticks; t++) {
      const fpos = at(t);
      const w = want(fpos);
      if (w) {
        target = w.p;
        fore = w.fore;
        if (w.clamped) clampedTicks++;
      } else held++; // fail closed: keep the last target
      const solved = arm.solve(target, fore, q);
      residual.push(Math.hypot(...arm.fk(solved).ee.map((v, i) => v - target[i])) * 100);
      if (solved.some((v, i) => v <= arm.joints[i].range[0] + 1e-3 || v >= arm.joints[i].range[1] - 1e-3)) atLimit++;
      if (solved.some((v, i) => Math.abs(v - q[i]) > maxStep)) limited++;
      // the whole step is scaled, not each joint clipped, so a capped move still heads for the same pose
      const fastest = Math.max(...solved.map((v, i) => Math.abs(v - q[i])));
      const slow = fastest > maxStep ? maxStep / fastest : 1;
      q = solved.map((v, i) => q[i] + (v - q[i]) * slow);

      if (handLandmarks) {
        const [wr, ix, th] = [W, hand.index, hand.thumb].map((k) => st.lm(k, fpos));
        if (Math.min(wr.visibility, ix.visibility, th.visibility) >= 0.5) {
          const pinch = Math.hypot(ix.x - th.x, ix.y - th.y, ix.z - th.z) / (Math.hypot(ix.x - wr.x, ix.y - wr.y, ix.z - wr.z) || 1);
          if (pinch < PINCH_CLOSE) closed = true;
          else if (pinch > PINCH_OPEN) closed = false;
        } else closed = false; // a hand the camera cannot see opens the gripper
      }
      opening = Math.min(1, Math.max(0, opening + (closed ? -1 : 1) / GRIPPER_TICKS));
      if (closed) closedTicks++;

      const c = arm.ctrl(q, opening).map((v) => +v.toFixed(5));
      const info = sim.tick(c, target);
      ctrl.push(c);
      state.push(info.state);
      targets.push(target.map((v) => +v.toFixed(4)));
      skeleton.push(st.skeleton(SKELETON_IDS, Math.min(n - 1, (startSeconds + t / TICK_HZ) * track.fps)));
      if (info.selfCollision) collisions++;
      if (info.torqueSaturated) saturated++;
      if (info.tableContact) table++;
    }
    return { ctrl, state, targets, skeleton, residual, held, clampedTicks, limited, atLimit, collisions, saturated, closedTicks, table };
  }

  const first = fly(0);
  const lag = lagOf(first.ctrl, first.state, nj);
  const final = fly(lag);
  // residual lag: achieved joints against the un-led commands, which is what the viewer sees beside the footage
  const lagAfter = lagOf(first.ctrl, final.state, nj);
  // the achieved end effector is judged against the un-led target for the same reason
  const trackingShown = final.state.map((joints, t) => Math.hypot(...arm.fk(joints).ee.map((v, k) => v - first.targets[t][k])) * 100);
  const pct = (v: number) => +((v / ticks) * 100).toFixed(1);
  const stats: ArmStats = {
    trackedPct: +(100 - pct(final.held)).toFixed(1),
    armUsed: side,
    reachClampedPct: pct(final.clampedTicks),
    ikResidualCmMean: +mean(final.residual).toFixed(3),
    ikResidualCmP95: +quantile(final.residual, 0.95).toFixed(3),
    jointLimitPct: pct(final.atLimit),
    speedCapPct: pct(final.limited),
    selfCollisionTicks: final.collisions,
    lagMsBefore: lag * (1000 / TICK_HZ),
    lagMsAfter: lagAfter * (1000 / TICK_HZ),
    torqueSaturatedPct: pct(final.saturated),
    trackingErrorCmMean: +mean(trackingShown).toFixed(3),
    trackingErrorCmP95: +quantile(trackingShown, 0.95).toFixed(3),
    tableContactTicks: final.table,
    gripperClosedPct: pct(final.closedTicks),
    handLandmarks,
  };
  return { robot: arm.spec.robot, aspect: st.aspect, startSeconds, task: null, hz: Math.round(TICK_HZ), actuators: arm.actuators, ctrl: final.ctrl, target: first.targets, skeleton: final.skeleton, stats };
}
