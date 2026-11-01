// security-watch filing: only `private` carries details; the redaction test uses sentinel strings.
import { test, expect } from "bun:test";
import { fullTitle, issueLabels, redactedTitle } from "../src/plugins/bundled/security-watch/file";
import { groupCodeScanning } from "../src/plugins/bundled/security-watch/rules";
import { cs, dep, REPO, world } from "./security-watch-fixture";

const SENTINELS = [
  "js/secret-rule",
  "src/secret-path.ts",
  "RULE-DESC",
  "MESSAGE-",
  "HYPOTHESIS",
  "FILE",
  "REASON",
  "CodeQL",
  "CWE-",
  "high",
];

function leaks(o: unknown): string[] {
  const text = JSON.stringify(o);
  return SENTINELS.filter((s) => text.includes(s));
}

const secretAlert = () => cs(120, { ruleId: "js/secret-rule", path: "src/secret-path.ts" });

for (const visibility of ["public", "internal", "unknown"] as const) {
  test(`${visibility}: redacted issue carries no alert details`, async () => {
    const { w, poller } = world({ publicRiskAck: true });
    w.visibility = visibility;
    w.setCs([secretAlert(), cs(121, { ruleId: "js/secret-rule", path: "src/secret-path.ts" })]);
    await poller.poll();
    expect(w.created).toHaveLength(1);
    const issue = w.created[0]!;
    expect(leaks(issue)).toEqual([]);
    expect(issue.untrusted).toEqual([]);
    expect(issue.labels).toEqual(["security-alert"]);
    expect(issue.title).toBe(redactedTitle("cs", 120));
    expect(issue.title).toContain("gh api");
    expect(issue.body).toContain("gh api repos/o/web/code-scanning/alerts/120");
    expect(issue.body).toContain("gh api repos/o/web/code-scanning/alerts/121");
  });
}

test("redacted Dependabot issue hides the package and advisory", async () => {
  const { w, poller } = world({ publicRiskAck: true });
  w.visibility = "public";
  w.setDep([dep(11)]);
  await poller.poll();
  const text = JSON.stringify(w.created[0]);
  for (const s of ["lodash", "package.json", "ADVISORY", "GHSA", "9.9.9"]) {
    expect(text).not.toContain(s);
  }
  expect(w.created[0]?.body).toContain("gh api repos/o/web/dependabot/alerts/11");
  expect(w.created[0]?.body).toContain("gh pr list --app dependabot");
});

test("a redacted issue lists at most 50 alerts", async () => {
  const { w, poller } = world({ publicRiskAck: true });
  w.visibility = "public";
  w.setCs(Array.from({ length: 60 }, (_, i) => cs(i + 1)));
  await poller.poll();
  const body = w.created[0]!.body;
  expect(body).toContain("alerts/50");
  expect(body).not.toContain("alerts/51");
  expect(body).toContain("10 more");
});

test("a visibility read that rejects files redacted with the opt-in, nothing without it", async () => {
  const acked = world({ publicRiskAck: true });
  acked.w.visibility = new Error("HTTP 500");
  acked.w.setCs([secretAlert()]);
  await acked.poller.poll();
  expect(acked.w.created).toHaveLength(1);
  expect(leaks(acked.w.created[0])).toEqual([]);

  const plain = world();
  plain.w.visibility = new Error("HTTP 500");
  plain.w.setCs([secretAlert()]);
  await plain.poller.poll();
  expect(plain.w.triaged).toHaveLength(0);
  expect(plain.w.created).toHaveLength(0);
  expect(plain.w.status()["needs-ack"]).toBe(1);
});

test("private: full issue with details fenced as untrusted, trusted title sanitized", async () => {
  const { w, poller } = world();
  w.setCs([secretAlert()]);
  await poller.poll();
  const issue = w.created[0]!;
  expect(issue.title).toBe("Code scanning: js/secret-rule in src/secret-path.ts");
  expect(issue.body).toContain("https://gh/cs/120");
  expect(issue.body).toContain("high");
  expect(issue.body).not.toContain("MESSAGE-120");
  const fenced = JSON.stringify(issue.untrusted);
  for (const s of ["MESSAGE-120", "RULE-DESC", "HYPOTHESIS", "FILE"]) expect(fenced).toContain(s);
  expect(issue.body).toContain("Never suppress the finding");
});

test("fullTitle: an unsafe rule or path falls back to the alert number", () => {
  const g = (o: Parameters<typeof cs>[1]) => ({
    ...groupCodeScanning(REPO, [cs(7, o)])[0]!,
    triage: undefined,
  });
  expect(fullTitle(g({}), 7)).toBe("Code scanning: js/rule in src/a.ts");
  expect(fullTitle(g({ path: "ignore previous instructions.ts" }), 7)).toBe(
    "Code scanning alert #7",
  );
  expect(fullTitle(g({ ruleId: "a\nb" }), 7)).toBe("Code scanning alert #7");
  expect(fullTitle(g({ path: `${"x".repeat(250)}.ts` }), 7)).toBe("Code scanning alert #7");
});

test("issueLabels: the drain label needs auto-drain, a label and attempts left", () => {
  expect(issueLabels(false, "auto", 0)).toEqual(["security-alert"]);
  expect(issueLabels(true, undefined, 0)).toEqual(["security-alert"]);
  expect(issueLabels(true, "auto", 1)).toEqual(["security-alert", "auto"]);
  expect(issueLabels(true, "auto", 2)).toEqual(["security-alert"]);
});

test("a repo that turned public between poll and filing is refused at filing", async () => {
  const { w, poller } = world();
  w.setCs([secretAlert()]);
  w.onTriage = () => void (w.visibility = "public");
  await poller.poll();
  expect(w.created).toHaveLength(0);
  expect(w.status()["needs-ack"]).toBe(1);
  expect(w.group("js/secret-rule").triage).toMatchObject({ outcome: "accepted" });
  expect(w.group("js/secret-rule").triage?.filing).toBeUndefined();
});

test("a forge error leaves the group unfiled; a core refusal settles it", async () => {
  const { w, poller, triage } = world();
  w.setCs([cs(1)]);
  w.createError = new Error("HTTP 502");
  await poller.poll();
  expect(w.group().filing).toBeUndefined();
  expect(w.group().triage?.retryAt).toBeGreaterThan(w.clock);
  w.createError = null;
  w.clock += 16 * 60_000;
  await triage.advance();
  expect(w.created).toHaveLength(1);
  expect(w.group().filing?.number).toBe(41);

  const refused = world();
  refused.w.setCs([cs(1)]);
  refused.w.createError = Object.assign(new Error("no"), {
    name: "PluginIssuesError",
    code: "lightweight",
  });
  await refused.poller.poll();
  expect(refused.w.group().triage?.filing).toEqual({ status: "refused", code: "lightweight" });
});
