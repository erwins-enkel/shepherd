# herdr Offline Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a freshly-installed Shepherd host end with a **running** herdr server, so the `herdr` diagnostic reaches `ok` and the three red nightly scenarios (issue #1574) go green.

**Architecture:** PR #1562 added a liveness dimension to the herdr check (`diagnostics_hint_herdr_offline` ⇒ `error`), but nothing in the product ever starts a herdr daemon. Fix at both layers: a shared, idempotent `HERDR_SERVE` command in the remediation table (so the in-app Fix endpoint and the harness can both recover a dead daemon), and a provisioner that leaves one running — a `Restart=always` systemd user unit on the service path, a detached process on the no-service path.

**Tech Stack:** Bun + TypeScript, systemd user units, Incus (harness), `bun:test`.

## Global Constraints

- **Verified fact (do not re-litigate):** herdr **0.7.3 does not auto-spawn** its daemon. `herdr agent list` against a fresh socket exits 1 (`NotFound`) and creates nothing. Confirmed in a clean Incus `images:ubuntu/24.04` instance on 2026-07-09. The comment at `src/herdr-update.ts:88-95` asserting the opposite is **false** and is corrected in Task 4.
- **`setsid` does not exist on macOS.** `buildOnly()` is the macOS path. Every start command MUST fall back to `nohup`. Never emit a bare `setsid`.
- **`~/.local/bin` is not on a non-login shell's PATH.** herdr installs there. Any command that installs herdr and then *runs* it in the same shell MUST `export PATH="$HOME/.local/bin:$PATH"` first.
- **Single-apply constraint:** `runHerdrPreflightE2E` (`ci/onboarding-harness/run.ts:216`) applies **only** `diagnostics_hint_herdr_missing`, once, with no second round. So that remediation must **install AND start** or `herdr-missing` stays red.
- **Commit prefix is `fix:`**, never `feat:`. A `feat` subject arms `scripts/check-feature-catalog.sh` and would demand a feature-announcement entry. This change ships no new user-facing UX.
- **i18n:** `diagnostics_hint_herdr_offline` already exists in **both** `ui/messages/en.json:1269` and `de.json:1269` (added by #1562). Add **no** new message keys. If you do, add to both catalogs.
- **Tests:** run `bun run test` (NOT bare `bun test`). Lint with `bun run lint`. This worktree may need `bun install` first.
- **Never** run `pkill`/`killall` against `herdr` on the host. Probe only inside a disposable Incus instance; tear it down by exact name.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/remediations.ts` (modify) | Add `HERDR_SERVE`; wire `herdr_offline` + chain into `herdr_missing`. |
| `test/remediations.test.ts` (create) | Lock the contract: offline is auto-fixable, missing installs+starts, portable, idempotent. |
| `deploy/herdr.service` (create) | `Restart=always` systemd **user** unit owning the daemon durably. |
| `deploy/shepherd.service` (modify) | Order Shepherd after herdr. |
| `deploy/provision.ts` (modify) | `installService` enables the unit; `buildOnly` starts a detached daemon. |
| `test/provision.test.ts` (modify) | Assert both provision paths leave a server. |
| `src/herdr-update.ts` (modify) | Correct the falsified auto-spawn comment. |
| `ci/onboarding-harness/README.md` (modify) | Document that the target-ok set now implies a live daemon. |

---

### Task 1: Shared `HERDR_SERVE` remediation

**Files:**
- Modify: `src/remediations.ts:21` (the `HERDR_INSTALL` const) and `src/remediations.ts:43-55` (the `REMEDIATIONS` map)
- Test: `test/remediations.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `REMEDIATIONS["diagnostics_hint_herdr_offline"]: string` and a `herdr_missing` value that installs then starts. Task 3 reuses the exported `HERDR_SERVE` const, so it MUST be exported.

- [ ] **Step 1: Write the failing test**

Create `test/remediations.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { REMEDIATIONS, autoFixCommandFor, HERDR_SERVE } from "../src/remediations";

describe("herdr offline remediation (#1574)", () => {
  it("exposes a start command for the offline hint", () => {
    expect(REMEDIATIONS.diagnostics_hint_herdr_offline).toBe(HERDR_SERVE);
  });

  it("makes the offline fix auto-runnable in-app (not guidance-only)", () => {
    expect(autoFixCommandFor("diagnostics_hint_herdr_offline")).toBe(HERDR_SERVE);
  });

  it("starts the daemon detached, portably (macOS has no setsid)", () => {
    expect(HERDR_SERVE).toContain("setsid");
    expect(HERDR_SERVE).toContain("nohup");
  });

  it("is idempotent: a live daemon short-circuits before spawning a second", () => {
    expect(HERDR_SERVE.indexOf("herdr agent list")).toBeLessThan(HERDR_SERVE.indexOf("herdr server"));
  });

  it("puts ~/.local/bin on PATH before invoking herdr", () => {
    expect(HERDR_SERVE.indexOf(".local/bin")).toBeLessThan(HERDR_SERVE.indexOf("herdr agent list"));
  });

  it("herdr_missing installs AND starts, so the single-apply preflight scenario reaches green", () => {
    const cmd = REMEDIATIONS.diagnostics_hint_herdr_missing!;
    expect(cmd).toContain("herdr.dev/install.sh");
    expect(cmd).toContain("herdr server");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test test/remediations.test.ts`
Expected: FAIL — `HERDR_SERVE` is not exported from `src/remediations.ts`.

- [ ] **Step 3: Write minimal implementation**

In `src/remediations.ts`, replace the `HERDR_INSTALL` line (currently line 21) with:

```ts
const HERDR_INSTALL = "curl -fsSL https://herdr.dev/install.sh | bash";

/** Bring the herdr daemon up and PROVE it answers. herdr 0.7.3 does NOT auto-spawn its
 *  server on a CLI call (verified in a clean instance, #1574) — a host that never ran
 *  `herdr server` has a dead socket, which is exactly the `offline` state #1562 made red.
 *
 *  Shape, in order, and every clause is load-bearing:
 *   - `export PATH` — herdr installs to ~/.local/bin, absent from a non-login shell's PATH.
 *   - `agent list || { start }` — IDEMPOTENT: a live daemon short-circuits, so this never
 *     races a second server against a bound socket. Also makes the command safe to re-run.
 *   - `setsid … || nohup …` — detach so the daemon outlives the shell (an `incus exec`
 *     session, or the in-app Fix endpoint's child). macOS has NO `setsid`, and buildOnly()
 *     is the macOS path, so the nohup fallback is required, not decorative.
 *   - the poll — resolve only once the daemon actually ANSWERS. Without it the command
 *     exits 0 the instant the fork returns, and a caller (provision, the harness) would
 *     treat a still-binding — or crashed — server as success. Bounded at ~10s.
 *
 *  NOT durable across a `systemctl restart shepherd` when spawned from Shepherd's cgroup;
 *  the systemd path installs `deploy/herdr.service` (Restart=always) for that. */
export const HERDR_SERVE =
  'export PATH="$HOME/.local/bin:$PATH"; ' +
  "herdr agent list >/dev/null 2>&1 || " +
  "{ if command -v setsid >/dev/null 2>&1; then " +
  "setsid herdr server </dev/null >/dev/null 2>&1 & " +
  "else nohup herdr server </dev/null >/dev/null 2>&1 & fi; }; " +
  "for _ in 1 2 3 4 5 6 7 8 9 10; do " +
  "herdr agent list >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1";
```

Then in the `REMEDIATIONS` map, replace the two herdr lines:

```ts
  // Install AND start: a bare binary leaves the daemon dead, which #1562 correctly reports
  // as `offline`/error. The harness's preflight scenario applies this hint ONCE with no
  // second round (run.ts:216), so installing without starting can never reach green.
  diagnostics_hint_herdr_missing: `${HERDR_INSTALL} && ${HERDR_SERVE}`,
  diagnostics_hint_herdr_outdated: HERDR_INSTALL,
  diagnostics_hint_herdr_offline: HERDR_SERVE,
```

Leave `GUIDANCE_ONLY` untouched — starting a daemon is unprivileged and clears the check unattended, so it is correctly one-click fixable in-app.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test test/remediations.test.ts`
Expected: PASS, 6 tests.

Run: `bun run test test/provision.test.ts test/diagnostics.test.ts`
Expected: PASS — `selectPrereqCommand` still resolves a command for herdr; no existing assertion pins the exact `herdr_missing` string. If one does, update it to expect the chained command.

- [ ] **Step 5: Commit**

```bash
git add src/remediations.ts test/remediations.test.ts
git commit -m "fix(remediations): start the herdr daemon, not just install the binary (#1574)"
```

---

### Task 2: Durable herdr systemd user unit

**Files:**
- Create: `deploy/herdr.service`
- Modify: `deploy/shepherd.service:4-5` (the `After=`/`Wants=` block)

**Interfaces:**
- Consumes: nothing.
- Produces: `deploy/herdr.service`, read+written by `installService` in Task 3.

- [ ] **Step 1: Create the unit**

Create `deploy/herdr.service`:

```ini
[Unit]
Description=herdr — terminal workspace manager (Shepherd's session backend)
# Shepherd cannot spawn a single agent without this daemon, and herdr 0.7.3 does NOT
# auto-spawn it on a CLI call (#1574). A user unit — NOT system — because herdr's socket,
# config and panes all live under $HOME and belong to the operator, same as shepherd.service.
Documentation=https://herdr.dev

[Service]
Type=simple
ExecStart=%h/.local/bin/herdr server
# Restart=always (not on-failure): a `herdr server stop`, an OOM kill, or a crashed daemon
# must all come back — panes OUTLIVE the server and reattach, so a restart is always safe
# and always preferable to a host that silently can't start agents. This is the "durable
# operator-side fix" src/herdr-update.ts refers to; with it, that module's last-resort
# `setsid herdr server` fallback becomes dead code on a provisioned host (it stays for
# hand-rolled installs).
Restart=always
RestartSec=2
Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Order Shepherd after herdr**

In `deploy/shepherd.service`, replace lines 4-5:

```ini
After=network-online.target
Wants=network-online.target
```

with:

```ini
After=network-online.target herdr.service
Wants=network-online.target
# Wants (not Requires): a herdr that fails to start must not cascade-fail Shepherd — the
# server still boots degraded and DIAGNOSE reports `herdr: offline`, which is the whole
# point of the check. After= only orders us behind it when both are enabled.
Wants=herdr.service
```

- [ ] **Step 3: Verify the units parse**

Run: `systemd-analyze verify deploy/herdr.service`
Expected: no output (exit 0). A `Restart=always` warning is acceptable; an unknown-directive error is not.

If `systemd-analyze` is unavailable, skip — Task 5 exercises both units for real inside Incus.

- [ ] **Step 4: Commit**

```bash
git add deploy/herdr.service deploy/shepherd.service
git commit -m "fix(deploy): add a Restart=always herdr user unit, order shepherd behind it (#1574)"
```

---

### Task 3: Provision a running daemon on both paths

**Files:**
- Modify: `deploy/provision.ts` — import block (line 23), `installService` (lines 272-337), `buildOnly` (lines 341-351)
- Test: `test/provision.test.ts` (modify)

**Interfaces:**
- Consumes: `HERDR_SERVE` from `src/remediations.ts` (Task 1); `deploy/herdr.service` (Task 2).
- Produces: no new exported symbols. `installService` and `buildOnly` keep their existing signatures exactly:
  - `installService(repo: string, run: Runner, fileIO: FileIO, env: NodeJS.ProcessEnv, home: string, buildEnv: NodeJS.ProcessEnv): void`
  - `buildOnly(repo: string, run: Runner, buildEnv: NodeJS.ProcessEnv): void`

- [ ] **Step 1: Write the failing tests**

Use the file's existing `recorder()` helper. Its exact shape (do not introduce a second one):
`recorder()` → `{ calls: string[][], writes: Map<string, string>, run: Runner, fileIO: FileIO }`,
where each `calls` entry is `[cmd, ...args]` flattened. Hence `calls.map((c) => c.join(" "))` and
`[...writes.keys()]`, matching the test at `test/provision.test.ts:332`.

In `test/provision.test.ts`, add to the `describe("extracted helpers (direct)")` block, after the existing `installService` test:

```ts
it("installs + enables the herdr unit BEFORE shepherd starts (#1574)", () => {
  const { calls, writes, run, fileIO } = recorder();
  installService("/repo", run, fileIO, { USER: "me" }, "/home/op", { PATH: "/x" });

  expect([...writes.keys()].some((p) => p.endsWith("systemd/user/herdr.service"))).toBe(true);

  const flat = calls.map((c) => c.join(" "));
  const enableHerdr = flat.findIndex((c) => c.includes("enable --now herdr"));
  const startShepherd = flat.findIndex((c) => c.includes("deploy/update.sh"));
  expect(enableHerdr).toBeGreaterThanOrEqual(0);
  // Ordering is the point: update.sh starts Shepherd, which needs a live daemon.
  expect(enableHerdr).toBeLessThan(startShepherd);
});
```

And after the existing `buildOnly` test:

```ts
it("starts a detached herdr daemon, no systemd on this path (#1574)", () => {
  const { calls, run } = recorder();
  buildOnly("/repo", run, { PATH: "/x" });

  const flat = calls.map((c) => c.join(" "));
  const serve = flat.find((c) => c.includes("herdr server"));
  expect(serve).toBeDefined();
  expect(serve!.startsWith("bash -c")).toBe(true);
  // macOS takes this path and has no setsid.
  expect(serve!).toContain("nohup");
  // It must precede the slow build so a dead daemon fails fast.
  const serveIdx = flat.findIndex((c) => c.includes("herdr server"));
  const installIdx = flat.findIndex((c) => c.includes("bun install"));
  expect(serveIdx).toBeLessThan(installIdx);
});
```

Note: the existing `buildOnly` test asserts `flat.some((c) => c.includes("systemctl"))` is `false`. `HERDR_SERVE` contains no `systemctl`, so that assertion still holds — if it breaks, you wired the wrong command.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test test/provision.test.ts`
Expected: FAIL — no `herdr.service` write, no `herdr server` command.

- [ ] **Step 3: Implement**

In `deploy/provision.ts`, extend the import on line 23:

```ts
import { autoFixCommandFor, HERDR_SERVE } from "../src/remediations";
```

In `installService`, immediately **after** the `run("systemctl", ["--user", "daemon-reload"])` call (line 317) and **before** `loginctl enable-linger`, insert the unit write. Place the `fileIO.write` for herdr up with the other unit writes (after the logrotate writes, ~line 316):

```ts
  // herdr's daemon: Shepherd cannot spawn a single agent without it, and herdr 0.7.3 does
  // NOT auto-spawn it (#1574). Copies verbatim — the unit's only path is %h-relative, which
  // systemd expands, so there is no WorkingDirectory to template.
  fileIO.write(join(unitDir, "herdr.service"), fileIO.read(join(repo, "deploy", "herdr.service")));
```

Then, after `run("systemctl", ["--user", "enable", "shepherd"])` (line 321), add:

```ts
  // --now: bring the daemon up immediately. MUST precede update.sh below, which starts
  // Shepherd — a Shepherd that boots against a dead herdr reports `offline` and spawns
  // nothing. `enable` alone would only arm it for the next login.
  run("systemctl", ["--user", "enable", "--now", "herdr"]);
```

In `buildOnly`, add as the **first** action (before `bun install`), so a failure surfaces before the slow build:

```ts
  // No systemd on this path (harness install-e2e + macOS), so start the daemon directly.
  // HERDR_SERVE is idempotent and polls until it answers, so this both starts and verifies.
  log("starting herdr server (no-service path)");
  run("bash", ["-c", HERDR_SERVE], { env: buildEnv });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test test/provision.test.ts`
Expected: PASS, including the two new tests.

Run: `bun run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add deploy/provision.ts test/provision.test.ts
git commit -m "fix(provision): leave a running herdr server on both install paths (#1574)"
```

---

### Task 4: Correct the falsified comment + docs

**Files:**
- Modify: `src/herdr-update.ts:88-95` and `:108-113`
- Modify: `ci/onboarding-harness/README.md` (the `install-e2e` section)

**Interfaces:**
- Consumes: nothing. Comment/doc only — no behavior change, no test.

- [ ] **Step 1: Correct the auto-spawn claim**

In `src/herdr-update.ts`, the comment block asserting *"any herdr CLI call auto-spawns the daemon (stated in the … design doc)"* is **false as of 0.7.3**. Replace that claim (keep the surrounding recovery rationale intact) with:

```ts
  // Recovery (#1558): `herdr update` exits 0 even when it leaves NO running server, so
  // gating recovery on `rc != 0` (as we used to) skipped the exact bug. So we ALWAYS run
  // `herdr agent list` after the update, regardless of rc.
  //
  // That call VERIFIES; it does not repair. An earlier version of this comment claimed any
  // herdr CLI call auto-spawns the daemon (sourced to the 0.6.x-era "herdr update without a
  // shepherd restart" design doc). That is FALSE on 0.7.x: against a dead socket `herdr
  // agent list` exits 1 with ENOENT and spawns nothing — verified in a clean instance
  // (#1574). The `setsid … server` fallback below is therefore NOT a belt-and-braces
  // leftover; it is the ONLY thing that recovers a host whose server did not come back.
```

Then in the "Last-resort fallback" block, drop the now-obsolete hedge *"Kept (not deleted) because the auto-spawn premise above is from the herdr 0.6.x era…"* and replace with:

```ts
  // Last-resort fallback: the ONLY repair path (see above — nothing auto-spawns). Relaunch a
  // detached server so orphaned targets reattach. On a host provisioned by deploy/provision.ts
  // this is normally unreachable: `deploy/herdr.service` (Restart=always) wins the retry race
  // above. It still covers hand-rolled installs with no unit.
```

- [ ] **Step 2: Update the harness README**

In `ci/onboarding-harness/README.md`, in the `### install-e2e` section, after the fenced `herdr  bun  node  git  claude` block, add:

```markdown
`herdr: ok` means the daemon **answers**, not merely that the binary parses a `--version`
(#1562 added a liveness probe; #1574 made the installer satisfy it). `deploy/provision.ts`
therefore leaves a running server: a `Restart=always` user unit (`deploy/herdr.service`) on
the service path, a detached `herdr server` on this `SHEPHERD_NO_SERVICE` path. herdr does
**not** auto-spawn its daemon on a CLI call.
```

- [ ] **Step 3: Verify no behavior changed**

Run: `bun run test`
Expected: PASS, full suite. (Comments and markdown only — a failure here means Step 1 deleted code, not a comment. Revert and redo.)

- [ ] **Step 4: Commit**

```bash
git add src/herdr-update.ts ci/onboarding-harness/README.md
git commit -m "docs(herdr): correct the falsified auto-spawn claim (#1574)"
```

---

### Task 5: Prove it green in Incus

**Files:** none modified. This task is verification — the plan's actual deliverable is a green harness, and no prior task proves that.

**Interfaces:**
- Consumes: everything from Tasks 1-4.

- [ ] **Step 1: Confirm an Incus host**

Run: `incus list -c ns`
Expected: the command succeeds. Note any pre-existing instances (e.g. `openclaw-marina`) — they MUST still be present at the end. If Incus is absent, STOP: report that the gate cannot be verified locally and hand back.

- [ ] **Step 2: Run the three previously-red scenarios**

Run each, in order, from the repo root:

```bash
bun run onboarding:test --scenario herdr-missing
bun run onboarding:test --scenario install-e2e
bun run onboarding:test --scenario install-e2e-service
```

Expected: exit 0 each. In `onboarding-gap-report.md`, each row reads `Green: yes`, `Classification: PASS`.

If `herdr-missing` is red: the single-apply chain from Task 1 did not start the daemon — check that `HERDR_SERVE`'s `export PATH` precedes the `herdr` call, since `curl | bash` lands the binary in `~/.local/bin`.
If `install-e2e-service` is red: `systemctl --user is-active herdr` inside the instance; a `Restart=always` unit that never binds usually means `%h/.local/bin/herdr` does not exist for that user.

- [ ] **Step 3: Run the deterministic gate subset**

Run: `scripts/onboarding-gate.sh`
Expected: exit 0. This is the same `structured`-and-not-`detectionOnly` subset the release gate consults.

- [ ] **Step 4: Confirm no collateral damage**

Run: `incus list -c ns` — every pre-existing instance from Step 1 is still RUNNING.
Run: `herdr status server` — the **host's** daemon still reports `status: running`.

Neither the harness nor these steps may touch the host daemon. If either check fails, say so plainly; do not silently restart anything.

- [ ] **Step 5: Full suite + push**

```bash
bun run test && bun run lint
git push -u origin shepherd/onboarding-harness-nightly-regression
```

Then open the PR with `gh pr create`, body referencing `Fixes #1574`, and paste the three green scenario rows as evidence.

---

## Unresolved Questions

1. `herdr_outdated` still maps to bare `HERDR_INSTALL` — reinstalls the binary but leaves the **old** daemon running, so the warning persists until a restart. Chain a restart (`herdr update --handoff`?) or leave? No scenario covers it. Out of scope here?
2. In-app Fix spawns the daemon inside Shepherd's cgroup → dies on `systemctl restart shepherd`. Acceptable (unit covers provisioned hosts), or should the Fix endpoint prefer `systemctl --user start herdr` when the unit exists?
3. `deploy/herdr.service` hardcodes `%h/.local/bin/herdr`. Honor `HERDR_BIN` (which `config.herdrBin` reads) instead?
4. Should `install.sh`'s degraded-capability list (line ~70) mention a dead herdr?
