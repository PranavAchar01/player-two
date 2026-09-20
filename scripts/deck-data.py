"""Writes the numbers the brain deck shows, from real run traces. Nothing here is typed in by hand.

usage: python3 scripts/deck-data.py <first-run-id> <second-run-id> <deck-dir>
The first run is one the brain made with nothing remembered, the second is the same task run again with memory.
A number that a trace does not contain is left out, and the slide shows a dash.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ROBOTS = {"g1": "Unitree G1", "so101": "SO-101", "panda": "Franka Panda"}


def load(run_id: str) -> tuple[dict, dict]:
    d = ROOT / "data/runs" / run_id
    return json.loads((d / "run.json").read_text()), json.loads(
        (d / "brain.json").read_text()
    )


def did(brain: dict, name: str) -> list[dict]:
    return [s for s in brain["steps"] if s["name"] == name]


def main(first: str, second: str, deck: Path) -> None:
    run1, brain1 = load(first)
    run2, brain2 = load(second)
    b2 = run2.get("brain") or {}
    out: dict[str, object] = {}

    failed = lambda run: len(
        [
            c
            for c in run["candidates"]
            if c["stage"] == "failed"
            or (c.get("verdict") and not c["verdict"]["accepted"])
        ]
    )
    attempts = lambda run: len(
        [
            c
            for c in run["candidates"]
            if c["stage"] in ("judged", "failed") and not c.get("reused")
        ]
    )
    title = lambda run: f"{ROBOTS[run['options']['robot']]}, {run['task']}"
    out |= {
        "run1Title": title(run1),
        "run1Downloads": attempts(run1),
        "run1Refused": failed(run1),
        "run1Episodes": len(run1["episodes"]),
    }
    out |= {"run2Title": title(run2), "run2Episodes": len(run2["episodes"])}

    recall = [s for s in did(brain2, "recall") if s["ok"]]
    if recall:
        out |= {
            "run2Recalled": (b2.get("memory") or {}).get("recalled"),
            "run2Skipped": b2.get("skipped"),
        }
        lessons = recall[0].get("lessons") or []
        if lessons:
            out["lesson"] = " ".join(lessons[:2])[:330]
        stored = [
            s for s in did(brain1, "remember") + did(brain2, "remember") if s["ok"]
        ]
        out |= {
            "cogneeNum": sum(s.get("stored", 0) for s in stored),
            "cogneeLabel": "video outcomes in the knowledge graph",
            "cogneeWhat": f"Remembers every video outcome and one lesson per run. On the second run it recalled {out['run2Recalled']} outcomes and saved {out['run2Skipped']} downloads that had already failed.",
        }

    web = [s for s in did(brain2, "discover") if s["ok"]]
    if web:
        out |= {
            "brightNum": sum(s.get("fresh", 0) for s in web),
            "brightLabel": f"web leads from {len(web)} searches",
            "brightWhat": f"Searches the open web for people doing the task. {b2.get('discoveredKept', 0)} of its leads passed the Creative Commons licence gate and went on to the judge.",
        }

    calls = len(brain2["steps"])
    harness = brain2.get("harness", {})
    out |= {
        "strandsNum": calls,
        "strandsLabel": "tool calls in the run",
        "strandsWhat": f"A Strands agent ({harness.get('model', '')}) read the recalled lessons, wrote the web queries and drove four tools: recall, discover, build, remember."
        + (
            " This run fell back to the scripted order because the model was unreachable."
            if harness.get("scripted")
            else ""
        ),
    }

    boxed = (run1.get("brain") or {}).get("sandboxed", 0) + b2.get("sandboxed", 0)
    if boxed:
        out |= {
            "dockerNum": boxed,
            "dockerLabel": "videos decoded in the sandbox",
            "dockerWhat": "Video from the internet is untrusted input. It is decoded and pose-tracked inside a Docker sandbox that sees one folder, and only the numbers come out.",
        }

    deck.mkdir(parents=True, exist_ok=True)
    (deck / "data.json").write_text(
        json.dumps({k: v for k, v in out.items() if v is not None}, indent=1)
    )
    for k, v in out.items():
        print(f"{k}: {v}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], Path(sys.argv[3]))
