"""Builds the voiced video: Pranav's intro recording, then the app demo, then the stack B-roll, all timed to his voice.

usage: uv run --with numpy python scripts/assemble-vo.py            (the deck server must be up on :4640)
Inputs: media/vo/intro.m4a + lines.m4a (his recordings) and their Whisper word timings (*.large.json), media/app-50s.mp4.
Output: media/player-two-brains-vo.mp4 and a 720p preview.

The picture follows the voice, never the other way round: every B-roll shot starts on the word it illustrates, each demo
piece is as long as the line spoken over it, and pauses longer than 0.55 s inside a take are shortened to 0.35 s.
"""

import json
import subprocess
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
VO = ROOT / "media/vo"
SR, FADE, PIECE_FADE = 48000, 0.5, 0.25
DECK = "http://localhost:4640/broll.html"


def sh(*args: str) -> str:
    return subprocess.run(list(args), check=True, capture_output=True, text=True).stdout


# ---------------------------------------------------------------- voice
def level(name: str, denoise: bool) -> tuple[np.ndarray, float]:
    """(Light hiss reduction,) high-pass, a gentle compressor, then two-pass loudness normalisation to -16 LUFS with a
    -1.5 dBTP ceiling. Returns the audio and the silence threshold for this recording (its noise floor + 12 dB)."""
    chain = "aformat=channel_layouts=mono," + ("afftdn=nr=12:nf=-44:tn=1," if denoise else "") + "highpass=f=80,acompressor=threshold=-24dB:ratio=2.5:attack=8:release=150"
    src = str(VO / f"{name}.m4a")
    stats = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", src, "-af", f"{chain},loudnorm=I=-16:TP=-1.5:LRA=9:print_format=json", "-f", "null", "-"],
                           capture_output=True, text=True, check=True).stderr
    m = json.loads(stats[stats.rindex("{") : stats.rindex("}") + 1])
    # a straight gain to -16 LUFS, then a limiter for the few peaks it pushes past -1.5 dBFS (loudnorm's linear mode
    # refuses the gain instead, which left the quieter takes 3 to 4 dB under the rest)
    norm = f"volume={-16 - float(m['input_i']):.2f}dB,alimiter=limit=0.84:attack=5:release=50:level=false"
    out = VO / f"{name}-level.wav"
    sh("ffmpeg", "-y", "-loglevel", "error", "-i", src, "-af", f"{chain},{norm},aresample={SR}", "-ac", "1", "-c:a", "pcm_s16le", str(out))
    with wave.open(str(out)) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    floor = float(np.percentile(frames_db(x, SR // 100), 10))
    return x, max(floor + 12, -52.0)


def frames_db(x: np.ndarray, hop: int) -> np.ndarray:
    n = len(x) // hop
    return 20 * np.log10(np.sqrt(np.mean(x[: n * hop].reshape(n, hop) ** 2, axis=1)) + 1e-9)


def clean_cut(x: np.ndarray, thr: float, t: float, forward: bool) -> float:
    """Move a cut into silence without entering a word: a start cut walks back to the nearest quiet 10 ms, an end cut
    walks forward until 40 ms in a row are quiet (Whisper's word ends are often early, so the tail is kept)."""
    hop = SR // 100
    quiet = lambda i: 20 * np.log10(np.sqrt(np.mean(x[i : i + hop] ** 2)) + 1e-9) < thr
    i = int(t * SR)
    for _ in range(80):
        if forward and all(quiet(i + k * hop) for k in range(4)):
            return (i + 2 * hop) / SR
        if not forward and quiet(i):
            return (i + hop // 2) / SR
        i += hop if forward else -hop
    return t


def take(x: np.ndarray, thr: float, a: float, b: float) -> tuple[np.ndarray, list[tuple[float, float]]]:
    """Cut [a, b], trim silence at both ends to 80/120 ms, and shorten pauses over 0.55 s to 0.35 s. Returns the audio
    and knots mapping original time to time in the take."""
    hop = SR // 50
    db = frames_db(x[int(a * SR) : int(b * SR)], hop)
    loud = np.flatnonzero(db >= thr)
    if len(loud):
        a, b = max(a, a + loud[0] * hop / SR - 0.08), min(b, a + (loud[-1] + 1) * hop / SR + 0.12)
    seg = x[int(a * SR) : int(b * SR)].copy()
    silent = frames_db(seg, hop) < thr
    keep: list[tuple[int, int]] = []
    knots = [(a, 0.0)]
    i, pos, out_len = 0, 0, 0
    while i < len(silent):
        if silent[i]:
            j = i
            while j < len(silent) and silent[j]:
                j += 1
            if (j - i) * hop / SR > 0.55 and i > 0 and j < len(silent):
                cut_from = i * hop + int(0.175 * SR)
                cut_to = j * hop - int(0.175 * SR)
                keep.append((pos, cut_from))
                out_len += cut_from - pos
                knots.append((a + cut_from / SR, out_len / SR))
                knots.append((a + cut_to / SR, out_len / SR))
                pos = cut_to
            i = j
        else:
            i += 1
    keep.append((pos, len(seg)))
    fade = int(0.015 * SR)
    parts = []
    for s0, s1 in keep:
        piece = seg[s0:s1].copy()
        if len(piece) > 2 * fade:
            piece[:fade] *= np.linspace(0, 1, fade)
            piece[-fade:] *= np.linspace(1, 0, fade)
        parts.append(piece)
    audio = np.concatenate(parts)
    knots.append((b, len(audio) / SR))
    return audio, knots


def remap(knots: list[tuple[float, float]], t: float) -> float:
    return float(np.interp(t, [k[0] for k in knots], [k[1] for k in knots]))


def lines_between(x: np.ndarray, thr: float, bounds: list[float], keys: list[str]) -> dict[str, np.ndarray]:
    """Consecutive lines from one take. Each boundary is where Whisper says the previous line's last word ends; the
    real end is found by walking forward into silence, and the next line starts from that same point."""
    cuts = [clean_cut(x, thr, bounds[0], False)] + [clean_cut(x, thr, t, True) for t in bounds[1:]]
    return {k: take(x, thr, cuts[i], cuts[i + 1])[0] for i, k in enumerate(keys)}


# Recordings: intro4 = "Public Storage 4" (his re-recorded intro), lines6 = "Public Storage 6" (the demo lines, re-recorded),
# lines = "Public Storage" (the first take, still used for the outro until he re-records it).
intro_x, intro_thr = level("intro4", True)
demo_x, demo_thr = level("lines6", True)
old_x, old_thr = level("lines", False)
intro, iknots = take(intro_x, intro_thr, clean_cut(intro_x, intro_thr, 1.30, False), clean_cut(intro_x, intro_thr, 31.26, True))
at = lambda t: remap(iknots, t)
clips = lines_between(demo_x, demo_thr, [5.25, 13.98, 20.66, 26.14, 30.34, 37.08, 41.10], ["D1", "D2", "D3", "D4", "D5", "D6"])
OUTRO = {"S1": (43.30, 45.82), "S2": (46.20, 49.70), "S3": (50.16, 53.92), "S4": (54.44, 57.92), "S5": (58.04, 60.62)}
clips |= {k: take(old_x, old_thr, clean_cut(old_x, old_thr, a, False), clean_cut(old_x, old_thr, b_, True))[0] for k, (a, b_) in OUTRO.items()}
ln = {k: len(v) / SR for k, v in clips.items()}

# ---------------------------------------------------------------- the timeline
T0 = 0.30  # the intro voice starts here
# shot changes on the first word of each sentence: agent, gap, supply, internet, research
b = [0.0] + [T0 + at(w) - 0.25 for w in (3.82, 9.06, 13.80, 17.42, 25.32)]
demo_at = T0 + at(29.30) - 0.30  # the landing page comes up on "Here's a quick demo"
intro_dwell = [b[i + 1] - b[i] for i in range(5)] + [demo_at - b[5] + FADE]

# demo pieces cut from app-50s.mp4: (app start, app end), sized to the line spoken over each
# Each piece: (app start, shortest end, latest end before the next thing on screen), how far into the piece its line
# starts, and how long the picture holds after the line. A line never starts until the one before it has finished
# plus GAP, and a piece grows (up to its limit) to hold its line.
GAP = 0.35
PIECES = [
    (0.0, 11.4, 11.4, 2.55, 0.0),
    (11.4, 17.0, 21.85, 0.35, 0.6),
    (21.85, 26.6, 27.75, 0.25, 0.3),
    (27.75, 36.0, 36.0, 1.2, 0.0),
    (36.0, 42.0, 45.8, 0.3, 0.6),
    (45.8, 50.0, 50.0, 0.3, 0.3),
]
K: list[tuple[float, float]] = []
vo_demo: dict[str, float] = {}
prev_end = T0 + len(intro) / SR - demo_at  # the intro's last word, in demo time
t = 0.0
for i, (a0, a1_min, a1_max, lead, tail) in enumerate(PIECES):
    key = f"D{i + 1}"
    start = max(t + lead, prev_end + GAP)
    prev_end = start + ln[key]
    length = min(a1_max - a0, max(a1_min - a0, prev_end + tail - t + PIECE_FADE))
    K.append((a0, a0 + length))
    vo_demo[key] = start
    t += length - PIECE_FADE
demo_len = t + PIECE_FADE
stack_at = demo_at + demo_len - FADE
s1_lead = max(
    0.35, demo_at + prev_end + GAP - stack_at
)  # the last demo line may run past the demo's last frame
stack_lead = [s1_lead, 0.35, 0.35, 0.35, 0.35]
stack_dwell = [
    ln["S1"] + s1_lead + 0.6,
    ln["S2"] + 0.95,
    ln["S3"] + 0.95,
    ln["S4"] + 0.95,
    ln["S5"] + 2.4,
]


# ---------------------------------------------------------------- film the two B-roll sets
def film(set_name: str, dwell: list[float]) -> tuple[Path, list[float], float]:
    out = ROOT / f"media/film-vo-{set_name}"
    url = f"{DECK}?set={set_name}&dwell={','.join(str(round(d * 1000)) for d in dwell)}"
    subprocess.run(
        [
            "zsh",
            "-ic",
            f"cd {ROOT} && pnpm dlx tsx scripts/film-deck.mts {out} '{url}'",
        ],
        check=True,
        capture_output=True,
    )
    cues = json.loads((out / "cues.json").read_text())
    s0 = next(c["t"] for c in cues if c["type"] == "slide-0")
    slides = [c["t"] - s0 for c in cues if c["type"].startswith("slide-")]
    return out, slides, next(c["t"] for c in cues if c["type"] == "done") - s0


def page_sound(film_dir: Path, dur: float, chord: bool) -> Path:
    rng = np.random.default_rng(11)
    cues = json.loads((film_dir / "cues.json").read_text())
    s0 = next(c["t"] for c in cues if c["type"] == "slide-0")
    audio = np.zeros(int(SR * (dur + 1)))

    def band(n: int, centre: float, width: float) -> np.ndarray:
        spec = np.fft.rfft(rng.standard_normal(n))
        spec *= np.exp(-(((np.fft.rfftfreq(n, 1 / SR) - centre) / width) ** 2))
        y = np.fft.irfft(spec, n)
        return y / (np.max(np.abs(y)) + 1e-9)

    def place(y: np.ndarray, at_s: float, gain: float) -> None:
        i = int(max(0.0, at_s) * SR)
        j = min(len(audio), i + len(y))
        if j > i:
            audio[i:j] += y[: j - i] * gain

    for c in cues:
        tt = c["t"] - s0
        if c["type"].startswith("slide-") and c["type"] != "slide-0":
            n = int(SR * 0.7)
            place(
                band(n, 700, 500) * np.sin(np.linspace(0, np.pi, n)) ** 2 * 0.05
                + np.sin(2 * np.pi * 523.25 * np.arange(n) / SR)
                * np.exp(-np.arange(n) / (SR * 0.25))
                * 0.03,
                tt - 0.15,
                1.0,
            )
        elif c["type"] == "card":
            n = int(SR * 0.18)
            place(
                np.sin(2 * np.pi * 180 * np.arange(n) / SR)
                * np.exp(-np.arange(n) / (SR * 0.03))
                * 0.08
                + band(n, 2600, 1400) * np.exp(-np.arange(n) / (SR * 0.012)) * 0.035,
                tt + 0.12,
                1.0,
            )
        elif c["type"] == "slide-0" and chord:
            n = int(SR * 1.6)
            y = (
                sum(
                    np.sin(2 * np.pi * f * np.arange(n) / SR)
                    for f in (261.63, 392.0, 523.25)
                )
                / 3
            )
            place(
                y
                * np.exp(-np.arange(n) / (SR * 0.6))
                * np.clip(np.arange(n) / (SR * 0.25), 0, 1),
                tt + 0.35,
                0.06,
            )
    ts = np.arange(len(audio)) / SR
    bed = sum(
        np.sin(2 * np.pi * f * ts + p) * (0.6 + 0.4 * np.sin(2 * np.pi * r * ts))
        for f, p, r in [(110, 0, 0.05), (164.81, 1.3, 0.07), (220, 2.1, 0.03)]
    )
    audio += bed / 3 * 0.018 * np.clip(ts / 0.6, 0, 1) * np.clip((dur - ts) / 0.6, 0, 1)
    wav = film_dir / "sfx.wav"
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


intro_dir, intro_slides, intro_len = film("intro", intro_dwell)
stack_dir, stack_slides, stack_len = film("stack", stack_dwell)
intro_sfx, stack_sfx = (
    page_sound(intro_dir, intro_len, True),
    page_sound(stack_dir, stack_len, False),
)
intro_s0 = next(
    c["t"]
    for c in json.loads((intro_dir / "cues.json").read_text())
    if c["type"] == "slide-0"
)
stack_s0 = next(
    c["t"]
    for c in json.loads((stack_dir / "cues.json").read_text())
    if c["type"] == "slide-0"
)
total = stack_at + stack_len

# ---------------------------------------------------------------- the voice track
vo = np.zeros(int(SR * (total + 1)), np.float32)


def put(y: np.ndarray, at_s: float) -> None:
    i = int(at_s * SR)
    vo[i : i + len(y)] += y[: max(0, len(vo) - i)]


put(intro, T0)
for k, local in vo_demo.items():
    put(clips[k], demo_at + local)
for i, k in enumerate(["S1", "S2", "S3", "S4", "S5"]):
    put(clips[k], stack_at + stack_slides[i] + stack_lead[i])
vo_wav = VO / "voice-track.wav"
with wave.open(str(vo_wav), "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((np.clip(vo, -1, 1) * 32767).astype(np.int16).tobytes())

# ---------------------------------------------------------------- picture and sound in one graph
app = ROOT / "media/app-50s.mp4"
g = [
    f"[0:v]trim=start={intro_s0:.3f}:duration={intro_len:.3f},setpts=PTS-STARTPTS,fps=30,format=yuv420p[vi]",
    f"[1:a]atrim=duration={intro_len:.3f},asetpts=PTS-STARTPTS[ai]",
]
for i, (a0, a1) in enumerate(K):
    g.append(
        f"[2:v]trim=start={a0:.3f}:end={a1:.3f},setpts=PTS-STARTPTS,fps=30,format=yuv420p[k{i}]"
    )
    g.append(
        f"[2:a]atrim=start={a0:.3f}:end={a1:.3f},asetpts=PTS-STARTPTS,aresample={SR}[q{i}]"
    )
vl, al, off = "k0", "q0", 0.0
for i in range(1, len(K)):
    off += (K[i - 1][1] - K[i - 1][0]) - PIECE_FADE
    g.append(
        f"[{vl}][k{i}]xfade=transition=fade:duration={PIECE_FADE}:offset={off:.3f}[kx{i}]"
    )
    g.append(f"[{al}][q{i}]acrossfade=d={PIECE_FADE}[qx{i}]")
    vl, al = f"kx{i}", f"qx{i}"
g += [
    f"[3:v]trim=start={stack_s0:.3f}:duration={stack_len:.3f},setpts=PTS-STARTPTS,fps=30,format=yuv420p[vs]",
    f"[4:a]atrim=duration={stack_len:.3f},asetpts=PTS-STARTPTS[as]",
    f"[vi][{vl}]xfade=transition=fade:duration={FADE}:offset={demo_at:.3f}[v1]",
    f"[v1][vs]xfade=transition=fade:duration={FADE}:offset={stack_at:.3f},fade=t=in:st=0:d=0.4,fade=t=out:st={total - 0.8:.3f}:d=0.8[v]",
    f"[ai][{al}]acrossfade=d={FADE}[a1]",
    "[a1][as]acrossfade=d=0.5[sfx]",
    "[5:a]aresample=48000,pan=stereo|c0=c0|c1=c0,asplit=2[vk][vm]",
    "[sfx]volume=0.9[sfxv];[sfxv][vk]sidechaincompress=threshold=0.03:ratio=6:attack=15:release=350[duck]",
    f"[duck][vm]amix=inputs=2:normalize=0:duration=longest,volume=-1.6dB,alimiter=limit=0.89,afade=t=out:st={total - 0.8:.3f}:d=0.8[au]",
]
out = ROOT / "media/player-two-brains-vo.mp4"
subprocess.run(
    [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(intro_dir / "raw.webm"),
        "-i",
        str(intro_sfx),
        "-i",
        str(app),
        "-i",
        str(stack_dir / "raw.webm"),
        "-i",
        str(stack_sfx),
        "-i",
        str(vo_wav),
        "-filter_complex",
        ";".join(g),
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
sh(
    "ffmpeg",
    "-y",
    "-loglevel",
    "error",
    "-i",
    str(out),
    "-vf",
    "scale=1280:720",
    "-c:v",
    "libx264",
    "-crf",
    "26",
    "-preset",
    "medium",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    str(out.with_name(out.stem + "-preview.mp4")),
)

report = {
    "total": round(total, 2),
    "intro_shots_at": [round(x, 2) for x in b] + [round(demo_at, 2)],
    "demo_pieces": [[a0, round(a1, 2)] for a0, a1 in K],
    "stack_at": round(stack_at, 2),
    "vo": {
        "intro": [T0, round(T0 + len(intro) / SR, 2)],
        **{
            k: [round(demo_at + v, 2), round(demo_at + v + ln[k], 2)]
            for k, v in vo_demo.items()
        },
        **{
            k: [
                round(stack_at + stack_slides[i] + stack_lead[i], 2),
                round(stack_at + stack_slides[i] + stack_lead[i] + ln[k], 2),
            ]
            for i, k in enumerate(["S1", "S2", "S3", "S4", "S5"])
        },
    },
}
(VO / "timeline.json").write_text(json.dumps(report, indent=1))
print(json.dumps(report))
