"""Player Two's brain: a Strands agent that wraps the existing video-to-robot pipeline with memory and the open web.

    recall (Cognee)  ->  discover (Bright Data)  ->  build (the pipeline, video decoded in a Docker sandbox)  ->  remember (Cognee)

The pipeline itself is unchanged and stays the judge of everything: a discovered video is a lead that still has to
pass the licence gate and the footage judge, and memory may only save a download it already saw fail for the same
task and robot. The model decides what to search for and in what order to use the tools. It decides nothing else.

usage: uv run brain/agent.py "<task>" --robot g1|so101|panda [--target-accepted N] [--max-videos N] [--sandbox NAME]
Keys are read from the environment or the macOS keychain, never from a file:
  COGNEE_API_KEY / keychain player-two-cognee, BRIGHTDATA_API_KEY / keychain player-two-brightdata, GEMINI_API_KEY
"""
# /// script
# requires-python = ">=3.11"
# dependencies = ["strands-agents[gemini]>=1.50", "httpx>=0.27"]
# ///

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from strands import Agent, tool
from strands.models.gemini import GeminiModel

ROOT = Path(__file__).resolve().parent.parent
COGNEE_URL = os.environ.get(
    "COGNEE_URL", "https://tenant-839f8b4c-73a5-4154-a38b-8c751081c408.aws.cognee.ai"
)
COGNEE_TENANT = os.environ.get(
    "COGNEE_TENANT_ID", "839f8b4c-73a5-4154-a38b-8c751081c408"
)
DATASET = "player_two_brain"
SERP_ZONE = os.environ.get("BRIGHTDATA_SERP_ZONE", "serp_api1")
MODEL_ID = os.environ.get("BRAIN_MODEL", "gemini-flash-latest")
YOUTUBE_ID = re.compile(
    r"(?:youtube\.com/(?:watch\?v=|shorts/|embed/)|youtu\.be/)([\w-]{11})"
)
# one memory line per video: deterministic to write, deterministic to read back out of a retrieved chunk
MEMORY_LINE = re.compile(
    r'VIDEO (\S+) TASK "([^"]*)" ROBOT (\w+) OUTCOME (accepted|rejected|refused) REASON ([^\n|]*)'
)


def secret(env: str, service: str) -> str | None:
    if os.environ.get(env):
        return os.environ[env].strip()
    got = subprocess.run(
        [
            "security",
            "find-generic-password",
            "-a",
            os.environ.get("USER", ""),
            "-s",
            service,
            "-w",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return got.stdout.strip() or None


def gemini_key() -> str | None:
    if os.environ.get("GEMINI_API_KEY"):
        return os.environ["GEMINI_API_KEY"].strip()
    rc = Path.home() / ".zshrc"
    m = re.search(
        r"^\s*export\s+GEMINI_API_KEY=([\"']?)([^\"'\s#]+)\1",
        rc.read_text() if rc.exists() else "",
        re.MULTILINE,
    )
    return m.group(2) if m else None


class Trace:
    """Everything the brain did, in order, for the run page. Written next to run.json."""

    def __init__(self, task: str, robot: str, run_id: str) -> None:
        self.data = {
            "schema": 1,
            "runId": run_id,
            "task": task,
            "robot": robot,
            "startedAt": now(),
            "finishedAt": None,
            "harness": {
                "framework": "strands-agents",
                "model": MODEL_ID,
                "scripted": False,
            },
            "steps": [],
            "report": None,
        }
        self.path = ROOT / "data/runs" / run_id / "brain.json"

    def step(
        self,
        name: str,
        provider: str,
        started: float,
        summary: str,
        detail: dict | None = None,
        ok: bool = True,
    ) -> None:
        self.data["steps"].append(
            {
                "name": name,
                "provider": provider,
                "ms": round((time.time() - started) * 1000),
                "ok": ok,
                "summary": summary,
                **(detail or {}),
            }
        )
        print(
            f"[{datetime.now(timezone.utc):%H:%M:%S}] brain {name} ({provider}): {summary}",
            flush=True,
        )
        self.save()

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, indent=1))


def now() -> str:
    return (
        datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    )


