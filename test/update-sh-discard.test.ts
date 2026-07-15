import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Executable harness: run the REAL deploy/update.sh with stub git/bun/systemctl on
// PATH (so nothing touches the host), and assert on the recorded git calls. Proves
// the flag parsing, the scoped `git restore` (never `git reset --hard`), the token
// requirement, the framed stale-guard, and the trap cleanup.

const REPO = join(import.meta.dir, "..");
const SCRIPT = join(REPO, "deploy", "update.sh");

// Fixed stub outputs for the signature commands; the matching sig is their framing.
// (No NUL here — a JS "\0" would be a real NUL, but a literal \0 inside the bash
// stub, so they'd never hash equal; NUL parsing is covered by the real-git tests.)
const STATUS = " M a.ts";
const CACHED = "CACHED-DIFF";
const WT = "WT-DIFF";
const sub = (s: string) => createHash("sha256").update(s).digest("hex");
const GOOD_SIG = createHash("sha256")
  .update(sub(STATUS) + sub(CACHED) + sub(WT))
  .digest("hex");

function makeStubs(): string {
  const bin = mkdtempSync(join(tmpdir(), "shepherd-stub-bin-"));
  const gitlog = join(bin, "git.log");
  const git = `#!/usr/bin/env bash
echo "git $*" >> "${gitlog}"
sub="$1"; [ "$sub" = "--literal-pathspecs" ] && sub="$2"
case "$sub" in
  rev-parse) echo "\${STUB_BRANCH:-main}" ;;
  status) printf '%s' "${STATUS}" ;;
  diff)
    for a in "$@"; do [ "$a" = "--quiet" ] && exit 0; done
    if printf '%s\\n' "$@" | grep -q -- '--cached'; then printf '%s' "${CACHED}"; else printf '%s' "${WT}"; fi ;;
esac
exit 0
`;
  writeFileSync(join(bin, "git"), git);
  chmodSync(join(bin, "git"), 0o755);
  // stub bun: no-op for install/build; stub systemctl: present but --user unavailable
  writeFileSync(join(bin, "bun"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(bin, "bun"), 0o755);
  writeFileSync(
    join(bin, "systemctl"),
    '#!/usr/bin/env bash\n[ "$1" = "--user" ] && [ "$2" = "show-environment" ] && exit 1\nexit 0\n',
  );
  chmodSync(join(bin, "systemctl"), 0o755);
  return bin;
}

function makeDiscardDir(wtContent: string): {
  dir: string;
  all: string;
  wt: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-discard-"));
  const all = join(dir, "all");
  const wt = join(dir, "wt");
  writeFileSync(all, "a.ts\0");
  writeFileSync(wt, wtContent);
  return { dir, all, wt };
}

type RunOpts = {
  args?: string[];
  branch?: string;
  sig?: string | null;
  dir?: string | null;
  all?: string | null;
  wt?: string | null;
};

function run(bin: string, opts: RunOpts = {}): { code: number; git: string } {
  const gitlog = join(bin, "git.log");
  writeFileSync(gitlog, "");
  const env: Record<string, string> = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    STUB_BRANCH: opts.branch ?? "main",
  };
  if (opts.sig != null) env.SHEPHERD_DISCARD_SIG = opts.sig;
  if (opts.dir != null) env.SHEPHERD_DISCARD_DIR = opts.dir;
  if (opts.all != null) env.SHEPHERD_DISCARD_PATHSPEC_ALL = opts.all;
  if (opts.wt != null) env.SHEPHERD_DISCARD_PATHSPEC_WT = opts.wt;
  let code = 0;
  try {
    execFileSync("bash", [SCRIPT, ...(opts.args ?? [])], { env, stdio: "ignore" });
  } catch (e) {
    code = (e as { status?: number }).status ?? 1;
  }
  return { code, git: readFileSync(gitlog, "utf8") };
}

function discardRun(bin: string, over: Partial<RunOpts> = {}) {
  const { dir, all, wt } = makeDiscardDir("from.ts\0");
  return {
    ...run(bin, { args: ["--pull", "--discard"], sig: GOOD_SIG, dir, all, wt, ...over }),
    dir,
  };
}

test("discard runs a scoped git restore and NEVER git reset --hard", () => {
  const bin = makeStubs();
  const { code, git } = discardRun(bin);
  expect(code).toBe(0);
  expect(git).not.toContain("reset --hard");
  expect(git).toContain("restore --source=HEAD --staged --pathspec-from-file=");
  expect(git).toContain("--pathspec-file-nul");
  expect(git).toContain("--literal-pathspecs");
  expect(git).toContain("pull --ff-only");
});

test("--discard --pull (reversed order) also discards", () => {
  const bin = makeStubs();
  const { dir, all, wt } = makeDiscardDir("from.ts\0");
  const { code, git } = run(bin, { args: ["--discard", "--pull"], sig: GOOD_SIG, dir, all, wt });
  expect(code).toBe(0);
  expect(git).toContain("restore --source=HEAD --staged");
});

test("--pull without --discard performs no restore", () => {
  const bin = makeStubs();
  const { code, git } = run(bin, { args: ["--pull"] });
  expect(code).toBe(0);
  expect(git).not.toContain("restore");
});

test("--discard without --pull performs no restore (discard lives in the pull block)", () => {
  const bin = makeStubs();
  const { dir, all, wt } = makeDiscardDir("from.ts\0");
  const { code, git } = run(bin, { args: ["--discard"], sig: GOOD_SIG, dir, all, wt });
  expect(code).toBe(0);
  expect(git).not.toContain("restore");
});

test("empty worktree pathspec → only the --staged restore runs", () => {
  const bin = makeStubs();
  const { code, git } = discardRun(bin, { wt: (() => makeDiscardDir("").wt)() });
  expect(code).toBe(0);
  expect(git).toContain("restore --source=HEAD --staged");
  expect(git).not.toContain("restore --source=HEAD --worktree");
});

test("discard on a non-main branch aborts with no restore", () => {
  const bin = makeStubs();
  const { code, git } = discardRun(bin, { branch: "feature" });
  expect(code).not.toBe(0);
  expect(git).not.toContain("restore");
});

test("missing any confirmation token aborts with no restore", () => {
  const bin = makeStubs();
  for (const drop of ["sig", "dir", "all", "wt"] as const) {
    const { code, git } = discardRun(bin, { [drop]: null } as Partial<RunOpts>);
    expect(code).not.toBe(0);
    expect(git).not.toContain("restore");
  }
});

test("stale/content-drifted signature aborts with no restore, and the trap cleans up", () => {
  const bin = makeStubs();
  const { code, git, dir } = discardRun(bin, { sig: "deadbeef" });
  expect(code).not.toBe(0);
  expect(git).not.toContain("restore");
  expect(existsSync(dir)).toBe(false); // trap rm -rf'd the private dir
});

test("matching signature discards AND the trap removes the private dir on success", () => {
  const bin = makeStubs();
  const { code, dir } = discardRun(bin);
  expect(code).toBe(0);
  expect(existsSync(dir)).toBe(false);
});

// belt-and-suspenders alignment with the macOS restart test's assumption
test("the deploy script never invokes an unguarded restart at column 0", () => {
  const src = readFileSync(SCRIPT, "utf8");
  expect(src.split("\n").filter((l) => /^systemctl --user restart/.test(l))).toEqual([]);
});
