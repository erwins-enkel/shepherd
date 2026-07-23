import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexUpdateService,
  buildUpdateScript,
  CODEX_UPDATE_LOG_PREFIX,
  CONVERGED_MARKER,
  type CodexUpdateChannel,
  type CodexUpdateResult,
} from "../src/codex-update";

const LOG = "/home/op/.shepherd/codex-update.log";
const CB = "codex";

function jsonResponse(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function release(version: string, body: string | null) {
  return {
    tag_name: `rust-v${version}`,
    draft: false,
    prerelease: false,
    body,
  };
}

// ── buildUpdateScript: two channels, tried in the memo's order ─────────────────
test("buildUpdateScript: can run either channel", () => {
  const s = buildUpdateScript(LOG, "0.142.2", "0.142.4", CB);
  expect(s).toContain('"$CX" update'); // codex's own install-kind-aware updater
  expect(s).toContain("npm install -g @openai/codex"); // the npm-global copy
  expect(s).toContain(`CX='${CB}'`);
});

test("buildUpdateScript: probes the subcommand and runs non-interactively", () => {
  const s = buildUpdateScript(LOG, "0.142.2", "0.142.4", CB);
  // `--help` probe guards against a too-old codex treating `update` as an agent prompt
  expect(s).toContain('"$CX" --help');
  expect(s).toContain("export CODEX_NON_INTERACTIVE=1");
});

test("buildUpdateScript: a channel wins by ADVANCEMENT, never by exit code", () => {
  const s = buildUpdateScript(LOG, "0.142.2", "0.142.4", CB);
  // an installer that exits 0 while updating some OTHER copy is not a winner
  expect(s).toContain('if [ "$after" != "$before" ]; then winner="$ch"; break; fi');
});

test("buildUpdateScript: leads with the memo, else the historical order", () => {
  expect(buildUpdateScript(LOG, "0.142.2", "0.142.4", CB, "npm")).toContain(
    `elif [ "$PREF" = 'npm' ]; then order='npm codex'; src='memo'`,
  );
  expect(buildUpdateScript(LOG, "0.142.2", "0.142.4", CB, "npm")).toContain("PREF='npm'");
  expect(buildUpdateScript(LOG, "0.142.2", "0.142.4", CB, "codex")).toContain("PREF='codex'");
  // no memo → codex update first, exactly as before the memo existed
  const cold = buildUpdateScript(LOG, "0.142.2", "0.142.4", CB, null);
  expect(cold).toContain("PREF=''");
  expect(cold).toContain(`else order='codex npm'; src='default'; fi`);
});

test("buildUpdateScript: emits portable duplicate diagnostics via `type -a codex`", () => {
  const s = buildUpdateScript(LOG, "0.142.2", "0.142.4", CB);
  expect(s).toContain("type -a codex"); // bare name reveals PATH dups even if CODEX_BIN is absolute
  expect(s).not.toContain("which -a"); // non-POSIX, deliberately avoided
});

test("buildUpdateScript: never restarts a server, herdr, shepherd, or shells systemd", () => {
  const s = buildUpdateScript(LOG, "0.142.2", "0.142.4", CB);
  // codex updates are non-destructive: no handoff, no server restart, no systemd.
  expect(s).not.toContain("--handoff");
  expect(s).not.toContain("herdr");
  expect(s).not.toContain("systemctl");
  expect(s).not.toContain("systemd-run");
});

test("buildUpdateScript: echoes greppable markers for each channel + the verdict", () => {
  const s = buildUpdateScript(LOG, "0.142.2", "0.142.4", CB);
  expect(s).toContain(`${CODEX_UPDATE_LOG_PREFIX} channel=$ch (source=$s)`);
  expect(s).toContain(`${CODEX_UPDATE_LOG_PREFIX} codex update exited rc=$rc`);
  expect(s).toContain(`${CODEX_UPDATE_LOG_PREFIX} npm install exited rc=$rc`);
  expect(s).toContain(`${CONVERGED_MARKER}$winner`);
  expect(s).toContain(`${CODEX_UPDATE_LOG_PREFIX} did not converge`);
});

test("buildUpdateScript: appends a delimited, timestamped, versioned block", () => {
  const s = buildUpdateScript(LOG, "0.142.2", "0.142.4", CB);
  expect(s).toContain(`LOG='${LOG}'`);
  expect(s).toContain('| tee -a "$LOG"');
  expect(s).toContain("=== codex-update $(date -u +%Y-%m-%dT%H:%M:%SZ) 0.142.2 -> 0.142.4 ===");
  expect(s).toContain('mkdir -p "$(dirname "$LOG")"');
});

test("buildUpdateScript: sanitizes versions so a payload can't inject shell", () => {
  const s = buildUpdateScript(LOG, "0.142.2", '0.142.4"; rm -rf ~ #', CB);
  expect(s).not.toContain("rm -rf");
  expect(s).toContain("0.142.2 -> 0.142.4 ===");
});

test("buildUpdateScript: missing versions degrade to 'unknown'", () => {
  const s = buildUpdateScript(LOG, null, undefined, CB);
  expect(s).toContain("unknown -> unknown ===");
});

// ── buildUpdateScript, ACTUALLY EXECUTED against fake installers ───────────────
//
// String assertions can't tell us which installer a host would really invoke. So
// run the generated script for real, with `codex` and `npm` replaced by fakes on a
// controlled PATH. Each fake TOUCHES A SENTINEL when invoked, so a test asserts
// "npm ran" as a fact rather than inferring it from stdout.
//
// `bash -c`, never `bash -lc`: a login shell sources the profile, which can put
// the REAL npm ahead of our fakes on PATH and reach a real `npm install -g`.

const BEFORE = "0.142.2";
const AFTER = "0.142.4";

interface HarnessOpts {
  preferred?: CodexUpdateChannel | null;
  /** does `codex --help` advertise the `update` subcommand? */
  hasUpdate?: boolean;
  /** does `codex update` actually move the on-PATH version? */
  codexAdvances?: boolean;
  /** does `npm install -g` actually move the on-PATH version? */
  npmAdvances?: boolean;
}

function runScript(opts: HarnessOpts) {
  const dir = mkdtempSync(join(tmpdir(), "codex-update-"));
  const version = join(dir, "version"); // the "installed" version, mutated by a winning fake
  const codexRan = join(dir, "codex-update.ran");
  const npmRan = join(dir, "npm-install.ran");
  writeFileSync(version, BEFORE);

  // the `update` line must match the script's `^[[:space:]]+update[[:space:]]` probe
  const helpBody = opts.hasUpdate === false ? "  login    Log in" : "  update   Update codex";
  const bump = (advances: boolean | undefined) => (advances ? `echo ${AFTER} > '${version}'` : ":");

  writeFileSync(
    join(dir, "codex"),
    `#!/bin/bash
case "$1" in
  --version) echo "codex-cli $(cat '${version}')" ;;
  --help)    echo "Usage: codex [COMMAND]"; echo "${helpBody}" ;;
  update)    touch '${codexRan}'; ${bump(opts.codexAdvances)}; echo "codex update ran" ;;
esac
exit 0
`,
  );
  writeFileSync(
    join(dir, "npm"),
    `#!/bin/bash
touch '${npmRan}'; ${bump(opts.npmAdvances)}; echo "npm $*"
exit 0
`,
  );
  chmodSync(join(dir, "codex"), 0o755);
  chmodSync(join(dir, "npm"), 0o755);

  const script = buildUpdateScript(
    join(dir, "log"),
    BEFORE,
    AFTER,
    "codex",
    opts.preferred ?? null,
  );
  const stdout = execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir }, // fakes shadow the real installers
  });
  return {
    stdout,
    codexUpdateRan: existsSync(codexRan),
    npmInstallRan: existsSync(npmRan),
    installed: readFileSync(version, "utf8").trim(),
    converged: /converged via channel=(\w+)/.exec(stdout)?.[1] ?? null,
  };
}

