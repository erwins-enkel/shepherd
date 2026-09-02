import { describe, expect, it } from "bun:test";
import {
  DEFAULT_BAND_THRESHOLDS,
  MAINTAIN_DRAFT_FILE,
  bandKey,
  breaches,
  buildDiagnosisPrompt,
  describeReading,
  evaluateBands,
  mergeThresholds,
  parseMaintainDraft,
  renderIssueBody,
  thresholdsFromEnv,
  type BandInput,
} from "../src/maintain-core";
import type { BandReading, DeliveryRepoRow, DeliveryStats } from "../src/types";

const NOW = 1_800_000_000_000;

const EMPTY_INPUT: BandInput = {
  reviewOutcomes: { verdicts: 0, errors: 0 },
  incidents: [],
  repos: [],
};

function input(over: Partial<BandInput>): BandInput {
  return { ...EMPTY_INPUT, ...over };
}

function evaluate(over: Partial<BandInput>): BandReading[] {
  return evaluateBands(input(over), DEFAULT_BAND_THRESHOLDS, NOW);
}

function readingFor(readings: BandReading[], key: string): BandReading {
  const r = readings.find((x) => x.key === key);
  if (!r) throw new Error(`no reading for ${key}; got ${readings.map((x) => x.key).join(", ")}`);
  return r;
}

/** A DeliveryRepoRow carrying only the field the band reads; the rest is inert padding. */
function repoRow(repoPath: string, value: number | null, n: number): DeliveryRepoRow {
  const nil = { value: null, n: 0 };
  const stats: DeliveryStats = {
    mergedTasks: n,
    firstPassRate: { value, n },
    unreviewed: 0,
    reworkCyclesMedian: nil,
    reworkCyclesMean: nil,
    criticErrors: 0,
    planRoundsMedian: nil,
    planReworkRate: nil,
    planDriftRate: nil,
    planDriftMajor: 0,
    timeToFirstReviewMs: nil,
    leadTimeMs: nil,
    firstPushGreenRate: nil,
  };
  return { ...stats, repoPath, repo: repoPath.split("/").pop() ?? repoPath };
}

describe("bandKey", () => {
  it("is the bare band id for a global band and suffixed for a subject-scoped one", () => {
    expect(bandKey("critic_error_rate")).toBe("critic_error_rate");
    expect(bandKey("incident_spike", "stall")).toBe("incident_spike:stall");
    expect(bandKey("first_pass_collapse", "/repos/shepherd")).toBe(
      "first_pass_collapse:/repos/shepherd",
    );
  });

  it("treats an empty subject as no subject, so a key is never left dangling", () => {
    expect(bandKey("incident_spike", "")).toBe("incident_spike");
    expect(bandKey("incident_spike", null)).toBe("incident_spike");
  });
});

describe("critic_error_rate band", () => {
  it("is below-min-sample (never 'clear') under 10 outcome-bearing spawns", () => {
    // 4/5 = 80% — deep in tier 2 territory, but on five spawns it means nothing.
    const r = readingFor(
      evaluate({ reviewOutcomes: { verdicts: 1, errors: 4 } }),
      "critic_error_rate",
    );
    expect(r.tier).toBe(0);
    expect(r.belowMinSample).toBe(true);
    expect(r.sampleN).toBe(5);
  });

  it("reports tier 0 with a 0 value and no NaN when nothing was reviewed at all", () => {
    const r = readingFor(evaluate({}), "critic_error_rate");
    expect(r.value).toBe(0);
    expect(Number.isNaN(r.value)).toBe(false);
    expect(r.belowMinSample).toBe(true);
  });

  it("stays clear below the tier-1 threshold once the sample qualifies", () => {
    // 1/20 = 5%
    const r = readingFor(
      evaluate({ reviewOutcomes: { verdicts: 19, errors: 1 } }),
      "critic_error_rate",
    );
    expect(r.tier).toBe(0);
    expect(r.belowMinSample).toBe(false);
  });

  it("logs at exactly the tier-1 threshold (inclusive)", () => {
    // 3/20 = 15%
    const r = readingFor(
      evaluate({ reviewOutcomes: { verdicts: 17, errors: 3 } }),
      "critic_error_rate",
    );
    expect(r.tier).toBe(1);
  });

  it("diagnoses at exactly the tier-2 threshold (inclusive)", () => {
    // 6/20 = 30%
    const r = readingFor(
      evaluate({ reviewOutcomes: { verdicts: 14, errors: 6 } }),
      "critic_error_rate",
    );
    expect(r.tier).toBe(2);
  });
});

