import { describe, expect, it } from "bun:test";
import {
  DEFAULT_BAND_THRESHOLDS,
  MAINTAIN_DRAFT_FILE,
  bandKey,
  breaches,
  buildDiagnosisPrompt,
  describeDeadCode,
  describeReading,
  evaluateBands,
  mergeThresholds,
  packagesFor,
  parseDeadCodeReport,
  readMaintainDraft,
  renderFixPrBody,
  renderIssueBody,
  thresholdsFromEnv,
  windowDaysFor,
  type BandInput,
} from "../src/maintain-core";
import type { BandReading, DeliveryRepoRow, DeliveryStats } from "../src/types";

const NOW = 1_800_000_000_000;

const EMPTY_INPUT: BandInput = {
  reviewOutcomes: { verdicts: 0, errors: 0 },
  incidents: [],
  repos: [],
  deadCode: null,
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
      deadCode: { autoFixable: 0, total: 0, byCategory: {} },
    });
    expect(readings).toHaveLength(4);
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
      thresholdNote: "n",
    });
    expect(prompt).toContain(MAINTAIN_DRAFT_FILE);
    expect(prompt).toContain("do not edit anything");
  });
});

describe("readMaintainDraft", () => {
  const good = JSON.stringify({
    title: "Critic spawns wedge on the trust dialog",
    anomaly: "30% of review spawns produced no verdict.",
    evidence: "src/review.ts finalize() times out.",
    subsystem: "ReviewService",
    openQuestions: ["Is this only Codex?"],
  });

  it("reports a well-formed draft as a STRICT parse, so it finalizes without waiting", () => {
    const r = readMaintainDraft(good);
    expect(r.status).toBe("parsed");
    if (r.status !== "parsed") throw new Error("unreachable");
    expect(r.repaired).toBe(false);
    expect(r.value.title).toBe("Critic spawns wedge on the trust dialog");
    expect(r.value.openQuestions).toEqual(["Is this only Codex?"]);
  });

  it("recovers a draft with unescaped inner quotes, and MARKS it repaired", () => {
    // The recurring real failure: the agent writes „…" prose and forgets to escape. Recoverable —
    // but `repaired` is what stops a truncated mid-write file being trusted as a finished one.
    const sloppy = '{"title":"Reviewer says "no verdict"","anomaly":"It errored."}';
    const r = readMaintainDraft(sloppy);
    expect(r.status).toBe("parsed");
    if (r.status !== "parsed") throw new Error("unreachable");
    expect(r.repaired).toBe(true);
    expect(r.value.anomaly).toBe("It errored.");
  });

  it("marks a TRUNCATED draft repaired rather than passing it off as complete", () => {
    // jsonrepair closes this up into a shape-valid object; only `repaired` distinguishes it from a
    // finished document.
    const r = readMaintainDraft('{"title":"Critic errors spiked","anomaly":"30% of review spa');
    expect(r.status).toBe("parsed");
    if (r.status !== "parsed") throw new Error("unreachable");
    expect(r.repaired).toBe(true);
  });

  it("reports a missing file as absent, distinct from a bad one", () => {
    expect(readMaintainDraft(null).status).toBe("absent");
  });

  it("reports a present-but-shapeless draft as unparseable, not absent", () => {
    // Present but not a diagnosis: waiting out the timeout for it would be pointless.
    expect(readMaintainDraft('{"anomaly":"x"}').status).toBe("unparseable");
    expect(readMaintainDraft('{"title":"x"}').status).toBe("unparseable");
    expect(readMaintainDraft('{"title":"  ","anomaly":"x"}').status).toBe("unparseable");
  });

  it("rejects non-JSON and non-object payloads", () => {
    expect(readMaintainDraft("").status).toBe("unparseable");
    expect(readMaintainDraft("null").status).toBe("unparseable");
    expect(readMaintainDraft('"just a string"').status).toBe("unparseable");
    expect(readMaintainDraft("[1,2,3]").status).toBe("unparseable");
  });

  it("clamps an over-long title and collapses its whitespace", () => {
    const r = readMaintainDraft(
      JSON.stringify({ title: `a\n\nb${"c".repeat(500)}`, anomaly: "x" }),
    );
    if (r.status !== "parsed") throw new Error("expected a parsed draft");
    expect(r.value.title.length).toBe(120);
    expect(r.value.title.startsWith("a b")).toBe(true);
  });

  it("caps and cleans the open-questions list", () => {
    const r = readMaintainDraft(
      JSON.stringify({
        title: "t",
        anomaly: "a",
        openQuestions: [...Array.from({ length: 20 }, (_, i) => `q${i}`), "", 42],
      }),
    );
    if (r.status !== "parsed") throw new Error("expected a parsed draft");
    expect(r.value.openQuestions).toHaveLength(8);
  });

  it("tolerates a missing openQuestions field", () => {
    const r = readMaintainDraft('{"title":"t","anomaly":"a"}');
    if (r.status !== "parsed") throw new Error("expected a parsed draft");
    expect(r.value.openQuestions).toEqual([]);
  });
});

