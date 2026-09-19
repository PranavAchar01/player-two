// The agent: a task in plain words in, a traceable set of retargeted robot demonstrations out.
//   plan (LLM, validated) -> search (paced, licence-checked) -> fetch + pose -> judge footage -> retarget -> write run
//   before any of it: does the task suit the robot (feasible.ts)? A refusal exits with code 2 and asks nobody for anything.
// usage: tsx scripts/agent/agent.mts "<task>" [--robot g1|so101|panda] [--max-videos N] [--target-accepted N]
//          [--seconds S] [--sources pexels,youtube-cc] [--allow-standard-license]
// --max-videos counts JUDGED videos (up to CLI_MAX_VIDEOS_CAP here, MAX_VIDEOS_CAP from the web page).
// run.json is rewritten after every change so the /agent page can show the run while it happens.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { limitsFor, searchWant, stopReason } from "./budget";
import { EMBODIMENTS, checkFeasibility } from "./feasible";
import { MEDIAPIPE_PIN, extractPose, fetchVideo, probeDuration, reusable } from "./fetch";
import { judgeBestWindow, parseTrack } from "./judge";
import { planTask } from "./plan";
import { renderReport } from "./report";
import { retargetClip } from "./retarget";
import { Pacer, searchPexels, searchYoutube } from "./search";
import { CLI_MAX_VIDEOS_CAP, RUN_ID, type Candidate, type Episode, type Run, type StepName } from "./types";
import { parseArgv, validateRunRequest } from "./validate";

const run$ = promisify(execFile);
// every path below is relative to the repo root, wherever the command was typed
process.chdir(path.resolve(import.meta.dirname, "../.."));

const argv = parseArgv(process.argv.slice(2));
if ("error" in argv) { console.error(argv.error); process.exit(2); }
const checked = validateRunRequest(argv.request, CLI_MAX_VIDEOS_CAP);
if (!checked.ok) { console.error(checked.error); process.exit(2); }
if (argv.runId !== null && !RUN_ID.test(argv.runId)) { console.error("bad --run-id"); process.exit(2); }
const { task, ...options } = checked.value;

// Before a run directory exists and before anything is searched: a task the robot cannot do is not a failed run,
// it is a request to rephrase, so it leaves nothing behind and exits like any other bad argument.
const feasibility = checkFeasibility(task, options.robot);
if (feasibility.level === "refuse") {
  console.error(`Not started: "${task}" does not suit the ${EMBODIMENTS[options.robot].label}.`);
  for (const r of feasibility.reasons) console.error(`  - ${r}`);
  if (feasibility.suggestion) console.error(feasibility.suggestion);
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "task";
const id = argv.runId ?? `${stamp}-${slug}-${randomBytes(2).toString("hex")}`;
const dir = `data/runs/${id}`;
const STEPS: StepName[] = ["plan", "search", "fetch", "judge", "retarget", "write"];

const run: Run = {
  schema: 1, id, task, options, status: "running", pid: process.pid, startedAt: new Date().toISOString(), finishedAt: null, error: null, feasibility,
  steps: STEPS.map((name) => ({ name, status: "pending", startedAt: null, ms: null, summary: null })),
  plan: null, searches: [], candidates: [], episodes: [], retargetFailures: [], versions: {},
};

const log = (line: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
const short = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n").filter(Boolean).slice(-1).join("").slice(0, 240);

/** Write-then-rename, so the page polling this file never reads half of it. */
async function save() {
  await writeFile(`${dir}/run.json.tmp`, JSON.stringify(run, null, 1));
  await rename(`${dir}/run.json.tmp`, `${dir}/run.json`);
}
const step = (name: StepName) => run.steps.find((s) => s.name === name)!;
async function begin(name: StepName) { const s = step(name); s.status = "running"; s.startedAt ??= new Date().toISOString(); log(`${name}: started`); await save(); }
async function end(name: StepName, ms: number, summary: string, failed = false) { const s = step(name); s.status = failed ? "failed" : "done"; s.ms = Math.round(ms); s.summary = summary; log(`${name}: ${summary}`); await save(); }

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  run.status = "failed"; run.error = `stopped by ${signal}`; run.finishedAt = new Date().toISOString();
  try { writeFileSync(`${dir}/run.json`, JSON.stringify(run, null, 1)); } catch { /* nothing left to do */ }
  process.exit(130);
});

await mkdir(dir, { recursive: true });
run.versions = {
  agent: "0.1.0", node: process.version, "yt-dlp": await run$("yt-dlp", ["--version"]).then((r) => r.stdout.trim(), () => "not installed"),
  mediapipe: `${MEDIAPIPE_PIN} (pinned)`, poseModel: "pose_landmarker_lite.task", extractor: "scripts/extract_pose.py",
};
await save();
log(`run ${id}: "${task}" -> ${options.robot}, up to ${options.maxVideos} judged videos${options.targetAccepted ? `, stopping at ${options.targetAccepted} accepted` : ""}, ${options.seconds} s each`);
if (feasibility.level === "warn") for (const r of feasibility.reasons) log(`feasibility warning: ${r}`);

