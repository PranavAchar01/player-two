import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { limitsFor, searchWant, stopReason } from "./budget";
import { reusable } from "./fetch";
import { contractArgs } from "./retarget";
import { CLI_MAX_VIDEOS_CAP, MAX_VIDEOS_CAP } from "./types";

describe("run limits", () => {
  it("keeps the web cap at 25 and lets the command line go to 80", () => {
    expect(MAX_VIDEOS_CAP).toBe(25);
    expect(CLI_MAX_VIDEOS_CAP).toBe(80);
  });

  it("counts judged videos as the budget and allows twice as many download attempts", () => {
    expect(limitsFor({ maxVideos: 6 })).toEqual({ budget: 6, maxAttempts: 12, targetAccepted: null });
    expect(limitsFor({ maxVideos: 80, targetAccepted: 20 })).toEqual({ budget: 80, maxAttempts: 160, targetAccepted: 20 });
    // the validator is the rule, this is the backstop behind it
    expect(limitsFor({ maxVideos: 5000 }).budget).toBe(80);
    expect(limitsFor({ maxVideos: 4, targetAccepted: 9 }).targetAccepted).toBe(4);
  });

  it("stops at the accepted target first, then the judged budget, then the attempt limit", () => {
    const limits = limitsFor({ maxVideos: 80, targetAccepted: 20 });
    expect(stopReason({ judged: 0, attempts: 0, accepted: 0 }, limits)).toBeNull();
    expect(stopReason({ judged: 41, attempts: 70, accepted: 19 }, limits)).toBeNull();
    expect(stopReason({ judged: 42, attempts: 71, accepted: 20 }, limits)).toMatch(/target of 20 accepted/);
    expect(stopReason({ judged: 80, attempts: 120, accepted: 12 }, limits)).toMatch(/budget of 80 judged/);
    expect(stopReason({ judged: 60, attempts: 160, accepted: 12 }, limits)).toMatch(/160 download attempts/);
    // without a target only the budget and the attempts can stop a run
    expect(stopReason({ judged: 5, attempts: 9, accepted: 5 }, limitsFor({ maxVideos: 6 }))).toBeNull();
  });

  it("sizes a search to what the run still needs, never past the attempts that are left", () => {
    expect(searchWant({ judged: 0, attempts: 0, accepted: 0 }, limitsFor({ maxVideos: 6 }))).toBe(12);
    expect(searchWant({ judged: 0, attempts: 0, accepted: 0 }, limitsFor({ maxVideos: 80 }))).toBe(160);
    // a target of 20 needs about 80 candidates, not the 160 the whole budget would take
    expect(searchWant({ judged: 0, attempts: 0, accepted: 0 }, limitsFor({ maxVideos: 80, targetAccepted: 20 }))).toBe(80);
    expect(searchWant({ judged: 30, attempts: 50, accepted: 17 }, limitsFor({ maxVideos: 80, targetAccepted: 20 }))).toBe(12);
    expect(searchWant({ judged: 70, attempts: 158, accepted: 3 }, limitsFor({ maxVideos: 80 }))).toBe(2);
    expect(searchWant({ judged: 80, attempts: 100, accepted: 3 }, limitsFor({ maxVideos: 80 }))).toBe(0);
  });
});

describe("reuse across runs", () => {
  const made: string[] = [];
  afterAll(async () => { for (const d of made) await rm(d, { recursive: true, force: true }); });

  it("finds footage and tracks an earlier run left behind, and ignores empty files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "p2-reuse-"));
    made.push(root);
    await mkdir(`${root}/sources`);
    await mkdir(`${root}/tracks`);
    await writeFile(`${root}/sources/youtube-cc-aaaaaaaaaaa.mp4`, "x");
    await writeFile(`${root}/tracks/youtube-cc-aaaaaaaaaaa.json`, "{}");
    await writeFile(`${root}/tracks/youtube-cc-bbbbbbbbbbb.json`, "{}");
    await writeFile(`${root}/sources/youtube-cc-ccccccccccc.mp4`, ""); // a download that died at zero bytes is not footage
    expect(await reusable("youtube-cc-aaaaaaaaaaa", root)).toEqual({ file: `${root}/sources/youtube-cc-aaaaaaaaaaa.mp4`, track: `${root}/tracks/youtube-cc-aaaaaaaaaaa.json` });
    expect(await reusable("youtube-cc-bbbbbbbbbbb", root)).toEqual({ file: null, track: `${root}/tracks/youtube-cc-bbbbbbbbbbb.json` });
    expect(await reusable("youtube-cc-ccccccccccc", root)).toEqual({ file: null, track: null });
    expect(await reusable("pexels-123456", root)).toEqual({ file: null, track: null });
  });
});

describe("retarget command", () => {
  it("hands an arm robot the arm the judge passed, and never sends the flag to the g1", () => {
    expect(contractArgs("youtube-cc-aaaaaaaaaaa", "so101", 6, "data/demos/x.json", 3, "right")).toEqual(["dlx", "tsx", "scripts/retarget.mts", "--track", "data/tracks/youtube-cc-aaaaaaaaaaa.json", "--robot", "so101", "--start", "3", "--seconds", "6", "--out", "data/demos/x.json", "--arm", "right"]);
    expect(contractArgs("k", "panda", 6, "o.json", null, null)).not.toContain("--arm");
    expect(contractArgs("k", "panda", 6, "o.json", null, null)).toContain("auto");
    expect(contractArgs("k", "g1", 6, "o.json", 0, "left")).not.toContain("--arm");
  });
});