/**
 * The PATH-shadowing shape: `codex update` installs a NEW codex into an EARLIER
 * PATH directory (what a standalone installer repointing ~/.local/bin does) while
 * the old one stays put. bash hashes `codex`→old-path when it execs the updater,
 * so a naive re-read goes back to the OLD binary and reads the OLD version — the
 * update looks like a no-op. Without `hash -r` this test fails on both counts:
 * npm gets run as a pointless fallback, and `codex` is memoized as a loser.
 */
function runScriptShadowing() {
  const root = mkdtempSync(join(tmpdir(), "codex-shadow-"));
  const early = join(root, "early"); // wins PATH once populated
  const late = join(root, "late"); // holds the current (old) codex
  mkdirSync(early);
  mkdirSync(late);
  const npmRan = join(root, "npm-install.ran");
  const codexRan = join(root, "codex-update.ran");

  writeFileSync(
    join(late, "codex"),
    `#!/bin/bash
case "$1" in
  --version) echo "codex-cli ${BEFORE}" ;;                       # this copy never moves
  --help)    echo "Usage: codex [COMMAND]"; echo "  update   Update codex" ;;
  update)    touch '${codexRan}'
             printf '#!/bin/bash\\necho "codex-cli ${AFTER}"\\n' > '${early}/codex'
             chmod 755 '${early}/codex' ;;                       # …the NEW one lands earlier on PATH
esac
exit 0
`,
  );
  writeFileSync(join(late, "npm"), `#!/bin/bash\ntouch '${npmRan}'\nexit 0\n`);
  chmodSync(join(late, "codex"), 0o755);
  chmodSync(join(late, "npm"), 0o755);

  const script = buildUpdateScript(join(root, "log"), BEFORE, AFTER, "codex", "codex");
  const stdout = execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: `${early}:${late}:/usr/bin:/bin`, HOME: root },
  });
  return {
    stdout,
    codexUpdateRan: existsSync(codexRan),
    npmInstallRan: existsSync(npmRan),
    converged: /converged via channel=(\w+)/.exec(stdout)?.[1] ?? null,
  };
}

