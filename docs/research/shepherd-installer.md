# Shepherd — Installer Investigation (reusing the diagnostics/verification layer)

> Research deliverable. How to build a first-run installer for Shepherd **itself**, and how far
> it can piggyback on the existing diagnostics ("DIAGNOSE" settings tab) + remediation machinery.
> Authored 2026-06-15. References are file:line snapshots of the repo at the time of writing.

---

## 0. TL;DR / recommendation

Shepherd already contains **~80% of an installer** — it just isn't assembled or surfaced as one:

- A **verification layer** that knows what a ready host looks like: `DiagnosticsService` runs 7
  dependency probes (herdr, bun, node, git, gh, claude, tailscale) and emits tri-state
  `{ id, state, hintKey }` checks (`src/diagnostics.ts`).
- A **remediation layer** that knows the verbatim, non-interactive command to fix each fixable
  deficiency (`ci/onboarding-harness/remediations.ts` — `REMEDIATIONS` map keyed by `hintKey`).
- A **proof harness** that already boots clean, deliberately-broken Linux instances, applies those
  remediations, and re-probes until green (`ci/onboarding-harness/`).
- A **deploy flow** (install deps → build UI → restart unit → health-check) in `deploy/update.sh`,
  and a **systemd unit** template in `deploy/shepherd.service`.

The gap is that these pieces live in three disconnected places (the harness, the server, the deploy
scripts) and **the remediation map is buried in the test harness**, so the running product can't
offer a one-click fix and there is no single entry point a new user can run.

**Recommendation — a two-surface installer sharing one source of truth:**

1. **Promote `REMEDIATIONS` out of the harness into a shipped `src/remediations.ts`** so the
   bootstrap script, the in-app "Fix" action, and the onboarding harness all consume **one**
   command map. This is the keystone change; everything else builds on it.
2. **A pre-install bootstrap script** (`deploy/install.sh`, the `curl … | bash` entry point) for the
   cold-start case where Shepherd isn't running yet. It can't use the settings pane, but it can and
   should reuse the same remediation commands + the same min-version floors.
3. **In-app remediation in the DIAGNOSE tab** — the "piggyback" the prompt asks about: each
   non-OK check that has a known fix gains a **Fix** button that runs the verbatim remediation
   server-side (operator-confirmed), then re-probes. Checks whose fix needs a human secret
   (`gh auth login`, `tailscale` login/serve) stay **guidance-only**, mirroring the harness's
   existing `detectionOnly` split.

This is timely: Shepherd is on the cusp of an open-source launch (see
[`effort-maturity-and-open-source-launch.md`](effort-maturity-and-open-source-launch.md)), and a
frictionless first-run is the single biggest lever on "interest → running instance."

---

## 1. What "installing Shepherd" actually means today

Shepherd is **not a packaged binary**. The systemd unit runs the working tree directly
(`ExecStart=%h/.bun/bin/bun run src/index.ts`, `deploy/shepherd.service:10`), and `deploy/update.sh`
is explicit that "the working tree IS the deployment." So an install is really a **host
provisioning + first checkout + service registration** sequence, today fully manual across the
README:

| Step | Today (manual)                                                                   | Source                                   |
| ---- | -------------------------------------------------------------------------------- | ---------------------------------------- |
| 1    | Install prerequisites: Bun, Node, herdr, the `claude` CLI, git, gh               | README "Requirements" (README.md:91-96)  |
| 2    | `bun install` (root) + `cd ui && bun install`                                    | README "Quick start" (README.md:100-103) |
| 3    | `cd ui && bun run build` (core serves `ui/build` statically)                     | README.md:105-106                        |
| 4    | `bun run start` _or_ install the systemd unit + `enable-linger` + `enable --now` | README.md:360-368                        |
| 5    | (optional remote access) `tailscale serve --bg 7330` + `SHEPHERD_ALLOWED_HOSTS`  | README.md:256-260                        |
| 6    | Authenticate: `claude` logged into a Max/Pro subscription, `gh auth login`       | README.md:95, 174-175                    |

