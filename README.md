# Player Two

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

## Known limits

- The webcam path has not been exercised with a real camera yet. If the robot's arms cross over when
  yours do not, tick "Flip left and right" on the operator page.
- Replay on the wall is open-loop playback of recorded actions. No policy is trained here.
- Episodes are stored on local disk under `.player-two/`.
