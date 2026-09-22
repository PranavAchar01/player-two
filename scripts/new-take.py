"""Finds known voice-over lines in a fresh recording and writes their cut points for assemble-vo.py.

usage: uv run --python 3.12 --with mlx-whisper python scripts/new-take.py <recording>
Two groups of lines are recognised, and a recording may hold either or both:
  goal  (G1, G2)       -> media/vo/goal.json    "The goal of Player Two..." / "MediaPipe tracks..."
  outro (S1 ... S5)    -> media/vo/outro.json   the sponsor lines
Each line is recognised by a word Whisper reliably hears near its start and one near its end, and the split between
two lines is the longest pause between the first line's end word and the next line's start word, so it works whether
the reader paused a second or barely at all. A line said more than once uses its last take.
"""

import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import mlx_whisper

ROOT = Path(__file__).resolve().parent.parent
VO = ROOT / "media/vo"
# (words near the start, words near the end) of each line; alternatives cover what Whisper tends to mishear
GROUPS = {
    "goal": {
        "G1": (r"goal|create", r"data|training"),
        "G2": (r"mediapipe|media|pipe|tracks", r"robot|drives|motion"),
    },
    "outro": {
        "S1": (r"bright|searches", r"task|doing|people|web"),
        "S2": (r"aws|strands|stram|strat|trans|agent", r"drives|step|everything"),
        "S3": (r"video|decoded|deported|deployed|docker", r"numbers|out|come"),
        "S4": (r"remembers|cognee|kongi|kongu|worked", r"failed|fails|skips"),
        "S5": (r"player|layer|learns", r"learns|internet|whole"),
    },
}

src = Path(sys.argv[1]).expanduser()
name = f"take-{int(time.time())}"
subprocess.run(
    [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(src),
        "-vn",
        "-c:a",
        "aac",
        "-b:a",
        "256k",
        str(VO / f"{name}.m4a"),
    ],
    check=True,
)
shutil.copy2(src, VO / f"{name}-original{src.suffix}")
r = mlx_whisper.transcribe(
    str(VO / f"{name}.m4a"),
    path_or_hf_repo="mlx-community/whisper-large-v3-turbo",
    word_timestamps=True,
    language="en",
    condition_on_previous_text=False,
)
words = [w for s in r["segments"] for w in s["words"]]
if not words:
    sys.exit("Whisper heard nothing in the recording")
tok = [re.sub(r"[^a-z0-9]", "", w["word"].lower()) for w in words]
print("heard:", " ".join(w["word"].strip() for w in words))


def hits(pattern: str, lo: int, hi: int) -> list[int]:
    return [i for i in range(lo, hi) if re.fullmatch(pattern, tok[i])]


def gap(i: int) -> float:
    """The pause after word i."""
    return words[i + 1]["start"] - words[i]["end"] if i + 1 < len(words) else 9.0


found_any = False
for group, lines in GROUPS.items():
    keys = list(lines)
    # each line's start word, walking backwards so the last take of every line wins and the order holds
    first: dict[str, int] = {}
    limit = len(words)
    for k in reversed(keys):
        h = hits(lines[k][0], 0, limit)
        if not h:
            break
        first[k] = h[-1]
        limit = h[-1]
    if len(first) < len(keys):
        print(f"{group}: not in this recording")
        continue
    found_any = True
    start = {}
    for n, k in enumerate(keys):
        if n == 0:
            long_pauses = [
                i for i in range(0, first[k]) if gap(i) > 0.8
            ]  # skip a count-in, a false start, another group
            start[k] = long_pauses[-1] + 1 if long_pauses else 0
            continue
        prev = keys[n - 1]
        ends = hits(lines[prev][1], first[prev], first[k])
        lo = ends[-1] if ends else first[prev]
        start[k] = max(range(lo, first[k]), key=gap) + 1 if first[k] > lo else first[k]
    last = next(i for i in range(first[keys[-1]], len(words)) if gap(i) > 0.8)
    cuts, texts = {}, {}
    for n, k in enumerate(keys):
        a = start[k]
        b = (start[keys[n + 1]] - 1) if n + 1 < len(keys) else last
        cuts[k] = [round(max(0.0, words[a]["start"] - 0.05), 3), round(words[b]["end"] + 0.05, 3)]
        texts[k] = " ".join(w["word"].strip() for w in words[a : b + 1])
        if n + 1 < len(keys) and gap(b) < 0.15:
            print(f"note: almost no pause after {k}; the cut there is tight")
    cfg = {"file": name, "cuts": cuts, "lines": texts}
    if group == "outro":
        cfg["endcap"] = "internet" in tok[start["S5"] : last + 1]
    (VO / f"{group}.json").write_text(json.dumps(cfg, indent=1))
    for k in keys:
        print(f"{k} {cuts[k][0]:6.2f}-{cuts[k][1]:6.2f}: {texts[k]}")
    if group == "outro":
        print(
            "end caption:",
            "on"
            if cfg["endcap"]
            else "off (the last word was not heard as 'internet')",
        )
if not found_any:
    sys.exit("none of the known lines were found in this recording")
