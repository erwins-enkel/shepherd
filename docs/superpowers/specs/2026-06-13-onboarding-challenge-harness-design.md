# Onboarding Challenge & Regression Harness — Design

**Date:** 2026-06-13
**Status:** Approved (brainstorm) — pending spec review
**Topic:** A throw-away-environment harness that boots deliberately-messy machines, turns real Shepherd loose to self-diagnose & coach the local user to a healthy host, scores how well it copes, and locks that in as a regression guard for the OSS-launch onboarding experience.

## Why

Shepherd is heading for an open-source launch. A new user's first experience must not be merely documentation-bound — Shepherd should **intelligently coach** a messy machine to a working state. Today that coaching is `diagnostics.ts` (detect a host defect → surface a prose `hintKey`) and `readiness.ts` (static target-repo guardrail scoring). Neither is regression-tested against the divergent, broken environments real users actually have.

This framework **discovers where onboarding fails today** (the primary deliverable) and then **locks in a regression guard** so coping with divergent setups does not silently regress.

## Scope & decisions (locked during brainstorm)

- **Deliverable:** discover onboarding gaps today **and** guard against regressions (not building a new coach — testing/hardening the existing one and reporting its gaps).
- **Topology:** *in-VM degraded self-heal* — Shepherd runs **inside** the messy environment, boots in a degraded-but-running mode, self-diagnoses via its own checks, and coaches the local user.
- **Isolation primitive:** **Incus** (already on the host). **System containers** are the default tier (real `systemd`, real `tailscaled`+TUN, full distro userland — unlike single-process Docker app containers); **Incus VMs** are reserved per-scenario for kernel/arch fidelity. One CLI/API for both; snapshots give instant throw-away reset.
- **Success signal:** *detect → apply → re-probe green*. A scenario passes only if the environment actually reaches a healthy state after Shepherd's coaching is applied — proving advice is correct, not merely present.
- **Apply mechanism:** **both** — run a **structured remediation verbatim** where the check provides one; fall back to an **agent interpreting prose coaching** otherwise.
- **Finish line:** **host green** — Shepherd boots and all 7 diagnostic checks pass. Target-repo readiness coaching and "first agent launches" are explicitly **out of scope** (separate, already-shipped or future surfaces).
- **Cadence/location:** **manual + nightly + pre-release gate**, on the self-hosted **Incus host**. **Never per-PR.**

### The bootstrap-paradox boundary

Shepherd is a Bun app: if `bun` is entirely absent it cannot boot to coach anyone. Therefore:

- Every core scenario's **baseline image already has the bun runtime** (the one true prereq). Defects are layered **on top** of a bootable Shepherd: `gh` missing/unauthed, `tailscale` missing/not-serving, `herdr` missing, `claude` missing, `git` missing, and **too-old** `bun`/`node`/`herdr` (Shepherd boots and warns).
- The **truly-cold "bun absent" cold-start** is the only path Shepherd-in-VM cannot self-heal. It is scoped to the **agent-bootstrap path** (a Claude Code agent following install docs stands Shepherd up) as a **Phase 2 stretch scenario class**, not the Phase 1 core matrix.

## Detection signal (grounded)