test("harness: memo=npm → npm ONLY; `codex update` is never invoked", () => {
  const r = runScript({ preferred: "npm", npmAdvances: true, codexAdvances: true });
  expect(r.npmInstallRan).toBe(true);
  expect(r.codexUpdateRan).toBe(false); // the whole point: one installer, not two
  expect(r.converged).toBe("npm");
  expect(r.installed).toBe(AFTER);
  expect(r.stdout).toContain("channel=npm (source=memo)");
});

test("harness: memo=codex → `codex update` ONLY; npm is never invoked", () => {
  const r = runScript({ preferred: "codex", codexAdvances: true, npmAdvances: true });
  expect(r.codexUpdateRan).toBe(true);
  expect(r.npmInstallRan).toBe(false);
  expect(r.converged).toBe("codex");
  expect(r.stdout).toContain("channel=codex (source=memo)");
});

test("harness: cold + `codex update` advances (standalone / #1560) → codex ONLY", () => {
  // The shape issue #1560 fixed: a standalone install that `npm install -g` would
  // NOT update. `codex update` wins on the first attempt, npm must never run, and
  // the winner is attributed so the memo learns `codex`.
  const r = runScript({ preferred: null, codexAdvances: true, npmAdvances: false });
  expect(r.codexUpdateRan).toBe(true);
  expect(r.npmInstallRan).toBe(false);
  expect(r.converged).toBe("codex");
  expect(r.installed).toBe(AFTER);
  expect(r.stdout).toContain("channel=codex (source=default)");
});

test("harness: cold + `codex update` no-ops → npm fallback converges (this host's shape)", () => {
  // `codex update` exits 0 but updates a copy nothing on PATH resolves. Exit code
  // says success; the version says otherwise — so we fall through to npm.
  const r = runScript({ preferred: null, codexAdvances: false, npmAdvances: true });
  expect(r.codexUpdateRan).toBe(true);
  expect(r.npmInstallRan).toBe(true);
  expect(r.converged).toBe("npm");
  expect(r.stdout).toContain(`channel=codex did not advance codex (${BEFORE})`);
  expect(r.stdout).toContain("channel=npm (source=fallback)");
});

test("harness: a stale memo misses, the fallback converges and names the new winner", () => {
  // operator migrated npm → standalone: the memo says npm, npm no longer moves the
  // on-PATH codex, `codex update` does. One miss, then the memo is rewritten.
  const r = runScript({ preferred: "npm", npmAdvances: false, codexAdvances: true });
  expect(r.npmInstallRan).toBe(true);
  expect(r.codexUpdateRan).toBe(true);
  expect(r.converged).toBe("codex");
});

test("harness: no `update` subcommand → npm only, and codex is never tried", () => {
  const r = runScript({ preferred: "codex", hasUpdate: false, npmAdvances: true });
  expect(r.npmInstallRan).toBe(true);
  expect(r.codexUpdateRan).toBe(false); // a too-old codex must never be handed `update`
  expect(r.converged).toBe("npm");
  expect(r.stdout).toContain("codex update subcommand not present; using npm");
});

test("harness: neither channel advances → no winner, nothing to memoize", () => {
  const r = runScript({ preferred: null, codexAdvances: false, npmAdvances: false });
  expect(r.codexUpdateRan).toBe(true);
  expect(r.npmInstallRan).toBe(true); // both tried…
  expect(r.converged).toBeNull(); // …neither won
  expect(r.stdout).toContain("did not converge");
  expect(r.installed).toBe(BEFORE);
});

// ── check(): version compare against the npm registry ─────────────────────────
test("current < latest → updateAvailable true", async () => {
  const svc = new CodexUpdateService({
    versionRunner: () => "@openai/codex 0.142.2\n",
    fetchLatest: async () => ({ version: "0.142.4" }),
  });
  const s = await svc.check(1000);
  expect(s.current).toBe("0.142.2");
  expect(s.latest).toBe("0.142.4");
  expect(s.updateAvailable).toBe(true);
  expect(s.notes).toBe(null);
});

test("current == latest → updateAvailable false", async () => {
  const svc = new CodexUpdateService({
    versionRunner: () => "@openai/codex 0.142.4",
    fetchLatest: async () => ({ version: "0.142.4" }),
  });
  const s = await svc.check(2000);
  expect(s.updateAvailable).toBe(false);
});

