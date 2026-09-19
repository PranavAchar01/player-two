# Player Two: technical reference

A webcam is all it takes to teach a robot. Open the page, move your arms, and a simulated humanoid
upper body (MuJoCo, in the browser) mirrors you. Every episode is re-simulated on the server and has
to pass eleven measured gates before it is written into a LeRobot-format dataset.

## Run

```bash
pnpm install
pnpm dev --port 3218        # operator page at /, dataset wall at /wall
pnpm dlx tsx scripts/seed.mts   # optional: six scripted-pilot episodes plus two bad ones
pnpm export                 # or press "Approve batch" on the wall
```

Webcam access needs a secure origin. `localhost` counts. For other laptops in the room, put the dev
server behind an HTTPS tunnel and show the wall from that URL so the QR code points at it.

## How it works

- `src/sim/scene.ts`: the robot and task as MJCF. Pinned upper body, 4 joints per arm, joint limits
  and 25 N·m torque cap taken from Unitree's G1 arm (re-check before quoting). Task: strike a
  pendulum that hangs on the arc a sideways arm raise sweeps, so the motion stays in the camera plane.
- `src/sim/retarget.ts`: MediaPipe world landmarks to joint targets. Mirrored. Depth is attenuated.
  Fail closed: low landmark visibility holds the last target. Targets are clamped and rate limited.
- `src/sim/sim.ts`: fixed-step simulation (250 Hz physics, 50 Hz control). Same code in browser and Node.
- `src/sim/episode.ts`: upload format (joint targets and flags only, never pixels), the judge, and a
  scripted pilot that goes through the same retarget path as a webcam.
- `src/app/api/episodes`: validates, replays the actions in MuJoCo on the server, scores the gates.
- `scripts/export_lerobot.py`: accepted episodes written through the LeRobot library (format v3.0) and loaded back as a check, plus a dataset card (`CARD.md`) that
  lists every rejected episode with the gate that failed it.

## Gates

success on server replay, client and replay agree, correct hand made first contact, tracking-confidence
holds, joint-range clamps, speed cap, torque saturation, self-collision, command jerk, dropped frames,
minimum length. Thresholds are in `LIMITS` in `src/sim/episode.ts`.

## Agent

Give it a task in plain words and it builds a small, traceable set of robot demonstrations from videos of
people doing that task.

```bash
pnpm dlx tsx scripts/agent/agent.mts "dumbbell lateral raise" --robot g1 --max-videos 6 --seconds 6 --sources pexels,youtube-cc
# a big run for a demo: judge up to 80 videos, stop as soon as 20 are accepted
pnpm dlx tsx scripts/agent/agent.mts "raise one arm out to the side" --robot so101 --max-videos 80 --target-accepted 20 --sources youtube-cc
# or open /agent, type the task and press "Start run". The page shows the run live.
```

The task has to make sense for the robot. Before anything is planned or searched, `scripts/agent/feasible.ts`
checks the task against a small capability model:

| robot | what it is here | refused | warned |
| --- | --- | --- | --- |
| `g1` | humanoid: two arms, legs, torso, no fingers in this pipeline | nothing | finger work (type, play piano, thread a needle) |
| `so101`, `panda` | ONE fixed-base arm with a gripper: no second arm, no legs, no torso | anything that needs two hands or a body: both hands, clap, jumping jack, squat, lunge, walk, run, dance, jump, burpee, push up, pull up, kick, fold a shirt, tie, open a jar, barbell | grasp-dependent tasks (pick up, grab, pour, stack, place, hand over) and finger work |

A refused task prints the reasons and a suggestion (choose `--robot g1`, or ask for a one-arm version such as
"raise one arm out to the side"), exits with code 2 and searches nothing. `POST /api/runs` answers 422 with the
same reasons, and the /agent page shows them while you type. A warning lets the run continue and is recorded in
`run.json` as `feasibility` and printed in `REPORT.md`. The honest reason for the grasp warning: the pose model
cannot tell an open hand from a fist, so gripper closing cannot be learned from video yet. Only the path of the
arm is. These are keyword rules, so they catch the obvious mismatches, not every one.

For an arm robot the planner is told the robot is ONE arm, and the plan's `arm` is `left`, `right` or `either`,
never `both`. Videos of people moving both arms are fine: with `either` the judge checks each arm against the
per-arm bars and takes the better one, and that same arm is the one handed to the retargeter.

Steps, each written to `data/runs/<runId>/run.json` as it happens (`REPORT.md` beside it is the readable version):

1. Plan. Gemini (`gemini-flash-latest`, falling back to `gemini-flash-lite-latest`, key from `GEMINI_API_KEY`)
   fills in a fixed form: 4 to 6 search queries, which arm matters, and one machine-checkable motion signature
   (`arm_elevation`, `elbow_flexion` or `wrist_oscillation` with a threshold and a count). The answer is
   treated as untrusted and validated. With no key, or on any failure, deterministic queries are used.
2. Search, one request at a time, at least 1.5 s apart. YouTube is read up to 30 results deep per query, and
   only as many queries are spent as the run needs: the first round is sized to the budget (or to four
   candidates per accepted clip wanted), and the remaining queries are used only if the fetch step runs dry.
   The same video is never emitted twice in a run.
3. Fetch to `data/sources/` (gitignored) and extract pose with the pinned `scripts/extract_pose.py` command.
   If an earlier run already left `data/sources/<key>.mp4` or `data/tracks/<key>.json`, it is reused and
   nothing is downloaded or extracted again.