describe("incident_spike band", () => {
  it("excludes the `reply` kind — the correction stream is not an incident class", () => {
    const readings = evaluate({
      incidents: [
        { kind: "reply", occurrences: 500, sessions: 40 },
        { kind: "stall", occurrences: 1, sessions: 1 },
      ],
    });
    expect(readings.some((r) => r.key === "incident_spike:reply")).toBe(false);
    expect(readings.some((r) => r.key === "incident_spike:stall")).toBe(true);
  });

  it("needs BOTH counts, so one thrashing session cannot trip a systemic band", () => {
    const r = readingFor(
      evaluate({ incidents: [{ kind: "stall", occurrences: 40, sessions: 1 }] }),
      "incident_spike:stall",
    );
    expect(r.tier).toBe(0);
  });

  it("logs when both tier-1 counts are met", () => {
    const r = readingFor(
      evaluate({ incidents: [{ kind: "block", occurrences: 10, sessions: 3 }] }),
      "incident_spike:block",
    );
    expect(r.tier).toBe(1);
  });

  it("diagnoses only when both tier-2 counts are met", () => {
    const nearMiss = readingFor(
      evaluate({ incidents: [{ kind: "block", occurrences: 25, sessions: 4 }] }),
      "incident_spike:block",
    );
    expect(nearMiss.tier).toBe(1);
    const hit = readingFor(
      evaluate({ incidents: [{ kind: "block", occurrences: 25, sessions: 5 }] }),
      "incident_spike:block",
    );
    expect(hit.tier).toBe(2);
  });
});

describe("first_pass_collapse band", () => {
  it("is below-min-sample under 8 merged tasks, however bad the rate", () => {
    const r = readingFor(evaluate({ repos: [repoRow("/r/a", 0, 3)] }), "first_pass_collapse:/r/a");
    expect(r.tier).toBe(0);
    expect(r.belowMinSample).toBe(true);
  });

  it("treats an unmeasured rate as no data rather than 0%", () => {
    const r = readingFor(
      evaluate({ repos: [repoRow("/r/a", null, 20)] }),
      "first_pass_collapse:/r/a",
    );
    expect(r.tier).toBe(0);
    expect(r.belowMinSample).toBe(true);
  });

  it("is inverted — a LOWER rate is worse", () => {
    const healthy = readingFor(
      evaluate({ repos: [repoRow("/r/a", 0.9, 20)] }),
      "first_pass_collapse:/r/a",
    );
    expect(healthy.tier).toBe(0);
    const logged = readingFor(
      evaluate({ repos: [repoRow("/r/a", 0.6, 20)] }),
      "first_pass_collapse:/r/a",
    );
    expect(logged.tier).toBe(1);
    const diagnosed = readingFor(
      evaluate({ repos: [repoRow("/r/a", 0.4, 20)] }),
      "first_pass_collapse:/r/a",
    );
    expect(diagnosed.tier).toBe(2);
  });

  it("emits one reading per repo, keyed by path", () => {
    const readings = evaluate({ repos: [repoRow("/r/a", 0.9, 20), repoRow("/r/b", 0.2, 20)] });
    expect(
      readings
        .filter((r) => r.bandId === "first_pass_collapse")
        .map((r) => r.key)
        .sort(),
    ).toEqual(["first_pass_collapse:/r/a", "first_pass_collapse:/r/b"]);
  });
});

describe("evaluateBands", () => {
  it("returns every band including the clear ones, so the lens can show live values", () => {
    const readings = evaluate({
      reviewOutcomes: { verdicts: 100, errors: 0 },
      incidents: [{ kind: "stall", occurrences: 0, sessions: 0 }],
      repos: [repoRow("/r/a", 1, 20)],
    });
    expect(readings).toHaveLength(3);
    expect(readings.every((r) => r.tier === 0)).toBe(true);
  });

  it("stamps every reading with the injected clock", () => {
    const readings = evaluate({ repos: [repoRow("/r/a", 1, 20)] });
    expect(readings.every((r) => r.evaluatedAt === NOW)).toBe(true);
  });
});

