// Step f: the run as something a person can read in a minute. Everything in it comes from run.json.
import type { Run } from "./types";

// Titles and model text come from the internet. Inside a table cell a pipe or a newline would break the layout.
const cell = (v: string | number | null | undefined) => String(v ?? "").replace(/[|\r\n]+/g, " ").replace(/[[\]]/g, "").trim() || "n/a";
const link = (text: string, url: string) => `[${cell(text)}](${url.replace(/[()\s]/g, "")})`;

export function renderReport(run: Run): string {
  const judged = run.candidates.filter((c) => c.verdict);
  const accepted = judged.filter((c) => c.verdict!.accepted);
  const rejected = judged.filter((c) => !c.verdict!.accepted);
  const tally = new Map<string, number>();
  for (const c of rejected) for (const r of c.verdict!.checks.filter((k) => !k.pass)) tally.set(r.name, (tally.get(r.name) ?? 0) + 1);
  const lines: string[] = [];
  const add = (...l: string[]) => lines.push(...l);

  add(`# Agent run: ${cell(run.task)}`, "", `Run \`${run.id}\`, robot \`${run.options.robot}\`, ${run.options.seconds} s per episode, up to ${run.options.maxVideos} videos from ${run.options.sources.join(", ")}. Status: **${run.status}**${run.error ? ` (${cell(run.error)})` : ""}.`, "");
  add(`Started ${run.startedAt}${run.finishedAt ? `, finished ${run.finishedAt}` : ""}.`, "");
  add("These are retargeted kinematic demonstrations. No policy was trained, and video carries no object state or contact forces.", "");

  add("## Result", "", `- candidates found: ${run.candidates.length} (${run.options.sources.map((s) => `${s} ${run.candidates.filter((c) => c.source === s || (s === "youtube-cc" && c.source === "youtube")).length}`).join(", ")})`, `- fetched and judged: ${judged.length}`, `- accepted: ${accepted.length}, rejected: ${rejected.length}`, `- episodes written: ${run.episodes.length}`);
  if (tally.size) add(`- most common rejection reasons: ${[...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} (${n})`).join(", ")}`);
  add("");

  if (run.plan) {
    const p = run.plan;
    add("## Plan", "", `Planner: ${p.planner}${p.model ? ` (${p.model})` : ""}${p.note ? `. Note: ${cell(p.note)}` : ""}`, "", `- arm that matters: ${p.arm}`, `- motion: ${cell(p.motionDescription)}`, `- machine check: \`${p.signature.kind}\` threshold ${p.signature.threshold}, at least ${p.signature.minCount} time(s)${p.signature.direction && p.signature.direction !== "any" ? `, direction ${p.signature.direction}` : ""}`, `- rejection criteria: ${p.rejectionCriteria.map(cell).join("; ")}`, "", "Queries:", "", ...p.queries.map((q) => `1. ${cell(q)}`), "");
  }

  add("## Searches", "", "| source | query | found | kept | note |", "| --- | --- | ---: | ---: | --- |", ...run.searches.map((s) => `| ${s.source} | ${cell(s.query)} | ${s.found} | ${s.kept} | ${cell(s.note ?? "")} |`), "");

  add("## Episodes, ranked by quality", "");
  if (run.episodes.length === 0) add("None.", "");
  else add("| rank | episode | quality | retargeter | window | stats | source | licence | author |", "| ---: | --- | ---: | --- | --- | --- | --- | --- | --- |", ...run.episodes.map((e) => `| ${e.rank} | \`${e.out}\`${e.poseOnly ? " (pose only)" : ""} | ${e.quality} | ${e.retargeter} | ${e.startSeconds === null ? "auto" : `${e.startSeconds.toFixed(1)} s`} +${e.seconds} s | ${cell(Object.entries(e.stats).map(([k, v]) => `${k} ${v}`).join(", "))} | ${link(`${e.provenance.source} ${e.provenance.id}`, e.provenance.pageUrl)} | ${cell(e.provenance.licence.name)} | ${cell(e.provenance.author)} |`), "");
  if (run.retargetFailures.length) add("Retarget failures:", "", ...run.retargetFailures.map((f) => `- ${cell(f.candidateKey)}: ${cell(f.reason)}`), "");

  add("## Candidates", "", "| candidate | licence | author | length | verdict | score | reasons |", "| --- | --- | --- | ---: | --- | ---: | --- |");
  for (const c of run.candidates) {
    const verdict = c.verdict ? (c.verdict.accepted ? "accepted" : "rejected") : c.stage;
    const reasons = c.verdict ? (c.verdict.accepted ? `all checks passed${c.verdict.windowNote ? `. ${c.verdict.windowNote}` : ""}` : c.verdict.reasons.join("; ")) : c.note ?? "";
    add(`| ${link(c.key, c.pageUrl)} | ${cell(c.licence.name)} | ${cell(c.author)} | ${c.durationS === null ? "n/a" : `${Math.round(c.durationS)} s`} | ${verdict} | ${c.verdict ? c.verdict.score : ""} | ${cell(reasons)} |`);
  }
  add("");

  add("## Timings and versions", "", ...run.steps.map((s) => `- ${s.name}: ${s.status}${s.ms === null ? "" : `, ${(s.ms / 1000).toFixed(1)} s`}${s.summary ? `. ${cell(s.summary)}` : ""}`), "", ...Object.entries(run.versions).map(([k, v]) => `- ${k}: ${cell(v)}`), "");
  return lines.join("\n");
}
