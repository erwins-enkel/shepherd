import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CANONICAL_REL,
  comparePins,
  extractCanonicalVersion,
  extractPinRefs,
  gitEnv,
  scanTree,
} from "../scripts/check-fallow-pin.mjs";

// Resolved from this file, never process.cwd(), so the live-tree cases below behave
// identically under `bun test ./test` and a single-file invocation.
const ROOT = join(import.meta.dir, "..");

/**
 * Every fixture pin is BUILT, never written literally.
 *
 * This file is scanned by the very gate it tests, so a literal `fallow` + `@` + digits
 * here would fail the gate ON ITS OWN TEST FILE. Interpolation leaves `fallow@${…}` in
 * the source — no digit after the `@`, so the pattern cannot match — which keeps the
 * repo-wide scan free of exclusion lists. An exclusion would be a cheap escape hatch in
 * the one file most likely to need real coverage. `decl` interpolates for the same
 * reason: the declaration pattern needs a digit straight after the opening quote.
 */
const pin = (v: string) => `fallow@${v}`;
const decl = (v: string) => `export const FALLOW_VERSION = "${v}";\n`;

// ── extractPinRefs ───────────────────────────────────────────────────────────

describe("extractPinRefs", () => {
  test("finds a pinned invocation with its line", () => {
    const source = `first line\nrun: bunx ${pin("2.100.0")} audit --base origin/main\n`;
    expect(extractPinRefs(source)).toEqual([{ kind: "invocation", version: "2.100.0", line: 2 }]);
  });

  test("finds the FALLOW_VERSION declaration", () => {
    expect(extractPinRefs(`// a comment\n${decl("2.100.0")}`)).toEqual([
      { kind: "declaration", version: "2.100.0", line: 2 },
    ]);
  });

  test("captures a prerelease tail instead of truncating to the release", () => {
    // A bare \d+\.\d+\.\d+ would capture "2.100.0" here and compare EQUAL to a plain
    // 2.100.0 at another site — drift the gate would wave through.
    expect(extractPinRefs(`bunx ${pin("2.100.0-beta.1")} audit`).map((r) => r.version)).toEqual([
      "2.100.0-beta.1",
    ]);
  });

  test("ignores prose naming a DIFFERENT release beside a real pin", () => {
    // Shapes lifted from ci.yml / CONTRIBUTING.md. These are correct as written, and
    // they are why #2182 normalized the prose PIN sites to carry `@` rather than
    // widening the pattern to "fallow near a semver" — which would flag all three.
    const source =
      "# The synthetic Svelte <template> complexity metric (fallow 2.98+) is adopted\n" +
      "# via health.thresholdOverrides. The line-shift mis-attribution that forced the\n" +
      "# old 2.97 pin was re-tested against 2.100 and does NOT reproduce.\n";
    expect(extractPinRefs(source)).toEqual([]);
  });

  test("ignores the deliberately version-free placeholders", () => {
    // scripts/pre-push.ts and src/maintain.ts write `fallow@…`; the docs-site
    // configuration reference writes `fallow@<pinned>`. Both must stay unmatched.
    const source = "a cold `bunx fallow@…` download\nruns `bunx fallow@<pinned> fix --yes`\n";
    expect(extractPinRefs(source)).toEqual([]);
  });

  test("finds every site in a file, ordered by line", () => {
    const source = `${decl("2.100.0")}// then: bunx ${pin("2.100.0")} dupes\n`;
    expect(extractPinRefs(source).map((r) => [r.line, r.kind])).toEqual([
      [1, "declaration"],
      [2, "invocation"],
    ]);
  });
});

// ── extractCanonicalVersion ──────────────────────────────────────────────────

describe("extractCanonicalVersion", () => {
  test("reads the declaration", () => {
    expect(extractCanonicalVersion(decl("2.100.0"))).toBe("2.100.0");
  });

  test("is null when the constant is only IMPORTED or named in prose", () => {
    // src/maintain.ts imports FALLOW_VERSION, and maintain-core.ts's own doc comment
    // argues about keeping it in sync — a loose `<NAME>[^=]*=` anchor lands on prose.
    const source =
      `import { FALLOW_VERSION } from "./maintain-core";\n` +
      `// KEEP IN SYNC with the other pin sites — FALLOW_VERSION is the canonical.\n`;
    expect(extractCanonicalVersion(source)).toBeNull();
  });

  test("is null when the value is not a version literal", () => {
    // A reshape (env lookup, imported constant) must fail closed, not read as "0 sites".
    expect(
      extractCanonicalVersion(`const FALLOW_VERSION = process.env.FALLOW ?? "";\n`),
    ).toBeNull();
  });
});

