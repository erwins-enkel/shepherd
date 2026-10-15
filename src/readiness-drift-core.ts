/**
 * Readiness "Framework majors" (#3113) — pure core. Reads the pinned-stack packages a repo
 * declares out of its manifests, compares each declared line with the registry's current stable
 * line and renders the upgrade story. I/O (files, registries, forge) lives in
 * `readiness-drift.ts`; this file only parses and decides.
 */
import { pinOf, type HouseStack } from "./house-stack";

export type DriftEcosystem = "npm" | "crates";

/** One package declaration found in one manifest. `line` = the lowest line (major, or `0.minor`
 *  for 0.x) the declared `spec` admits. */
export interface DeclaredDep {
  ecosystem: DriftEcosystem;
  name: string;
  line: string;
  spec: string;
  manifest: string;
}

/** An open Dependabot PR that bumps a tracked package across a line. */
export interface DependabotBump {
  number: number;
  url: string;
  from: string;
  to: string;
}

export type DriftState = "ok" | "behind" | "unknown";

export interface DriftRow {
  ecosystem: DriftEcosystem;
  name: string;
  /** Behind: the lowest line among declarations that don't admit `target`. Otherwise the lowest
   *  declared line. */
  installed: string;
  /** Registry's current stable version; null when the lookup failed. */
  latest: string | null;
  /** Line of `latest`; null when the lookup failed. */
  target: string | null;
  state: DriftState;
  /** Manifests below `target` when behind; otherwise every manifest declaring the package. */
  manifests: string[];
  dependabot: DependabotBump[];
}

/** Whole-registry outcome: none = nothing tracked is declared, so nothing was looked up. */
export type ResolverState = "ok" | "partial" | "offline" | "none";

export interface FrameworkDrift {
  rows: DriftRow[];
  resolver: ResolverState;
  /** Open `epic/*` branches that must be re-synced after an upgrade lands. */
  epicBranches: string[];
  /** Parent issue of the repo's running epic, if any. */
  runningEpic: number | null;
  /** The forge can file the upgrade story. */
  canCreateStory: boolean;
  /** An open upgrade story already filed for this repo. */
  openStory: { number: number; url: string } | null;
}

/** Marks Shepherd's upgrade-story issue body; one open story per repo. */
export const UPGRADE_STORY_MARKER = "<!-- shepherd:framework-upgrade -->";

const BOUND_RE = /^(?:\^|~|>=?|=)?v?(\d+)(?:\.(\d+|[xX*]))?/;

/** Parse a line (`"2"` / `"0.4"`) into a comparable tuple. */
function lineTuple(line: string): [number, number] {
  const [major, minor] = line.split(".").map(Number);
  return [major!, major === 0 ? (minor ?? 0) : 0];
}

/** Negative when `a` is an older line than `b`, 0 equal, positive newer. */
export function compareLine(a: string, b: string): number {
  const [am, an] = lineTuple(a);
  const [bm, bn] = lineTuple(b);
  return am - bm || an - bn;
}

/** One `||` alternative split into comparators (`>= 2` → `>=2`). */
function comparators(alt: string): string[] {
  return alt
    .replace(/([<>=^~]+)\s+/g, "$1")
    .split(/[\s,]+/)
    .filter(Boolean);
}

/** The line a version token sits on; null when it isn't one. */
function tokenLine(token: string): string | null {
  const m = BOUND_RE.exec(token);
  if (!m) return null;
  const major = Number(m[1]);
  if (major !== 0) return String(major);
  const minor = Number(m[2]);
  return `0.${Number.isInteger(minor) ? minor : 0}`;
}

/** The lowest line one `||` alternative admits; null when it has no lower bound we can read. */
function alternativeLine(alt: string): string | null {
  const lower = comparators(alt).find((c) => !c.startsWith("<") && c !== "-");
  return lower ? tokenLine(lower) : null;
}

/** Whether an exclusive upper bound `<X` still admits the line `X` sits on (`<3.1` does, `<3`
 *  and `<3.0.0` don't). */
function exclusiveAdmitsOwnLine(bound: string): boolean {
  const parts = bound.replace(/^<v?/, "").split(".").slice(1).map(Number);
  return tokenLine(bound.slice(1))?.startsWith("0.")
    ? (parts[1] ?? 0) > 0
    : parts.some((n) => n > 0);
}

/** Whether `target` lies at or below an alternative's upper bound(s). */
function belowUpper(uppers: string[], target: string): boolean {
  return uppers.every((u) => {
    const inclusive = u.startsWith("<=");
    const line = tokenLine(u.slice(inclusive ? 2 : 1));
    if (!line) return false;
    const cmp = compareLine(target, line);
    return cmp < 0 || (cmp === 0 && (inclusive || exclusiveAdmitsOwnLine(u)));
  });
}

