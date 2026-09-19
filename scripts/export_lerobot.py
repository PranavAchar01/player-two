"""Write accepted episodes as a LeRobot dataset, using LeRobot's own writer so the format is always current.

usage: export_lerobot.py <episodes_dir> <out_dir>

Only episodes whose every gate passed are exported. Rejected ones are listed in the
dataset card with the gate that failed them. The dataset is loaded back before the
script reports success. Prints one JSON summary line at the end.
"""

import json
import shutil
import sys
from pathlib import Path

import numpy as np
from lerobot.datasets.lerobot_dataset import LeRobotDataset

FPS = 50
JOINTS = [
    f"{side}_{j}"
    for side in ("left", "right")
    for j in ("shoulder_pitch", "shoulder_roll", "shoulder_yaw", "elbow")
]
REPO_ID = "local/player-two"


def main(src: Path, out: Path) -> None:
    episodes = [json.loads(p.read_text()) for p in sorted(src.glob("*.json"))]
    episodes.sort(key=lambda e: e["createdAt"])
    accepted = [e for e in episodes if e["accepted"]]
    rejected = [e for e in episodes if not e["accepted"]]

    if out.exists():
        shutil.rmtree(out)
    vec = {"dtype": "float32", "shape": (len(JOINTS),), "names": JOINTS}
    ds = LeRobotDataset.create(
        REPO_ID,
        fps=FPS,
        features={"observation.state": vec, "action": vec},
        root=out,
        robot_type="player-two-g1-like-upper-body-sim",
        use_videos=False,
    )
    tasks: dict[str, int] = {}
    index = 0
    for e in accepted:
        sentence = f"Strike the {e['task']['slot']} pendulum with the {e['task']['side']} hand."
        tasks[sentence] = tasks.get(sentence, 0) + 1
        for state, action in zip(e["state"], e["ctrl"]):
            ds.add_frame(
                {
                    "observation.state": np.asarray(state, dtype=np.float32),
                    "action": np.asarray(action, dtype=np.float32),
                    "task": sentence,
                }
            )
            index += 1
        ds.save_episode()
    ds.finalize()

    loaded = LeRobotDataset(REPO_ID, root=out)
    assert loaded.num_episodes == len(accepted) and loaded.num_frames == index, (
        "dataset did not load back as written"
    )

    card = [
        "# Player Two demonstrations",
        "",
        "Webcam teleoperation of a simulated humanoid upper body (MuJoCo, 50 Hz control, 8 arm joints).",
        "Every episode was re-simulated on the server and had to pass every gate below to be included.",
        "No video, landmarks or pixels of any operator are stored: only joint targets and joint states.",
        "",
        f"- accepted episodes: {len(accepted)} ({index} frames)",
        f"- rejected episodes: {len(rejected)}",
        f"- operators: {len({e['nickname'] for e in accepted})}",
        "",
        "## Gates",
        "",
        "| gate | requirement |",
        "|---|---|",
    ]
    if episodes:
        card += [f"| {g['label']} | {g['required']} |" for g in episodes[0]["gates"]]
    card += ["", "## Coverage (accepted)", "", "| task | episodes |", "|---|---|"]
    card += [f"| {t} | {n} |" for t, n in tasks.items()]
    card += [
        "",
        "## Rejected episodes",
        "",
        "| id | operator | failed gates |",
        "|---|---|---|",
    ]
    card += [
        f"| {e['id']} | {e['nickname']} | {'; '.join(g['label'] + ' (' + g['measured'] + ')' for g in e['gates'] if not g['pass'])} |"
        for e in rejected
    ]
    (out / "CARD.md").write_text("\n".join(card) + "\n")

    print(
        json.dumps(
            {
                "accepted": len(accepted),
                "rejected": len(rejected),
                "frames": index,
                "tasks": len(tasks),
            }
        )
    )


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