The harness reads `GET /api/diagnostics?refresh=1` (Shepherd's loopback HTTP API, already serving the HUD) inside each instance. The returned `DiagnosticsSnapshot` lists each check with its `id`, `state` (`ok`/`warning`/`error`), and `hintKey`. This is the structured detection signal asserted against each scenario's expectations.

The 7 checks (from `src/diagnostics.ts`): `bun`, `node`, `claude`, `gh`, `git`, `herdr`, `tailscale` — each with missing / too-old / not-authenticated / not-serving / ok states.

## Architecture

Code lives in **`ci/onboarding-harness/`** (Bun + TS), a sibling of the existing `ci/self-hosted-runner/`. It is an ops/test harness, **not** part of the shipped server runtime. Six small, independently-testable units:

1. **Incus driver** — thin wrapper over the `incus` CLI: `launch(image, profile)`, `exec`, `push`/`pull`, `snapshot`/`restore`, `delete`. Instances are ephemeral and deleted on teardown; resource caps applied via a dedicated Incus profile. System containers by default; a scenario opts into a VM with `type: "vm"`.
2. **Scenario catalog** — declarative TS records. Each scenario: `id`; `image` (ubuntu/debian/alpine/arch/fedora); optional `vm: true`; `seed` (commands that diverge/break the env); `expect` (the checks that must flag and their expected `state`); and `coaching` kind (`structured` | `prose`) selecting the apply path.
3. **Seed engine** — launches a fresh instance, installs the bootable-Shepherd baseline, then runs the scenario's `seed` steps to produce the messy state.
4. **Probe + assert (detection)** — boots Shepherd in the instance, polls `GET /api/diagnostics?refresh=1`, and asserts the snapshot matches `expect`. This is the first source of gap findings (defect missed or mis-classified).
5. **Apply engine** — two paths, chosen per scenario `coaching` kind:
   - **Verbatim:** runs the command from the **harness-side remediation catalog** (Phase 2 `ci/onboarding-harness/remediations.ts`, keyed by the `hintKey` Shepherd emits) exactly as written. Deterministic, LLM-free. No change to the shipped diagnostics payload (revised per plan review — keeps the `DiagnosticCheck` exact-keys purity contract intact).
   - **Agent:** spawns a fresh Claude Code agent given **only** what a real user sees (the diagnostics snapshot + prose coaching) and lets it drive the env to green — a proxy-user UX test. Non-deterministic; LLM cost.
6. **Re-probe + report** — re-runs diagnostics; the scenario passes only when all checks are green. Emits a **markdown gap report**: per scenario — detected? advice present? advice actually fixed it? — plus an agent-transcript reference for prose cases.

### Unit boundaries

- The **Incus driver** knows nothing about scenarios or diagnostics — pure instance lifecycle over the `incus` CLI.
- The **scenario catalog** is pure data; adding a scenario never touches engine code.
- The **apply engine's** two paths share a `(snapshot, instance) → result` interface so the orchestrator treats them uniformly.
- **Shepherd's job stays detect+advise**; the harness (not Shepherd) orchestrates the apply. The agent in the agent-path is a *harness* proxy-user, not a Shepherd-spawned agent.

## Phasing

### Phase 1 — gap-report MVP (the primary deliverable)
Units 1–4 + 5(**agent path**) + 6, run **manually**. Tests *current* Shepherd with **no product change** (all coaching is prose today), and produces the "where onboarding fails today" report. Covers ≥1 scenario per relevant check×state plus distro spread.

### Phase 2 — deterministic regression tier
- Add a **harness-side remediation catalog** (`ci/onboarding-harness/remediations.ts`) mapping each command-fixable `hintKey` to a verbatim shell command. **No `src/` product change** (revised per plan review): the shipped `DiagnosticCheck` payload is untouched, so the exact-keys purity contract holds and there is no hidden, undiscoverable field. A user-facing "click-to-fix" feature, if ever wanted, is a separate spec.
- Build the **verbatim apply path** against it → a fast, deterministic, LLM-free regression subset.
- Wire **nightly** (existing scheduler) + **pre-release gate** (required-green before the OSS tag) on the Incus host.

## Scenario matrix (backbone)

Derived from the 7 checks × their states, across the distro spread. Representative (not exhaustive) Phase 1 set:

| Scenario | Image | Seed (messy state) | Expect | Coaching path |
| --- | --- | --- | --- | --- |
| `gh-unauthed` | ubuntu | `gh` installed, not logged in | `gh: error/warning` (not-authenticated) | prose (agent) |
| `gh-missing` | debian | `gh` absent | `gh: error` (missing) | structured (P2) / prose |
| `tailscale-missing` | ubuntu | no tailscale | `tailscale: error` | structured (P2) / prose |
| `tailscale-not-serving` | ubuntu (sys container, TUN) | tailscaled up, not serving | `tailscale: warning` | prose (agent) |
| `herdr-missing` | arch | no herdr | `herdr: error` | structured (P2) / prose |
| `claude-missing` | fedora | no claude CLI | `claude: error` | structured (P2) / prose |
| `git-missing` | alpine | no git | `git: error` | structured (P2) / prose |
| `bun-too-old` | ubuntu | bun < `BUN_MIN_VERSION` | `bun: warning` | structured (P2) / prose |
| `node-too-old` | debian | node < `NODE_MIN_VERSION` | `node: warning` | structured (P2) / prose |
| `herdr-too-old` | ubuntu | herdr < `HERDR_MIN_VERSION` | `herdr: warning` | structured (P2) / prose |
| *(Phase 2 stretch)* `cold-bun-absent` | ubuntu (bare) | no bun at all | Shepherd can't boot | agent-bootstrap |

Additional divergence axes to fold in opportunistically (confirmed in scope as future scenarios, not blocking Phase 1): corrupted/short `PATH`, root-vs-nonroot user, restricted-egress / proxied networks.

## Risks & mitigations

- **Incus-in-CI:** requires the self-hosted Incus host; not portable to GitHub cloud runners — acceptable, matches the manual/nightly/pre-release cadence.
- **tailscaled in a system container:** needs TUN + `security.nesting`; the not-serving scenario may use a fake/loopback tailnet rather than a real login. Prototype this path **first** to de-risk.
- **Agent-path flakiness/cost:** non-deterministic and token-spending; kept off the per-PR path. The release gate relies on the **deterministic verbatim subset**, with agent-path scenarios reported but not gating.
- **claude OAuth in a throw-away instance:** the agent path needs auth — provisioned via a mounted credential/secret, never interactive login.
- **Snapshot/teardown leaks:** every instance is created from a profile with caps and force-deleted in a `finally`; a sweep step reaps orphaned harness instances by name prefix at start.

## Success criteria

1. The harness provisions ≥1 scenario per relevant check×state from the catalog on Incus, boots degraded Shepherd, captures the diagnostics snapshot, applies coaching (verbatim or agent), re-probes, and emits a gap report — runnable via `bun run onboarding:test [--scenario <id>]`.
2. Detection assertions correctly flag both matches and gaps (a deliberately-broken expectation fails the scenario).
3. Phase 2 adds a deterministic verbatim subset that green-gates a release, wired to nightly + pre-release.
4. All harness instances are torn down (no leaked Incus instances) after a full run, including on failure.

## Out of scope

**Brokenness scope (user-signed-off):** "various states of brokenness" is intentionally scoped to exactly what `diagnostics.ts` can detect today — the 7 checks × their states. The gap report is honestly bounded to detectable states; the harness is built so these can be added later as Shepherd's detection grows. Explicitly **deferred** (not v1):

- Corrupted / locked git repos, port-already-in-use, partial/half-installed herdr state, no network / DNS failure, full disk, broken git worktrees.
- Building a new/LLM onboarding coach (we test and report on the existing detect+advise layer).
- Target-repo readiness coaching (`readiness.ts`) and "first agent launches" finish lines.
- Per-PR execution; macOS/Windows hosts; ARM via emulation.