try {
  // ---- a. plan
  let t0 = performance.now();
  await begin("plan");
  run.plan = await planTask(task, options.seconds, options.robot, log);
  run.versions.planner = run.plan.model ?? "deterministic fallback";
  await end("plan", performance.now() - t0, `${run.plan.planner}${run.plan.model ? ` (${run.plan.model})` : ""}: ${run.plan.queries.length} queries, ${run.plan.arm} arm, ${run.plan.signature.kind} ${run.plan.signature.threshold} x${run.plan.signature.minCount} ${run.plan.signature.direction ?? ""}${run.plan.note ? `. ${run.plan.note}` : ""}`);

  // ---- b. search
  t0 = performance.now();
  await begin("search");
  const plan = run.plan;
  const pacer = new Pacer();
  const seen = new Set<string>();
  const limits = limitsFor(options);
  const counts = { judged: 0, attempts: 0, accepted: 0 };
  const usable = (list: Candidate[]) => list.filter((c) => c.stage === "found");
  const fromSource = (s: string) => (c: Candidate) => c.source === s || (s === "youtube-cc" && c.source === "youtube");

  // YouTube is searched as deep as the run turns out to need. Each hit costs a metadata request, so the first round
  // is sized by searchWant and the remaining queries are only spent if the fetch loop below runs dry.
  // One query per call, so run.json (and the page reading it) fills in query by query during a long search.
  let nextYoutubeQuery = 0;
  async function searchYoutubeMore(want: number): Promise<Candidate[]> {
    const got: Candidate[] = [];
    while (got.length < want && nextYoutubeQuery < plan.queries.length) {
      const found = await searchYoutube([plan.queries[nextYoutubeQuery++]], want - got.length, options.allowStandardLicense, pacer, seen, log);
      run.searches.push(...found.searches);
      run.candidates.push(...found.candidates);
      got.push(...usable(found.candidates));
      await save();
    }
    return got;
  }

  const firstWant = searchWant(counts, limits);
  for (const source of options.sources) {
    if (source === "youtube-cc") { await searchYoutubeMore(firstWant); continue; }
    const found = await searchPexels(plan.queries, firstWant, pacer, seen, log);
    run.searches.push(...found.searches);
    run.candidates.push(...found.candidates);
    await save();
  }
  // Take turns between sources so one prolific source cannot use the whole budget.
  const pools = options.sources.map((s) => usable(run.candidates).filter(fromSource(s)));
  const queue: Candidate[] = [];
  for (let i = 0; pools.some((p) => p.length > i); i++) for (const p of pools) if (p[i]) queue.push(p[i]);
  await end("search", performance.now() - t0, `${run.candidates.length} candidates (${options.sources.map((s, i) => `${s} ${pools[i].length} usable`).join(", ")}). Fetching until ${limits.budget} are judged${limits.targetAccepted !== null ? ` or ${limits.targetAccepted} are accepted` : ""}, at most ${limits.maxAttempts} download attempts`);

  // ---- c + d. fetch, extract pose, judge. Judged one by one so the page fills in as the run goes.
  t0 = performance.now();
  await begin("fetch");
  let judgeMs = 0, reusedCount = 0, topUps = 0;
  const emitted = new Set<string>();
  let stopped: string | null = null;
  for (let i = 0; ; i++) {
    if ((stopped = stopReason(counts, limits))) break;
    if (i >= queue.length) {
      // The queue ran dry with budget left: spend the planned queries that have not been used yet.
      if (!options.sources.includes("youtube-cc") || nextYoutubeQuery >= plan.queries.length) { stopped = "every candidate the searches found was used"; break; }
      topUps++;
      log(`search: queue is empty with budget left, searching query ${nextYoutubeQuery + 1} of ${plan.queries.length}`);
      queue.push(...(await searchYoutubeMore(Math.max(1, searchWant(counts, limits)))));
      i--;
      continue;
    }
    const c = queue[i];
    // The searches share one `seen` set, so this should never fire. It is the guarantee, not the mechanism:
    // whatever a source hands back, one video is fetched, judged and retargeted at most once per run.
    if (emitted.has(c.key)) { c.stage = "skipped"; c.note = "same video as an earlier candidate in this run"; continue; }
    emitted.add(c.key);
    try {
      const onDisk = await reusable(c.key);
      if (onDisk.track) {
        c.reused = "track"; c.file = onDisk.file; reusedCount++;
        log(`fetch: ${c.key} pose track already on disk, reused`);
      } else if (onDisk.file) {
        c.reused = "footage"; c.file = onDisk.file; reusedCount++;
        log(`fetch: ${c.key} footage already on disk, reused`);
      } else {
        counts.attempts++;
        c.stage = "fetching"; await save();
        c.file = await fetchVideo(c, pacer);
        log(`fetch: ${c.key} downloaded`);
      }
      if (c.file) c.durationS ??= await probeDuration(c.file);
      c.stage = "extracting"; await save();
      c.track = onDisk.track ?? (await extractPose(c.file!, c.key));
      if (!c.licence.redistributable) {
        // --allow-standard-license: the numbers are kept, the footage is not.
        await rm(`data/sources/${c.key}.mp4`, { force: true });
        c.file = null; c.footageDeleted = true;
      }
      if (step("judge").status === "pending") await begin("judge");
      const tj = performance.now();
      const track = parseTrack(JSON.parse(await readFile(c.track, "utf8")));
      c.verdict = track ? judgeBestWindow(track, plan, options.seconds) : { pinnedStartS: null, windowNote: null, accepted: false, score: 0, reasons: ["track file is not in the expected shape"], checks: [], metrics: null };
      judgeMs += performance.now() - tj;
      c.stage = "judged";
      counts.judged++;
      if (c.verdict.accepted) counts.accepted++;
      log(`judge: ${c.key} ${c.verdict.accepted ? "ACCEPTED" : "rejected"} score ${c.verdict.score}${c.verdict.accepted ? "" : ` (${c.verdict.reasons.map((r) => r.split(":")[0]).join(", ")})`} [${counts.accepted} accepted of ${counts.judged} judged]`);
    } catch (err) {
      c.stage = "failed"; c.note = short(err);
      // the keep-no-footage promise holds on the failure path too
      if (!c.licence.redistributable) { await rm(`data/sources/${c.key}.mp4`, { force: true }); c.file = null; c.footageDeleted = true; }
      log(`fetch: ${c.key} failed: ${c.note}`);
    }
    await save();
  }
  for (const c of run.candidates) if (c.stage === "found") { c.stage = "skipped"; c.note = `not needed: ${stopped}`; }
  const judged = run.candidates.filter((c) => c.verdict);
  const accepted = judged.filter((c) => c.verdict!.accepted).sort((a, b) => b.verdict!.score - a.verdict!.score);
  const failedCount = run.candidates.filter((c) => c.stage === "failed").length;
  await end("fetch", performance.now() - t0 - judgeMs, `${judged.length} videos tracked: ${counts.attempts} download attempts (${failedCount} refused or failed), ${reusedCount} reused from disk${topUps ? `, ${topUps} extra search${topUps === 1 ? "" : "es"}` : ""}. Stopped because ${stopped}`);
  if (step("judge").status === "pending") await begin("judge");
  await end("judge", judgeMs, `${accepted.length} accepted, ${judged.length - accepted.length} rejected`);

  // ---- e. retarget
  t0 = performance.now();
  await begin("retarget");
  for (const c of accepted) {
    try {
      const poseOnly = !c.licence.redistributable;
      // Always hand over the exact window the judge evaluated. "auto" lets each retargeter pick its own most active
      // window, and the arm and humanoid retargeters do not pick the same one, so an unjudged stretch could slip in.
      const judgedStart = c.verdict!.pinnedStartS ?? c.verdict!.metrics?.windowStartS ?? null;
      const judgedArm = c.verdict!.metrics?.armUsed;
      const r = await retargetClip(c, options.robot, options.seconds, id, poseOnly, judgedStart, judgedArm === "left" || judgedArm === "right" ? judgedArm : null);
      // Footage quality says how far the input can be trusted, retarget stats say how much of it the robot could follow.
      const followed = typeof r.stats.tracked === "number" ? (r.stats.tracked / 100) * (1 - (r.stats.limited ?? 0) / 100) : c.verdict!.score;
      const episode: Episode = {
        name: path.basename(r.out, ".json"), rank: 0, quality: +(0.6 * c.verdict!.score + 0.4 * followed).toFixed(3), candidateKey: c.key, robot: options.robot, out: r.out, retargeter: r.retargeter, poseOnly,
        startSeconds: r.startSeconds, seconds: options.seconds, stats: r.stats,
        provenance: { source: c.source, id: c.id, pageUrl: c.pageUrl, licence: c.licence, author: c.author, authorUrl: c.authorUrl, title: c.title, query: c.query, fetchedAt: new Date().toISOString() },
      };
      run.episodes.push(episode);
      log(`retarget: ${episode.name} via ${r.retargeter} ${JSON.stringify(r.stats)}`);
    } catch (err) {
      run.retargetFailures.push({ candidateKey: c.key, reason: short(err) });
      log(`retarget: ${c.key} failed: ${short(err)}`);
    }
    await save();
  }
  await end("retarget", performance.now() - t0, `${run.episodes.length} episodes written for the ${options.robot}, ${run.retargetFailures.length} failed`);

  // ---- f. write
  t0 = performance.now();
  await begin("write");
  run.episodes.sort((a, b) => b.quality - a.quality).forEach((e, i) => { e.rank = i + 1; });
  run.status = "done";
  run.finishedAt = new Date().toISOString();
  await end("write", performance.now() - t0, `${dir}/run.json and ${dir}/REPORT.md`);
} catch (err) {
  run.status = "failed";
  run.error = short(err);
  run.finishedAt = new Date().toISOString();
  for (const s of run.steps) if (s.status === "running") s.status = "failed";
  log(`run failed: ${run.error}`);
}
await writeFile(`${dir}/REPORT.md`, renderReport(run));
await save();
log(`${run.status}: ${run.episodes.length} episodes, report at ${dir}/REPORT.md`);
process.exit(run.status === "done" ? 0 : 1);
