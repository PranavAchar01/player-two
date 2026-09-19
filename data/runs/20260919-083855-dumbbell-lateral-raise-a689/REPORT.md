# Agent run: dumbbell lateral raise

Run `20260919-083855-dumbbell-lateral-raise-a689`, robot `g1`, 6 s per episode, up to 6 videos from pexels, youtube-cc. Status: **done**.

Started 2026-09-19T08:38:55.676Z, finished 2026-09-19T08:40:57.836Z.

These are retargeted kinematic demonstrations. No policy was trained, and video carries no object state or contact forces.

## Result

- candidates found: 9 (pexels 0, youtube-cc 9)
- fetched and judged: 6
- accepted: 5, rejected: 1
- episodes written: 5
- most common rejection reasons: one continuous person (1)

## Plan

Planner: gemini (gemini-flash-lite-latest). Note: gemini-flash-latest: HTTP 503

- arm that matters: both
- motion: Both arms lift outward to the sides from the torso until the upper arms reach near horizontal and then return downward.
- machine check: `arm_elevation` threshold 65, at least 2 time(s)
- rejection criteria: More than one person in the frame; Side view or back view instead of front view; Camera is moving or shaking; Cuts or camera angles change during the clip; Arms go out of the camera frame; Only partial body or close up of just the dumbbells; Person is not performing lateral raises; Fast or erratic movements

Queries:

1. front view dumbbell lateral raise demonstration
1. one person doing shoulder lateral raises full body
1. front facing exercise video dumbbell side raise
1. stable camera single person lateral shoulder raise

## Searches

| source | query | found | kept | note |
| --- | --- | ---: | ---: | --- |
| pexels | front view dumbbell lateral raise demonstration | 0 | 0 | pexels.com answered with a bot check (HTTP 403). Not bypassed. Set PEXELS_API_KEY to use the official API instead. |
| youtube-cc | front view dumbbell lateral raise demonstration | 10 | 9 | n/a |

## Episodes, ranked by quality