// ── comparePins ──────────────────────────────────────────────────────────────

describe("comparePins", () => {
  const ref = (
    file: string,
    version: string,
    kind: "invocation" | "declaration" = "invocation",
    line = 1,
  ) => ({ file, kind, version, line });

  test("ok when every site names the canonical", () => {
    const result = comparePins("2.100.0", [
      ref(".github/workflows/ci.yml", "2.100.0"),
      ref("src/maintain-core.ts", "2.100.0", "declaration"),
    ]);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect([result.invocations, result.declarations, result.files]).toEqual([1, 1, 2]);
  });

  test("names the odd site out", () => {
    const odd = ref("CONTRIBUTING.md", "2.99.0", "invocation", 147);
    const result = comparePins("2.100.0", [ref(".github/workflows/ci.yml", "2.100.0"), odd]);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("drift");
    expect(result.mismatches).toEqual([odd]);
  });

  test("reports a drifted SECOND declaration like any other site", () => {
    // The canonical comes from src/maintain-core.ts, so its own declaration can never
    // mismatch — but a hand-copied mirror elsewhere can, which is why the declaration
    // pattern is scanned repo-wide rather than only in the canonical file.
    const mirror = ref("ui/src/lib/maintain.ts", "2.99.0", "declaration", 12);
    const result = comparePins("2.100.0", [
      ref("src/maintain-core.ts", "2.100.0", "declaration"),
      ref(".github/workflows/ci.yml", "2.100.0"),
      mirror,
    ]);
    expect(result.mismatches).toEqual([mirror]);
  });

  test("fails closed when the canonical cannot be parsed", () => {
    const result = comparePins(null, [ref(".github/workflows/ci.yml", "2.100.0")]);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-canonical");
  });

  test("fails closed on ZERO invocations — a rotted pattern, not a clean tree", () => {
    // Two empty sides comparing as "equal" is the vacuous pass a gate must never
    // produce: it reads as green precisely when it has stopped checking anything.
    const result = comparePins("2.100.0", [ref("src/maintain-core.ts", "2.100.0", "declaration")]);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-invocations");
  });
});

// ── the CLI, against throwaway checkouts ─────────────────────────────────────

function withFixture(prefix: string, fn: (dir: string) => void): void {
  // realpathSync keeps the temp root free of symlink components, so each case isolates
  // the one thing it names (macOS `os.tmpdir()` is `/var/folders/…` → `/private/var/…`,
  // which would otherwise make the spaced-path case fail for the *symlink* reason).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Build a throwaway git checkout at `dir` holding a copy of the gate; returns its path. */
function fakeCheckout(dir: string, files: Record<string, string>): string {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const script = join(dir, "scripts", "check-fallow-pin.mjs");
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(join(ROOT, "scripts", "check-fallow-pin.mjs"), script);

  // The gate enumerates through `git ls-files`, so the fixture must be a real repo with
  // a populated index. EVERY git call here runs with git's repo-local variables scrubbed
  // (`gitEnv`): the root suite honours an ambient GIT_DIR, so an inherited one would
  // point `git init`/`git add` at the REAL repository regardless of `cwd` — the exact
  // trap `.husky/pre-push` unsets those variables to avoid.
  const env = gitEnv();
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
  ]) {
    const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    // A non-zero status here would leave the fixture repo-less, and `git ls-files` would
    // walk UP to whatever repo contains tmpdir — so assert rather than assume.
    expect(r.status).toBe(0);
  }
  return script;
}

function runGate(script: string) {
  return spawnSync("node", [script], { encoding: "utf8", env: gitEnv() });
}

/** A checkout whose one pinned invocation disagrees with FALLOW_VERSION. */
function driftedCheckout(dir: string): string {
  return fakeCheckout(dir, {
    "src/maintain-core.ts": decl("2.100.0"),
    "docs/notes.md": `first line\nrun \`bunx ${pin("2.99.0")} audit\`\n`,
  });
}

test("CLI exits 0 when every site agrees", () => {
  withFixture("shepherd-fallow-pin-ok-", (dir) => {
    const script = fakeCheckout(dir, {
      "src/maintain-core.ts": decl("2.100.0"),
      "docs/notes.md": `run \`bunx ${pin("2.100.0")} audit\`\n`,
      ".fallowrc.jsonc": `// bunx ${pin("2.100.0")} dupes --save-baseline\n{}\n`,
    });
    const r = runGate(script);
    expect(`${r.stdout}${r.stderr}`).toContain("2.100.0");
    expect(r.status).toBe(0);
  });
});