class Brain:
    def __init__(
        self,
        task: str,
        robot: str,
        target: int,
        max_videos: int,
        seconds: int,
        sandbox: str | None,
    ) -> None:
        (
            self.task,
            self.robot,
            self.target,
            self.max_videos,
            self.seconds,
            self.sandbox,
        ) = task, robot, target, max_videos, seconds, sandbox
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        slug = (
            re.sub(
                r"-+$",
                "",
                re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", task.lower()))[:40],
            )
            or "task"
        )
        self.run_id = f"{stamp}-{slug}-{secrets.token_hex(2)}"
        self.trace = Trace(task, robot, self.run_id)
        self.cognee_key, self.bright_key = (
            secret("COGNEE_API_KEY", "player-two-cognee"),
            secret("BRIGHTDATA_API_KEY", "player-two-brightdata"),
        )
        self.lessons: list[str] = []
        self.skip: dict[str, str] = {}
        self.recalled = 0
        self.memory_note: str | None = None
        self.discovered: dict[str, str] = {}
        self.discovery_queries = 0
        self.discovery_note: str | None = None
        self.built = False

    # ---------------------------------------------------------------- Cognee
    def _cognee(self, path: str, body: dict, timeout: float = 120) -> httpx.Response:
        return httpx.post(
            f"{COGNEE_URL}{path}",
            json=body,
            timeout=timeout,
            headers={"X-Api-Key": self.cognee_key or "", "X-Tenant-Id": COGNEE_TENANT},
        )

    def recall(self) -> str:
        t0 = time.time()
        if not self.cognee_key:
            self.memory_note = "no Cognee key in the environment or keychain"
            self.trace.step("recall", "cognee", t0, self.memory_note, ok=False)
            return self.memory_note
        try:
            # Raw chunks for the per-video facts (parsed, not paraphrased), then one graph question for the lessons.
            chunks = self._cognee(
                "/api/v1/recall",
                {
                    "query": f'videos judged for the task "{self.task}" on robot {self.robot}',
                    "datasets": [DATASET],
                    "searchType": "CHUNKS",
                    "topK": 40,
                },
            )
            if chunks.status_code == 401:
                raise PermissionError(
                    "Cognee answered 401 Unauthorized: the API key is missing or wrong"
                )
            text = json.dumps(chunks.json()) if chunks.status_code == 200 else ""
            for key, task, robot, outcome, reason in MEMORY_LINE.findall(
                text.replace('\\"', '"')
            ):
                if (
                    robot == self.robot
                    and task.strip().lower() == self.task.strip().lower()
                ):
                    self.recalled += 1
                    if outcome != "accepted":
                        self.skip[key] = f"{outcome} before: {reason.strip()}"
            asked = self._cognee(
                "/api/v1/recall",
                {
                    "query": f'What have past runs taught about finding usable video for "{self.task}" on a {self.robot} robot? Which search phrasings and channels worked, and what got videos rejected?',
                    "datasets": [DATASET],
                    "searchType": "GRAPH_COMPLETION",
                    "topK": 12,
                },
            )
            if asked.status_code == 200:
                answer = asked.json()
                flat = (
                    answer
                    if isinstance(answer, str)
                    else " ".join(
                        str(a.get("search_result", a))
                        if isinstance(a, dict)
                        else str(a)
                        for a in (answer if isinstance(answer, list) else [answer])
                    )
                )
                self.lessons = [
                    s.strip()
                    for s in re.split(r"(?<=[.!?])\s+", flat)
                    if len(s.strip()) > 24
                ][:5]
            summary = (
                f"{self.recalled} remembered videos for this task, {len(self.skip)} will not be downloaded again, {len(self.lessons)} lessons"
                if self.recalled or self.lessons
                else "nothing remembered for this task yet (first run)"
            )
            self.trace.step(
                "recall",
                "cognee",
                t0,
                summary,
                {"lessons": self.lessons, "skip": len(self.skip)},
            )
            return json.dumps(
                {
                    "summary": summary,
                    "lessons": self.lessons,
                    "videos_that_already_failed": len(self.skip),
                }
            )
        # memory is a help, not a dependency: the run goes on without it
        except (httpx.HTTPError, OSError, RuntimeError, ValueError, KeyError) as err:
            self.memory_note = str(err)[:200]
            self.trace.step("recall", "cognee", t0, self.memory_note, ok=False)
            return f"memory unavailable: {self.memory_note}"

    def remember(self) -> str:
        t0 = time.time()
        run_file = ROOT / "data/runs" / self.run_id / "run.json"
        if not run_file.exists():
            return "nothing to remember: the run wrote no trace"
        run = json.loads(run_file.read_text())
        lines, accepted_authors, reasons = [], {}, {}
        for c in run["candidates"]:
            v = c.get("verdict")
            if v:
                outcome, reason = (
                    ("accepted", f"score {v['score']}")
                    if v["accepted"]
                    else (
                        "rejected",
                        "; ".join(r.split(":")[0] for r in v["reasons"])[:120],
                    )
                )
            elif c["stage"] == "failed":
                outcome, reason = "refused", (c.get("note") or "download failed")[:120]
            else:
                continue
            if outcome == "accepted" and c.get("author"):
                accepted_authors[c["author"]] = accepted_authors.get(c["author"], 0) + 1
            if outcome == "rejected":
                for r in reason.split("; "):
                    reasons[r] = reasons.get(r, 0) + 1
            lines.append(
                f'VIDEO {c["key"]} TASK "{self.task}" ROBOT {self.robot} OUTCOME {outcome} REASON {reason} | title "{(c.get("title") or "")[:70]}" by {c.get("author") or "unknown"} found with query "{c.get("query", "")[:60]}"'
            )
        plan = run.get("plan") or {}
        top_reasons = (
            ", ".join(
                f"{k} ({n})"
                for k, n in sorted(reasons.items(), key=lambda kv: -kv[1])[:4]
            )
            or "none"
        )
        top_authors = (
            ", ".join(
                f"{k} ({n})"
                for k, n in sorted(accepted_authors.items(), key=lambda kv: -kv[1])[:5]
            )
            or "none"
        )
        lesson = (
            f'Run {self.run_id} for the task "{self.task}" on the {self.robot} robot: {len(run["episodes"])} demonstrations written from {len(lines)} videos tried. '
            f"Search queries used: {'; '.join(plan.get('queries', [])[:6])}. Channels whose videos were accepted: {top_authors}. Most common rejection reasons: {top_reasons}. "
            f"Videos found through Bright Data web discovery that were usable: {(run.get('brain') or {}).get('discoveredKept', 0)}."
        )
        if not self.cognee_key:
            self.trace.step(
                "remember", "cognee", t0, "not stored: no Cognee key", ok=False
            )
            return "not stored: no Cognee key"
        try:
            docs = [lesson] + [
                "\n".join(lines[i : i + 12]) for i in range(0, len(lines), 12)
            ]
            added = self._cognee(
                "/api/v1/add_text", {"textData": docs, "datasetName": DATASET}
            )
            if added.status_code >= 300:
                raise RuntimeError(
                    f"Cognee add_text answered HTTP {added.status_code}: {added.text[:120]}"
                )
            graph = self._cognee(
                "/api/v1/cognify",
                {"datasets": [DATASET], "runInBackground": False},
                timeout=600,
            )
            summary = f"{len(lines)} video outcomes and 1 run lesson stored in dataset {DATASET}, knowledge graph {'rebuilt' if graph.status_code < 300 else f'not rebuilt (HTTP {graph.status_code})'}"
            self.trace.step(
                "remember",
                "cognee",
                t0,
                summary,
                {"stored": len(lines), "lesson": lesson},
                ok=graph.status_code < 300,
            )
            return summary
        except (httpx.HTTPError, OSError, RuntimeError, ValueError, KeyError) as err:
            self.trace.step("remember", "cognee", t0, str(err)[:200], ok=False)
            return f"not stored: {str(err)[:200]}"

    # ---------------------------------------------------------------- Bright Data
    def discover(self, query: str) -> str:
        t0 = time.time()
        query = query.strip()[:120]
        self.discovery_queries += 1
        if not self.bright_key:
            self.discovery_note = "no Bright Data key in the environment or keychain"
            self.trace.step(
                "discover",
                "brightdata",
                t0,
                self.discovery_note,
                {"query": query},
                ok=False,
            )
            return self.discovery_note
        try:
            url = (
                "https://www.google.com/search?"
                + httpx.QueryParams(
                    {
                        "q": f"{query} site:youtube.com",
                        "tbm": "vid",
                        "num": "30",
                        "brd_json": "1",
                    }
                ).__str__()
            )
            res = httpx.post(
                "https://api.brightdata.com/request",
                json={"zone": SERP_ZONE, "url": url, "format": "raw"},
                headers={"Authorization": f"Bearer {self.bright_key}"},
                timeout=90,
            )
            problem = res.headers.get("x-brd-error") or res.headers.get("x-brd-err-msg")
            if problem or res.status_code >= 300:
                raise RuntimeError(
                    f"Bright Data: {problem or f'HTTP {res.status_code}'}"
                )
            fresh = 0
            for vid in dict.fromkeys(
                YOUTUBE_ID.findall(
                    res.text.replace("\\/", "/").replace("%3D", "=").replace("%3F", "?")
                )
            ):
                if vid not in self.discovered:
                    self.discovered[vid] = query
                    fresh += 1
            self.trace.step(
                "discover",
                "brightdata",
                t0,
                f'"{query}": {fresh} new videos ({len(self.discovered)} leads so far)',
                {"query": query, "fresh": fresh},
            )
            return json.dumps(
                {
                    "query": query,
                    "new_videos": fresh,
                    "total_leads": len(self.discovered),
                }
            )
        except (httpx.HTTPError, OSError, RuntimeError, ValueError, KeyError) as err:
            self.discovery_note = str(err)[:200]
            self.trace.step(
                "discover",
                "brightdata",
                t0,
                self.discovery_note,
                {"query": query},
                ok=False,
            )
            return f"discovery failed: {self.discovery_note}"

    # ---------------------------------------------------------------- the pipeline
    def build(self) -> str:
        t0 = time.time()
        if self.built:
            return "already built in this run"
        self.built = True
        brief = {
            "sandbox": self.sandbox,
            "discovered": [{"id": k, "query": q} for k, q in self.discovered.items()],
            "skip": self.skip,
            "memory": {
                "provider": "cognee",
                "recalled": self.recalled,
                "lessons": self.lessons,
            }
            if not self.memory_note
            else None,
            "discovery": {
                "provider": "brightdata",
                "queries": self.discovery_queries,
                "hits": len(self.discovered),
                "note": self.discovery_note,
            },
            "harness": {"framework": "strands-agents", "model": MODEL_ID},
        }
        brief_file = ROOT / "data/runs" / self.run_id / "brief.json"
        brief_file.parent.mkdir(parents=True, exist_ok=True)
        brief_file.write_text(json.dumps(brief, indent=1))
        cmd = [
            "pnpm",
            "dlx",
            "tsx",
            "scripts/agent/agent.mts",
            self.task,
            "--robot",
            self.robot,
            "--max-videos",
            str(self.max_videos),
            "--target-accepted",
            str(self.target),
            "--seconds",
            str(self.seconds),
            "--sources",
            "youtube-cc",
            "--run-id",
            self.run_id,
            "--brain",
            str(brief_file),
        ]
        done = subprocess.run(
            cmd, cwd=ROOT, text=True, stdout=sys.stdout, stderr=subprocess.PIPE, check=False
        )
        run_file = ROOT / "data/runs" / self.run_id / "run.json"
        if (
            done.returncode == 2
        ):  # the robot cannot do this task: not a failure, a request to rephrase
            self.trace.step(
                "build", "pipeline", t0, done.stderr.strip()[:300], ok=False
            )
            return f"refused: {done.stderr.strip()[:400]}"
        if not run_file.exists():
            self.trace.step(
                "build", "pipeline", t0, f"pipeline exited {done.returncode}", ok=False
            )
            return f"pipeline failed: {done.stderr.strip()[-300:]}"
        run = json.loads(run_file.read_text())
        judged = [c for c in run["candidates"] if c.get("verdict")]
        accepted = [c for c in judged if c["verdict"]["accepted"]]
        b = run.get("brain") or {}
        summary = {
            "run_id": self.run_id,
            "found": len(run["candidates"]),
            "judged": len(judged),
            "accepted": len(accepted),
            "episodes": len(run["episodes"]),
            "skipped_by_memory": b.get("skipped", 0),
            "usable_web_discoveries": b.get("discoveredKept", 0),
            "decoded_in_sandbox": b.get("sandboxed", 0),
        }
        self.trace.step(
            "build",
            "pipeline" + (" + docker sandbox" if self.sandbox else ""),
            t0,
            f"{summary['episodes']} demonstrations from {summary['judged']} judged videos; memory saved {summary['skipped_by_memory']} downloads, {summary['decoded_in_sandbox']} videos decoded in the sandbox",
            summary,
        )
        return json.dumps(summary)


