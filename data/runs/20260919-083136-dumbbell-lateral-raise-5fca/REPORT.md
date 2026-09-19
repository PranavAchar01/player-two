# Agent run: dumbbell lateral raise

Run `20260919-083136-dumbbell-lateral-raise-5fca`, robot `g1`, 6 s per episode, up to 6 videos from pexels, youtube-cc. Status: **done**.

Started 2026-09-19T08:31:36.926Z, finished 2026-09-19T08:35:35.640Z.

These are retargeted kinematic demonstrations. No policy was trained, and video carries no object state or contact forces.

## Result

- candidates found: 6 (pexels 0, youtube-cc 6)
- fetched and judged: 4
- accepted: 2, rejected: 2
- episodes written: 2
- most common rejection reasons: one continuous person (1), frontal view (1)

## Plan

Planner: gemini (gemini-flash-latest)

- arm that matters: both
- motion: Both arms simultaneously lift dumbbells outward to the sides until upper arms reach approximately horizontal shoulder level and then lower steadily back down.
- machine check: `arm_elevation` threshold 65, at least 1 time(s)
- rejection criteria: Side profile or angled camera view; Hands or dumbbells crop out of frame at top of lift; Camera moving, panning, or shaking; Cuts or transitions between repetitions; Multiple people visible in shot; Excessive torso swinging or momentum-driven reps; Front raises performed instead of lateral raises

Queries:

1. dumbbell lateral raise front view demonstration
1. person doing lateral raises front view full body
1. dumbbell side lateral raise exercise front view
1. dumbbell lateral raise form one person front
1. standing lateral raise demonstration front view

## Searches

| source | query | found | kept | note |
| --- | --- | ---: | ---: | --- |
| pexels | dumbbell lateral raise front view demonstration | 0 | 0 | pexels.com answered with a bot check (HTTP 403). Not bypassed. Set PEXELS_API_KEY to use the official API instead. |
| youtube-cc | dumbbell lateral raise front view demonstration | 10 | 6 | n/a |

## Episodes, ranked by quality

| rank | episode | quality | retargeter | window | stats | source | licence | author |
| ---: | --- | ---: | --- | --- | --- | --- | --- | --- |
| 1 | `data/demos/agent-g1-youtube-cc-TM6se0vr1VA.json` | 0.986 | retarget.mts | 12.5 s +6 s | tracked 100, limited 1, lagMsBefore 20, lagMsAfter 0 | [youtube-cc TM6se0vr1VA](https://www.youtube.com/watch?v=TM6se0vr1VA) | Creative Commons Attribution (CC BY) | Barbell Logic |
| 2 | `data/demos/agent-g1-youtube-cc-v3YOWW1G0lU.json` | 0.924 | retarget.mts | 13.5 s +6 s | tracked 100, limited 0.7, lagMsBefore 20, lagMsAfter 20 | [youtube-cc v3YOWW1G0lU](https://www.youtube.com/watch?v=v3YOWW1G0lU) | Creative Commons Attribution (CC BY) | Hybrid Fitness |

## Candidates

| candidate | licence | author | length | verdict | score | reasons |
| --- | --- | --- | ---: | --- | ---: | --- |
| [youtube-cc-Y29xKcze8Ik](https://www.youtube.com/watch?v=Y29xKcze8Ik) | Creative Commons Attribution (CC BY) | Physique Development | 219 s | failed |  | ERROR: ffmpeg exited with code 8 |
| [youtube-cc-pgrWjBfaFe8](https://www.youtube.com/watch?v=pgrWjBfaFe8) | Creative Commons Attribution (CC BY) | Colossus Fitness | 103 s | failed |  | ERROR: ffmpeg exited with code 8 |
| [youtube-cc-TM6se0vr1VA](https://www.youtube.com/watch?v=TM6se0vr1VA) | Creative Commons Attribution (CC BY) | Barbell Logic | 38 s | accepted | 0.984 | all checks passed |
| [youtube-cc-v0y1ofwURX4](https://www.youtube.com/watch?v=v0y1ofwURX4) | Creative Commons Attribution (CC BY) | HL | 19 s | rejected | 0.987 | one continuous person: 1 sudden jump in position or size (cut or second person), limit 0 |
| [youtube-cc-bGcrurcvkpk](https://www.youtube.com/watch?v=bGcrurcvkpk) | Creative Commons Attribution (CC BY) | Fitness Volt | 48 s | rejected | 0.855 | frontal view: shoulders turned 38 deg from the camera plane, limit 35 deg |
| [youtube-cc-v3YOWW1G0lU](https://www.youtube.com/watch?v=v3YOWW1G0lU) | Creative Commons Attribution (CC BY) | Hybrid Fitness | 22 s | accepted | 0.878 | all checks passed |

## Timings and versions

- plan: done, 4.0 s. gemini (gemini-flash-latest): 5 queries, both arm, arm_elevation 65 x1
- search: done, 19.1 s. 6 candidates (pexels 0 usable, youtube-cc 6 usable), 6 chosen to fetch
- fetch: done, 198.1 s. 4 of 6 fetched and tracked, 2 failed
- judge: done, 0.3 s. 2 accepted, 2 rejected
- retarget: done, 16.1 s. 2 episodes written for the g1, 0 failed
- write: done, 0.0 s. data/runs/20260919-083136-dumbbell-lateral-raise-5fca/run.json and data/runs/20260919-083136-dumbbell-lateral-raise-5fca/REPORT.md

- agent: 0.1.0
- node: v24.15.0
- yt-dlp: 2026.07.04
- mediapipe: 0.10.14 (pinned)
- poseModel: pose_landmarker_lite.task
- extractor: scripts/extract_pose.py
- planner: gemini-flash-latest