test("check keeps its default latest fetch independent from the release-history transport", async () => {
  const originalFetch = globalThis.fetch;
  let latestCalls = 0;
  let historyCalls = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      latestCalls++;
      expect(String(input)).toBe("https://registry.npmjs.org/@openai/codex/latest");
      return jsonResponse({ version: "0.145.0" });
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const svc = new CodexUpdateService({
      versionRunner: () => "@openai/codex 0.144.0",
      fetchHistory: async () => {
        historyCalls++;
        throw new Error("release history must stay on demand");
      },
    });

    expect(await svc.check(3_000)).toMatchObject({
      current: "0.144.0",
      latest: "0.145.0",
      updateAvailable: true,
      notes: null,
    });
    expect(latestCalls).toBe(1);
    expect(historyCalls).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("versionRunner throws → fail-safe, no badge, error set", async () => {
  const svc = new CodexUpdateService({
    versionRunner: () => {
      throw new Error("codex: command not found");
    },
    fetchLatest: async () => ({ version: "0.142.4" }),
  });
  const s = await svc.check(4000);
  expect(s.updateAvailable).toBe(false);
  expect(s.error).toContain("command not found");
});

test("check isolates status from history and validates npm latest as an anchored stable version", async () => {
  for (const latest of ["0.145.0-alpha.1", "v0.145.0", "00.145.0", "0.145", "0.145.0 extra"]) {
    let historyCalls = 0;
    const svc = new CodexUpdateService({
      versionRunner: () => "codex-cli 0.144.0 (build metadata is tolerated)",
      fetchLatest: async () => ({ version: latest }),
      fetchHistory: async () => {
        historyCalls++;
        return jsonResponse({});
      },
    });

    const status = await svc.check(5);
    expect(status).toMatchObject({ latest: null, updateAvailable: false, notes: null });
    expect(await svc.releaseNotes()).toEqual({
      current: "0.144.0",
      latest: null,
      notes: [],
      complete: true,
    });
    expect(historyCalls).toBe(0);
  }
});

test("check compares arbitrarily large stable components without Number coercion", async () => {
  const svc = new CodexUpdateService({
    versionRunner: () => "codex-cli 90071992547409931234567890.2.3",
    fetchLatest: async () => ({ version: "90071992547409931234567891.0.0" }),
  });

  expect(await svc.check(6)).toMatchObject({
    current: "90071992547409931234567890.2.3",
    latest: "90071992547409931234567891.0.0",
    updateAvailable: true,
    notes: null,
  });
});

test("releaseNotes resumes a finite npm target set with at most two serial GitHub requests per call", async () => {
  let now = 1_000;
  const calls: string[] = [];
  const fetchHistory = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url === "https://registry.npmjs.org/@openai%2Fcodex") {
      return jsonResponse({
        versions: {
          "0.145.0": {},
          "0.141.0": {},
          "0.144.0": {},
          "0.142.0": {},
          "0.143.0": {},
        },
      });
    }
    if (url.endsWith("releases?per_page=30&page=1")) {
      return jsonResponse([release("0.140.0", "current"), release("0.144.0", "notes 144")], {
        link: '<https://api.github.com/repos/openai/codex/releases?per_page=30&page=2>; rel="next"',
        "x-ratelimit-remaining": "50",
        "x-ratelimit-reset": "9999999999",
      });
    }
    if (url.endsWith("releases/tags/rust-v0.145.0")) {
      return jsonResponse(release("0.145.0", "notes 145"), {
        "x-ratelimit-remaining": "49",
        "x-ratelimit-reset": "9999999999",
      });
    }
    if (url.endsWith("releases?per_page=30&page=2")) {
      return jsonResponse([release("0.142.0", "notes 142"), release("0.141.0", "notes 141")], {
        "x-ratelimit-remaining": "48",
        "x-ratelimit-reset": "9999999999",
      });
    }
    if (url.endsWith("releases/tags/rust-v0.143.0")) {
      return jsonResponse(release("0.143.0", "notes 143"), {
        "x-ratelimit-remaining": "47",
        "x-ratelimit-reset": "9999999999",
      });
    }
    throw new Error(`unexpected history URL: ${url}`);
  };
  const svc = new CodexUpdateService({
    versionRunner: () => "codex-cli 0.140.0",
    fetchLatest: async () => ({ version: "0.145.0" }),
    fetchHistory,
    historyNow: () => now,
    historyProgressIntervalMs: 60_000,
  });
  await svc.check(7);

  const first = await svc.releaseNotes();
  expect(first).toEqual({
    current: "0.140.0",
    latest: "0.145.0",
    notes: [
      { version: "0.145.0", body: "notes 145" },
      { version: "0.144.0", body: "notes 144" },
    ],
    complete: false,
  });
  expect(calls.filter((url) => new URL(url).hostname === "api.github.com")).toHaveLength(2);

  now = 30_000;
  expect(await svc.releaseNotes()).toEqual(first);
  expect(calls.filter((url) => new URL(url).hostname === "api.github.com")).toHaveLength(2);

  now = 61_001;
  const complete = await svc.releaseNotes();
  expect(complete).toEqual({
    current: "0.140.0",
    latest: "0.145.0",
    notes: [
      { version: "0.145.0", body: "notes 145" },
      { version: "0.144.0", body: "notes 144" },
      { version: "0.143.0", body: "notes 143" },
      { version: "0.142.0", body: "notes 142" },
      { version: "0.141.0", body: "notes 141" },
    ],
    complete: true,
  });
  expect(calls.filter((url) => new URL(url).hostname === "api.github.com")).toHaveLength(4);
  expect(calls).toContain("https://api.github.com/repos/openai/codex/releases?per_page=30&page=2");
  expect(calls).toContain("https://api.github.com/repos/openai/codex/releases/tags/rust-v0.143.0");
});