/** Whether one `||` alternative admits some version on the `target` line. */
function alternativeAdmits(alt: string, target: string): boolean {
  const cs = comparators(alt);
  if (cs.length === 3 && cs[1] === "-")
    return belowUpper([`<=${cs[2]}`], target) && admitsFrom(cs[0]!, target);
  const lower = cs.find((c) => !c.startsWith("<"));
  if (!lower || !admitsFrom(lower, target)) return false;
  const uppers = cs.filter((c) => c.startsWith("<"));
  // `>=`/`>` without an upper bound is open-ended: every later line is admitted.
  if (lower.startsWith(">")) return belowUpper(uppers, target);
  return compareLine(tokenLine(lower)!, target) === 0 || wildcardZero(lower, target);
}

/** `target` is at or above the lower bound's line. */
function admitsFrom(lower: string, target: string): boolean {
  const line = tokenLine(lower);
  return line !== null && compareLine(target, line) >= 0;
}

/** `0`, `0.x`, `0.*` admit every 0.x line. */
function wildcardZero(lower: string, target: string): boolean {
  return /^[=^~]?v?0(\.[xX*])?$/.test(lower) && target.startsWith("0.");
}

/** Whether a semver range (npm or Cargo) admits a version on the `target` line — some `||`
 *  alternative reaches it. `^8 || ^9` and `>=5` admit 9; `^8` and `>=5 <9` don't. */
export function admitsLine(range: string, target: string): boolean {
  return range.split("||").some((alt) => alternativeAdmits(alt.trim(), target));
}

/** The lowest line a semver range (npm or Cargo) admits. Non-version specs (`workspace:`,
 *  `file:`, git URLs, `*`, `latest`, …) → null, so they never produce a warning. */
export function lowestLine(range: string): string | null {
  const alts = range.trim().split("||");
  let lowest: string | null = null;
  for (const alt of alts) {
    const line = alternativeLine(alt.trim());
    if (!line) return null;
    if (lowest === null || compareLine(line, lowest) < 0) lowest = line;
  }
  return lowest;
}

const NPM_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/** Declarations in one package.json (`packageManager: bun@x` counts as `bun`). */
export function parsePackageJson(text: string, manifest: string): DeclaredDep[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== "object") return [];
  const d = doc as Record<string, unknown>;
  const out: DeclaredDep[] = [];
  const add = (name: string, spec: unknown) => {
    const line = typeof spec === "string" ? lowestLine(spec) : null;
    if (line) out.push({ ecosystem: "npm", name, line, spec: spec as string, manifest });
  };
  for (const section of NPM_SECTIONS) {
    const deps = d[section];
    if (deps && typeof deps === "object") {
      for (const [name, spec] of Object.entries(deps)) add(name, spec);
    }
  }
  if (typeof d.packageManager === "string") {
    const [pm, version] = d.packageManager.split("@");
    if (pm && version) add(pm, version.split("+")[0]);
  }
  return out;
}

const CARGO_SECTIONS = ["dependencies", "dev-dependencies", "build-dependencies"];

function cargoDep(key: string, spec: unknown): { name: string; version: unknown } {
  if (spec && typeof spec === "object") {
    const s = spec as { version?: unknown; package?: unknown };
    return { name: typeof s.package === "string" ? s.package : key, version: s.version };
  }
  return { name: key, version: spec };
}

/** Declarations in one Cargo.toml (incl. `[workspace.dependencies]`). */
export function parseCargoToml(text: string, manifest: string): DeclaredDep[] {
  let doc: Record<string, unknown>;
  try {
    doc = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch {
    return [];
  }
  const tables = CARGO_SECTIONS.map((s) => doc[s]);
  const ws = doc.workspace as Record<string, unknown> | undefined;
  tables.push(ws?.dependencies);
  const out: DeclaredDep[] = [];
  for (const table of tables) {
    if (!table || typeof table !== "object") continue;
    for (const [key, spec] of Object.entries(table)) {
      const { name, version } = cargoDep(key, spec);
      const line = typeof version === "string" ? lowestLine(version) : null;
      if (line) out.push({ ecosystem: "crates", name, line, spec: version as string, manifest });
    }
  }
  return out;
}

const NPM_PIN_RE = /Use `((?:@[^/`\s]+\/)?[^@`\s]+)@[^`\s]+`/g;
const CRATE_PIN_RE = /Use crate `([A-Za-z][\w-]*) = "/g;

/** Package names pinned in a CLAUDE.md in the format `renderHouseStackRules` writes. */
export function claudeMdPins(text: string): { npm: string[]; crates: string[] } {
  return {
    npm: [...text.matchAll(NPM_PIN_RE)].map((m) => m[1]!),
    crates: [...text.matchAll(CRATE_PIN_RE)].map((m) => m[1]!),
  };
}

export const driftKey = (ecosystem: DriftEcosystem, name: string) => `${ecosystem}:${name}`;

/** Keys of the tracked packages: the House Stack plus the repo's CLAUDE.md pins. */
export function trackedKeys(
  stack: HouseStack,
  pins: { npm: string[]; crates: string[] },
): Set<string> {
  return new Set([
    ...[...stack.npm, ...pins.npm].map((n) => driftKey("npm", n)),
    ...[...stack.crates, ...pins.crates].map((n) => driftKey("crates", n)),
  ]);
}