4. Judge the footage from the track numbers only: tracked frames, arm visibility, person size, limbs in frame,
   frontal view, facing the camera, arm motion, one continuous person (no cuts, including front-to-back cuts),
   whether the planned motion occurs, and its direction (a front raise is not a lateral raise). If the busiest
   stretch of a clip fails, every other whole-second window is tried and the best passing one is pinned.
   Every rejection states the number and the bar, for example "shoulders turned 50.2 deg, limit 35 deg".
5. Retarget accepted clips with `scripts/retarget.mts` (for the G1, `scripts/mirror.mts` is the fallback).
6. Rank the episodes and write the run. Each episode carries its source URL, licence, author and query, both
   in the run and inside the demo file.

Run size. `--max-videos` counts JUDGED videos. From the web page it is capped at 25 (`MAX_VIDEOS_CAP`), because
anyone who can open the page can start a run. From the command line it goes to 80 (`CLI_MAX_VIDEOS_CAP`): about
half of judged clips are accepted, so 20 accepted clips takes 40 or more judged. Download attempts are capped
at twice the budget, because YouTube refuses about 40 percent of media downloads (HTTP 403); a refused clip is
counted and dropped, never retried or worked around. `--target-accepted N` stops the run early once N clips are
accepted. Pacing, licence checks and the first-60-seconds rule are the same at every size.

Licence policy: only footage that may be reused is kept. `pexels` is the Pexels licence. `youtube-cc` searches
with YouTube's Creative Commons filter and then keeps only videos whose own metadata says Creative Commons,
at most 240 s long, downloading the first 60 s at 720p or lower. `--allow-standard-license` exists for the
command line only and is off by default. With it on, standard-licence footage is deleted right after pose
extraction and the episode is marked `poseOnly: true`, so it is never rendered next to its source video.

Pexels search pages sit behind a bot check that refuses headless browsers. The agent records that and moves
on. It does not work around it. Set `PEXELS_API_KEY` (free) and the same source uses the official Pexels API.

Limits, honestly: the output is retargeted kinematic demonstrations, joint targets that follow a person's
motion. The agent does not train a policy, and nothing here shows that a policy trained on these episodes
would work. Video gives no object state and no contact forces, so the dumbbell, the pot or the door are not
in the data at all: only the arm motion is. One camera gives poor depth, which is why the judge insists on
frontal footage. The pose extractor follows one person, so the judge notices a cut or a switch between
people but not a bystander who is never tracked. The footage checks are fixed thresholds tuned on a handful
of clips, and the motion signature checks that a motion of the right kind happened, not that the exercise
was done well. YouTube refuses some media downloads (HTTP 403). Those clips are dropped, not worked around.

## Other robots

The same pose track can drive real fixed-base arms, not only the G1:

```bash
pnpm dlx tsx scripts/retarget.mts --track data/tracks/<id>.json --robot so101|panda|g1 \
  [--arm left|right|auto] [--start <seconds>|auto] [--seconds <n>] --out data/demos/<name>.json
```

Exit code 0 and exactly one line on stdout: `{"out", "robot", "stats"}`. `/render?demo=<name>&mode=source|robot`
shows any of them; `scripts/capture.mts` and `scripts/peek.mts` work unchanged.

- `vendor/so101`: TheRobotStudio SO-ARM101, the official MJCF from `SO-ARM100/Simulation/SO101` (Apache-2.0).
  `vendor/franka_emika_panda`: MuJoCo Menagerie (Apache-2.0). Both unmodified on disk; `armXml` in
  `src/sim/arm.ts` sets the timestep, adds the table and gravity compensation, and for the SO-101 swaps the
  inline kp=998 for the identified STS3215 gain (17.8) from the same repo, because the stock gain reads every
  motion as torque saturation.
- `src/sim/arm.ts`: generic arm. Joints, actuators and gripper are discovered from the compiled model; position
  IK is numeric (damped least squares on a finite-difference Jacobian), with the forearm direction and a home
  posture in the null space; `ArmSim` is the same 250 Hz / 50 Hz fixed-step physics as the G1.
- `src/sim/armRetarget.ts`: one human arm drives the gripper in TASK space. Wrist relative to shoulder, in arm
  lengths, mirrored, scaled to 0.85 of the room the robot measurably has around a per-robot virtual shoulder
  (a table-mounted arm cannot hang its hand below its base, so "hanging" becomes "reaching down to the table").
  Depth comes from foreshortening, attenuated and smoothed harder than the other axes.
- `src/sim/track.ts`: what the G1 mirror and the arms share (zero-phase smoothing, 50 Hz interpolation,
  window picking, lag measurement). `src/sim/mirror.ts` is the G1 full-body mirror, unchanged in output.

Arm limits worth knowing: a robot's joint speed cap is real, so fast human motion (the Panda allows 2.175 rad/s)
is followed late and the stats say so (`speedCapPct`, `trackingErrorCm*`). The gripper reads the pose model's
index and thumb points, which barely move between an open hand and a fist at stock-clip resolution, so on real
footage it has only ever stayed open; closing is proven on synthetic landmarks only. Wrist orientation is not
retargeted.

## Known limits

- The webcam path has not been exercised with a real camera yet. If the robot's arms cross over when
  yours do not, tick "Flip left and right" on the operator page.
- Replay on the wall is open-loop playback of recorded actions. No policy is trained here.
- Episodes are stored on local disk under `.player-two/`.
