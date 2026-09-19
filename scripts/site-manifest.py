"""Builds the public site's preloaded demos from REAL agent runs. Nothing here is invented:
numbers, step text, rejections, sources, licences and authors all come from data/runs/<id>/run.json.

usage: python3 scripts/site-manifest.py <site-dir>
Clips come from media/source-<episode>.mp4 (rendered by scripts/capture.mts) and are transcoded to 720p.
"""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEMOS = [
    {
        "id": "g1-shoulder-press",
        "run": "20260919-095031-dumbbell-shoulder-press-9180",
        "robot": "Unitree G1",
        "robotId": "g1",
        "task": "do a dumbbell shoulder press",
        "match": ["shoulder press", "dumbbell press", "overhead press"],
    },
    {
        "id": "so101-lateral-raise",
        "run": "20260919-085358-dumbbell-lateral-raise-caa9",
        "robot": "SO-101",
        "robotId": "so101",
        "task": "follow a dumbbell lateral raise",
        "match": ["lateral raise", "side raise"],
    },
]
STEP_NAMES = {
    "plan": "Plan",
    "search": "Search",
    "fetch": "Fetch and track",
    "judge": "Judge footage",
    "retarget": "Retarget",
    "write": "Write dataset",
}
MAX_CLIPS = 6
# Footage is shown mirrored so the person and the robot move on the same side of the screen, which makes burnt-in
# captions read backwards. Until footage is shown unflipped, captioned clips stay out of the public gallery.
CAPTIONED = {"agent-so101-youtube-cc-TM6se0vr1VA", "agent-g1-youtube-cc-2HdeGWc0UF4"}


def short(reason: str) -> str:
    """'motion direction: raised arm points 13% sideways, need 70%...' -> a line a person can read at a glance."""
    name, _, detail = reason.partition(":")
    return f"{name.strip()}: {detail.strip()}"[:140]


def main(site: Path) -> None:
    out_demos = []
    for d in DEMOS:
        run = json.loads((ROOT / "data/runs" / d["run"] / "run.json").read_text())
        cands = run["candidates"]
        judged = [
            c
            for c in cands
            if c.get("verdict")
            and c["verdict"].get("metrics") is not None
            or (c.get("verdict") or {}).get("reasons")
        ]
        accepted = [c for c in cands if (c.get("verdict") or {}).get("accepted")]
        rejected = [c for c in judged if not c["verdict"].get("accepted")]
        clips = []
        dest = site / "media/demo" / d["id"]
        dest.mkdir(parents=True, exist_ok=True)
        for ep in sorted(run["episodes"], key=lambda e: e.get("rank", 99)):
            src = ROOT / "media" / f"source-{ep['name']}.mp4"
            if not src.exists() or len(clips) >= MAX_CLIPS or ep["name"] in CAPTIONED:
                continue
            n = len(clips) + 1
            mp4, jpg = dest / f"clip-{n}.mp4", dest / f"clip-{n}.jpg"
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-loglevel",
                    "quiet",
                    "-i",
                    str(src),
                    "-vf",
                    "scale=1280:720",
                    "-c:v",
                    "libx264",
                    "-crf",
                    "24",
                    "-preset",
                    "slow",
                    "-pix_fmt",
                    "yuv420p",
                    "-an",
                    "-movflags",
                    "+faststart",
                    str(mp4),
                ],
                check=True,
            )
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-loglevel",
                    "quiet",
                    "-ss",
                    "2.4",
                    "-i",
                    str(src),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=960:540",
                    "-q:v",
                    "3",
                    str(jpg),
                ],
                check=True,
            )
            cand = next(
                (c for c in cands if c.get("key") == ep.get("candidateKey")), {}
            )
            prov, st = ep.get("provenance", {}), ep.get("stats", {})
            stats = {
                "tracked": st.get("tracked", st.get("trackedPct")),
                "lagBefore": st.get("lagMsBefore"),
                "lagAfter": st.get("lagMsAfter"),
                "speedCap": st.get("limited", st.get("speedCapPct")),
            }
            err = st.get("trackingErrorCmMean", st.get("trackingErrCmMean"))
            if err is not None:
                stats["trackErrCm"] = round(err, 2)
            clips.append(
                {
                    "file": f"media/demo/{d['id']}/clip-{n}.mp4",
                    "poster": f"media/demo/{d['id']}/clip-{n}.jpg",
                    "title": (cand.get("title") or ep["name"]).strip()[:70],
                    "seconds": ep.get("seconds", 6),
                    "source": "YouTube, Creative Commons"
                    if prov.get("source") == "youtube-cc"
                    else str(prov.get("source")),
                    "url": prov.get("pageUrl"),
                    "licence": (prov.get("licence") or {}).get("name"),
                    "author": prov.get("author") or cand.get("author"),
                    "quality": ep.get("quality"),
                    "stats": stats,
                }
            )
        total_s = sum(s.get("ms", 0) for s in run["steps"]) / 1000
        out_demos.append(
            {
                "id": d["id"],
                "robot": d["robot"],
                "robotId": d["robotId"],
                "task": d["task"],
                "tier": "curated",
                "match": d["match"],
                "agentTask": run["task"],
                "recordedAt": run.get("finishedAt"),
                "summary": {
                    "found": len(cands),
                    "judged": len(judged),
                    "accepted": len(accepted),
                    "rejected": len(rejected),
                    "episodes": len(run["episodes"]),
                    "seconds": round(total_s),
                },
                "steps": [
                    {
                        "name": STEP_NAMES.get(s["name"], s["name"]),
                        "detail": s.get("summary", ""),
                        "ms": s.get("ms", 0),
                    }
                    for s in run["steps"]
                    if s["name"] in STEP_NAMES
                ],
                "rejections": [
                    {
                        "title": (c.get("title") or "").strip()[:60],
                        "reason": short(c["verdict"]["reasons"][0]),
                    }
                    for c in rejected
                    if c["verdict"].get("reasons")
                ][:4],
                "clips": clips,
            }
        )
    (site / "media/demo/manifest.json").write_text(
        json.dumps({"demos": out_demos}, indent=1)
    )
    for d in out_demos:
        print(d["id"], "clips", len(d["clips"]), "summary", d["summary"])


if __name__ == "__main__":
    main(Path(sys.argv[1]))