export interface DeclaredPackage {
  ecosystem: DriftEcosystem;
  name: string;
  declarations: { manifest: string; line: string; spec: string }[];
}

/** Tracked packages the repo declares, grouped per package, sorted by name. */
export function trackedDeclared(declared: DeclaredDep[], tracked: Set<string>): DeclaredPackage[] {
  const groups = new Map<string, DeclaredPackage>();
  for (const d of declared) {
    const key = driftKey(d.ecosystem, d.name);
    if (!tracked.has(key)) continue;
    const g = groups.get(key) ?? { ecosystem: d.ecosystem, name: d.name, declarations: [] };
    g.declarations.push({ manifest: d.manifest, line: d.line, spec: d.spec });
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const BUMP_RE = /\bbump (\S+) from v?(\S+) to v?(\S+)/i;

/** Open Dependabot PRs that bump a package across a line, keyed by package name. Grouped bumps
 *  ("Bump the x group …") name no package in the title and are not detected. */
export function dependabotBumps(
  prs: { number: number; url: string; title: string; kind: string }[],
): Map<string, DependabotBump[]> {
  const out = new Map<string, DependabotBump[]>();
  for (const pr of prs) {
    if (pr.kind !== "dependabot") continue;
    const m = BUMP_RE.exec(pr.title);
    if (!m) continue;
    const [, name, from, to] = m;
    const fromLine = lowestLine(from!);
    const toLine = lowestLine(to!);
    if (!fromLine || !toLine || compareLine(toLine, fromLine) <= 0) continue;
    const list = out.get(name!) ?? [];
    list.push({ number: pr.number, url: pr.url, from: from!, to: to! });
    out.set(name!, list);
  }
  return out;
}

function lowestOf(lines: string[]): string {
  return lines.reduce((a, b) => (compareLine(b, a) < 0 ? b : a));
}

/** One row per declared tracked package. `latest` maps a {@link driftKey} to the registry
 *  version, or null when the lookup failed (→ `unknown`, never `behind`). A declaration is behind
 *  only when its range admits no version on the target line — a range like `^8 || ^9` or `>=5`
 *  already covers the current major, and narrowing it would drop support for the older one. */
export function driftRows(
  packages: DeclaredPackage[],
  latest: Map<string, string | null>,
  bumps: Map<string, DependabotBump[]>,
): DriftRow[] {
  return packages.map((p) => {
    const version = latest.get(driftKey(p.ecosystem, p.name)) ?? null;
    const target = version ? pinOf(version) : null;
    const lagging = target ? p.declarations.filter((d) => !admitsLine(d.spec, target)) : [];
    const shown = lagging.length ? lagging : p.declarations;
    return {
      ecosystem: p.ecosystem,
      name: p.name,
      installed: lowestOf(shown.map((d) => d.line)),
      latest: version,
      target,
      state: target === null ? "unknown" : lagging.length ? "behind" : "ok",
      manifests: [...new Set(shown.map((d) => d.manifest))],
      dependabot: bumps.get(p.name) ?? [],
    };
  });
}

/** Registry outcome over the looked-up packages. */
export function resolverState(rows: DriftRow[]): ResolverState {
  if (rows.length === 0) return "none";
  const unknown = rows.filter((r) => r.state === "unknown").length;
  if (unknown === 0) return "ok";
  return unknown === rows.length ? "offline" : "partial";
}

const TITLE_MAX_PACKAGES = 3;

/** The upgrade story. Agent-facing forge content → fixed English. */
export function renderUpgradeStory(
  behind: DriftRow[],
  epicBranches: string[],
): { title: string; body: string } {
  const shown = behind
    .slice(0, TITLE_MAX_PACKAGES)
    .map((r) => `${r.name} ${r.installed} → ${r.target}`);
  const more = behind.length > TITLE_MAX_PACKAGES ? ", …" : "";
  const title = `Upgrade framework majors: ${shown.join(", ")}${more}`;
  const pkgLines = behind.map((r) => {
    const prs = r.dependabot.map((b) => ` (Dependabot #${b.number})`).join("");
    const where = r.manifests.map((m) => `\`${m}\``).join(", ");
    return `- \`${r.name}\` (${r.ecosystem}): ${r.installed} → ${r.target} (latest ${r.latest}) in ${where}${prs}`;
  });
  const epics = epicBranches.length
    ? [
        "",
        "## Open epic branches to re-sync after this lands",
        "",
        ...epicBranches.map((b) => `- \`${b}\``),
      ]
    : [];
  const body = [
    "Shepherd's readiness check found pinned-stack packages a major behind the registry's current stable release.",
    "",
    "## Packages",
    "",
    ...pkgLines,
    "",
    "## Do",
    "",
    "- Upgrade each package to the target line, following the upstream migration guide.",
    "- If CLAUDE.md has a `## Pinned stack` pin for a package, update it to the new line.",
    "- Close or supersede the linked Dependabot PRs once the upgrade lands.",
    ...epics,
    "",
    UPGRADE_STORY_MARKER,
  ].join("\n");
  return { title, body };
}