describe("windowDaysFor", () => {
  it("gives each band the window it is actually scored over", () => {
    // first_pass_collapse reads the 30d delivery range; quoting 7 in the prompt would put a wrong
    // measurement window into the filed issue as the agent's reasoning.
    expect(windowDaysFor("first_pass_collapse")).toBe(30);
    expect(windowDaysFor("critic_error_rate")).toBe(7);
    expect(windowDaysFor("incident_spike")).toBe(7);
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

// ── dead_code_drift + tier 3 (#2171) ─────────────────────────────────────────

/** A minimal but shape-faithful `fallow dead-code --format json` payload: one auto-fixable unused
 *  export plus one unused file fallow refuses to touch, which is exactly today's repo state. */
function fallowReport(over?: {
  exports?: number;
  files?: number;
  extra?: Record<string, unknown>;
}): string {
  const exports = over?.exports ?? 1;
  const files = over?.files ?? 1;
  return JSON.stringify({
    kind: "dead-code",
    schema_version: 7,
    total_issues: exports + files,
    unused_files: Array.from({ length: files }, (_, i) => ({
      path: `ui/src/lib/components/Gone${i}.svelte`,
      actions: [
        { type: "delete-file", auto_fixable: false, description: "Delete this file" },
        { type: "suppress-file", auto_fixable: false, description: "Suppress" },
      ],
    })),
    unused_exports: Array.from({ length: exports }, (_, i) => ({
      path: "src/usage.ts",
      export_name: `gone${i}`,
      actions: [
        { type: "remove-export", auto_fixable: true, description: "Remove the unused export" },
        { type: "suppress-line", auto_fixable: false, description: "Suppress" },
      ],
    })),
    // The only other top-level array fallow emits, and the reason the parser keys off `actions`
    // rather than off "is an array".
    next_steps: [{ id: "trace-unused-export", command: "fallow dead-code --trace x", reason: "y" }],
    ...over?.extra,
  });
}

describe("parseDeadCodeReport", () => {
  it("counts only findings fallow can fix itself", () => {
    const r = parseDeadCodeReport(fallowReport({ exports: 2, files: 3 }));
    expect(r).not.toBeNull();
    expect(r!.autoFixable).toBe(2);
    expect(r!.total).toBe(5);
    expect(r!.byCategory).toEqual({ unused_exports: 2 });
  });

  it("ignores top-level arrays that carry no actions", () => {
    // `next_steps` has three entries in the fixture's shape but no `actions` — counting it would
    // inflate every reading.
    const r = parseDeadCodeReport(fallowReport({ exports: 0, files: 0 }));
    expect(r!.total).toBe(0);
    expect(r!.autoFixable).toBe(0);
  });

  it("counts a category fallow adds in a later release without a code change here", () => {
    const r = parseDeadCodeReport(
      fallowReport({
        exports: 0,
        files: 0,
        extra: {
          some_future_category: [
            { path: "a.ts", actions: [{ type: "x", auto_fixable: true, description: "d" }] },
          ],
        },
      }),
    );
    expect(r!.autoFixable).toBe(1);
    expect(r!.byCategory).toEqual({ some_future_category: 1 });
  });

  it("returns null rather than a confident zero for anything that is not a dead-code report", () => {
    // Each of these would otherwise read as "no dead code" — the exact lie that would let the
    // Tier-3 verify gate pass on a fallow that fell over.
    expect(parseDeadCodeReport(null)).toBeNull();
    expect(parseDeadCodeReport("")).toBeNull();
    expect(parseDeadCodeReport("not json at all {{{")).toBeNull();
    expect(parseDeadCodeReport(JSON.stringify({ error: "boom" }))).toBeNull();
    expect(parseDeadCodeReport(JSON.stringify({ kind: "health", total_issues: 0 }))).toBeNull();
  });
});

describe("describeDeadCode", () => {
  it("spells out the per-category breakdown", () => {
    expect(describeDeadCode(parseDeadCodeReport(fallowReport({ exports: 2 }))!)).toBe(
      "2 unused exports",
    );
  });

  it("says so when there is nothing to fix", () => {
    expect(describeDeadCode({ autoFixable: 0, total: 3, byCategory: {} })).toBe(
      "no auto-fixable findings",
    );
  });
});

describe("evaluateBands — dead_code_drift", () => {
  const reading = (over: Partial<BandInput>) => readingFor(evaluate(over), "dead_code_drift");

  it("is always present, and reads as no-data when fallow could not be run", () => {
    const r = reading({ deadCode: null });
    expect(r.tier).toBe(0);
    expect(r.belowMinSample).toBe(true);
    expect(r.value).toBe(0);
  });

  it("is clear at zero auto-fixable findings even with findings a human still owns", () => {
    const r = reading({ deadCode: { autoFixable: 0, total: 4, byCategory: {} } });
    expect(r.tier).toBe(0);
    expect(r.belowMinSample).toBe(false);
    expect(r.sampleN).toBe(4);
  });

  it("logs at tier 1 below the tier-2 threshold", () => {
    const r = reading({ deadCode: { autoFixable: 1, total: 3, byCategory: {} } });
    expect(r.tier).toBe(1);
  });

  it("promotes its tier-2 breach to tier 3 — it declares a fix class", () => {
    const r = reading({ deadCode: { autoFixable: 3, total: 3, byCategory: {} } });
    expect(r.tier).toBe(3);
    expect(DEFAULT_BAND_THRESHOLDS.dead_code_drift.tier3).toEqual({ class: "dead_code" });
  });

  it("reports tier 2, not 3, when the band declares no fix class", () => {
    // The whole point of the promotion rule: a band without a mechanical remediation keeps the
    // diagnosis path. Guards against a future edit putting `tier3` on the shared config shape.
    const noClass = {
      ...DEFAULT_BAND_THRESHOLDS,
      dead_code_drift: { tier1: 1, tier2: 3 },
    };
    const readings = evaluateBands(
      input({ deadCode: { autoFixable: 9, total: 9, byCategory: {} } }),
      noClass,
      NOW,
    );
    expect(readingFor(readings, "dead_code_drift").tier).toBe(2);
  });

  it("never promotes the three v1 bands — none has a fix class", () => {
    const readings = evaluateBands(
      input({
        reviewOutcomes: { verdicts: 1, errors: 9 },
        incidents: [{ kind: "stall", occurrences: 100, sessions: 50 }],
        repos: [repoRow("/r/a", 0.0, 40)],
        deadCode: { autoFixable: 9, total: 9, byCategory: {} },
      }),
      DEFAULT_BAND_THRESHOLDS,
      NOW,
    );
    for (const r of readings) {
      if (r.bandId === "dead_code_drift") expect(r.tier).toBe(3);
      else expect(r.tier).toBe(2);
    }
  });
});

describe("mergeThresholds — dead_code_drift", () => {
  it("retunes the numbers", () => {
    const t = mergeThresholds({ dead_code_drift: { tier1: 5, tier2: 20 } });
    expect(t.dead_code_drift.tier1).toBe(5);
    expect(t.dead_code_drift.tier2).toBe(20);
  });

  it("keeps the fix class an override cannot reach", () => {
    // Disarming tier 3 is SHEPHERD_MAINTAIN_PR's job, not the threshold table's — one disarm
    // switch, not two. An override that drops the class must not silently disarm the tier.
    const t = mergeThresholds({ dead_code_drift: { tier1: 2, tier2: 4 } });
    expect(t.dead_code_drift.tier3).toEqual({ class: "dead_code" });
    const cleared = mergeThresholds({ dead_code_drift: { tier3: null } });
    expect(cleared.dead_code_drift.tier3).toEqual({ class: "dead_code" });
  });

  it("falls back field-by-field on garbage", () => {
    const t = mergeThresholds({ dead_code_drift: { tier1: "lots", tier2: 7 } });
    expect(t.dead_code_drift.tier1).toBe(DEFAULT_BAND_THRESHOLDS.dead_code_drift.tier1);
    expect(t.dead_code_drift.tier2).toBe(7);
  });
});

describe("describeReading / renderFixPrBody — count band", () => {
  const r: BandReading = {
    key: "dead_code_drift",
    bandId: "dead_code_drift",
    repoPath: null,
    subject: null,
    tier: 3,
    value: 2,
    sampleN: 5,
    belowMinSample: false,
    evaluatedAt: NOW,
  };

  it("renders a count, not a percentage", () => {
    expect(describeReading(r)).toBe("dead_code_drift: 2 auto-fixable of 5 finding(s) → tier 3");
  });

  it("names what was removed, what was left, and the pinned fallow", () => {
    const body = renderFixPrBody(
      { autoFixable: 2, total: 5, byCategory: { unused_exports: 2 } },
      r,
      ["root", "ui"],
    );
    expect(body).toContain("maintain loop (tier 3)");
    // The body must name what was ACTUALLY checked — the root tsc alone would be a vacuous claim
    // for a diff under ui/.
    expect(body).toContain("`root`, `ui`");
    expect(body).toContain("2 unused exports");
    expect(body).toContain("3 finding(s) are not auto-fixable");
    expect(body).toContain("dead_code_drift");
  });

  it("omits the left-alone section when fallow could fix everything", () => {
    const body = renderFixPrBody(
      { autoFixable: 2, total: 2, byCategory: { unused_exports: 2 } },
      r,
      ["root"],
    );
    expect(body).not.toContain("Left alone");
  });
});

describe("windowDaysFor", () => {
  it("reports no window for the point-in-time band", () => {
    expect(windowDaysFor("dead_code_drift")).toBe(0);
  });
});

describe("packagesFor", () => {
  it("routes each changed path to the package that can actually check it", () => {
    // The bug this closes: `bun run typecheck` is tsc against a tsconfig that EXCLUDES ui and
    // extension, so a root-only gate passes vacuously for a fix under ui/src/lib.
    expect(packagesFor(["src/usage.ts"]).packages).toEqual(["root"]);
    expect(packagesFor(["ui/src/lib/x.ts"]).packages).toEqual(["ui"]);
    expect(packagesFor(["extension/src/background.ts"]).packages).toEqual(["extension"]);
  });

  it("returns every touched package, cheapest check first", () => {
    expect(packagesFor(["ui/src/lib/x.ts", "src/usage.ts", "extension/src/y.ts"]).packages).toEqual(
      ["root", "extension", "ui"],
    );
  });

  it("de-duplicates several paths in one package", () => {
    expect(packagesFor(["ui/a.ts", "ui/b.ts", "ui/c.ts"]).packages).toEqual(["ui"]);
  });

  it("flags the trees nothing here can verify rather than silently checking the root", () => {
    // site/ and docs-site/ are in fallow's entry list but have no installed deps and no wired
    // check in the fix worktree — treating them as "root" would be the same vacuous pass.
    const out = packagesFor(["src/usage.ts", "site/src/pages/index.astro", "docs-site/x.mjs"]);
    expect(out.unverifiable).toEqual(["site/src/pages/index.astro", "docs-site/x.mjs"]);
    expect(out.packages).toEqual(["root"]);
  });

  it("treats scripts and tests as root", () => {
    expect(packagesFor(["scripts/x.ts", "test/y.ts"]).packages).toEqual(["root"]);
  });
});
