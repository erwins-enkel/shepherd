// iOS ↔ PWA parity tracker. The iOS app lags the PWA, so every PWA change is an
// iOS question. This script turns that into GitHub issues, keyed on the What's-New
// feature catalog (ui/src/lib/feature-announcements/entries/) that every
// user-facing `feat` must already extend (scripts/check-feature-catalog.sh):
//
//   features --base <sha> --head <sha>
//       One `parity` issue per catalog entry ADDED in base..head (the push to main).
//   digest [--now <iso>]
//       One weekly issue listing the past 7 days' merged ui/src changes that did NOT
//       add a catalog entry (fixes, refinements) — reviewed for iOS in one pass.
//   backfill
//       One-time catch-up: one issue per release line (major.minor) listing that
//       line's catalog features as a checklist, plus an epic issue linking them.
//
// Every mode accepts --dry-run (print, create nothing). Each issue carries an HTML
// marker (`<!-- ios-parity:… -->`) so re-runs never create duplicates.
//
// Inputs are our own main-branch commits and catalog strings, but they still pass
// through `neutralizeMentions` so a subject like `@types/node` never pings anyone.
// `gh` is always invoked with an argument vector (no shell), and issue bodies go
// through --body-file, so no text here is ever interpreted by a shell.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ENTRIES_DIR = "ui/src/lib/feature-announcements/entries";
export const LABELS = ["parity", "ios-app", "requires-macos"];
const BODY_SNIPPET_MAX = 160;
const BACKFILL_MAX_ITEMS = 90;

export interface CatalogEntry {
  id: string;
  sinceVersion: string;
  titleKey: string;
  bodyKey: string;
}

export interface ResolvedEntry extends CatalogEntry {
  file: string;
  titleEn: string;
  titleDe: string;
  bodyEn: string;
  bodyDe: string;
}

export interface ChangeItem {
  sha: string;
  subject: string;
}

export interface IssueDraft {
  marker: string;
  title: string;
  body: string;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Read id/sinceVersion/titleKey/bodyKey from an entry fragment's source. */
export function parseEntry(source: string): CatalogEntry | null {
  const field = (name: string) =>
    source.match(new RegExp(`\\b${name}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`))?.[1];
  const id = field("id");
  const sinceVersion = field("sinceVersion");
  const titleKey = field("titleKey");
  const bodyKey = field("bodyKey");
  if (!id || !sinceVersion || !titleKey || !bodyKey) return null;
  return { id, sinceVersion, titleKey, bodyKey };
}

/** The squash-merge PR number at the end of a main commit subject, if any. */
export function prNumberFromSubject(subject: string): number | null {
  const m = subject.match(/\(#(\d+)\)\s*$/);
  return m ? Number(m[1]) : null;
}

/** True for a PWA source file (ui/src/**) that is not a test. */
export function isUiSourceChange(path: string): boolean {
  if (!path.startsWith("ui/src/")) return false;
  return !/(\.(test|spec)\.[cm]?[jt]sx?$)|(\/__tests__\/)/.test(path);
}

/** Stop GitHub from turning `@name` into a ping (zero-width space after `@`). */
export function neutralizeMentions(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9_-])/g, "@​");
}

/** Collapse whitespace and cut to `max` chars on a word boundary. */
export function snippet(text: string, max = BODY_SNIPPET_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()} …`;
}

/** ISO-8601 week label (`2026-W45`) for a UTC date. */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** `2.6.0` → `2.6`. */
export function releaseLine(version: string): string {
  return version.split(".").slice(0, 2).join(".");
}

function compareLines(a: string, b: string): number {
  const [am = 0, an = 0] = a.split(".").map(Number);
  const [bm = 0, bn = 0] = b.split(".").map(Number);
  return am - bm || an - bn;
}

/** `#123 — subject` for a squash-merged PR, else a commit link + subject. */
function changeLine(c: ChangeItem, repo: string): string {
  const pr = prNumberFromSubject(c.subject);
  if (!pr)
    return `[\`${c.sha.slice(0, 9)}\`](https://github.com/${repo}/commit/${c.sha}) — ${c.subject}`;
  return `#${pr} — ${c.subject.replace(/\s*\(#\d+\)\s*$/, "")}`;
}

/** Conventional-commit types that never change what a user sees. */
export function isNonUserFacing(subject: string): boolean {
  return /^(docs|test|ci|build)(\(.*\))?!?:/.test(subject);
}

