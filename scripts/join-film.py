"""Joins the parts of the final video in order with half-second cross-fades, and gives filmed pages their sound.

usage: uv run --with numpy python scripts/join-film.py <out.mp4> <total-seconds> <part> [<part> ...]
A part is either an .mp4 (used as it is, with its own sound) or a film directory from scripts/film-deck.mts
(raw.webm + cues.json), which is trimmed from its first slide to its "done" cue and given a soft swell on each slide
change, a quiet tick when a card lands, and a low bed. The result is cut to the exact total, and a copy with no sound
at all is written next to it (<out>-silent.mp4) so a voice-over can be laid on either.
"""

import json
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

SR, FADE = 48000, 0.5
out, total = Path(sys.argv[1]), float(sys.argv[2])
parts = [Path(p) for p in sys.argv[3:]]
rng = np.random.default_rng(11)


def seconds(f: Path) -> float:
    got = subprocess.run(
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
    )
    return float(got.stdout.strip())


def band(n: int, centre: float, width: float) -> np.ndarray:
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    spec *= np.exp(-(((f - centre) / width) ** 2))
    x = np.fft.irfft(spec, n)
    return x / (np.max(np.abs(x)) + 1e-9)


def page_sound(film: Path, start: float, dur: float) -> Path:
    cues = json.loads((film / "cues.json").read_text())
    audio = np.zeros(int(SR * (dur + 1)))

    def place(x: np.ndarray, t: float, gain: float) -> None:
        i = int(max(0.0, t) * SR)
        j = min(len(audio), i + len(x))
        if j > i:
            audio[i:j] += x[: j - i] * gain

    for c in cues:
        t = c["t"] - start
        if c["type"].startswith("slide-") and c["type"] != "slide-0":
            n = int(SR * 0.7)
            swell = band(n, 700, 500) * np.sin(np.linspace(0, np.pi, n)) ** 2
            note = np.sin(2 * np.pi * 523.25 * np.arange(n) / SR) * np.exp(
                -np.arange(n) / (SR * 0.25)
            )
            place(swell * 0.05 + note * 0.035, t - 0.15, 1.0)
        elif c["type"] == "card":
            n = int(SR * 0.18)
            thud = np.sin(2 * np.pi * 180 * np.arange(n) / SR) * np.exp(
                -np.arange(n) / (SR * 0.03)
            )
            place(
                thud * 0.08
                + band(n, 2600, 1400) * np.exp(-np.arange(n) / (SR * 0.012)) * 0.035,
                t + 0.12,
                1.0,
            )
        elif c["type"] == "slide-0" and film.name.startswith("film-intro"):
            n = int(SR * 1.6)
            chord = (
                sum(
                    np.sin(2 * np.pi * f * np.arange(n) / SR)
                    for f in (261.63, 392.0, 523.25)
                )
                / 3
            )
            place(
                chord
                * np.exp(-np.arange(n) / (SR * 0.6))
                * np.clip(np.arange(n) / (SR * 0.25), 0, 1),
                t + 0.35,
                0.06,
            )
    tt = np.arange(len(audio)) / SR
    bed = sum(
        np.sin(2 * np.pi * f * tt + p) * (0.6 + 0.4 * np.sin(2 * np.pi * r * tt))
        for f, p, r in [(110, 0, 0.05), (164.81, 1.3, 0.07), (220, 2.1, 0.03)]
    )
    audio += bed / 3 * 0.018 * np.clip(tt / 0.6, 0, 1) * np.clip((dur - tt) / 0.6, 0, 1)
    wav = film / "sfx.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(
            (np.clip(np.stack([audio, audio], axis=1), -1, 1) * 32767)
            .astype(np.int16)
            .tobytes()
        )
    return wav


inputs: list[str] = []
chains: list[str] = []
durations: list[float] = []
for k, part in enumerate(parts):
    if part.suffix == ".mp4":
        dur = seconds(part)
        inputs += ["-i", str(part)]
        v, a = len(inputs) // 2 - 1, len(inputs) // 2 - 1
        chains.append(
            f"[{v}:v]fps=30,scale=1920:1080:flags=lanczos,format=yuv420p,setpts=PTS-STARTPTS[v{k}];[{a}:a]aresample=48000,asetpts=PTS-STARTPTS[a{k}]"
        )
    else:
        cues = json.loads((part / "cues.json").read_text())
        start = next(c["t"] for c in cues if c["type"] == "slide-0")
        dur = next(c["t"] for c in cues if c["type"] == "done") - start
        wav = page_sound(part, start, dur)
        inputs += ["-i", str(part / "raw.webm"), "-i", str(wav)]
        v, a = len(inputs) // 2 - 2, len(inputs) // 2 - 1
        chains.append(
            f"[{v}:v]trim=start={start:.3f}:duration={dur:.3f},setpts=PTS-STARTPTS,fps=30,scale=1920:1080:flags=lanczos,format=yuv420p[v{k}];[{a}:a]atrim=duration={dur:.3f},asetpts=PTS-STARTPTS[a{k}]"
        )
    durations.append(dur)

graph = ";".join(chains)
vlast, alast, offset = "v0", "a0", 0.0
for k in range(1, len(parts)):
    offset += durations[k - 1] - FADE
    graph += f";[{vlast}][v{k}]xfade=transition=fade:duration={FADE}:offset={offset:.3f}[vx{k}];[{alast}][a{k}]acrossfade=d={FADE}[ax{k}]"
    vlast, alast = f"vx{k}", f"ax{k}"
graph += f";[{vlast}]fade=t=out:st={total - 0.8:.3f}:d=0.8[v];[{alast}]afade=t=out:st={total - 0.8:.3f}:d=0.8[au]"
natural = sum(durations) - FADE * (len(parts) - 1)
subprocess.run(
    [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        *inputs,
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
starts, t = [], 0.0
for d in durations:
    starts.append(round(t, 2))
    t += d - FADE
print(
    "parts",
    [round(d, 2) for d in durations],
    "start at",
    starts,
    f"natural {natural:.2f} s, cut to {seconds(out):.2f} s",
)
