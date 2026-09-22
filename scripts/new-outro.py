"""Finds the five sponsor lines in a fresh outro recording and writes media/vo/outro.json for assemble-vo.py.

usage: uv run --python 3.12 --with mlx-whisper python scripts/new-outro.py <recording>
Any audio file works. Each line is recognised by a word Whisper reliably hears near its start and one near its end, and
the split between two lines is the longest pause between the first line's end word and the next line's start word, so it
works whether the reader paused a second or barely at all. A line said more than once uses its last take.
"""

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import mlx_whisper

ROOT = Path(__file__).resolve().parent.parent
VO = ROOT / "media/vo"
# (words near the start, words near the end) of each line; alternatives cover what Whisper tends to mishear
LINES = {
    "S1": (r"bright|data|searches", r"task|doing|people|web"),
    "S2": (r"aws|strands|stram|strat|agent", r"drives|step|everything"),
    "S3": (r"video|decoded|deported|docker", r"numbers|out|come"),
    "S4": (r"remembers|cognee|kongi|worked", r"failed|fails|skips"),
    "S5": (r"player|layer|robot|learns", r"learns|internet|whole"),
}

src = Path(sys.argv[1]).expanduser()
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
        str(VO / "outro.m4a"),
    ],
    check=True,
)
shutil.copy2(src, VO / f"outro-original{src.suffix}")
r = mlx_whisper.transcribe(
    str(VO / "outro.m4a"),
    path_or_hf_repo="mlx-community/whisper-large-v3-turbo",
    word_timestamps=True,
    language="en",
    condition_on_previous_text=False,
)
words = [w for s in r["segments"] for w in s["words"]]
tok = [re.sub(r"[^a-z0-9]", "", w["word"].lower()) for w in words]
heard = " ".join(w["word"].strip() for w in words)
keys = list(LINES)


def hits(pattern: str, lo: int, hi: int) -> list[int]:
    return [i for i in range(lo, hi) if re.fullmatch(pattern, tok[i])]


def gap(i: int) -> float:
    """The pause after word i."""
    return words[i + 1]["start"] - words[i]["end"]


# each line's start word, walking backwards so the last take of every line wins and the order holds
first: dict[str, int] = {}
limit = len(words)
for k in reversed(keys):
    h = hits(LINES[k][0], 0, limit)
    if not h:
        sys.exit(f"could not find {k} (start words /{LINES[k][0]}/) in: {heard}")
    first[k] = h[-1]
    limit = h[-1]

# where each line starts: after the longest pause between the previous line's end word and this line's start word
start = {}
for n, k in enumerate(keys):
    if n == 0:
        long_pauses = [
            i for i in range(first[k]) if gap(i) > 0.8
        ]  # skip a count-in or a false start
        start[k] = long_pauses[-1] + 1 if long_pauses else 0
        continue
    prev = keys[n - 1]
    ends = hits(LINES[prev][1], first[prev], first[k])
    lo = ends[-1] if ends else first[prev]
    start[k] = max(range(lo, first[k]), key=gap) + 1 if first[k] > lo else first[k]
stop_after = [i for i in range(first["S5"], len(words) - 1) if gap(i) > 0.8]
last_word = stop_after[0] if stop_after else len(words) - 1

cuts, texts = {}, {}
for n, k in enumerate(keys):
    a = start[k]
    b = (start[keys[n + 1]] - 1) if n + 1 < len(keys) else last_word
    cuts[k] = [round(words[a]["start"] - 0.05, 3), round(words[b]["end"] + 0.05, 3)]
    texts[k] = " ".join(w["word"].strip() for w in words[a : b + 1])
    if n + 1 < len(keys) and gap(b) < 0.15:
        print(f"note: almost no pause after {k}; the cut there is tight", flush=True)
cfg = {
    "file": "outro",
    "cuts": cuts,
    "lines": texts,
    "endcap": "internet" in tok[start["S5"] : last_word + 1],
}
(VO / "outro.json").write_text(json.dumps(cfg, indent=1))
for k in keys:
    print(f"{k} {cuts[k][0]:6.2f}-{cuts[k][1]:6.2f}: {texts[k]}")
print(
    "end caption:",
    "on" if cfg["endcap"] else "off (the last word was not heard as 'internet')",
)
