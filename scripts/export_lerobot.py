"""Write accepted episodes as a LeRobot v2.1-layout dataset.

usage: export_lerobot.py <episodes_dir> <out_dir>

Only episodes whose every gate passed are exported. Rejected ones are listed in the
dataset card with the gate that failed them. Prints one JSON summary line at the end.
"""

import json
import shutil
import sys
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

FPS = 50
JOINTS = [
    f"{side}_{j}"
    for side in ("left", "right")
    for j in ("shoulder_pitch", "shoulder_roll", "shoulder_yaw", "elbow")
]


def stats(a: np.ndarray) -> dict:
    return {
        "min": a.min(0).tolist(),
        "max": a.max(0).tolist(),
        "mean": a.mean(0).tolist(),
        "std": a.std(0).tolist(),
        "count": [int(a.shape[0])],
    }


def main(src: Path, out: Path) -> None:
    episodes = [json.loads(p.read_text()) for p in sorted(src.glob("*.json"))]
    episodes.sort(key=lambda e: e["createdAt"])
    accepted = [e for e in episodes if e["accepted"]]
    rejected = [e for e in episodes if not e["accepted"]]

    if out.exists():
        shutil.rmtree(out)
    (out / "meta").mkdir(parents=True)
    (out / "data" / "chunk-000").mkdir(parents=True)

    tasks: dict[str, int] = {}
    index = 0
    ep_lines, stat_lines = [], []
    for ei, e in enumerate(accepted):
        sentence = f"Strike the {e['task']['slot']} pendulum with the {e['task']['side']} hand."
        ti = tasks.setdefault(sentence, len(tasks))
        action = np.asarray(e["ctrl"], dtype=np.float32)
        state = np.asarray(e["state"], dtype=np.float32)
        n = len(action)
        done = np.zeros(n, dtype=bool)
        done[-1] = True
        table = pa.table(
            {
                "observation.state": pa.array(
                    state.tolist(), type=pa.list_(pa.float32(), len(JOINTS))
                ),
                "action": pa.array(
                    action.tolist(), type=pa.list_(pa.float32(), len(JOINTS))
                ),
                "timestamp": pa.array(np.arange(n, dtype=np.float32) / FPS),
                "frame_index": pa.array(np.arange(n, dtype=np.int64)),
                "episode_index": pa.array(np.full(n, ei, dtype=np.int64)),
                "index": pa.array(np.arange(index, index + n, dtype=np.int64)),
                "task_index": pa.array(np.full(n, ti, dtype=np.int64)),
                "next.done": pa.array(done),
            }
        )
        pq.write_table(table, out / "data" / "chunk-000" / f"episode_{ei:06d}.parquet")
        ep_lines.append(
            {
                "episode_index": ei,
                "tasks": [sentence],
                "length": n,
                "source_id": e["id"],
                "operator": e["nickname"],
                "capture": e["source"],
            }
        )
        stat_lines.append(
            {
                "episode_index": ei,
                "stats": {"observation.state": stats(state), "action": stats(action)},
            }
        )
        index += n

    vec = {"dtype": "float32", "shape": [len(JOINTS)], "names": JOINTS}
    scalar = lambda dtype: {"dtype": dtype, "shape": [1], "names": None}  # noqa: E731
    info = {
        "codebase_version": "v2.1",
        "robot_type": "player-two-g1-like-upper-body-sim",
        "total_episodes": len(accepted),
        "total_frames": index,
        "total_tasks": len(tasks),
        "total_videos": 0,
        "total_chunks": 1,
        "chunks_size": 1000,
        "fps": FPS,
        "splits": {"train": f"0:{len(accepted)}"},
        "data_path": "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
        "video_path": None,
        "features": {
            "observation.state": vec,
            "action": vec,
            "timestamp": scalar("float32"),
            "frame_index": scalar("int64"),
            "episode_index": scalar("int64"),
            "index": scalar("int64"),
            "task_index": scalar("int64"),
            "next.done": scalar("bool"),
        },
    }
    (out / "meta" / "info.json").write_text(json.dumps(info, indent=2))
    (out / "meta" / "tasks.jsonl").write_text(
        "".join(
            json.dumps({"task_index": i, "task": t}) + "\n" for t, i in tasks.items()
        )
    )
    (out / "meta" / "episodes.jsonl").write_text(
        "".join(json.dumps(line) + "\n" for line in ep_lines)
    )
    (out / "meta" / "episodes_stats.jsonl").write_text(
        "".join(json.dumps(line) + "\n" for line in stat_lines)
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
    card += [
        f"| {t} | {sum(1 for line in ep_lines if line['tasks'][0] == t)} |"
        for t in tasks
    ]
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
    (out / "README.md").write_text("\n".join(card) + "\n")

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