| rank | episode | quality | retargeter | window | stats | source | licence | author |
| ---: | --- | ---: | --- | --- | --- | --- | --- | --- |
| 1 | `data/demos/agent-g1-youtube-cc-v0y1ofwURX4.json` | 0.993 | retarget.mts | 4.0 s +6 s | tracked 100, limited 0, lagMsBefore 20, lagMsAfter 0 | [youtube-cc v0y1ofwURX4](https://www.youtube.com/watch?v=v0y1ofwURX4) | Creative Commons Attribution (CC BY) | HL |
| 2 | `data/demos/agent-g1-youtube-cc-bGcrurcvkpk.json` | 0.991 | retarget.mts | 21.0 s +6 s | tracked 100, limited 0, lagMsBefore 20, lagMsAfter 0 | [youtube-cc bGcrurcvkpk](https://www.youtube.com/watch?v=bGcrurcvkpk) | Creative Commons Attribution (CC BY) | Fitness Volt |
| 3 | `data/demos/agent-g1-youtube-cc-n3V4nh5G9AE.json` | 0.988 | retarget.mts | 1.8 s +6 s | tracked 100, limited 0.7, lagMsBefore 20, lagMsAfter 0 | [youtube-cc n3V4nh5G9AE](https://www.youtube.com/watch?v=n3V4nh5G9AE) | Creative Commons Attribution (CC BY) | Fitnessyard |
| 4 | `data/demos/agent-g1-youtube-cc-TM6se0vr1VA.json` | 0.986 | retarget.mts | 12.5 s +6 s | tracked 100, limited 1, lagMsBefore 20, lagMsAfter 0 | [youtube-cc TM6se0vr1VA](https://www.youtube.com/watch?v=TM6se0vr1VA) | Creative Commons Attribution (CC BY) | Barbell Logic |
| 5 | `data/demos/agent-g1-youtube-cc-WWhSHS2DrKQ.json` | 0.97 | retarget.mts | 6.7 s +6 s | tracked 95.3, limited 0, lagMsBefore 20, lagMsAfter 0 | [youtube-cc WWhSHS2DrKQ](https://www.youtube.com/watch?v=WWhSHS2DrKQ) | Creative Commons Attribution (CC BY) | Coach Bobby Bluford |

## Candidates

| candidate | licence | author | length | verdict | score | reasons |
| --- | --- | --- | ---: | --- | ---: | --- |
| [youtube-cc-Y29xKcze8Ik](https://www.youtube.com/watch?v=Y29xKcze8Ik) | Creative Commons Attribution (CC BY) | Physique Development | 219 s | failed |  | yt-dlp could not download the clip: ERROR: ffmpeg exited with code 8 |
| [youtube-cc-pgrWjBfaFe8](https://www.youtube.com/watch?v=pgrWjBfaFe8) | Creative Commons Attribution (CC BY) | Colossus Fitness | 103 s | failed |  | yt-dlp could not download the clip: ERROR: ffmpeg exited with code 8 |
| [youtube-cc-bGcrurcvkpk](https://www.youtube.com/watch?v=bGcrurcvkpk) | Creative Commons Attribution (CC BY) | Fitness Volt | 48 s | accepted | 0.985 | all checks passed. most active window (36.18 s) failed: frontal view. Window at 21 s passes every check and is pinned instead. |
| [youtube-cc-n3V4nh5G9AE](https://www.youtube.com/watch?v=n3V4nh5G9AE) | Creative Commons Attribution (CC BY) | Fitnessyard | 18 s | accepted | 0.984 | all checks passed |
| [youtube-cc-TM6se0vr1VA](https://www.youtube.com/watch?v=TM6se0vr1VA) | Creative Commons Attribution (CC BY) | Barbell Logic | 38 s | accepted | 0.984 | all checks passed |
| [youtube-cc-WWhSHS2DrKQ](https://www.youtube.com/watch?v=WWhSHS2DrKQ) | Creative Commons Attribution (CC BY) | Coach Bobby Bluford | 30 s | accepted | 0.981 | all checks passed |
| [youtube-cc-v0y1ofwURX4](https://www.youtube.com/watch?v=v0y1ofwURX4) | Creative Commons Attribution (CC BY) | HL | 19 s | accepted | 0.988 | all checks passed. most active window (7.54 s) failed: one continuous person. Window at 4 s passes every check and is pinned instead. |
| [youtube-cc-3LbW_XoMEt4](https://www.youtube.com/watch?v=3LbW_XoMEt4) | Creative Commons Attribution (CC BY) | HL | 19 s | rejected | 0.989 | one continuous person: 3 sudden jumps in position or size (cut or second person), limit 0 |
| [youtube-cc-v3YOWW1G0lU](https://www.youtube.com/watch?v=v3YOWW1G0lU) | Creative Commons Attribution (CC BY) | Hybrid Fitness | 22 s | skipped |  | not needed: the budget of 6 judged videos (or 9 attempts) was reached first |

## Timings and versions

- plan: done, 5.1 s. gemini (gemini-flash-lite-latest): 4 queries, both arm, arm_elevation 65 x2. gemini-flash-latest: HTTP 503
- search: done, 19.7 s. 9 candidates (pexels 0 usable, youtube-cc 9 usable). Fetching until 6 are judged, at most 9 attempts
- fetch: done, 75.6 s. 6 of 8 attempted videos fetched and tracked, 2 failed
- judge: done, 2.8 s. 5 accepted, 1 rejected
- retarget: done, 18.5 s. 5 episodes written for the g1, 0 failed
- write: done, 0.0 s. data/runs/20260919-083855-dumbbell-lateral-raise-a689/run.json and data/runs/20260919-083855-dumbbell-lateral-raise-a689/REPORT.md

- agent: 0.1.0
- node: v24.15.0
- yt-dlp: 2026.07.04
- mediapipe: 0.10.14 (pinned)
- poseModel: pose_landmarker_lite.task
- extractor: scripts/extract_pose.py
- planner: gemini-flash-lite-latest
