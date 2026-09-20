"""Writes the lines the B-roll terminal shot types out, from one recorded run's own traces.

usage: python3 scripts/broll-log.py <run-id> <deck-dir>
Only steps that really succeeded are shown: a line is never written for something the run did not do.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main(run_id: str, deck: Path) -> None:
    d = ROOT / "data/runs" / run_id
    run, brain = (
        json.loads((d / "run.json").read_text()),
        json.loads((d / "brain.json").read_text()),
    )
    clock = lambda iso: (iso or "")[11:19]  # noqa: E731
    lines = [
        {
            "time": clock(brain["startedAt"]),
            "text": f'strands agent ({brain["harness"]["model"]}): task "{brain["task"]}" on {brain["robot"]}',
        }
    ]
    shown_discover = 0
    for s in brain["steps"]:
        if not s["ok"] or (
            s["name"] == "discover" and (shown_discover := shown_discover + 1) > 2
        ):
            continue
        if s["name"] == "build":
            judged = [c for c in run["candidates"] if c.get("verdict")]
            for c in judged[:2]:
                verdict = "ACCEPTED" if c["verdict"]["accepted"] else "rejected"
                lines.append(
                    {
                        "time": "",
                        "text": f"judge: {c['key']} {verdict} score {c['verdict']['score']}",
                    }
                )
        lines.append(
            {
                "time": "",
                "text": f"brain {s['name']} ({s['provider']}): {s['summary']}"[:150],
            }
        )
    (deck / "log.json").write_text(json.dumps(lines, indent=1))
    for line in lines:
        print(line["text"])


if __name__ == "__main__":
    main(sys.argv[1], Path(sys.argv[2]))