`deploy/update.sh` already automates **steps 2-4** for an _existing_ checkout (and adds a health
check against `/api/sessions`). It does **not** install prerequisites or perform the first clone —
that is exactly the missing front half of an installer.

### The chicken-and-egg constraint

The diagnostics server **is** Shepherd — it runs on Bun. So the in-app surface cannot bootstrap the
two things it depends on (Bun, and a checkout to run). Those must come from the pre-install script.
Everything _after_ Shepherd is first running (a stale herdr, a missing `claude`, an un-served
tailscale) is fixable in-app. This split is fundamental and drives the two-surface design.

---

## 2. The verification layer already in place (`src/diagnostics.ts`)

`DiagnosticsService` (`src/diagnostics.ts:72`) is, in effect, the installer's success criteria
expressed as code. It fans 7 probes with `Promise.all` behind a 60 s TTL cache:

| Check       | Probe                                                 | Non-OK states & hintKey                 |
| ----------- | ----------------------------------------------------- | --------------------------------------- |
| `herdr`     | `herdr --version` ≥ `HERDR_MIN_VERSION`               | missing (error) / outdated (warning)    |
| `bun`       | `bun --version` ≥ `BUN_MIN_VERSION`                   | missing / outdated                      |
| `node`      | `node --version` ≥ `NODE_MIN_VERSION`                 | missing / outdated                      |
| `git`       | presence only                                         | missing (error)                         |
| `gh`        | presence + `gh auth status` **exit code only**        | missing / not-authenticated             |
| `claude`    | presence only (`claude --version`)                    | missing (error)                         |
| `tailscale` | logged-in (`resolveNodeHost`) + serving `config.port` | missing (error) / not-serving (warning) |

Properties that make it installer-grade already:

- **Payload purity** (`src/diagnostics.ts:58-71`): every probe returns only `{ id, state, hintKey }`
  — no stdout, tokens, paths, or account identity. The `hintKey` is a UI message-key string. This
  matters for an installer: the same snapshot can drive both a CLI bootstrap and the UI safely.
- **Timeout discipline**: each probe resolves to a defined non-OK fallback on hang
  (`DIAGNOSTICS_PROBE_TIMEOUT_MS`), so the batch never blocks Bun's single thread.
- **Tri-state semantics with advisory floors**: below-min-version ⇒ _warning_ (not error); tailscale
  not-serving ⇒ _warning_ (Shepherd runs fine on loopback). An installer should treat warnings as
  "offer to fix," errors as "must fix to proceed."

**Surfaces consuming it today:**

- `GET /api/diagnostics[?refresh=1]` → `DiagnosticsSnapshot` (`src/server.ts`, ~:1873).
- Settings → **DIAGNOSE** tab renders `DiagnoseRows.svelte`, with ✓/⚠/✗ glyphs, localized hint
  text, and a **Rerun Diagnostics** button (`onretry`). Notably there is **no per-check action**
  today — the row is read-only advice (`ui/src/lib/components/DiagnoseRows.svelte:42-57`).
