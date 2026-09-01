# Sandbox security posture — accepted residuals

Internal developer/operator reference. Exempt from i18n and the feature catalog —
not app chrome.

Shepherd wraps each spawned `claude` agent in a bubblewrap (`bwrap`)
filesystem/process **membrane** with three profiles: `trusted` (no sandbox, the
default), `standard` (membrane, interactive-only) and `autonomous` (membrane +
per-spawn network-egress firewall; required for `auto=true` drain/autopilot).
The egress firewall (slirp4netns + nftables + dnsmasq, shipped in **PR #601**,
closed **#551** — `src/egress.ts`) confines outbound traffic to
`api.anthropic.com` + `statsig.anthropic.com` + the GitHub hosts, and watches
for DNS drops. Egress is keyed to the **autonomous profile**, not to
attendedness (`src/sandbox.ts` `egressApplies`).

This note records two residuals the operator has **accepted** after the audit.

## R3 — in-membrane token readability (accepted)

The membrane keeps two token surfaces readable to any in-membrane tool call
(`buildMembraneFlags`, `src/sandbox.ts`):

- `~/.claude/.credentials.json` — bound **RW** so OAuth refresh writes back
  (`--bind-try`); the whole `~/.claude` dir is `--ro-bind`ed. **In api-key mode**
  (`maskCredentials`) this is different: the config dir is mounted with a `--dir`
  mount point plus per-child RO binds that omit `.credentials.json`
  (`maskedClaudeDirBinds`), and there is no credential bind of any kind — the
  OAuth token is **genuinely absent** inside the membrane, not an empty overlay.
  The api-key helper script is instead bound RO at its own path so the
  `apiKeyHelper` settings entry resolves inside the sandbox.
- `~/.config/gh` — bound **RO** (the gh token, needed to `git push` /
  `gh pr create`).

`--clearenv` strips **all** inherited env
(`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`, `SHEPHERD_TOKEN`,
…), re-setting only HOME/PATH/TERM + non-secret locale vars — so these two
**bound files** are the only token surfaces left inside the membrane.

**Why accepted.** A single-uid `bwrap` membrane has no privilege boundary
between `claude` and its own tool calls: any file `claude` reads to authenticate,
an injected tool call can also read. So the tokens the session legitimately needs
stay reachable by a hijacked agent.

**Out of scope, not impossible.** A narrowing _is_ technically conceivable — e.g.
a nested sub-membrane for the Bash tool that omits the credentials bind, so
`claude` reads the OAuth token only at startup and tool calls can't. It was not
pursued: significant nesting complexity, and a full external **broker**
(intercepting/spoofing `claude`'s auth to `api.anthropic.com`) would edge into
the prohibited "third-party harness piloting the account" conduct (audit R6) and
break the unmodified-CLI + subscription-OAuth-refresh stance.

**Compensating controls.** On the autonomous profile the egress allowlist
(#601) bounds **where** a leaked token can go; `--clearenv` keeps env-resident
secrets out of the membrane entirely.

## Attended-mode egress coverage

Egress confinement is keyed to the autonomous **profile**, not to whether a human
is watching (`willEgressConfine`, `src/sandbox.ts`; applied in
`src/service.ts`): the wrap applies iff the autonomous profile resolves
**and** the fs + egress backends are present, independent of `ctx.auto`.
Consequences:

- An **attended** session on the autonomous profile **is** egress-confined (with
  an egress-degraded banner if the backend is missing).
- The default `trusted` profile and `standard` are **filesystem-confined only**,
  never network-confined.

To get attended network confinement, select the **autonomous** profile — per-repo
in the repo's Settings panel, or globally via `SHEPHERD_SANDBOX_DEFAULT_PROFILE`.

## Launch probe — the membrane is proven, the launcher is not (#2111)

`detectBackend` (`src/sandbox.ts`) answers "can bwrap build a sandbox here" by
running `node --version && git --version` through the real derived membrane. It
never launches `claude`/`codex`, and must not: `null` means **run unconfined**, so
folding a launcher fault into that verdict would strip the membrane from around
untrusted plan text on the very hosts that can sandbox.

`src/membrane-launch.ts` is the second, orthogonal signal — "does the agent binary
actually start inside the membrane". Its failure is **loud** (a `sandbox_membrane`
DIAGNOSE row) and **blocking** (`resolveAuxPatch` returns a `SpawnRefusal` with the
`membrane-launch` sentinel, per binary), never a change to whether the membrane is
applied. Fail-open by construction: only a **non-zero exit** counts as `broken`; a
probe that throws or times out is `uninspectable` and spawns proceed. The launcher's
output is the whole diagnosis but carries absolute host paths, so it is logged and
never placed in a diagnostics or UI payload. The plan gate persists a visible error
gate carrying that sentinel instead of skipping silently; the PR critic carries the
same code.

The row and the refusal share one cache, so they can never disagree; the DIAGNOSE
read probes fresh, so a repaired toolchain un-blocks wrapped roles as soon as the row
goes green.

## R4 — prompt-injection posture

**Input-side defenses (prompt-injection-hardening pass).** Before any of the
execution controls below, Shepherd bounds the injection surface at ingestion
(`src/untrusted.ts`, `src/service.ts`):

- **Untrusted-content fencing.** External text an agent or helper LLM might read —
  issue title/body, issue comments, PR bodies + author-notes, captured terminal
  tails, and the recap/rundown context — is wrapped in unforgeable `⟦UNTRUSTED:…⟧`
  markers (`fenceUntrusted`, with a per-fence random nonce that the content cannot
  predict or close early) so the model treats it as **data, never instructions**.
  The fence carries its **label and nonce only**; the instruction hierarchy has one
  home, `UNTRUSTED_CONTENT_DIRECTIVE`, which every prompt that fences states exactly
  once — session spawns get it as the standing `<untrusted-content-boundary>` block
  (`composeSystemPromptBlocks`), and each aux prompt builder emits it itself. That
  invariant is pinned by `test/untrusted.test.ts`: a builder that fences without the
  directive fails there.
- **Fail-closed author-trust gate.** An **autonomous** (`auto=true`) spawn from an
  issue whose author is **not** a trusted repo association (`OWNER` / `MEMBER` /
  `COLLABORATOR` — anything else, including an unresolvable, absent, or Gitea-side
  association, fails closed) is refused before any worktree is created
  (`assertIssueAuthorTrusted` → `UntrustedIssueAuthorError`). It records an
  `untrusted_author` signal and toasts the operator (`repo:untrusted-author`) —
  once per `(repo, issue)` per process, so a stuck issue's drain retries don't grow
  the signal store. Operator-initiated creates are unaffected — a human can still
  start such an issue manually if they trust it. On forges that structurally can't
  supply a GitHub-style association (non-GitHub — Gitea/local), autonomous drain
  would otherwise be silently disabled; an operator can opt back in with
  `SHEPHERD_TRUST_ISSUE_AUTHORS=1` (scoped to non-GitHub — a GitHub miss or
  untrusted author still refuses).
- **Advisory injection scan.** Issue content is scanned against a conservative
  signature set (`scanForInjection`); a hit is **advisory only** — it records an
  `injection_detected` signal and toasts the operator to eyeball the session, but
  never blocks the spawn.

These are content-boundary defenses; the execution-confinement residuals below
still stand.

- **A `PreToolUse` tool guard denies two hazards at the call site** on Claude
  spawns (`scripts/tool-guard.mjs`, wired by `src/tool-guard-hook.ts`,
  `config.toolGuard` / `SHEPHERD_TOOL_GUARD`): a bare `git stash` against the
  shared `refs/stash` stack, and a worktree-add or dependency install under a
  tmpfs root. It is a **local `command` hook**, not the fail-open HTTP ingest
  transport, precisely so the deny still holds for unattended sessions whose
  `--clearenv` membrane 401s the restricted ingress. Its script is bound RO into
  the membrane (`agentSupportPaths` → `agentSupportFlags`, `src/sandbox.ts`),
  because the decision to drop the equivalent prompt notices is taken host-side —
  a guard missing inside the sandbox would leave that session with neither.
- **Autonomous task agents** run `--dangerously-skip-permissions`, but behind
  **both** the filesystem and the egress membrane. `standard` auto-spawns are
  refused outright (`src/sandbox.ts` `autoHoldReason`).
- **Unattended reviewers** (PR critic + plan-gate) run **read-only**, not
  skip-permissions: `--safe-mode --disable-slash-commands --allowedTools Read
Grep Glob Bash(git diff *) Bash(git log *) Bash(git show *) Bash(git status)
Write --permission-mode dontAsk` (`src/transient-agent-argv.ts`,
  `buildTransientAgentArgv("reviewer", …)`).
- **Research is the deliberately egress-UNCONFINED surface.** A research session
  that would resolve to `autonomous` is **downgraded to `standard`**
  (`src/service.ts` `researchSafeProfileOverride`, warns once),
  because research needs **open** web egress (search/fetch + sub-agents) that the
  autonomous firewall would block. The same downgrade applies to an
  **epic-authoring** session (`input.epicAuthoring`, #1507), which likewise needs
  open web/repo egress to shape a draft — though unlike research it creates **no
  GitHub issues itself**: the hard write-gate is that only the server-side approve
  route materializes the draft. It is operator-_created_ (cannot be
  auto-drained — `standard` refuses auto-spawn) but **autopilot-steerable, so it
  runs unattended in practice** (`RESEARCH_PROCEED_STEER`,
  `src/autopilot.ts`, dispatched from the steer loop). It ingests **untrusted web**
  content on `trusted`/`standard` with the **network open**, and can
  `gh pr create` / open issues via the bound gh token — so a hijacked research
  agent has **both** readable tokens **and** open egress.

  **Compensating factors:** the downgrade is explicit and warns once; research
  delivers a **report PR or GitHub issue only, never a code PR**
  (`RESEARCH_PROCEED_STEER`, `src/autopilot.ts`). The residual is **accepted**.

## See also

- `src/egress.ts`, `src/sandbox.ts`, `src/service.ts`, `src/autopilot.ts`,
  `src/transient-agent-argv.ts`, `src/untrusted.ts`, `src/tool-guard-hook.ts`,
  `scripts/tool-guard.mjs`.