test("CLI exits 1 and names the drifted file:line and both versions", () => {
  withFixture("shepherd-fallow-pin-drift-", (dir) => {
    const r = runGate(driftedCheckout(dir));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("docs/notes.md:2");
    expect(r.stderr).toContain("2.99.0");
    expect(r.stderr).toContain("2.100.0");
  });
});

test("CLI exits 1 when FALLOW_VERSION cannot be parsed", () => {
  withFixture("shepherd-fallow-pin-nocanon-", (dir) => {
    const script = fakeCheckout(dir, {
      "src/maintain-core.ts": "export const MAX_ACTIONS_PER_SWEEP = 1;\n",
      "docs/notes.md": `run \`bunx ${pin("2.100.0")} audit\`\n`,
    });
    const r = runGate(script);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FALLOW_VERSION");
  });
});

test("CLI exits 1 when ZERO pinned invocations are found", () => {
  withFixture("shepherd-fallow-pin-empty-", (dir) => {
    const script = fakeCheckout(dir, { "src/maintain-core.ts": decl("2.100.0") });
    const r = runGate(script);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ZERO");
  });
});

// Both cases below exercise the `isMainModule` guard, whose failure modes are
// indistinguishable from success by exit code alone: if the guard is wrong the CLI block
// never runs and the process exits 0 having compared NOTHING. So each plants a DRIFTED
// checkout and asserts exit 1 — only a CLI that genuinely ran can produce that.

test("the CLI runs (and fails) from a checkout path containing a space", () => {
  // Guards the percent-encoding trap: import.meta.url encodes the space as %20, so a
  // `file://` + argv[1] concat comparison is false and the CLI is skipped.
  withFixture("shepherd fallow pin ", (dir) => {
    expect(dir).toContain(" "); // the whole point of the case
    const r = runGate(driftedCheckout(dir));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("2.99.0");
  });
});

test("the CLI runs (and fails) when reached through a SYMLINKED path component", () => {
  // Guards the realpath trap: Node realpath-resolves the entry module behind
  // import.meta.url but leaves argv[1] merely path.resolve'd, so without
  // realpathSync(argv[1]) the comparison is false and the CLI is skipped.
  withFixture("shepherd-fallow-pin-symlink-", (root) => {
    const real = join(root, "real");
    mkdirSync(real, { recursive: true });
    const script = driftedCheckout(real);
    const link = join(root, "link");
    symlinkSync(real, link);
    const viaLink = join(link, "scripts", "check-fallow-pin.mjs");
    // Same file, reached via the symlink — argv[1] keeps "link", import.meta.url "real".
    expect(realpathSync(viaLink)).toBe(script);
    const r = runGate(viaLink);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("2.99.0");
  });
});

// ── the live tree ────────────────────────────────────────────────────────────

describe("the live tree", () => {
  test("every pin site agrees with FALLOW_VERSION", () => {
    const canonical = extractCanonicalVersion(readFileSync(join(ROOT, CANONICAL_REL), "utf8"));
    const result = comparePins(canonical, scanTree(ROOT));
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("still covers every file #2182 normalized", () => {
    // Guards the OTHER half of #2182. Five of the twelve sites named the version in
    // prose, which no safe pattern can match; they were reworded to carry the
    // `fallow@<semver>` token. Reverting any of them shrinks the gate's coverage
    // silently — the gate itself would still pass, having stopped watching that site.
    // Counts are a FLOOR, so adding a pin site is free; removing one is deliberate.
    const perFile = new Map<string, number>();
    for (const r of scanTree(ROOT)) perFile.set(r.file!, (perFile.get(r.file!) ?? 0) + 1);

    const expected: Record<string, number> = {
      ".fallowrc.jsonc": 1,
      ".github/workflows/ci.yml": 2,
      "CONTRIBUTING.md": 4,
      "scripts/pre-push.ts": 3,
      "src/maintain-core.ts": 1,
      "test/maintain.test.ts": 1,
    };
    const shortfalls = Object.entries(expected)
      .filter(([file, atLeast]) => (perFile.get(file) ?? 0) < atLeast)
      .map(
        ([file, atLeast]) =>
          `${file}: ${perFile.get(file) ?? 0} gated site(s), expected ≥ ${atLeast}`,
      );
    expect(shortfalls).toEqual([]);
  });
});
