"""Cuts the raw site recording into the ~49 s demo and lays in sound effects exactly on the recorded cues.

usage: uv run --with numpy python scripts/edit-film.py <film-dir> <out.mp4>

Typing and the run timeline are sped up; the robot footage stays close to real time so motion looks natural.
Sounds are synthesised on the FINAL timeline (cue times are remapped through the speed changes), so nothing is
pitch shifted. Levels leave room for a voice-over.
"""

import json
import os
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

SR = 48000
film, out = Path(sys.argv[1]), Path(sys.argv[2])
cues = json.loads((film / "cues.json").read_text())


def first(kind: str, after: float = 0.0) -> float:
    return next(c["t"] for c in cues if c["type"] == kind and c["t"] >= after)


def last_before(kind: str, before: float) -> float:
    return [c["t"] for c in cues if c["type"] == kind and c["t"] < before][-1]


# ---- segments of the raw recording: (start, end, speed)
segments: list[tuple[float, float, float]] = []
loaded = first("loaded")
order = [
    int(c["type"].rsplit("-", 1)[1])
    for c in cues
    if c["type"].startswith("demo-start-")
]
for n, which in enumerate(order):
    start, end = first(f"demo-start-{which}"), first(f"demo-end-{which}")
    first_tick = first("tick", start)
    compose = last_before("click", first_tick)
    success = first("success", start)
    clicks_after = [
        c["t"] for c in cues if c["type"] == "click" and success < c["t"] < end
    ]
    if n == 0:
        segments.append(
            (loaded + 0.15, start + 1.0, 1.0)
        )  # the headline resolving out of its blur
        segments.append((start + 1.0, compose, 1.8))
        segments.append((compose, success + 0.6, 1.6))
        segments.append((success + 0.6, end - 0.2, 1.18))
    else:
        segments.append((start + 1.0, compose, 1.9))
        segments.append((compose, success + 0.6, 1.7))
        # second demo: stop two seconds after moving to the next clip in the viewer
        stop = clicks_after[1] + 1.8 if len(clicks_after) > 1 else end - 0.2
        segments.append((success + 0.6, stop, 1.25))


# Hold the cut to TARGET seconds: a longer sentence takes longer to type, so the typing and run-timeline segments
# (the ones already sped up past 1.5x) absorb the difference. The robot footage keeps its near-real-time speed.
TARGET = float(os.environ.get("TARGET", "49"))
fixed = sum((b - a) / sp for a, b, sp in segments if sp < 1.5)
flexible = sum((b - a) / sp for a, b, sp in segments if sp >= 1.5)
if fixed + flexible > TARGET:
    squeeze = flexible / (TARGET - fixed)
    segments = [(a, b, sp * squeeze if sp >= 1.5 else sp) for a, b, sp in segments]


def remap(t: float) -> float | None:
    acc = 0.0
    for a, b, sp in segments:
        if a <= t < b:
            return acc + (t - a) / sp
        acc += (b - a) / sp
    return None


total = sum((b - a) / sp for a, b, sp in segments)
print("final length", round(total, 2), "s from", len(segments), "segments")

# ---- sound design
rng = np.random.default_rng(7)


def env(n: int, decay: float) -> np.ndarray:
    return np.exp(-np.arange(n) / (SR * decay))


def tone(freq: float, dur: float, decay: float) -> np.ndarray:
    n = int(SR * dur)
    return np.sin(2 * np.pi * freq * np.arange(n) / SR) * env(n, decay)


def noise_band(dur: float, lo: float, hi: float, sweep: float = 1.0) -> np.ndarray:
    n = int(SR * dur)
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    spec *= np.exp(-(((f - (lo + hi) / 2) / ((hi - lo) / 2 + 1)) ** 2))
    x = np.fft.irfft(spec, n)
    x /= np.max(np.abs(x)) + 1e-9
    if (
        sweep != 1.0
    ):  # rising or falling brightness, by crossfading into a second, shifted band
        y = noise_band(dur, lo * sweep, hi * sweep)
        ramp = np.linspace(0, 1, n)
        x = x * (1 - ramp) + y * ramp
    return x


