"""Joins the app demo and the filmed slideshow into the final video, and gives the slides one soft sound per change.

usage: uv run --with numpy python scripts/join-film.py <app.mp4> <deck-film-dir> <out.mp4> [total-seconds=80]
The app clip keeps its own sound. The two are cross-faded for half a second, and the result is cut to the exact
total so a voice-over can be timed against it. A copy with no sound at all is written next to it (<out>-silent.mp4).
"""

import json
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

SR, FADE = 48000, 0.5
app, deck_dir, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
total = float(sys.argv[4]) if len(sys.argv) > 4 else 80.0


def seconds(f: Path) -> float:
    return float(
        subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
                str(f),
            ],
            capture_output=True,
            text=True,
            check=False,
        ).stdout.strip()
    )


app_s = seconds(app)
cues = json.loads((deck_dir / "cues.json").read_text())
first_slide = next(c["t"] for c in cues if c["type"] == "slide-0")
deck_s = total - app_s + FADE  # how much of the deck recording is needed

# ---- deck sound: a low soft swell on each slide change, and the same quiet bed as the app clip
rng = np.random.default_rng(11)
audio = np.zeros(int(SR * (deck_s + 1)))
for c in cues:
    if not c["type"].startswith("slide-") or c["type"] == "slide-0":
        continue
    t = c["t"] - first_slide
    n = int(SR * 0.7)
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    spec *= np.exp(-(((f - 700) / 500) ** 2))
    swell = np.fft.irfft(spec, n)
    swell = (
        swell / (np.max(np.abs(swell)) + 1e-9) * np.sin(np.linspace(0, np.pi, n)) ** 2
    )
    note = np.sin(2 * np.pi * 523.25 * np.arange(n) / SR) * np.exp(
        -np.arange(n) / (SR * 0.25)
    )
    i = int(max(0, t - 0.15) * SR)
    j = min(len(audio), i + n)
    audio[i:j] += (swell * 0.05 + note * 0.035)[: j - i]
tt = np.arange(len(audio)) / SR
bed = sum(
    np.sin(2 * np.pi * f * tt + p) * (0.6 + 0.4 * np.sin(2 * np.pi * r * tt))
    for f, p, r in [(110, 0, 0.05), (164.81, 1.3, 0.07), (220, 2.1, 0.03)]
)
audio += bed / 3 * 0.018 * np.clip(tt / 1.0, 0, 1) * np.clip((deck_s - tt) / 2.5, 0, 1)
with wave.open(str(deck_dir / "sfx.wav"), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(
        (np.clip(np.stack([audio, audio], axis=1), -1, 1) * 32767)
        .astype(np.int16)
        .tobytes()
    )

graph = (
    f"[1:v]trim=start={first_slide:.3f}:duration={deck_s:.3f},setpts=PTS-STARTPTS,fps=30,scale=1920:1080:flags=lanczos,format=yuv420p[d];"
    f"[0:v]fps=30,format=yuv420p[a];[a][d]xfade=transition=fade:duration={FADE}:offset={app_s - FADE:.3f},fade=t=out:st={total - 0.8:.3f}:d=0.8[v];"
    f"[2:a]atrim=duration={deck_s:.3f}[da];[0:a][da]acrossfade=d={FADE}[au]"
)
subprocess.run(
    [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(app),
        "-i",
        str(deck_dir / "raw.webm"),
        "-i",
        str(deck_dir / "sfx.wav"),
        "-filter_complex",
        graph,
        "-map",
        "[v]",
        "-map",
        "[au]",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-preset",
        "slow",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-t",
        f"{total:.3f}",
        "-movflags",
        "+faststart",
        str(out),
    ],
    check=True,
)
silent = out.with_name(out.stem + "-silent.mp4")
subprocess.run(
    [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(out),
        "-c:v",
        "copy",
        "-an",
        "-movflags",
        "+faststart",
        str(silent),
    ],
    check=True,
)
print(
    f"app {app_s:.2f} s + deck {deck_s:.2f} s -> {seconds(out):.2f} s: {out} and {silent}"
)