describe("breaches", () => {
  it("keeps only breached bands, most severe first — the spend cap takes the head", () => {
    const readings = evaluate({
      reviewOutcomes: { verdicts: 17, errors: 3 }, // tier 1
      incidents: [{ kind: "stall", occurrences: 40, sessions: 9 }], // tier 2
      repos: [repoRow("/r/a", 1, 20)], // clear
    });
    const ranked = breaches(readings);
    expect(ranked.map((r) => r.key)).toEqual(["incident_spike:stall", "critic_error_rate"]);
  });

  it("orders equal tiers deterministically so the pick does not flap between sweeps", () => {
    const readings = evaluate({
      incidents: [
        { kind: "stall", occurrences: 30, sessions: 9 },
        { kind: "block", occurrences: 30, sessions: 9 },
      ],
    });
    expect(breaches(readings).map((r) => r.key)).toEqual([
      "incident_spike:block",
      "incident_spike:stall",
    ]);
  });
});

describe("threshold overrides", () => {
  it("returns the defaults for absent, blank or unparseable env values", () => {
    expect(thresholdsFromEnv(undefined)).toEqual(DEFAULT_BAND_THRESHOLDS);
    expect(thresholdsFromEnv("   ")).toEqual(DEFAULT_BAND_THRESHOLDS);
    expect(thresholdsFromEnv("{{{not json")).toEqual(DEFAULT_BAND_THRESHOLDS);
  });

  it("merges field by field, leaving untouched bands at their defaults", () => {
    const merged = thresholdsFromEnv('{"critic_error_rate":{"tier2":0.5}}');
    expect(merged.critic_error_rate.tier2).toBe(0.5);
    expect(merged.critic_error_rate.tier1).toBe(DEFAULT_BAND_THRESHOLDS.critic_error_rate.tier1);
    expect(merged.first_pass_collapse).toEqual(DEFAULT_BAND_THRESHOLDS.first_pass_collapse);
  });

  it("ignores non-numeric junk rather than disarming a band", () => {
    const merged = mergeThresholds({ critic_error_rate: { tier1: "loads", minSample: -3 } });
    expect(merged.critic_error_rate.tier1).toBe(DEFAULT_BAND_THRESHOLDS.critic_error_rate.tier1);
    expect(merged.critic_error_rate.minSample).toBe(
      DEFAULT_BAND_THRESHOLDS.critic_error_rate.minSample,
    );
  });

  it("applies a merged override to the evaluation", () => {
    const readings = evaluateBands(
      input({ reviewOutcomes: { verdicts: 19, errors: 1 } }), // 5%
      thresholdsFromEnv('{"critic_error_rate":{"tier1":0.01,"tier2":0.02}}'),
      NOW,
    );
    expect(readingFor(readings, "critic_error_rate").tier).toBe(2);
  });
});

describe("buildDiagnosisPrompt", () => {
  const reading = readingFor(
    evaluate({ incidents: [{ kind: "stall", occurrences: 40, sessions: 9 }] }),
    "incident_spike:stall",
  );

  it("fences untrusted signal payloads", () => {
    const prompt = buildDiagnosisPrompt({
      reading,
      evidence: [{ kind: "stall", repo: "shepherd", ts: NOW, payload: "agent tail" }],
      windowDays: 7,
      thresholdNote: "t1 10/3, t2 25/5",
    });
    expect(prompt).toContain("⟦UNTRUSTED:signal 1:");
    expect(prompt).toContain("agent tail");
  });

  it("caps the evidence block so the prompt cannot grow with signal volume", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      kind: "stall",
      repo: "shepherd",
      ts: NOW,
      payload: `x${i} ${"y".repeat(5000)}`,
    }));
    const prompt = buildDiagnosisPrompt({
      reading,
      evidence: many,
      windowDays: 7,
      thresholdNote: "n",
    });
    // Count opening evidence fences only — the standing directive quotes the marker shape too.
    expect(prompt.split("⟦UNTRUSTED:signal ").length - 1).toBe(12);
    expect(prompt).not.toContain("x12 ");
    expect(prompt.length).toBeLessThan(20_000);
  });

  it("names the draft file and forbids editing", () => {
    const prompt = buildDiagnosisPrompt({
      reading,
      evidence: [],
      windowDays: 7,
      thresholdNote: "n",
    });
    expect(prompt).toContain(MAINTAIN_DRAFT_FILE);
    expect(prompt).toContain("do not edit anything");
  });
});

