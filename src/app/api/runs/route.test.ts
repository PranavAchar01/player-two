import { describe, expect, it, vi } from "vitest";
import { CLI_MAX_VIDEOS_CAP } from "../../../../scripts/agent/types";
import { parseArgv, validateRunRequest } from "../../../../scripts/agent/validate";

// If validation ever let a bad body through, the route would try to start a process. Make that loud, not real.
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn(() => { throw new Error("spawn must not be reached by an invalid request"); }) }));
vi.mock("node:child_process", () => ({ spawn, execFile: vi.fn() }));

const post = async (body: unknown) => {
  const { POST } = await import("./route");
  return POST(new Request("http://localhost/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }));
};

describe("validateRunRequest", () => {
  it("accepts a plain task and fills in defaults", () => {
    const v = validateRunRequest({ task: "  dumbbell   lateral raise " });
    expect(v).toEqual({ ok: true, value: { task: "dumbbell lateral raise", robot: "g1", maxVideos: 6, seconds: 6, sources: ["pexels", "youtube-cc"], allowStandardLicense: false } });
  });

  it("accepts every allowed robot and basic punctuation", () => {
    for (const robot of ["g1", "so101", "panda"]) expect(validateRunRequest({ task: "wave hello", robot }).ok).toBe(true);
    expect(validateRunRequest({ task: "stir a pot (slowly), don't spill" }).ok).toBe(true);
  });

  it("rejects tasks that are too short, too long, or outside the alphabet", () => {
    for (const task of ["", "ab", "x".repeat(121), "wave; rm -rf /", "wave $(id)", "wave `id`", "wave | cat", "wave > /tmp/x", "wave\nhello", "--robot panda", "-x wave", "wave \"hello\"", "../../etc/passwd", "wave\x00hello", 42, null, ["wave"]]) expect(validateRunRequest({ task }).ok).toBe(false);
  });

  it("rejects robots that are not on the list", () => {
    for (const robot of ["atlas", "G1", "", "g1 --allow-standard-license", 1, null]) expect(validateRunRequest({ task: "wave hello", robot }).ok).toBe(false);
  });

  it("holds maxVideos to whole numbers from 1 to 25", () => {
    for (const maxVideos of [1, 6, 25]) expect(validateRunRequest({ task: "wave hello", maxVideos }).ok).toBe(true);
    for (const maxVideos of [0, 26, -1, 2.5, "6", NaN, Infinity, null]) expect(validateRunRequest({ task: "wave hello", maxVideos }).ok).toBe(false);
  });

  it("lets the command line ask for up to 80, and only when it says so", () => {
    expect(validateRunRequest({ task: "wave hello", maxVideos: 80 }, CLI_MAX_VIDEOS_CAP).ok).toBe(true);
    expect(validateRunRequest({ task: "wave hello", maxVideos: 81 }, CLI_MAX_VIDEOS_CAP).ok).toBe(false);
    expect(validateRunRequest({ task: "wave hello", maxVideos: 80 }).ok).toBe(false);
  });

  it("takes an accepted-clips target no larger than the judged budget", () => {
    expect(validateRunRequest({ task: "wave hello", maxVideos: 80, targetAccepted: 20 }, CLI_MAX_VIDEOS_CAP)).toMatchObject({ ok: true, value: { maxVideos: 80, targetAccepted: 20 } });
    expect(validateRunRequest({ task: "wave hello", maxVideos: 6, targetAccepted: 6 })).toMatchObject({ ok: true, value: { targetAccepted: 6 } });
    for (const targetAccepted of [0, 7, -1, 2.5, "3", NaN, null]) expect(validateRunRequest({ task: "wave hello", maxVideos: 6, targetAccepted }).ok).toBe(false);
    const v = validateRunRequest({ task: "wave hello" });
    expect(v.ok && "targetAccepted" in v.value).toBe(false);
  });

  it("checks seconds, sources and the licence flag", () => {
    for (const seconds of [1, 21, "6", NaN]) expect(validateRunRequest({ task: "wave hello", seconds }).ok).toBe(false);
    for (const sources of [[], ["vimeo"], "pexels", ["pexels", 3]]) expect(validateRunRequest({ task: "wave hello", sources }).ok).toBe(false);
    expect(validateRunRequest({ task: "wave hello", sources: ["youtube-cc", "youtube-cc"] })).toMatchObject({ ok: true, value: { sources: ["youtube-cc"] } });
    expect(validateRunRequest({ task: "wave hello", allowStandardLicense: "yes" }).ok).toBe(false);
  });

  it("rejects bodies that are not objects", () => {
    for (const body of [null, undefined, "wave", 3, [], [{ task: "wave hello" }]]) expect(validateRunRequest(body).ok).toBe(false);
  });
});

describe("parseArgv", () => {
  it("maps CLI flags onto the same request the API takes", () => {
    const a = parseArgv(["dumbbell lateral raise", "--robot", "g1", "--max-videos", "6", "--seconds", "6", "--sources", "pexels,youtube-cc"]);
    expect(a).toEqual({ request: { task: "dumbbell lateral raise", robot: "g1", maxVideos: 6, seconds: 6, sources: ["pexels", "youtube-cc"] }, runId: null, brainFile: null });
    expect("request" in a && validateRunRequest(a.request).ok).toBe(true);
  });
  it("reads --target-accepted", () => {
    const a = parseArgv(["wave hello", "--max-videos", "80", "--target-accepted", "20"]);
    expect(a).toEqual({ request: { task: "wave hello", maxVideos: 80, targetAccepted: 20 }, runId: null, brainFile: null });
    expect("request" in a && validateRunRequest(a.request, CLI_MAX_VIDEOS_CAP).ok).toBe(true);
    expect("request" in a && validateRunRequest(a.request).ok).toBe(false); // the web door would not take 80
  });
  it("reads --brain as a file path and keeps it out of the request the API validates", () => {
    const a = parseArgv(["wave hello", "--brain", "data/runs/x/brief.json"]);
    expect(a).toEqual({ request: { task: "wave hello" }, runId: null, brainFile: "data/runs/x/brief.json" });
  });
  it("keeps the standard-licence switch off unless asked, and refuses unknown flags", () => {
    const off = parseArgv(["wave hello"]);
    expect("request" in off && validateRunRequest(off.request)).toMatchObject({ ok: true, value: { allowStandardLicense: false } });
    expect(parseArgv(["wave hello", "--shell", "sh"])).toHaveProperty("error");
    expect(parseArgv([])).toHaveProperty("error");
    expect(parseArgv(["wave", "hello"])).toHaveProperty("error");
  });
});

describe("POST /api/runs", () => {
  it("answers 400 and never starts a process for a bad body", async () => {
    for (const body of ["not json", { task: "x" }, { task: "wave; rm -rf /" }, { task: "wave hello", robot: "atlas" }, { task: "wave hello", maxVideos: 26 }, { task: "wave hello", maxVideos: 0 }, { task: "wave hello", sources: ["vimeo"] }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("answers 422 with the reasons when the robot cannot do the task, and starts nothing", async () => {
    for (const [task, robot] of [["do jumping jacks", "so101"], ["clap both hands", "panda"], ["fold a shirt", "so101"]]) {
      const res = await post({ task, robot });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string; reasons: string[]; suggestion: string | null };
      expect(body.error).toMatch(new RegExp(robot));
      expect(body.reasons.length).toBeGreaterThanOrEqual(2);
      expect(body.reasons.join(" ")).toMatch(/one fixed-base arm/);
      expect(body.suggestion).toMatch(/g1/);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("keeps the web cap at 25 even though the command line goes higher", async () => {
    expect((await post({ task: "wave hello", maxVideos: 80 })).status).toBe(400);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not let the web page switch the licence policy off", async () => {
    const res = await post({ task: "wave hello", allowStandardLicense: true });
    expect(res.status).toBe(400);
    expect(spawn).not.toHaveBeenCalled();
  });
});