test("releaseNotes remains total when catalog evidence is incomplete and stops retrying a terminal exact tag", async () => {
  let now = 1_000;
  const calls: string[] = [];
  const svc = new CodexUpdateService({
    versionRunner: () => "codex-cli 0.144.0",
    fetchLatest: async () => ({ version: "0.145.0" }),
    fetchHistory: async (input) => {
      const url = String(input);
      calls.push(url);
      if (new URL(url).hostname === "registry.npmjs.org") {
        return jsonResponse({ versions: { "0.144.0": {} } });
      }
      if (url.includes("releases?")) {
        return jsonResponse([], {
          "x-ratelimit-remaining": "50",
          "x-ratelimit-reset": "9999999999",
        });
      }
      return new Response("missing", {
        status: 404,
        headers: {
          "x-ratelimit-remaining": "49",
          "x-ratelimit-reset": "9999999999",
        },
      });
    },
    historyNow: () => now,
  });
  await svc.check(8);

  expect(await svc.releaseNotes()).toEqual({
    current: "0.144.0",
    latest: "0.145.0",
    notes: [],
    complete: false,
  });
  const callsAfterTerminalMiss = calls.length;
  now += 61_000;
  expect(await svc.releaseNotes()).toMatchObject({ complete: false, notes: [] });
  expect(calls).toHaveLength(callsAfterTerminalMiss);
});

test("releaseNotes honors a GitHub rate gate across range keys", async () => {
  let now = 1_000;
  let current = "0.140.0";
  let latest = "0.141.0";
  const githubCalls: string[] = [];
  const svc = new CodexUpdateService({
    versionRunner: () => `codex-cli ${current}`,
    fetchLatest: async () => ({ version: latest }),
    fetchHistory: async (input) => {
      const url = String(input);
      if (new URL(url).hostname === "registry.npmjs.org") {
        return jsonResponse({ versions: { [latest]: {} } });
      }
      githubCalls.push(url);
      return new Response("limited", {
        status: 429,
        headers: { "retry-after": "60", "x-ratelimit-reset": "61" },
      });
    },
    historyNow: () => now,
  });
  await svc.check(11);
  expect(await svc.releaseNotes()).toMatchObject({ complete: false });
  expect(githubCalls).toHaveLength(1);

  current = "0.141.0";
  latest = "0.142.0";
  await svc.check(12);
  expect(await svc.releaseNotes()).toEqual({
    current: "0.141.0",
    latest: "0.142.0",
    notes: [],
    complete: false,
  });
  expect(githubCalls).toHaveLength(1);

  now = 61_001;
  await svc.releaseNotes();
  expect(githubCalls).toHaveLength(2);
});

test("releaseNotes bounds malformed, timed-out, oversized, and over-limit upstream payloads", async () => {
  for (const catalogFailure of ["malformed", "timeout", "oversized"] as const) {
    let calls = 0;
    const svc = new CodexUpdateService({
      versionRunner: () => "codex-cli 0.144.0",
      fetchLatest: async () => ({ version: "0.145.0" }),
      fetchHistory: async (input, init) => {
        calls++;
        const url = String(input);
        if (new URL(url).hostname === "registry.npmjs.org") {
          if (catalogFailure === "malformed") return new Response("{");
          if (catalogFailure === "oversized") {
            return new Response("{}", {
              headers: { "content-length": String(8 * 1024 * 1024 + 1) },
            });
          }
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
        }
        return jsonResponse(release("0.145.0", "latest survives catalog failure"), {
          "x-ratelimit-remaining": "50",
          "x-ratelimit-reset": "9999999999",
        });
      },
      historyRequestTimeoutMs: 2,
      historyLoadTimeoutMs: 50,
    });
    await svc.check(13);

    expect(await svc.releaseNotes()).toEqual({
      current: "0.144.0",
      latest: "0.145.0",
      notes: [{ version: "0.145.0", body: "latest survives catalog failure" }],
      complete: false,
    });
    expect(calls).toBe(2);
  }

  for (const exactFailure of ["oversized-response", "oversized-body"] as const) {
    let calls = 0;
    const svc = new CodexUpdateService({
      versionRunner: () => "codex-cli 0.144.0",
      fetchLatest: async () => ({ version: "0.145.0" }),
      fetchHistory: async (input) => {
        calls++;
        const url = String(input);
        if (new URL(url).hostname === "registry.npmjs.org") {
          return jsonResponse({ versions: { "0.145.0": {} } });
        }
        if (url.includes("releases?")) return new Response("{");
        if (exactFailure === "oversized-response") {
          return new Response("{}", {
            headers: { "content-length": String(12 * 1024 * 1024 + 1) },
          });
        }
        return jsonResponse(release("0.145.0", "x".repeat(256 * 1024 + 1)), {
          "x-ratelimit-remaining": "50",
          "x-ratelimit-reset": "9999999999",
        });
      },
    });
    await svc.check(14);

    expect(await svc.releaseNotes()).toMatchObject({ notes: [], complete: false });
    expect(calls).toBe(3);
  }
});

