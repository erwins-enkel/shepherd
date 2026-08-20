import { describe, expect, it } from "bun:test";
import {
  overallExitCode,
  renderReport,
  reportFileName,
  type CheckResult,
} from "../scripts/herdr-compat/report";

const checks: CheckResult[] = [
  { id: "S1", title: "Protocol", verdict: "REVIEW", details: "17 -> 19" },
  { id: "S3", title: "Record-shape gate", verdict: "PASS", details: "zero drift" },
  { id: "L5", title: "Last-tab close", verdict: "REVIEW", details: "differs from baseline" },
];

function input(over?: Partial<Parameters<typeof renderReport>[0]>) {
  return {
    candidate: "0.8.2",
    baseline: "0.8.0",
    candidateProtocol: 19,
    baselineProtocol: 19,
    date: "2026-08-20",
    platform: "linux-x86_64",
    commandLine: "bun run herdr:compat -- --candidate 0.8.2",
    checks,
    ...over,
  };
}

describe("overallExitCode", () => {
  it("is 0 when nothing FAILs (REVIEW does not fail the run)", () => {
    expect(overallExitCode(checks)).toBe(0);
  });

  it("is 1 when any check FAILs", () => {
    expect(
      overallExitCode([...checks, { id: "S4", title: "CLI", verdict: "FAIL", details: "gone" }]),
    ).toBe(1);
  });
});

describe("reportFileName", () => {
  it("names the report after the sanitized candidate version", () => {
    expect(reportFileName("0.8.2")).toBe("0.8.2.md");
    expect(reportFileName("v0.8.2\n")).toBe("0.8.2.md");
  });

  it("refuses a version that sanitizes to nothing", () => {
    expect(() => reportFileName("../../etc/passwd")).toThrow();
    expect(() => reportFileName("")).toThrow();
  });
});

describe("renderReport", () => {
  it("carries header, verdict summary and one section per check", () => {
    const md = renderReport(input());
    expect(md).toContain("# herdr 0.8.2 compatibility report");
    expect(md).toContain("0.8.0");
    expect(md).toContain("protocol 19");
    expect(md).toContain("2026-08-20");
    expect(md).toContain("linux-x86_64");
    expect(md).toContain("bun run herdr:compat -- --candidate 0.8.2");
    // verdict roll-up: 1 PASS / 2 REVIEW / 0 FAIL
    expect(md).toMatch(/PASS: 1/);
    expect(md).toMatch(/REVIEW: 2/);
    expect(md).toMatch(/FAIL: 0/);
    for (const c of checks) {
      expect(md).toContain(`${c.id} — ${c.title}`);
      expect(md).toContain(c.details);
    }
    // next steps point at the regeneration commands and the rule
    expect(md).toContain("gen:herdr-schema");
    expect(md).toContain(".claude/rules/herdr-version-bump.md");
  });

  it("labels an all-clear run and a failing run distinctly", () => {
    const pass = renderReport(
      input({ checks: [{ id: "S3", title: "Gate", verdict: "PASS", details: "ok" }] }),
    );
    expect(pass).toContain("**Overall: PASS**");
    const fail = renderReport(
      input({ checks: [{ id: "S3", title: "Gate", verdict: "FAIL", details: "drift" }] }),
    );
    expect(fail).toContain("**Overall: FAIL**");
    const review = renderReport(input());
    expect(review).toContain("**Overall: REVIEW**");
  });
});