def key() -> np.ndarray:
    n = int(SR * 0.03)
    click = noise_band(0.03, 1800, 5200) * env(n, 0.006)
    thump = tone(140 + rng.uniform(-15, 15), 0.03, 0.01) * 0.5
    return (click + thump) * rng.uniform(0.8, 1.05)


def swell(up: bool) -> np.ndarray:
    n = int(SR * 0.26)
    x = noise_band(0.26, 500, 1600, 2.4 if up else 0.45)
    return x * np.sin(np.linspace(0, np.pi, n)) ** 1.5


SOUNDS = {
    "key": (key, 0.085),
    "click": (
        lambda: (
            tone(1150, 0.06, 0.012) * 0.8
            + noise_band(0.06, 2500, 6000) * env(int(SR * 0.06), 0.005) * 0.5
        ),
        0.11,
    ),
    "open": (lambda: swell(True), 0.075),
    "close": (lambda: swell(False), 0.06),
    "hover": (lambda: tone(620, 0.05, 0.015), 0.03),
}
audio = np.zeros(int(SR * (total + 1.0)))


def place(x: np.ndarray, t: float, gain: float) -> None:
    i = int(t * SR)
    j = min(len(audio), i + len(x))
    audio[i:j] += x[: j - i] * gain


tick_pitch = 0
for c in cues:
    t = remap(c["t"])
    if t is None:
        continue
    kind = c["type"]
    if kind == "tick":  # six steps of a run climb a pentatonic scale
        freq = [784, 880, 988, 1175, 1319, 1568][tick_pitch % 6]
        place(tone(freq, 0.22, 0.06) + tone(freq * 2, 0.22, 0.03) * 0.3, t, 0.1)
        tick_pitch += 1
    elif kind == "success":
        tick_pitch = 0
        place(tone(1047, 0.9, 0.28) + tone(1568, 0.9, 0.3) * 0.7, t, 0.12)
        place(tone(2093, 0.9, 0.32) * 0.5, t + 0.11, 0.12)
    elif kind in SOUNDS:
        make, gain = SOUNDS[kind]
        place(make(), t, gain)

# a quiet bed so the silence between sounds is not dead: three slow sines, far under a voice-over
tt = np.arange(len(audio)) / SR
bed = sum(
    np.sin(2 * np.pi * f * tt + p) * (0.6 + 0.4 * np.sin(2 * np.pi * r * tt))
    for f, p, r in [(110, 0, 0.05), (164.81, 1.3, 0.07), (220, 2.1, 0.03)]
)
fade = np.clip(tt / 1.5, 0, 1) * np.clip((tt[-1] - tt) / 2.0, 0, 1)
audio += bed / 3 * 0.018 * fade
audio = np.tanh(audio * 1.4) / 1.4
stereo = np.stack([audio, audio], axis=1)
with wave.open(str(film / "sfx.wav"), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((np.clip(stereo, -1, 1) * 32767).astype(np.int16).tobytes())

# ---- picture
# A recording that is already 1920 wide is left alone; an older 1280 one is scaled up and sharpened a little.
raw_w = int(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", str(film / "raw.webm")], capture_output=True, text=True).stdout.strip() or 0)
SCALE = "" if raw_w >= 1920 else "scale=1920:1080:flags=lanczos,unsharp=5:5:0.5:5:5:0.0,"
# NO_FADE_OUT=1 when another clip follows this one (scripts/join-film.py fades between them)
FADE_OUT = "" if os.environ.get("NO_FADE_OUT") else f",fade=t=out:st={total - 0.6:.3f}:d=0.6"
parts, labels = [], []
for i, (a, b, sp) in enumerate(segments):
    parts.append(
        f"[0:v]trim=start={a:.3f}:end={b:.3f},setpts=(PTS-STARTPTS)/{sp},fps=30[s{i}]"
    )
    labels.append(f"[s{i}]")
graph = (
    ";".join(parts)
    + f";{''.join(labels)}concat=n={len(segments)}:v=1:a=0,{SCALE}fade=t=in:st=0:d=0.5{FADE_OUT}[v]"
)
subprocess.run(
    [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(film / "raw.webm"),
        "-i",
        str(film / "sfx.wav"),
        "-filter_complex",
        graph,
        "-map",
        "[v]",
        "-map",
        "1:a",
        "-c:v",
        "libx264",
        "-crf",
        "19",
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
print("wrote", out)