const CHECKLIST = [
  "- [ ] Auf iOS umgesetzt (PR verlinken)",
  "- [ ] Gibt es auf iOS bereits — Issue schließen",
  "- [ ] Bewusst nicht auf iOS — Begründung als Kommentar, Issue schließen",
].join("\n");

/** Issue for one newly merged catalog feature. */
export function featureIssue(
  e: ResolvedEntry,
  change: ChangeItem | null,
  repo: string,
): IssueDraft {
  const marker = `<!-- ios-parity:feature:${e.id} -->`;
  const source = change ? changeLine(change, repo) : "unbekannt";
  const body = [
    marker,
    "Die PWA hat ein neues Feature bekommen. Bitte prüfen, ob und wie die iOS-App es braucht.",
    "",
    `**${e.titleDe}**`,
    "",
    e.bodyDe,
    "",
    "<details><summary>English</summary>",
    "",
    `**${e.titleEn}**`,
    "",
    e.bodyEn,
    "",
    "</details>",
    "",
    `- Feature-ID: \`${e.id}\` (seit v${e.sinceVersion})`,
    `- Katalog: [\`${e.file}\`](https://github.com/${repo}/blob/main/${e.file})`,
    `- Eingeführt in: ${source}`,
    "",
    "## Entscheidung",
    "",
    CHECKLIST,
    "",
    "_Automatisch angelegt von `.github/workflows/ios-parity.yml`._",
  ].join("\n");
  return {
    marker,
    title: neutralizeMentions(`iOS-Parität: ${e.titleDe}`),
    body: neutralizeMentions(body),
  };
}

/** Weekly issue listing ui/src changes that did not add a catalog feature. */
export function digestIssue(week: string, items: ChangeItem[], repo: string): IssueDraft {
  const marker = `<!-- ios-parity:digest:${week} -->`;
  const lines = items.map((c) => `- [ ] ${changeLine(c, repo)}`);
  const body = [
    marker,
    `PWA-Änderungen an \`ui/src\` aus ${week}, die **kein** neues Katalog-Feature`,
    "eingeführt haben (Fixes, Verfeinerungen). Neue Features haben ein eigenes",
    "`parity`-Issue. Abhaken, was auf iOS geprüft ist; für alles, was iOS",
    "nachziehen muss, ein eigenes `ios-app`-Issue anlegen und hier verlinken.",
    "",
    ...lines,
    "",
    "_Automatisch angelegt von `.github/workflows/ios-parity.yml`._",
  ].join("\n");
  return {
    marker,
    title: `iOS-Parität: PWA-Änderungen ${week} prüfen`,
    body: neutralizeMentions(body),
  };
}

/**
 * Catch-up issues, oldest first: whole release lines (major.minor) packed into
 * issues of at most `maxItems` features, so ~600 features fit in a handful of
 * issues that each stay well under GitHub's 65 536-character body limit. A single
 * line larger than `maxItems` gets an issue of its own.
 */
export function backfillIssues(
  entries: ResolvedEntry[],
  repo: string,
  maxItems = BACKFILL_MAX_ITEMS,
): IssueDraft[] {
  const byLine = new Map<string, ResolvedEntry[]>();
  for (const e of entries) {
    const line = releaseLine(e.sinceVersion);
    byLine.set(line, [...(byLine.get(line) ?? []), e]);
  }
  const chunks: { lines: string[]; entries: ResolvedEntry[] }[] = [];
  for (const line of [...byLine.keys()].sort(compareLines)) {
    const lineEntries = (byLine.get(line) ?? [])
      .slice()
      .sort((a, b) => a.file.localeCompare(b.file));
    const last = chunks.at(-1);
    if (last && last.entries.length + lineEntries.length <= maxItems) {
      last.lines.push(line);
      last.entries.push(...lineEntries);
    } else {
      chunks.push({ lines: [line], entries: lineEntries });
    }
  }
  return chunks.map(({ lines, entries: chunk }) => {
    const first = lines[0] ?? "";
    const last = lines.at(-1) ?? first;
    const range = first === last ? `v${first}` : `v${first}–v${last}`;
    const marker = `<!-- ios-parity:backfill:${first}-${last} -->`;
    const items = chunk.map(
      (e) => `- [ ] **${e.titleDe}** (\`${e.id}\`, v${e.sinceVersion}) — ${snippet(e.bodyDe)}`,
    );
    const body = [
      marker,
      `Rückstand: ${chunk.length} PWA-Features aus dem Katalog, Release ${range}.`,
      "Pro Zeile abhaken, wenn die iOS-App das Feature hat oder bewusst nicht",
      "bekommt. Was iOS nachziehen muss, als eigenes `ios-app`-Issue anlegen und",
      "hinter die Zeile schreiben.",
      "",
      `Katalog: [\`${ENTRIES_DIR}\`](https://github.com/${repo}/tree/main/${ENTRIES_DIR})`,
      "",
      ...items,
      "",
      "_Automatisch angelegt von `scripts/ios-parity.ts backfill`._",
    ].join("\n");
    return {
      marker,
      title: `iOS-Parität Rückstand: PWA-Features ${range}`,
      body: neutralizeMentions(body),
    };
  });
}

