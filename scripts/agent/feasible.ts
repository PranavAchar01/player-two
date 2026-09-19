// Runs before the planner: does this task make sense for this robot at all? A fixed-base arm cannot do jumping
// jacks, and finding twenty videos of them first would waste other people's bandwidth to produce nonsense.
// Pure keyword rules on purpose: the answer has to be the same on the CLI, in POST /api/runs and while someone is
// still typing on the /agent page, with no network and no model in the loop. Nothing here imports node.
import type { Arm, Robot } from "./types";

/**
 * What each robot in this pipeline can actually carry over from a video. This is about the pipeline, not the
 * hardware brochure: the real G1 can be fitted with hands, but no finger motion is retargeted here.
 */
export interface Embodiment {
  kind: "humanoid" | "single-arm";
  label: string;
  arms: 1 | 2;
  legs: boolean;
  torso: boolean;
  gripper: boolean;
  /** Finger motion carried over from video. False everywhere today. */
  fingers: boolean;
  notes: string[];
}

const ONE_ARM_NOTES = [
  "One arm on a fixed base: no second arm, no legs, no torso.",
  "Gripper closing cannot be learned from video yet, because the pose model cannot tell an open hand from a fist. Only the path of the arm is carried over.",
];

export const EMBODIMENTS: Record<Robot, Embodiment> = {
  g1: { kind: "humanoid", label: "G1 humanoid", arms: 2, legs: true, torso: true, gripper: false, fingers: false, notes: ["Two arms, legs and a torso. No fingers in this pipeline, so finger work is not carried over."] },
  so101: { kind: "single-arm", label: "SO-101 arm", arms: 1, legs: false, torso: false, gripper: true, fingers: false, notes: ONE_ARM_NOTES },
  panda: { kind: "single-arm", label: "Panda arm", arms: 1, legs: false, torso: false, gripper: true, fingers: false, notes: ONE_ARM_NOTES },
};

export const isSingleArm = (robot: Robot): boolean => EMBODIMENTS[robot].kind === "single-arm";

export type FeasibilityLevel = "ok" | "warn" | "refuse";

export interface Feasibility {
  level: FeasibilityLevel;
  /** Empty when the level is "ok". Each one quotes the words in the task that triggered it. */
  reasons: string[];
  suggestion?: string;
}

interface Rule {
  /** Matched against the task in lower case with hyphens turned into spaces, so "push-up" and "push up" are one rule. */
  pattern: RegExp;
  why: string;
}

// ---- a single arm REFUSES anything that needs a second hand or a body

const NEEDS_TWO_HANDS: Rule[] = [
  { pattern: /\b(?:both|two|2) (?:hands?|arms?)\b|\b(?:two|double) handed\b|\bbimanual\b|\beach (?:hand|arm)\b|\bhands together\b/, why: "needs two hands" },
  { pattern: /\bclap(?:s|ping)?\b|\bapplau(?:d|ds|ding|se)\b|\bhigh five\b/, why: "needs two hands meeting" },
  { pattern: /\bfold(?:s|ing)?\b/, why: "is two-handed work (folding a shirt takes one hand to hold and one to fold)" },
  { pattern: /\bt(?:ie|ies|ied|ying)\b|\bshoelaces?\b|\bknots?\b/, why: "is two-handed work (tying takes both hands)" },
  { pattern: /\b(?:open|opens|opening|unscrew|unscrews|unscrewing|twist off) (?:a |an |the )?(?:\w+ )?(?:jar|bottle|lid|cap)\b/, why: "is two-handed work (one hand holds, the other turns)" },
  { pattern: /\bbarbells?\b|\bdeadlifts?\b|\bbench press\b|\bkettlebell swings?\b|\bbattle ropes?\b|\browing\b|\bjuggl(?:e|es|ing)\b/, why: "is held or done with two hands" },
];

const NEEDS_A_BODY: Rule[] = [
  { pattern: /\bjumping jacks?\b|\bstar jumps?\b/, why: "needs two arms and legs" },
  // "jumping jack" already has its own line above, so it is not reported a second time here
  { pattern: /\bjump(?:s|ed|ing)?\b(?! jacks?\b)|\bhop(?:s|ping)?\b|\bskip(?:s|ping)?\b|\bburpees?\b/, why: "needs legs" },
  { pattern: /\bsquat(?:s|ting)?\b|\blunge(?:s|ing)?\b|\bkick(?:s|ing)?\b|\bleg (?:raise|raises|lift|lifts|swing|swings|curl|curls|press)\b|\bcalf raises?\b|\bknee (?:raise|raises|bend|bends)\b|\bhigh knees\b/, why: "needs legs" },
  { pattern: /\bwalk(?:s|ed|ing)?\b|\brun(?:s|ning)?\b|\bjog(?:s|ging)?\b|\bsprint(?:s|ing)?\b|\bmarch(?:es|ing)?\b|\bclimb(?:s|ing)?\b|\bcrawl(?:s|ing)?\b|\bstairs?\b|\bstep ups?\b/, why: "needs legs to move around, and this arm is bolted to a table" },
  { pattern: /\bdanc(?:e|es|ing)\b|\byoga\b|\btai chi\b|\bcartwheels?\b|\bhandstands?\b|\bswim(?:s|ming)?\b/, why: "is a whole-body motion" },
  { pattern: /\bpush ups?\b|\bpushups?\b|\bpress ups?\b|\bpull ups?\b|\bpullups?\b|\bchin ups?\b|\bsit ups?\b|\bsitups?\b|\bcrunch(?:es)?\b|\bplanks?\b|\bmountain climbers?\b/, why: "moves the whole body against the floor or a bar" },
  { pattern: /\bstand(?:s|ing)? up\b|\bsit(?:s|ting)? down\b|\bbow(?:s|ing)?\b|\bbend(?:s|ing)? (?:over|down|forward)\b|\btouch(?:es|ing)? (?:my |your |his |her |the )?toes\b|\btorso\b|\bkneel(?:s|ing)?\b|\bcrouch(?:es|ing)?\b/, why: "needs a torso and legs" },
];