SYSTEM = """You are the brain of Player Two, an agent that turns online video of people doing a task into robot demonstrations.
Work in exactly this order and do not skip a step:
1. Call recall_memory once. Read the lessons: they say which search phrasings and channels worked before and what got videos rejected.
2. Call discover_videos three to five times with different short search queries for videos of ONE person clearly doing the task,
   filmed from the front, full upper body in frame. Use what memory taught you. Never add words like "funny", "fail" or "compilation".
3. Call build_demonstrations once.
4. Call remember_run once.
5. Reply with two plain sentences: what was built, and what memory or the web contributed this time. No markdown."""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("task")
    ap.add_argument("--robot", default="g1", choices=["g1", "so101", "panda"])
    ap.add_argument("--target-accepted", type=int, default=22)
    ap.add_argument("--max-videos", type=int, default=70)
    ap.add_argument("--seconds", type=int, default=6)
    ap.add_argument(
        "--sandbox",
        default=None,
        help="name of a Docker sandbox (docker sandbox ls) to decode video in",
    )
    ap.add_argument(
        "--scripted",
        action="store_true",
        help="run the four steps in order without the model (used when the model is unreachable)",
    )
    ap.add_argument(
        "--remember-run",
        default=None,
        metavar="RUN_ID",
        help="store an earlier run (made before the brain existed) in memory, then stop. The task argument is ignored.",
    )
    a = ap.parse_args()
    if a.remember_run:
        old = json.loads((ROOT / "data/runs" / a.remember_run / "run.json").read_text())
        past = Brain(
            old["task"], old["options"]["robot"], 0, 0, old["options"]["seconds"], None
        )
        past.run_id = a.remember_run
        past.trace.path = ROOT / "data/runs" / a.remember_run / "brain-backfill.json"
        print(past.remember())
        return
    brain = Brain(
        a.task, a.robot, a.target_accepted, a.max_videos, a.seconds, a.sandbox
    )

    @tool
    def recall_memory() -> str:
        """Ask long-term memory (Cognee) what past runs learned about this task and robot. Call this first."""
        return brain.recall()

    @tool
    def discover_videos(query: str) -> str:
        """Search the open web (Bright Data) for videos of a person doing the task. query: a short search phrase."""
        return brain.discover(query)

    @tool
    def build_demonstrations() -> str:
        """Run the pipeline: licence check, download, pose tracking inside the sandbox, footage judge, retargeting, dataset."""
        return brain.build()

    @tool
    def remember_run() -> str:
        """Store what this run learned (per-video outcomes and one lesson) in long-term memory (Cognee)."""
        return brain.remember()

    key = gemini_key()
    report = None
    if key and not a.scripted:
        try:
            agent = Agent(
                model=GeminiModel(
                    client_args={"api_key": key},
                    model_id=MODEL_ID,
                    params={"temperature": 0.3},
                ),
                tools=[
                    recall_memory,
                    discover_videos,
                    build_demonstrations,
                    remember_run,
                ],
                system_prompt=SYSTEM,
                callback_handler=None,
            )
            report = str(
                agent(
                    f'Task: "{a.task}". Robot: {a.robot}. Target: {a.target_accepted} accepted demonstrations.'
                )
            ).strip()
        except Exception as err:  # noqa: BLE001  any SDK, quota or network failure falls back to the scripted order
            print(
                f"brain: the model failed ({str(err)[:160]}), finishing the remaining steps in order",
                flush=True,
            )
    done = {s["name"] for s in brain.trace.data["steps"]}
    if not {"recall", "build", "remember"} <= done:
        brain.trace.data["harness"]["scripted"] = True
        if "recall" not in done:
            brain.recall()
        if "discover" not in done:
            for q in [
                f"{a.task} proper form front view",
                f"how to {a.task} tutorial",
                f"{a.task} exercise demonstration",
            ]:
                brain.discover(q)
        if not brain.built:
            brain.build()
        if "remember" not in done:
            brain.remember()
    brain.trace.data["report"] = report
    brain.trace.data["finishedAt"] = now()
    brain.trace.save()
    print(
        f"brain: done, run {brain.run_id}" + (f"\n{report}" if report else ""),
        flush=True,
    )


if __name__ == "__main__":
    main()
