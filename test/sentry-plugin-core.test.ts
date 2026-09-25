// Sentry plugin (#2464): PII scrub, frame → repo-path resolution, filing rules/caps.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrub } from "../src/plugins/bundled/sentry/scrub";
import {
  candidatePaths,
  isRepoFile,
  resolveInAppFrames,
} from "../src/plugins/bundled/sentry/frames";
import {
  DAILY_CAP,
  evaluateIssue,
  projectIndex,
  type RuleContext,
} from "../src/plugins/bundled/sentry/rules";
import type { SentryFrame, SentryIssue } from "../src/plugins/bundled/sentry/api";

describe("scrub", () => {
  test("redacts emails, IPs, JWTs, bearer tokens, key=value secrets, query values, UUIDs", () => {
    const raw = [
      "user jane.doe+x@example.co.uk failed",
      "from 192.168.10.4 and 2001:db8::8a2e:370:7334",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "Authorization: Bearer abcdefghijklmnop1234",
      "password=hunter22 api_key: 'sk-live-xyz'",
      "GET https://app.example.com/cb?code=SECRETCODE&state=abc#frag",
      "req 123e4567-e89b-12d3-a456-426614174000",
      "https://publickey:priv@o1.ingest.sentry.io/42",
    ].join("\n");
    const out = scrub(raw);
    for (const leak of [
      "jane.doe",
      "192.168.10.4",
      "2001:db8",
      "eyJhbGci",
      "abcdefghijklmnop1234",
      "hunter22",
      "sk-live-xyz",
      "SECRETCODE",
      "123e4567",
      "publickey",
    ]) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain("[email]");
    expect(out).toContain("?code=[redacted]&state=[redacted]");
  });

  test("keeps code paths, line numbers and clock times", () => {
    const s = "at handle (src/lib/components/settings/Panel.svelte:42:7) 12:30:45";
    expect(scrub(s)).toBe(s);
  });

  test("strips control chars and caps length", () => {
    expect(scrub("a\u0000b\u001bc\nd")).toBe("abc\nd");
    expect(scrub("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("frames", () => {
  test("candidatePaths strips schemes/queries, longest first, refuses .. and node_modules", () => {
    expect(candidatePaths("app:///src/routes/+page.ts?v=3")).toEqual([
      "src/routes/+page.ts",
      "routes/+page.ts",
      "+page.ts",
    ]);
    expect(candidatePaths("webpack://my-app/./src/a.ts")[0]).toBe("my-app/src/a.ts");
    expect(candidatePaths("../../etc/passwd")).toEqual([]);
    expect(candidatePaths("/app/node_modules/x/index.js")).toEqual([]);
  });

  test("resolveInAppFrames maps in-app frames to real repo files, innermost first", async () => {
    const repo = mkdtempSync(join(tmpdir(), "shep-sentry-frames-"));
    try {
      mkdirSync(join(repo, "src/lib"), { recursive: true });
      writeFileSync(join(repo, "src/lib/a.ts"), "");
      writeFileSync(join(repo, "src/lib/b.ts"), "");
      const f = (filename: string, inApp: boolean, lineNo = 1): SentryFrame => ({
        filename,
        absPath: null,
        function: "fn",
        lineNo,
        inApp,
      });
      const out = await resolveInAppFrames(repo, [
        f("/build/node_modules/lib.js", false),
        f("/home/ci/work/app/src/lib/a.ts", true, 10),
        f("app:///src/lib/missing.ts", true),
        f("app:///src/lib/b.ts", true, 20),
      ]);
      expect(out).toEqual([
        { path: "src/lib/b.ts", lineNo: 20, fn: "fn" },
        { path: "src/lib/a.ts", lineNo: 10, fn: "fn" },
      ]);
      expect(await isRepoFile(repo, "../outside")).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("rules", () => {
  const issue = (over: Partial<SentryIssue> = {}): SentryIssue => ({
    id: "1",
    shortId: "APP-1",
    permalink: "https://sentry.io/organizations/o/issues/1/",
    substatus: "new",
    assignee: null,
    projectSlug: "web",
    count: 12,
    userCount: 3,
    firstSeen: null,
    lastSeen: null,
    ...over,
  });
  const ctx = (over: Partial<RuleContext> = {}): RuleContext => ({
    repoForProject: new Map([["web", "/r/web"]]),
    filed: null,
    filedToday: () => 0,
    ...over,
  });

  test("eligible new issue", () => {
    expect(evaluateIssue(issue(), ctx())).toEqual({
      ok: true,
      repo: "/r/web",
      regressionKey: null,
      refile: false,
    });
  });

  test("filters unmapped, wrong substatus, human-assigned; team-assigned is fine", () => {
    expect(evaluateIssue(issue({ projectSlug: "other" }), ctx())).toMatchObject({
      reason: "unmapped",
    });
    expect(evaluateIssue(issue({ substatus: "ongoing" }), ctx())).toMatchObject({
      reason: "substatus",
    });
    expect(evaluateIssue(issue({ assignee: "user" }), ctx())).toMatchObject({ reason: "assigned" });
    expect(evaluateIssue(issue({ assignee: "team" }), ctx()).ok).toBe(true);
  });

  test("dedup: filed → skip; regressed refiles until MAX_ATTEMPTS", () => {
    const filed = { repo: "/r/web", number: 5, url: "u", attempts: 1, filedAt: "t" };
    expect(evaluateIssue(issue(), ctx({ filed }))).toMatchObject({ reason: "filed" });
    expect(evaluateIssue(issue({ substatus: "regressed" }), ctx({ filed }))).toEqual({
      ok: true,
      repo: "/r/web",
      regressionKey: "r1",
      refile: true,
    });
    expect(
      evaluateIssue(issue({ substatus: "regressed" }), ctx({ filed: { ...filed, attempts: 2 } })),
    ).toMatchObject({ reason: "attempts" });
  });

  test("daily cap per repo", () => {
    expect(evaluateIssue(issue(), ctx({ filedToday: () => DAILY_CAP }))).toMatchObject({
      reason: "cap",
    });
    expect(evaluateIssue(issue(), ctx({ filedToday: () => DAILY_CAP - 1 })).ok).toBe(true);
  });

  test("projectIndex: first repo per project wins, unusable repos dropped", () => {
    const m = {
      "/r/b": { project: "web", autoDrain: false, source: "manual" as const },
      "/r/a": { project: "web", autoDrain: false, source: "manual" as const },
      "/r/c": { project: "api", autoDrain: false, source: "manual" as const },
    };
    expect([...projectIndex(m, (r) => r !== "/r/c")]).toEqual([["web", "/r/a"]]);
  });
});