- TopBar **health pip** appears only when `overall !== "ok"`, tappable to open the DIAGNOSE tab
  (shipped in #623, feature-catalog id `diagnostics`).

The DIAGNOSE tab is therefore the natural host for "Fix" actions: it already enumerates exactly the
failing checks, each already carrying the `hintKey` that keys the remediation map.

---

## 3. The remediation layer (today trapped in the harness)

`ci/onboarding-harness/remediations.ts` maps `hintKey → verbatim shell command`:

```ts
export const REMEDIATIONS: Record<string, string> = {
  diagnostics_hint_bun_missing: "curl -fsSL https://bun.sh/install | bash",
  diagnostics_hint_node_missing: NODE_INSTALL, // fnm install --lts + symlink into ~/.local/bin
  diagnostics_hint_node_outdated: NODE_INSTALL,
  diagnostics_hint_herdr_missing: "curl -fsSL https://herdr.dev/install.sh | bash",
  diagnostics_hint_herdr_outdated: HERDR_INSTALL,
  diagnostics_hint_claude_missing: "curl -fsSL https://claude.ai/install.sh | bash",
  diagnostics_hint_tailscale_missing: "curl -fsSL https://tailscale.com/install.sh | sh",
};
```

Two crucial design facts are already baked in here:

1. **Only deterministically-fixable deficiencies have entries.** Interactive/secret-bearing fixes
   (`gh auth login`, `tailscale` login + `serve` setup) are _intentionally absent_ — the file's own
   header calls them "prose-only coaching … stays on the agent path." This is the exact line an
   in-app installer must respect: **never** auto-run an interactive credential flow.
2. **The map is keyed by the shipped `hintKey` contract**, so it is already 1:1 with what
   `/api/diagnostics` emits. Wiring it to the UI requires no payload change.

**The problem:** this map lives under `ci/onboarding-harness/` and imports only `DiagnosticsSnapshot`
from `src/types`. The product server cannot import _from_ the harness without inverting the
dependency direction (the harness depends on `src/`, not vice versa). So today the running app has
no access to its own fix commands. **Promoting this file to `src/remediations.ts`** (harness then
imports from `src/`) is the keystone refactor — it turns a test-only table into a shared product
asset with three consumers.

---

## 4. The proof harness de-risks the installer (`ci/onboarding-harness/`)

This is the strongest existing asset and the most under-appreciated for this purpose. The harness
(README in `ci/onboarding-harness/README.md`) already:

- Boots deliberately-messy Incus instances (herdr missing, node too old, claude missing, git
  missing, gh unauthed, tailscale missing — `scenarios.ts`).
- Runs Shepherd in degraded mode, captures `/api/diagnostics`, applies the **same** `REMEDIATIONS`
  command for `structured` scenarios (LLM-free, release-gate-eligible), or an LLM agent for `prose`
  scenarios, then **re-probes** and asserts the broken checks return to `ok`.
- Splits scenarios into **green-able** (`structured`/`prose`) vs **detection-only** (`gh-unauthed`,
  `gh-missing`, `tailscale-missing` — needs a human/secret).
- Publishes a nightly verdict (rolling GitHub issue + commit status) and gates releases
  (`onboarding-gate.sh`, `.github/workflows/onboarding-release-gate.yml`).

**Implication:** the deterministic remediation commands an installer would run are **already
continuously regression-tested on clean Linux hosts.** The `structured`/`detectionOnly` taxonomy is
_exactly_ the auto-fixable/guidance-only split an in-app installer needs — it can be lifted directly
rather than re-derived. The harness can also be extended to test a full `deploy/install.sh`
end-to-end (it already owns clean-instance provisioning) — a natural follow-up that would make the
installer itself release-gated.

---

## 5. Design — the two-surface installer

### Surface A — pre-install bootstrap (`deploy/install.sh`, `curl … | bash`)

For the cold-start case (nothing installed yet). It mirrors the very install scripts it invokes
(`bun.sh/install`, `herdr.dev/install.sh`) so it's idiomatic to users. Responsibilities:

1. Detect OS/arch; refuse politely on unsupported platforms (the membrane + harness are Linux-first;
   macOS works for the core but `bwrap` sandboxing and tailscale-serve previews differ).
2. Install missing prerequisites using the **shared remediation commands** from the same
   `src/remediations.ts` table (single source of truth for "how to install bun/node/herdr/claude").
   See "Can it be a `curl … | bash` one-liner?" below for the chicken-and-egg this raises (a piped
   script has no checkout yet, so it can't `import` the table at the moment it needs it).
3. Clone the repo to `~/Work/shepherd` (the unit's `WorkingDirectory=%h/Work/shepherd`).
4. Run the existing `deploy/update.sh` logic (deps → UI build → unit install → health check). The
   bootstrap is essentially `provision-prereqs + first-clone + update.sh`.
5. Install + enable the systemd unit (`cp deploy/shepherd.service …`, `enable-linger`,
   `enable --now`), templating `%h`-relative paths (already done by systemd specifiers).
6. Print the URL and a one-line "open Settings → DIAGNOSE to finish (gh/tailscale login)."

Constraints: it must be **idempotent** (re-runnable), must **not** clobber an existing `~/.shepherd/`
or checkout without consent, and the prereq installs are third-party `curl|bash` — which is the
status-quo trust model Shepherd already lives with, but should be surfaced honestly in the README
(the OSS-launch doc's "radical transparency" posture applies here too).

#### Can it be a `curl … | bash` one-liner?

Yes — that's the intended shape, and it's idiomatic for this project: the prereq commands the
installer runs are themselves `curl -fsSL … | bash` (bun.sh, herdr.dev, claude.ai). It works off the
raw GitHub URL on day one, no domain required:

```bash
curl -fsSL https://raw.githubusercontent.com/erwins-enkel/shepherd/main/deploy/install.sh | bash
# later, optionally, a vanity:  curl -fsSL https://shepherd.dev/install.sh | bash
```

Piping through `| bash` adds three mechanics worth designing for explicitly:

1. **Chicken-and-egg vs. the single source of truth.** A piped script has no checkout and no Bun
   yet, so it **cannot** `import src/remediations.ts` — the very table meant to be canonical. Two
   resolutions:
   - **Thin bootstrap, then hand off (recommended).** The piped script does only the minimum —
     install git + Bun, clone the repo — then runs a repo-internal `bun run install` that reads the
     shared table for everything else. One source of truth preserved; the piped part is tiny and
     rarely changes.
   - **Generate-and-inline.** Emit `install.sh` at release time from `src/remediations.ts` so the
     published script has the commands baked in. No runtime dependency, but it needs a generator
     **and** a CI sync-check, or it silently drifts — the exact rot this report warns about
     elsewhere.
2. **Interactive auth can't run inside a pipe.** With `| bash`, the script's stdin _is_ the script,
   so `claude` login, `gh auth login`, and `tailscale` login (all interactive secrets) can't prompt
   normally. Either read from `</dev/tty` when a terminal is present, or — cleaner — finish the
   non-interactive parts and print the next steps. This is the same fixable-vs-guidance-only split
   drawn in §6; nothing auto-runs a credential flow.
3. **Trust + idempotency.** It runs unconfined, as the operator's user, _before_ any sandbox exists
   — the same trust model as the bun/herdr installers, but state it honestly in the README. And it
   must be safe to re-run (never clobber an existing `~/.shepherd/` or checkout without consent).

Net: fully `curl|bash`-able, but the "one canonical command table" goal pushes toward the **thin
piped bootstrap that hands off to the cloned repo**, rather than one large standalone script kept in
sync by codegen.

### Surface B — in-app remediation in the DIAGNOSE tab (the "piggyback")

This is what the prompt is really after. The DIAGNOSE tab already lists each failing check with its
`hintKey`. The change set:

- **Server:** a new endpoint, e.g. `POST /api/diagnostics/fix` `{ checkId }`, that looks up the
  check's current `hintKey`, resolves it against `src/remediations.ts`, and — only if an entry
  exists — runs the verbatim command **server-side** as the operator's own user (same identity that
  spawns agents). It streams/returns success/failure, then forces a fresh probe (`check(now)`) and
  returns the updated snapshot. Reuse the async, timeout-bounded `execFile` discipline from
  `diagnostics.ts` — **never** `execFileSync` on the main loop (per the single-loop rule).
- **UI:** `DiagnoseRows.svelte` gains a **Fix** button on rows whose `hintKey` is in the remediation
  set, behind a confirmation that shows the **exact command** that will run (no hidden execution).
  Rows without a remediation (gh-auth, tailscale) show their existing prose hint plus a "how to fix"
  link — no button. On success, re-render from the returned snapshot; on failure, a persistent
  failure toast (stable dedupe key, per the toast house-rule) — never a silent pass.
- **Fail-closed:** a non-zero exit, empty result, or timeout renders as an explicit failure on that
  row, not a success — consistent with the repo's "fail closed" house rule.

### Single source of truth (the keystone)

```
                 src/remediations.ts  (promoted from the harness)
                 hintKey → verbatim command  +  fixable/guidance-only split
                          │
        ┌─────────────────┼──────────────────────┐
        ▼                 ▼                        ▼
 deploy/install.sh   POST /api/diagnostics/fix   ci/onboarding-harness
 (cold start)        (in-app DIAGNOSE "Fix")     (regression proof)
```

All three consumers read one table. Add a remediation once → the bootstrap, the in-app fix, and the
nightly regression gate all pick it up. This also closes a latent drift risk: today a new probe could
ship without a harness remediation and only the gate would (eventually) notice.

---

## 6. What is NOT auto-installable (must stay guidance-only)

| Check / state                   | Why not auto-fixable                                                                            | Installer behavior                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `gh` not-authenticated          | `gh auth login` is interactive (browser/device code, a secret)                                  | Guidance + link; detection-only                  |
| `tailscale` missing/not-serving | install is scriptable, but **login** + operator-grant + serve need a human + tailnet            | Install step can be auto; login/serve = guidance |
| `claude` not logged in          | subscription OAuth login is interactive; diagnostics is presence-only by design (no auth probe) | Guidance: "run `claude` and log in"              |
| Bun (in-app)                    | Shepherd runs on Bun — can't bootstrap its own runtime                                          | Pre-install script only                          |

This matches the harness's `detectionOnly` set exactly — reuse that classification rather than
inventing a parallel one.

---

## 7. Security & trust considerations

- **In-app command execution is a real escalation of the DIAGNOSE tab's authority** (read-only →
  can-run-shell). Mitigations: (a) only verbatim, table-defined commands — never free-form or
  client-supplied; (b) operator confirmation showing the exact command; (c) run as the operator's
  own user, the same trust level that already spawns agents — no new privilege; (d) the endpoint is
  a state-changing `POST`, so it sits behind the existing `checkOrigin`/CSRF + `SHEPHERD_TOKEN`
  guards.
- **Third-party `curl|bash`** for prereqs is the existing trust model (it's how bun/herdr/claude are
  installed today). Don't hide it — list the exact upstreams in the README. Consider pinning/echoing
  each command before running.
- **Egress:** the prereq installers reach `bun.sh`, `fnm.vercel.app`, `herdr.dev`, `claude.ai`,
  `tailscale.com`. The bootstrap runs _before_ the sandbox exists, so it's unconfined by nature;
  the in-app fix runs in the operator context (not inside an `autonomous` agent's egress allowlist),
  which is acceptable because it's operator-initiated, not agent-initiated.

---

## 8. Suggested phasing

1. **Keystone refactor** — move `REMEDIATIONS` + the fixable/guidance split to `src/remediations.ts`;
   point the harness at it. No behavior change; pure consolidation. (Small, low-risk, unblocks both
   surfaces.)
2. **Surface B (in-app Fix)** — `POST /api/diagnostics/fix` + DIAGNOSE "Fix" buttons. Highest
   leverage for _existing_ users finishing setup; reuses everything already on screen. Adds one
   feature-catalog entry + EN/DE keys (per repo gates).
3. **Surface A (`deploy/install.sh`)** — the cold-start `curl|bash` entry point wrapping
   prereq-provision + first-clone + `update.sh` + unit install. The OSS-launch enabler.
4. **Harness extension** — add an end-to-end "fresh host → install.sh → all green" scenario so the
   installer itself is release-gated like the individual remediations already are.

---

## 9. Open questions (need a product call)

1. **Scope of v1** — ship only Surface B (in-app Fix, finishing setup for users who already cloned),
   or also Surface A (`curl|bash` cold-start) for the OSS launch? _(Recommend B first — small,
   reuses the on-screen surface; A next as the launch lever.)_
2. **`install.sh` hosting** — committed in-repo and run via raw GitHub URL, or a vanity
   `shepherd.dev/install.sh`? (The latter matches herdr/bun/claude but needs a domain.)
3. **macOS support in v1**, or Linux-only to match the membrane + harness coverage, with macOS as
   best-effort core-only?
4. **In-app Fix confirmation depth** — single confirm-the-command dialog, or a per-command
   allowlist toggle in Settings for operators who want it gated harder?
5. Should the installer **offer** (not auto-run) the `autonomous`-profile prerequisites (`bwrap` +
   unprivileged userns) so auto-drain works out of the box, given those need distro-specific,
   sometimes privileged steps?