/** The epic that groups the backfill issues. */
export function backfillEpic(children: { number: number; title: string }[]): IssueDraft {
  const marker = "<!-- ios-parity:backfill:epic -->";
  const body = [
    marker,
    "Die iOS-App hängt der PWA hinterher. Dieses Epic sammelt den Rückstand je",
    "Release-Linie. Neue PWA-Features bekommen ab jetzt automatisch ein eigenes",
    "`parity`-Issue, sonstige PWA-Änderungen landen im wöchentlichen Digest",
    "(beides `.github/workflows/ios-parity.yml`).",
    "",
    ...children.map((c) => `- [ ] #${c.number} ${c.title}`),
  ].join("\n");
  return { marker, title: "Epic: iOS ↔ PWA Feature-Parität", body: neutralizeMentions(body) };
}

// ── IO ───────────────────────────────────────────────────────────────────────

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function loadMessages(lang: "en" | "de", ref?: string): Record<string, string> {
  const path = `ui/messages/${lang}.json`;
  const raw = ref ? git(["show", `${ref}:${path}`]) : readFileSync(path, "utf8");
  return JSON.parse(raw) as Record<string, string>;
}

function resolveEntry(
  file: string,
  source: string,
  en: Record<string, string>,
  de: Record<string, string>,
): ResolvedEntry | null {
  const entry = parseEntry(source);
  if (!entry) return null;
  const titleEn = en[entry.titleKey] ?? entry.id;
  const bodyEn = en[entry.bodyKey] ?? "";
  return {
    ...entry,
    file,
    titleEn,
    bodyEn,
    titleDe: de[entry.titleKey] ?? titleEn,
    bodyDe: de[entry.bodyKey] ?? bodyEn,
  };
}

/** Markers of every `parity` issue that already exists (open or closed). */
function existingMarkers(): Set<string> {
  const raw = gh([
    "issue",
    "list",
    "--label",
    "parity",
    "--state",
    "all",
    "--limit",
    "5000",
    "--json",
    "body",
  ]);
  const markers = new Set<string>();
  for (const { body } of JSON.parse(raw) as { body: string }[]) {
    for (const m of body.matchAll(/<!-- ios-parity:[^>]+ -->/g)) markers.add(m[0]);
  }
  return markers;
}

function ensureLabel(): void {
  gh([
    "label",
    "create",
    "parity",
    "--force",
    "--color",
    "FBCA04",
    "--description",
    "iOS ↔ PWA feature parity (auto-created by ios-parity.yml)",
  ]);
}

let bodyDir: string | null = null;

function createIssue(draft: IssueDraft, dryRun: boolean): number {
  if (dryRun) {
    console.log(`\n=== [dry-run] ${draft.title}\n${draft.body}\n`);
    return 0;
  }
  bodyDir ??= mkdtempSync(join(tmpdir(), "ios-parity-"));
  const file = join(bodyDir, "body.md");
  writeFileSync(file, draft.body);
  const args = ["issue", "create", "--title", draft.title, "--body-file", file];
  for (const label of LABELS) args.push("--label", label);
  const url = gh(args).trim();
  console.log(`created ${url} — ${draft.title}`);
  return Number(url.split("/").pop());
}

function repoSlug(): string {
  return (
    process.env.GITHUB_REPOSITORY ??
    gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim()
  );
}

/** The commit that added `file`, within `range`. */
function addingCommit(range: string, file: string): ChangeItem | null {
  const line = git(["log", "--diff-filter=A", "--format=%H%x09%s", "-1", range, "--", file]).trim();
  if (!line) return null;
  const [sha = "", ...rest] = line.split("\t");
  return { sha, subject: rest.join("\t") };
}

