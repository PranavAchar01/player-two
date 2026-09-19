import { describe, expect, it } from "vitest";
import { validatePlan } from "./plan";
import { isCreativeCommons, keepYoutubeEntry, youtubeLicence } from "./search";

const CC = "Creative Commons Attribution license (reuse allowed)";
const ok = { id: "WWhSHS2DrKQ", license: CC, duration: 30 };

describe("licence filter", () => {
  it("recognises Creative Commons and nothing else", () => {
    expect(isCreativeCommons(CC)).toBe(true);
    expect(isCreativeCommons("creative commons")).toBe(true);
    for (const v of ["Standard YouTube License", "", null, undefined, 3, { license: CC }]) expect(isCreativeCommons(v)).toBe(false);
  });

  it("keeps a short Creative Commons video", () => {
    expect(keepYoutubeEntry(ok, false)).toEqual({ keep: true, reason: null });
    expect(youtubeLicence(CC).redistributable).toBe(true);
  });

  it("drops standard-licence and unlabelled videos by default, with the reason", () => {
    const std = keepYoutubeEntry({ ...ok, license: "Standard YouTube License" }, false);
    expect(std.keep).toBe(false);
    expect(std.reason).toMatch(/only Creative Commons/);
    expect(keepYoutubeEntry({ ...ok, license: undefined }, false).keep).toBe(false);
  });

  it("lets a standard licence through only with the flag, and never as redistributable", () => {
    expect(keepYoutubeEntry({ ...ok, license: "Standard YouTube License" }, true).keep).toBe(true);
    expect(youtubeLicence("Standard YouTube License").redistributable).toBe(false);
    expect(youtubeLicence(undefined).redistributable).toBe(false);
  });

  it("drops long videos, live streams, unknown durations and odd ids whatever the licence", () => {
    expect(keepYoutubeEntry({ ...ok, duration: 241 }, true).keep).toBe(false);
    expect(keepYoutubeEntry({ ...ok, duration: 240 }, false).keep).toBe(true);
    expect(keepYoutubeEntry({ ...ok, is_live: true }, true).keep).toBe(false);
    expect(keepYoutubeEntry({ ...ok, duration: undefined }, true).keep).toBe(false);
    expect(keepYoutubeEntry({ ...ok, id: "--exec=rm" }, true).keep).toBe(false);
    expect(keepYoutubeEntry({ ...ok, id: "../../etc/passwd" }, true).keep).toBe(false);
  });
});

describe("plan from the model is untrusted", () => {
  const good = { queries: ["lateral raise front view", "person lateral raise full body", "shoulder raise demonstration", "dumbbell side raise one person"], arm: "both", motionDescription: "both arms rise sideways", signature: { kind: "arm_elevation", threshold: 65, minCount: 3, direction: "sideways" }, rejectionCriteria: ["two people"] };

  it("accepts a well-formed plan and caps repetitions to what fits in the window", () => {
    const p = validatePlan(good, "dumbbell lateral raise", "m", 6)!;
    expect(p.planner).toBe("gemini");
    expect(p.queries).toHaveLength(4);
    expect(p.signature).toEqual({ kind: "arm_elevation", threshold: 65, minCount: 2, direction: "sideways" });
  });

  it("strips operators, markup and urls out of queries and clamps numbers", () => {
    const p = validatePlan({ ...good, queries: ["site:evil.example <script>alert(1)</script>", "a", "lateral raise | rm -rf /", "raise `id`"], signature: { kind: "arm_elevation", threshold: 9000, minCount: -4, direction: "up; rm -rf" }, motionDescription: "x".repeat(900) + "<img>" }, "dumbbell lateral raise", "m", 6)!;
    for (const q of p.queries) expect(q).toMatch(/^[A-Za-z0-9 '-]+$/);
    expect(p.queries.length).toBeGreaterThanOrEqual(4);
    expect(p.signature).toEqual({ kind: "arm_elevation", threshold: 150, minCount: 1, direction: "any" });
    expect(p.motionDescription.length).toBeLessThanOrEqual(240);
  });

  it("refuses shapes that are not a plan and falls back on unknown enums", () => {
    expect(validatePlan(null, "wave hello", "m", 6)).toBeNull();
    expect(validatePlan({ queries: "rm -rf" }, "wave hello", "m", 6)).toBeNull();
    const p = validatePlan({ ...good, arm: "tentacle", signature: { kind: "exec", threshold: 1, minCount: 1 } }, "wave hello", "m", 6)!;
    expect(p.arm).toBe("either");
    expect(p.signature.kind).toBe("wrist_oscillation");
  });
});
