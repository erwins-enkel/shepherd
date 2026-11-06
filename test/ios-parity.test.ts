import { expect, test } from "bun:test";
import {
  backfillEpic,
  backfillIssues,
  digestIssue,
  featureIssue,
  isNonUserFacing,
  isoWeek,
  isUiSourceChange,
  neutralizeMentions,
  parseEntry,
  prNumberFromSubject,
  snippet,
  type ResolvedEntry,
} from "../scripts/ios-parity";

const REPO = "acme/shepherd";

function entry(id: string, sinceVersion: string, body = "Body text."): ResolvedEntry {
  return {
    id,
    sinceVersion,
    titleKey: `feat_${id}_title`,
    bodyKey: `feat_${id}_body`,
    file: `ui/src/lib/feature-announcements/entries/v${sinceVersion}-${id}.ts`,
    titleEn: `Title ${id}`,
    titleDe: `Titel ${id}`,
    bodyEn: body,
    bodyDe: `DE ${body}`,
  };
}

test("parseEntry reads the catalog fragment shape", () => {
  const src = `import type { FeatureAnnouncement } from "../../feature-announcements";
export default {
  // comment
  id: "weekly-usage-push",
  sinceVersion: "2.7.0",
  titleKey: "feat_weekly_usage_push_title",
  bodyKey: "feat_weekly_usage_push_body",
  targetId: "x",
} satisfies FeatureAnnouncement;`;
  expect(parseEntry(src)).toEqual({
    id: "weekly-usage-push",
    sinceVersion: "2.7.0",
    titleKey: "feat_weekly_usage_push_title",
    bodyKey: "feat_weekly_usage_push_body",
  });
  expect(parseEntry(`export default { id: "x" }`)).toBeNull();
});

test("prNumberFromSubject takes the trailing squash-merge number", () => {
  expect(prNumberFromSubject("fix(x): thing (#3631) (#3699)")).toBe(3699);
  expect(prNumberFromSubject("chore: direct push")).toBeNull();
});

test("isUiSourceChange keeps ui/src code, drops tests and other packages", () => {
  expect(isUiSourceChange("ui/src/routes/+page.svelte")).toBe(true);
  expect(isUiSourceChange("ui/src/lib/foo.ts")).toBe(true);
  expect(isUiSourceChange("ui/src/lib/foo.test.ts")).toBe(false);
  expect(isUiSourceChange("ui/src/lib/__tests__/a.ts")).toBe(false);
  expect(isUiSourceChange("src/server.ts")).toBe(false);
});

test("isNonUserFacing skips docs/test/ci/build commits only", () => {
  expect(isNonUserFacing("docs: sync docs (#1)")).toBe(true);
  expect(isNonUserFacing("test(ui): cover x")).toBe(true);
  expect(isNonUserFacing("fix(ui): x")).toBe(false);
  expect(isNonUserFacing("feat(ui)!: x")).toBe(false);
});

test("neutralizeMentions breaks pings but keeps text readable", () => {
  expect(neutralizeMentions("bump @types/node, ask @kai")).toBe("bump @​types/node, ask @​kai");
  expect(neutralizeMentions("mail a@ b")).toBe("mail a@ b");
});

test("snippet collapses whitespace and cuts on a word boundary", () => {
  expect(snippet("a  b\n c")).toBe("a b c");
  const cut = snippet("word ".repeat(100), 30);
  expect(cut.endsWith(" …")).toBe(true);
  expect(cut.length).toBeLessThanOrEqual(32);
});

test("isoWeek follows ISO-8601 at year boundaries", () => {
  expect(isoWeek(new Date("2026-11-06T12:00:00Z"))).toBe("2026-W45");
  expect(isoWeek(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  expect(isoWeek(new Date("2025-12-29T00:00:00Z"))).toBe("2026-W01");
});

test("featureIssue carries the marker, both languages and the source PR", () => {
  const d = featureIssue(
    entry("chat-room", "2.7.0"),
    { sha: "abc", subject: "feat(ui): room (#3712)" },
    REPO,
  );
  expect(d.marker).toBe("<!-- ios-parity:feature:chat-room -->");
  expect(d.title).toBe("iOS-Parität: Titel chat-room");
  expect(d.body.startsWith(d.marker)).toBe(true);
  expect(d.body).toContain("DE Body text.");
  expect(d.body).toContain("Body text.");
  expect(d.body).toContain("#3712 — feat(ui): room");
  expect(d.body).not.toContain("room (#3712)");
});

test("featureIssue links the commit when there is no PR number", () => {
  const d = featureIssue(
    entry("x", "2.7.0"),
    { sha: "0123456789abcdef", subject: "feat: direct" },
    REPO,
  );
  expect(d.body).toContain(`https://github.com/${REPO}/commit/0123456789abcdef`);
});

test("digestIssue lists every change under a week marker", () => {
  const d = digestIssue(
    "2026-W45",
    [
      { sha: "a", subject: "fix(ui): one (#1)" },
      { sha: "b", subject: "fix(ui): two (#2)" },
    ],
    REPO,
  );
  expect(d.marker).toBe("<!-- ios-parity:digest:2026-W45 -->");
  expect(d.body).toContain("- [ ] #1 — fix(ui): one");
  expect(d.body).toContain("- [ ] #2 — fix(ui): two");
});

test("backfillIssues packs whole release lines, oldest first, under the cap", () => {
  const entries = [
    entry("a", "1.9.0"),
    entry("b", "1.10.0"),
    entry("c", "1.10.1"),
    entry("d", "2.0.0"),
    entry("e", "2.0.1"),
    entry("f", "2.1.0"),
  ];
  const drafts = backfillIssues(entries, REPO, 3);
  expect(drafts.map((d) => d.title)).toEqual([
    "iOS-Parität Rückstand: PWA-Features v1.9–v1.10",
    "iOS-Parität Rückstand: PWA-Features v2.0–v2.1",
  ]);
  expect(drafts.map((d) => d.marker)).toEqual([
    "<!-- ios-parity:backfill:1.9-1.10 -->",
    "<!-- ios-parity:backfill:2.0-2.1 -->",
  ]);
  const ids = drafts.flatMap((d) => [...d.body.matchAll(/\(`([a-z]+)`/g)].map((m) => m[1]));
  expect(ids).toEqual(["a", "b", "c", "d", "e", "f"]);
});

test("backfillIssues gives an oversized release line its own issue", () => {
  const drafts = backfillIssues(
    [entry("a", "1.0.0"), entry("b", "1.1.0"), entry("c", "1.1.1")],
    REPO,
    1,
  );
  expect(drafts.map((d) => d.title)).toEqual([
    "iOS-Parität Rückstand: PWA-Features v1.0",
    "iOS-Parität Rückstand: PWA-Features v1.1",
  ]);
});

test("backfill bodies stay under GitHub's body limit at the default cap", () => {
  const long = "x".repeat(2000);
  const entries = Array.from({ length: 600 }, (_, i) =>
    entry(`f${i}`, `2.${Math.floor(i / 50)}.0`, long),
  );
  for (const d of backfillIssues(entries, REPO)) expect(d.body.length).toBeLessThan(65_536);
});

test("backfillEpic lists its children", () => {
  const d = backfillEpic([
    { number: 10, title: "A" },
    { number: 11, title: "B" },
  ]);
  expect(d.body).toContain("- [ ] #10 A");
  expect(d.body).toContain("- [ ] #11 B");
});
