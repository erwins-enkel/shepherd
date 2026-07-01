# Going public — pre-flip checklist

One-time hardening runbook for flipping `erwins-enkel/shepherd` from **private → public**.
Work top-down: clear the **Blocker** and **High** items (and make the two go/no-go
decisions) before flipping; **Medium** / **Nice-to-have** can follow. Derived from the
pre-public audit on 2026-07-01. Each box is an action or an explicit decision — check it
when done, not when read.

## 🔴 Blocker — must be done before the repo is public

- [ ] **Tear down the self-hosted CI runners.** A self-hosted runner on a public repo
      runs **fork-PR code on the host, beside production** — remote code execution by any
      stranger. Making the repo public does **not** disarm this: the runners stay
      registered and `CI_RUNNER` stays set until you remove them. Follow the ordered
      "MANDATORY public-repo cutover" checklist in
      [`ci/self-hosted-runner/README.md`](../ci/self-hosted-runner/README.md)
      (validate hosted CI green → deregister every runner → verify `CI_RUNNER` gone and
      `actions/runners` count is 0 → **only then** flip). Standard GitHub-hosted runners
      are free and unlimited on public repos, so there's no cost reason to keep them.

## 🟠 High — do before flip

- [ ] **Enable the free security features** (all currently disabled). Settings → Code
      security: **secret scanning**, **push protection**, **Dependabot alerts**. Push
      protection is the safety net against a future accidental secret commit.
- [x] **Add a `SECURITY.md`** vulnerability-disclosure policy — added in this PR (points at
      GitHub Private Vulnerability Reporting; enabling that feature is a settings step below).
- [x] **Fix the required-check bypass.** `ci.yml`, `pr-hygiene.yml`, `pr-title.yml` skipped
      their gate jobs on `startsWith(github.head_ref, 'release-please--')` — a fork-controlled
      branch name, so a fork PR branched `release-please--x` skipped **all** CI while still
      reporting the required checks satisfied (skipped == passing). Fixed in this PR: the skip
      now also requires the release-bot **identity**, which a fork can't spoof.
- [x] **Candid internal research docs removed.** Seven `docs/research/` notes (the ToS-position,
      compliance-audit, account-integration and launch-strategy cluster, plus three borderline
      spikes) are deleted from the tree in this PR, and their inbound links + the sharper ToS
      framing in `README.md` / `PRD.md` / `PRODUCT.md` / `docs/sandbox-security.md` are softened
      to the design-stance level. **Operator step:** run the history scrub (`git filter-repo`)
      per the runbook so the files leave git history too, then force-push — do this **while
      still private**. See the PR description for the exact commands.

## 🟡 Medium — soon after flip

- [ ] **DECISION — forking.** `allow_forking` is currently `false`, which blocks all
      outside PRs. Enable it if you want real external contribution (and only after the
      runner teardown above).
- [x] **Add `permissions: { contents: read }`** to `pr-hygiene.yml` — done in this PR.
- [x] **SHA-pin third-party actions** — `oven-sh/setup-bun`, `googleapis/release-please-action`,
      `actions/create-github-app-token` pinned to commit SHAs (with version comments) in this PR.
      First-party `actions/checkout` + `actions/cache` left on major tags (Dependabot-managed).
- [ ] **Tighten PR-merge gating.** The `main` ruleset requires **0** approving reviews,
      Actions **can approve PRs**, and there's no `CODEOWNERS`. Consider ≥1 required review
      for outside contributions and disabling Actions PR approval.
- [ ] **Add protection rules to the `Production` environments** (currently 0 — no required
      reviewers on deploy).

## 🟢 Nice-to-have

- [ ] Add `CODE_OF_CONDUCT.md`, a `PULL_REQUEST_TEMPLATE`, and `CODEOWNERS`.
- [ ] Strip maintainer local paths (`/home/patrick/Work/...`) from tracked planning docs
      under `docs/superpowers/` and `docs/research/` (cosmetic username leak).
- [ ] Review internal-spend figures in `docs/token-usage-analysis.md` before they're public.
- [ ] Route `github.base_ref` through `env:` in `ci.yml` (single spot that interpolates
      event data into a `run:` shell step; low risk, consistency only).

## ✅ Confirmed clean at audit time (no action)

- No secrets in the working tree or across all 418 commits; `.gitignore` thorough.
- Server binds loopback by default; auth is solid (argon2id + HMAC-signed cookies);
  command execution is `execFile`-first with no user-input-into-shell paths.
- No `pull_request_target`; the one `workflow_run` (doc-automerge) is fork/association
  gated and never executes PR code.