describe("parseMaintainDraft", () => {
  const good = JSON.stringify({
    title: "Critic spawns wedge on the trust dialog",
    anomaly: "30% of review spawns produced no verdict.",
    evidence: "src/review.ts finalize() times out.",
    subsystem: "ReviewService",
    openQuestions: ["Is this only Codex?"],
  });

  it("parses a well-formed draft", () => {
    const d = parseMaintainDraft(good);
    expect(d?.title).toBe("Critic spawns wedge on the trust dialog");
    expect(d?.openQuestions).toEqual(["Is this only Codex?"]);
  });

  it("recovers a draft with unescaped inner quotes", () => {
    // The recurring real failure: the agent writes „…" prose and forgets to escape.
    const sloppy = '{"title":"Reviewer says "no verdict"","anomaly":"It errored."}';
    expect(parseMaintainDraft(sloppy)?.anomaly).toBe("It errored.");
  });

  it("rejects a draft with no title or no anomaly, so an empty issue can never be filed", () => {
    expect(parseMaintainDraft('{"anomaly":"x"}')).toBeNull();
    expect(parseMaintainDraft('{"title":"x"}')).toBeNull();
    expect(parseMaintainDraft('{"title":"  ","anomaly":"x"}')).toBeNull();
  });

  it("rejects non-JSON and non-object payloads", () => {
    expect(parseMaintainDraft("")).toBeNull();
    expect(parseMaintainDraft("null")).toBeNull();
    expect(parseMaintainDraft('"just a string"')).toBeNull();
    expect(parseMaintainDraft("[1,2,3]")).toBeNull();
  });

  it("clamps an over-long title and collapses its whitespace", () => {
    const d = parseMaintainDraft(
      JSON.stringify({ title: `a\n\nb${"c".repeat(500)}`, anomaly: "x" }),
    );
    expect(d?.title.length).toBe(120);
    expect(d?.title.startsWith("a b")).toBe(true);
  });

  it("caps and cleans the open-questions list", () => {
    const d = parseMaintainDraft(
      JSON.stringify({
        title: "t",
        anomaly: "a",
        openQuestions: [...Array.from({ length: 20 }, (_, i) => `q${i}`), "", 42],
      }),
    );
    expect(d?.openQuestions).toHaveLength(8);
  });

  it("tolerates a missing openQuestions field", () => {
    expect(parseMaintainDraft('{"title":"t","anomaly":"a"}')?.openQuestions).toEqual([]);
  });
});

describe("renderIssueBody", () => {
  const reading = readingFor(
    evaluate({ incidents: [{ kind: "stall", occurrences: 40, sessions: 9 }] }),
    "incident_spike:stall",
  );

  it("marks the issue as machine-opened and its diagnosis as a hypothesis", () => {
    const body = renderIssueBody(
      { title: "t", anomaly: "a", evidence: "e", subsystem: "s", openQuestions: ["q"] },
      reading,
    );
    expect(body).toContain("maintain loop");
    expect(body).toContain("hypothesis");
  });

  it("carries the band provenance so a triaging operator can trace the measurement", () => {
    const body = renderIssueBody(
      { title: "t", anomaly: "a", evidence: "", subsystem: "", openQuestions: [] },
      reading,
    );
    expect(body).toContain("incident_spike:stall");
    expect(body).toContain(describeReading(reading));
  });

  it("omits empty sections rather than rendering bare headings", () => {
    const body = renderIssueBody(
      { title: "t", anomaly: "a", evidence: "", subsystem: "", openQuestions: [] },
      reading,
    );
    expect(body).not.toContain("## Evidence");
    expect(body).not.toContain("## Open questions");
  });
});