// ---- both kinds of robot WARN when the point of the task is in the hand, because the hand is not in the data

const NEEDS_A_GRASP: Rule[] = [
  { pattern: /\bpick(?:s|ed|ing)?(?: up)?\b|\bgrab(?:s|bed|bing)?\b|\bgrasp(?:s|ed|ing)?\b|\bgrip(?:s|ped|ping)?\b|\bpour(?:s|ed|ing)?\b|\bstack(?:s|ed|ing)?\b|\bplac(?:e|es|ed|ing)\b|\bput(?:s|ting)?\b|\bhand(?:s|ed|ing)? (?:it |them |something |\w+ )?over\b|\bhold(?:s|ing)? (?:a|an|the|onto)\b|\bsqueez(?:e|es|ing)\b|\bpinch(?:es|ing)?\b|\binsert(?:s|ing)?\b|\bthrow(?:s|ing)?\b|\bcatch(?:es|ing)?\b/, why: "depends on the gripper closing at the right moment" },
];

const NEEDS_FINGERS: Rule[] = [
  { pattern: /\btyp(?:e|es|ing)\b|\bkeyboard\b|\bpiano\b|\bguitar\b|\bviolin\b|\bthread(?:s|ing)? (?:a |the )?needle\b|\bneedle\b|\bsew(?:s|ing)?\b|\bknit(?:s|ting)?\b|\bwrit(?:e|es|ing)\b|\bhandwriting\b|\bbutton(?:s|ing)? (?:up )?(?:a |the |my |your )?(?:shirt|coat|jacket)\b|\bsign language\b|\bsnap(?:s|ping)? (?:my |your |his |her |the )?fingers\b|\bfingers?\b|\bthumbs? up\b/, why: "is finger work" },
];

function matches(task: string, rules: Rule[]): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    const m = task.match(rule.pattern);
    if (m) out.push(`"${m[0].trim()}" ${rule.why}`);
  }
  return out;
}

export function checkFeasibility(task: string, robot: Robot): Feasibility {
  const body = EMBODIMENTS[robot];
  const t = task.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  const oneArm = body.kind === "single-arm";

  if (oneArm) {
    const blocked = [...matches(t, NEEDS_TWO_HANDS), ...matches(t, NEEDS_A_BODY)];
    if (blocked.length) {
      return {
        level: "refuse",
        // the matched words first, the robot's shape once at the end, so three matches do not repeat it three times
        reasons: [...blocked, `the ${body.label} is one fixed-base arm with a gripper: no second arm, no legs, no torso`],
        // worded for both doors: the CLI flag and the robot menu on the /agent page
        suggestion: 'Choose the g1 humanoid for this task (--robot g1), or ask for a one-arm version such as "raise one arm out to the side".',
      };
    }
  }

  const reasons: string[] = [];
  const grasp = oneArm ? matches(t, NEEDS_A_GRASP) : [];
  if (grasp.length) reasons.push(...grasp, "gripper closing cannot be learned from video yet, because the pose model cannot tell an open hand from a fist: only the path of the arm would be learned, not the grasp");
  const fingers = matches(t, NEEDS_FINGERS);
  if (fingers.length) reasons.push(...fingers, `no finger motion is carried over in this pipeline${oneArm ? ", and the gripper has two jaws, not fingers" : ""}: only the larger arm${body.legs ? " and body" : ""} motion would be learned`);
  if (reasons.length) return { level: "warn", reasons, suggestion: "The run continues. Read the episodes as arm paths, not as a finished manipulation skill." };
  return { level: "ok", reasons: [] };
}

/**
 * A single arm judges and retargets ONE human arm. "both" would make the judge demand two good arms from footage
 * of which only one is ever used, so it becomes "either": the better arm of a two-armed video is taken.
 */
export const armForRobot = (arm: Arm, robot: Robot): Arm => (isSingleArm(robot) && arm === "both" ? "either" : arm);

/** One paragraph for the planner, so its queries and its motion check describe something this robot can follow. */
export function embodimentBrief(robot: Robot): string {
  const body = EMBODIMENTS[robot];
  if (body.kind === "single-arm") {
    return `The robot is ONE fixed-base arm with a gripper (${body.label}). It has no second arm, no legs and no torso. Exactly ONE of the person's arms is judged and copied, so "arm" must be "left", "right" or "either", never "both". Videos in which the person moves both arms are fine, because only the better arm is used. Describe the motion and choose the signature for ONE arm.`;
  }
  return `The robot is a humanoid (${body.label}) with two arms, legs and a torso, and no fingers in this pipeline. "arm" may be "left", "right", "both" or "either".`;
}
