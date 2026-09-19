# Agent run: dumbbell lateral raise

Run `20260919-084403-dumbbell-lateral-raise-de7e`, robot `g1`, 6 s per episode, up to 6 videos from pexels, youtube-cc. Status: **done**.

Started 2026-09-19T08:44:04.429Z, finished 2026-09-19T08:46:03.500Z.

These are retargeted kinematic demonstrations. No policy was trained, and video carries no object state or contact forces.

## Result

- candidates found: 9 (pexels 0, youtube-cc 9)
- fetched and judged: 6
- accepted: 3, rejected: 3
- episodes written: 3
- most common rejection reasons: motion direction (3), one continuous person (1), frontal view (1)

## Plan

Planner: gemini (gemini-flash-latest)

- arm that matters: both
- motion: Both arms smoothly raise dumbbells laterally out to the sides until roughly horizontal and lower them back down to the hips.
- machine check: `arm_elevation` threshold 65, at least 1 time(s), direction sideways
- rejection criteria: Dumbbells or hands cut off by the camera frame at top of the raise; Side angle or oblique camera perspective; Camera moving or panning with the exercise; Multiple people visible in the gym background; Rapid cuts or edited speed ramps; Excessive torso swinging or bending; Single-arm variation instead of bilateral raise

Queries:

1. dumbbell lateral raise front view demonstration
1. dumbbell side raise one person front view
1. dumbbell lateral raises full body straight angle
1. person doing dumbbell lateral raise facing camera
1. standing dumbbell side lateral raise exercise front

## Searches

| source | query | found | kept | note |
| --- | --- | ---: | ---: | --- |
| pexels | dumbbell lateral raise front view demonstration | 0 | 0 | pexels.com answered with a bot check (HTTP 403). Not bypassed. Set PEXELS_API_KEY to use the official API instead. |
| youtube-cc | dumbbell lateral raise front view demonstration | 10 | 9 | n/a |

## Episodes, ranked by quality

| rank | episode | quality | retargeter | window | stats | source | licence | author |
| ---: | --- | ---: | --- | --- | --- | --- | --- | --- |
| 1 | `data/demos/agent-g1-youtube-cc-bGcrurcvkpk.json` | 0.991 | retarget.mts | 21.0 s +6 s | tracked 100, limited 0, lagMsBefore 20, lagMsAfter 0 | [youtube-cc bGcrurcvkpk](https://www.youtube.com/watch?v=bGcrurcvkpk) | Creative Commons Attribution (CC BY) | Fitness Volt |
| 2 | `data/demos/agent-g1-youtube-cc-TM6se0vr1VA.json` | 0.986 | retarget.mts | 12.5 s +6 s | tracked 100, limited 1, lagMsBefore 20, lagMsAfter 0 | [youtube-cc TM6se0vr1VA](https://www.youtube.com/watch?v=TM6se0vr1VA) | Creative Commons Attribution (CC BY) | Barbell Logic |
| 3 | `data/demos/agent-g1-youtube-cc-WWhSHS2DrKQ.json` | 0.97 | retarget.mts | 6.7 s +6 s | tracked 95.3, limited 0, lagMsBefore 20, lagMsAfter 0 | [youtube-cc WWhSHS2DrKQ](https://www.youtube.com/watch?v=WWhSHS2DrKQ) | Creative Commons Attribution (CC BY) | Coach Bobby Bluford |

## Candidates

| candidate | licence | author | length | verdict | score | reasons |
| --- | --- | --- | ---: | --- | ---: | --- |
| [youtube-cc-Y29xKcze8Ik](https://www.youtube.com/watch?v=Y29xKcze8Ik) | Creative Commons Attribution (CC BY) | Physique Development | 219 s | failed |  | YouTube refused the media download (HTTP 403). Clip dropped, no workaround attempted. |
| [youtube-cc-pgrWjBfaFe8](https://www.youtube.com/watch?v=pgrWjBfaFe8) | Creative Commons Attribution (CC BY) | Colossus Fitness | 103 s | failed |  | YouTube refused the media download (HTTP 403). Clip dropped, no workaround attempted. |
| [youtube-cc-TM6se0vr1VA](https://www.youtube.com/watch?v=TM6se0vr1VA) | Creative Commons Attribution (CC BY) | Barbell Logic | 38 s | accepted | 0.984 | all checks passed |
| [youtube-cc-v0y1ofwURX4](https://www.youtube.com/watch?v=v0y1ofwURX4) | Creative Commons Attribution (CC BY) | HL | 19 s | rejected | 0.987 | one continuous person: 1 sudden jump in position or size (cut or second person), limit 0; motion direction: raised arm points 13% sideways, need 70% or more for a raise out to the side (less looks like a front raise) |
| [youtube-cc-bGcrurcvkpk](https://www.youtube.com/watch?v=bGcrurcvkpk) | Creative Commons Attribution (CC BY) | Fitness Volt | 48 s | accepted | 0.985 | all checks passed. most active window (36.18 s) failed: frontal view. Window at 21 s passes every check and is pinned instead. |
| [youtube-cc-v3YOWW1G0lU](https://www.youtube.com/watch?v=v3YOWW1G0lU) | Creative Commons Attribution (CC BY) | Hybrid Fitness | 22 s | rejected | 0.878 | motion direction: raised arm points 56.5% sideways, need 70% or more for a raise out to the side (less looks like a front raise) |
| [youtube-cc-gtLbK3irtwA](https://www.youtube.com/watch?v=gtLbK3irtwA) | Creative Commons Attribution (CC BY) | Fitness Volt | 45 s | rejected | 0.824 | frontal view: shoulders turned 45.1 deg from the camera plane, limit 35 deg; motion direction: raised arm points 48.4% sideways, need 70% or more for a raise out to the side (less looks like a front raise) |
| [youtube-cc-WWhSHS2DrKQ](https://www.youtube.com/watch?v=WWhSHS2DrKQ) | Creative Commons Attribution (CC BY) | Coach Bobby Bluford | 30 s | accepted | 0.981 | all checks passed |
| [youtube-cc-3LbW_XoMEt4](https://www.youtube.com/watch?v=3LbW_XoMEt4) | Creative Commons Attribution (CC BY) | HL | 19 s | skipped |  | not needed: the budget of 6 judged videos (or 9 attempts) was reached first |

## Timings and versions

- plan: done, 2.6 s. gemini (gemini-flash-latest): 5 queries, both arm, arm_elevation 65 x1 sideways
- search: done, 22.4 s. 9 candidates (pexels 0 usable, youtube-cc 9 usable). Fetching until 6 are judged, at most 9 attempts
- fetch: done, 81.4 s. 6 of 8 attempted videos fetched and tracked, 2 failed
- judge: done, 1.2 s. 3 accepted, 3 rejected
- retarget: done, 11.0 s. 3 episodes written for the g1, 0 failed
- write: done, 0.0 s. data/runs/20260919-084403-dumbbell-lateral-raise-de7e/run.json and data/runs/20260919-084403-dumbbell-lateral-raise-de7e/REPORT.md

- agent: 0.1.0
- node: v24.15.0
- yt-dlp: 2026.07.04
- mediapipe: 0.10.14 (pinned)
- poseModel: pose_landmarker_lite.task
- extractor: scripts/extract_pose.py
- planner: gemini-flash-latest