function runFeatures(base: string, head: string, dryRun: boolean): void {
  // A new-branch push reports an all-zero `before`; fall back to the parent.
  const from = /^0+$/.test(base) ? `${head}~1` : base;
  const range = `${from}..${head}`;
  // -M so a version rename (stranded-entry fix) is R, not a fresh A.
  const added = git(["diff", "-M", "--diff-filter=A", "--name-only", from, head, "--", ENTRIES_DIR])
    .split("\n")
    .filter((f) => f.endsWith(".ts"));
  if (added.length === 0) {
    console.log(`no catalog entries added in ${range}`);
    return;
  }
  const repo = repoSlug();
  const en = loadMessages("en", head);
  const de = loadMessages("de", head);
  if (!dryRun) ensureLabel();
  const seen = dryRun ? new Set<string>() : existingMarkers();
  for (const file of added) {
    const entry = resolveEntry(file, git(["show", `${head}:${file}`]), en, de);
    if (!entry) {
      console.warn(`skip ${file}: could not parse the entry`);
      continue;
    }
    const draft = featureIssue(entry, addingCommit(range, file), repo);
    if (seen.has(draft.marker)) {
      console.log(`skip ${entry.id}: issue exists`);
      continue;
    }
    createIssue(draft, dryRun);
    seen.add(draft.marker);
  }
}

function runDigest(now: Date, dryRun: boolean): void {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  // Label by the last day covered, so a Monday run names the week that just ended.
  const week = isoWeek(new Date(now.getTime() - 86_400_000));
  const featureShas = new Set(
    git(["log", "--diff-filter=A", `--since=${since}`, "--format=%H", "HEAD", "--", ENTRIES_DIR])
      .split("\n")
      .filter(Boolean),
  );
  const log = git([
    "log",
    `--since=${since}`,
    "--format=%x00%H%x09%s",
    "--name-only",
    "HEAD",
    "--",
    "ui/src",
  ]);
  const items: ChangeItem[] = [];
  for (const block of log.split("\0").filter((b) => b.trim())) {
    const [header = "", ...files] = block.split("\n");
    const [sha = "", ...rest] = header.split("\t");
    const subject = rest.join("\t");
    if (featureShas.has(sha) || isNonUserFacing(subject) || !files.some(isUiSourceChange)) continue;
    items.push({ sha, subject });
  }
  if (items.length === 0) {
    console.log(`no ui/src changes without a catalog entry since ${since}`);
    return;
  }
  const draft = digestIssue(week, items.reverse(), repoSlug());
  if (!dryRun) {
    ensureLabel();
    if (existingMarkers().has(draft.marker)) {
      console.log(`skip digest ${week}: issue exists`);
      return;
    }
  }
  createIssue(draft, dryRun);
}

function runBackfill(dryRun: boolean): void {
  const repo = repoSlug();
  const en = loadMessages("en");
  const de = loadMessages("de");
  const files = git(["ls-files", "--", ENTRIES_DIR])
    .split("\n")
    .filter((f) => f.endsWith(".ts"));
  const entries = files.flatMap((file) => {
    const e = resolveEntry(file, readFileSync(file, "utf8"), en, de);
    return e ? [e] : [];
  });
  const drafts = backfillIssues(entries, repo);
  console.log(`${entries.length} catalog features in ${drafts.length} backlog issues`);
  if (!dryRun) ensureLabel();
  const seen = dryRun ? new Set<string>() : existingMarkers();
  const children: { number: number; title: string }[] = [];
  for (const draft of drafts) {
    if (seen.has(draft.marker)) {
      console.log(`skip ${draft.title}: issue exists`);
      continue;
    }
    children.push({ number: createIssue(draft, dryRun), title: draft.title });
  }
  const epic = backfillEpic(children);
  if (children.length === 0 || seen.has(epic.marker)) return;
  const epicNumber = createIssue(epic, dryRun);
  if (dryRun) return;
  // Attach each child as a GitHub sub-issue so the epic shows real progress.
  for (const c of children) {
    const id = gh(["api", `repos/${repo}/issues/${c.number}`, "-q", ".id"]).trim();
    gh([
      "api",
      "-X",
      "POST",
      `repos/${repo}/issues/${epicNumber}/sub_issues`,
      "-F",
      `sub_issue_id=${id}`,
    ]);
  }
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(): void {
  const [mode, ...args] = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  if (mode === "features") {
    const base = argValue(args, "--base");
    const head = argValue(args, "--head");
    if (!base || !head) throw new Error("features needs --base <sha> --head <sha>");
    runFeatures(base, head, dryRun);
  } else if (mode === "digest") {
    const now = argValue(args, "--now");
    runDigest(now ? new Date(now) : new Date(), dryRun);
  } else if (mode === "backfill") {
    runBackfill(dryRun);
  } else {
    throw new Error("usage: ios-parity.ts <features|digest|backfill> [options] [--dry-run]");
  }
}

if (import.meta.main) main();