test("releaseNotes deduplicates in-flight work and late range A cannot overwrite cached range B", async () => {
  let current = "0.140.0";
  let latest = "0.141.0";
  let resolveCatalogA!: (response: Response) => void;
  const catalogA = new Promise<Response>((resolve) => {
    resolveCatalogA = resolve;
  });
  const calls: string[] = [];
  let catalogCalls = 0;
  const svc = new CodexUpdateService({
    versionRunner: () => `codex-cli ${current}`,
    fetchLatest: async () => ({ version: latest }),
    fetchHistory: async (input) => {
      const url = String(input);
      calls.push(url);
      if (new URL(url).hostname === "registry.npmjs.org") {
        catalogCalls++;
        if (catalogCalls === 1) return catalogA;
        return jsonResponse({ versions: { "0.142.0": {} } });
      }
      if (url.includes("releases?")) {
        const version = latest;
        return jsonResponse([release(version, `notes ${version}`)], {
          "x-ratelimit-remaining": "50",
          "x-ratelimit-reset": "9999999999",
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  await svc.check(9);

  const rangeA = svc.releaseNotes();
  expect(svc.releaseNotes()).toBe(rangeA);

  current = "0.141.0";
  latest = "0.142.0";
  await svc.check(10);
  const rangeB = await svc.releaseNotes();
  expect(rangeB).toEqual({
    current: "0.141.0",
    latest: "0.142.0",
    notes: [{ version: "0.142.0", body: "notes 0.142.0" }],
    complete: true,
  });
  const callsAfterB = calls.length;

  resolveCatalogA(jsonResponse({ versions: { "0.141.0": {} } }));
  expect(await rangeA).toMatchObject({ current: "0.140.0", latest: "0.141.0" });
  const callsAfterA = calls.length;
  expect(await svc.releaseNotes()).toEqual(rangeB);
  expect(callsAfterA).toBeGreaterThan(callsAfterB);
  expect(calls).toHaveLength(callsAfterA);
});

// ── apply(): success/failure detection from a re-read version ──────────────────

/** Build a service primed with a known current→latest, injecting all seams so
 *  no real process spawns. `runUpdate` resolves immediately by default. */
function primed(opts: {
  installedAfter: string; // what `codex --version` reports AFTER the update
  latest?: string;
  current?: string;
  runUpdate?: (onLine: (l: string) => void, signal: AbortSignal) => Promise<void>;
  resolveOnPathBinary?: () => string | null;
  watchdogMs?: number;
}) {
  const dones: CodexUpdateResult[] = [];
  const memoWrites: CodexUpdateChannel[] = [];
  let versionCalls = 0;
  const svc = new CodexUpdateService({
    writeChannel: (c) => memoWrites.push(c),
    // first call (during check) returns `current`; later calls return installedAfter
    versionRunner: () => {
      versionCalls++;
      return `@openai/codex ${versionCalls === 1 ? (opts.current ?? "0.142.2") : opts.installedAfter}`;
    },
    fetchLatest: async () => ({ version: opts.latest ?? "0.142.4" }),
    runUpdate: opts.runUpdate ?? (async () => {}),
    // default null so failure-path tests stay hermetic (no real PATH scan)
    resolveOnPathBinary: opts.resolveOnPathBinary ?? (() => null),
    onLog: () => {},
    onStatus: () => {},
    onDone: (r) => dones.push(r),
    watchdogMs: opts.watchdogMs ?? 300_000,
  });
  return { svc, dones, memoWrites };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

/** a runUpdate that replays the marker lines a real script would emit */
const emitting =
  (...lines: string[]) =>
  async (onLine: (l: string) => void) => {
    for (const l of lines) onLine(l);
  };

test("apply(): success when the re-read version advances past the prior version", async () => {
  const { svc, dones } = primed({ installedAfter: "0.142.4", latest: "0.142.4" });
  await svc.check(1); // sets current=0.142.2, latest=0.142.4, updateAvailable
  expect(svc.apply()).toEqual({ started: true });
  await settle();
  expect(dones).toHaveLength(1);
  expect(dones[0]).toMatchObject({ ok: true, to: "0.142.4" });
});

test("apply(): success is by ADVANCEMENT, not npm-latest match (standalone channel skew)", async () => {
  // A standalone `codex update` landed 0.142.9 while npm-latest reports 0.143.0 —
  // the version advanced, so this is a success reported at the ACTUAL version.
  const { svc, dones } = primed({
    current: "0.142.2",
    installedAfter: "0.142.9",
    latest: "0.143.0",
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(dones[0]).toMatchObject({ ok: true, to: "0.142.9" });
});

test("apply(): non-advancement attaches the on-PATH binary for the stuck-update message", async () => {
  const { svc, dones } = primed({
    current: "0.142.2",
    installedAfter: "0.142.2", // update ran but version did not move (PATH dup / already-latest)
    latest: "0.142.4",
    resolveOnPathBinary: () => "/home/op/.local/bin/codex",
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(dones[0]).toMatchObject({
    ok: false,
    to: "0.142.2",
    onPathBinary: "/home/op/.local/bin/codex",
  });
});

test("apply(): stuck message prefers the login-shell path the script logged", async () => {
  const { svc, dones } = primed({
    current: "0.142.2",
    installedAfter: "0.142.2", // did not advance
    latest: "0.142.4",
    // the script's `command -v` under bash -lc resolves the real on-PATH codex;
    // it must win over the Node process.env.PATH scan (which could miss a
    // profile-only ~/.local/bin).
    resolveOnPathBinary: () => "/usr/bin/codex",
    runUpdate: async (onLine) => {
      onLine(">>> codex-update: on-PATH codex: /home/op/.local/bin/codex");
    },
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(dones[0]).toMatchObject({ ok: false, onPathBinary: "/home/op/.local/bin/codex" });
});

test("apply(): failure when version unchanged even though the child exits 0", async () => {
  const { svc, dones } = primed({ installedAfter: "0.142.2", latest: "0.142.4" });
  await svc.check(1); // current=0.142.2
  svc.apply();
  await settle();
  expect(dones[0]).toMatchObject({ ok: false });
});

test("apply(): when runUpdate throws, reports the ACTUAL version, not the target", async () => {
  const { svc, dones } = primed({
    installedAfter: "0.142.2",
    latest: "0.142.4",
    runUpdate: async () => {
      throw new Error("spawn failed");
    },
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(dones[0]).toMatchObject({
    ok: false,
    to: "0.142.2",
    error: expect.stringContaining("spawn failed"),
  });
  expect(dones[0]!.to).not.toBe("0.142.4"); // never the target we did NOT reach
});

test("apply(): watchdog timeout reports the ACTUAL version, not the target", async () => {
  const { svc, dones } = primed({
    installedAfter: "0.142.2", // hung update never swapped the binary
    latest: "0.142.4",
    watchdogMs: 20,
    runUpdate: (_onLine, signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  });
  await svc.check(1);
  svc.apply();
  await new Promise((r) => setTimeout(r, 60));
  expect(dones[0]).toMatchObject({
    ok: false,
    to: "0.142.2",
    error: expect.stringContaining("timed out"),
  });
  expect(dones[0]!.to).not.toBe("0.142.4");
});

test("apply(): double-launch guarded while one is in flight", async () => {
  let runs = 0;
  const { svc } = primed({
    installedAfter: "0.142.4",
    runUpdate: async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 30));
    },
  });
  await svc.check(1);
  expect(svc.apply()).toEqual({ started: true });
  expect(svc.apply()).toEqual({ started: false }); // still applying
  await new Promise((r) => setTimeout(r, 60));
  expect(runs).toBe(1);
});

test("apply(): streams runUpdate lines to onLog", async () => {
  const received: string[] = [];
  const svc = new CodexUpdateService({
    versionRunner: () => "@openai/codex 0.142.4",
    fetchLatest: async () => ({ version: "0.142.4" }),
    runUpdate: async (onLine) => {
      onLine("changed 1 package");
      onLine("updated @openai/codex");
    },
    onLog: (l) => received.push(l),
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(received).toEqual(["changed 1 package", "updated @openai/codex"]);
});

// ── the channel memo: written ONLY from a converged run that named its winner ──
//
// `ok` is shepherd's own compareSemver verdict — it says THAT codex advanced,
// never BY WHAT. Only the script can attribute a channel. So an unattributable
// run must leave the memo alone rather than guess: a wrong memo costs a wasted
// installer run on every future update.

test("memo: a converged run persists the channel that won", async () => {
  const { svc, memoWrites } = primed({
    installedAfter: "0.142.4",
    runUpdate: emitting(`${CONVERGED_MARKER}npm`),
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(memoWrites).toEqual(["npm"]);
});

test("memo: `codex update` winning persists `codex` (standalone / #1560 attribution)", async () => {
  const { svc, memoWrites } = primed({
    installedAfter: "0.142.4",
    runUpdate: emitting(`${CONVERGED_MARKER}codex`),
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(memoWrites).toEqual(["codex"]);
});

test("memo: converged but NO channel marker → left untouched, never guessed", async () => {
  const { svc, dones, memoWrites } = primed({
    installedAfter: "0.142.4", // ok:true …
    runUpdate: emitting("some output", "but no converged-via marker"), // … yet unattributable
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(dones[0]).toMatchObject({ ok: true });
  expect(memoWrites).toEqual([]);
});

test("memo: a non-converged run never writes (a failure can't poison a good memo)", async () => {
  const { svc, dones, memoWrites } = primed({
    installedAfter: "0.142.2", // version did not move
    runUpdate: emitting(`${CODEX_UPDATE_LOG_PREFIX} did not converge`),
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(dones[0]).toMatchObject({ ok: false });
  expect(memoWrites).toEqual([]);
});

test("memo: a watchdog-killed run never writes, even if a marker was seen", async () => {
  // The kill lands mid-stream: a killed run proves nothing about the channel.
  const { svc, dones, memoWrites } = primed({
    installedAfter: "0.142.4",
    watchdogMs: 5,
    runUpdate: async (onLine, signal) => {
      onLine(`${CONVERGED_MARKER}npm`);
      await new Promise((r) => {
        signal.addEventListener("abort", r, { once: true });
      });
    },
  });
  await svc.check(1);
  svc.apply();
  await new Promise((r) => setTimeout(r, 40));
  expect(dones[0]).toMatchObject({ ok: false, error: "codex update timed out" });
  expect(memoWrites).toEqual([]);
});

test("memo: an unknown channel name in the marker is ignored, not persisted", async () => {
  const { svc, memoWrites } = primed({
    installedAfter: "0.142.4",
    runUpdate: emitting(`${CONVERGED_MARKER}pnpm`),
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(memoWrites).toEqual([]);
});

test("memo: a throwing store cannot rewrite a converged outcome into a failure", async () => {
  // The memo is bookkeeping — codex is already updated on disk. A locked SQLite
  // must cost us the optimisation, never the verdict (and never the onStatus emit).
  const statuses: unknown[] = [];
  const dones: CodexUpdateResult[] = [];
  const svc = new CodexUpdateService({
    versionRunner: (() => {
      let n = 0;
      return () => `@openai/codex ${++n === 1 ? "0.142.2" : "0.142.4"}`;
    })(),
    fetchLatest: async () => ({ version: "0.142.4" }),
    runUpdate: emitting(`${CONVERGED_MARKER}npm`),
    writeChannel: () => {
      throw new Error("database is locked");
    },
    onStatus: (s) => statuses.push(s),
    onDone: (r) => dones.push(r),
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(dones[0]).toMatchObject({ ok: true, to: "0.142.4" });
  expect(dones[0]?.error).toBeUndefined();
  expect(statuses).toHaveLength(1); // the status emit still happened
});

test("harness: a winner that lands codex EARLIER on PATH is still seen (bash hash)", () => {
  // bash hashes `codex`→path on the `before` read. A standalone installer that
  // drops a NEW codex into an earlier PATH dir would be re-read through the stale
  // hashed path and look like a no-op — and that false negative would be memoized.
  const r = runScriptShadowing();
  expect(r.converged).toBe("codex");
  expect(r.npmInstallRan).toBe(false); // must NOT fall through to the npm fallback
});

test("memo: a throwing store READ degrades to the default order, never cancels the update", async () => {
  // The memo only picks which installer we try FIRST. Read it inside the spawn's
  // Promise executor and a locked SQLite rejects before `spawn` — killing an update
  // that would otherwise have succeeded. It is an optimisation, not a precondition.
  const seen: (CodexUpdateChannel | null)[] = [];
  const dones: CodexUpdateResult[] = [];
  const svc = new CodexUpdateService({
    versionRunner: (() => {
      let n = 0;
      return () => `@openai/codex ${++n === 1 ? "0.142.2" : "0.142.4"}`;
    })(),
    fetchLatest: async () => ({ version: "0.142.4" }),
    readChannel: () => {
      throw new Error("database is locked");
    },
    runUpdate: async (onLine, _signal, preferred) => {
      seen.push(preferred); // the update MUST still run…
      onLine(`${CONVERGED_MARKER}codex`);
    },
    onDone: (r) => dones.push(r),
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(seen).toEqual([null]); // …with the historical order, not a rejection
  expect(dones[0]).toMatchObject({ ok: true, to: "0.142.4" });
});

test("memo: a readable memo is handed to the update as the preferred channel", async () => {
  const seen: (CodexUpdateChannel | null)[] = [];
  const svc = new CodexUpdateService({
    versionRunner: (() => {
      let n = 0;
      return () => `@openai/codex ${++n === 1 ? "0.142.2" : "0.142.4"}`;
    })(),
    fetchLatest: async () => ({ version: "0.142.4" }),
    readChannel: () => "npm",
    runUpdate: async (_onLine, _signal, preferred) => {
      seen.push(preferred);
    },
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(seen).toEqual(["npm"]);
});
