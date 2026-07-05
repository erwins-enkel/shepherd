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
attendedness (`src/sandbox.ts` `egressApplies`, ~L554).

This note records two residuals the operator has **accepted** after the audit.

## R3 — in-membrane token readability (accepted)

The membrane keeps two token surfaces readable to any in-membrane tool call:

- `~/.claude/.credentials.json` — bound **RW** so OAuth refresh writes back
  (`src/sandbox.ts:315-317`, `--bind-try`); the whole `~/.claude` dir is
  `--ro-bind`ed at `src/sandbox.ts:308-310`.
- `~/.config/gh` — bound **RO** (the gh token, needed to `git push` /
  `gh pr create`) at `src/sandbox.ts:413`.

`--clearenv` (`src/sandbox.ts:438`) strips **all** inherited env
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
is watching (`willEgressConfine`, `src/sandbox.ts:565-570`; applied at
`src/service.ts:1661`): the wrap applies iff the autonomous profile resolves
**and** the fs + egress backends are present, independent of `ctx.auto`.
Consequences:

- An **attended** session on the autonomous profile **is** egress-confined (with
  an egress-degraded banner if the backend is missing).
- The default `trusted` profile and `standard` are **filesystem-confined only**,
  never network-confined.

To get attended network confinement, select the **autonomous** profile — per-repo
in the repo's Settings panel, or globally via `SHEPHERD_SANDBOX_DEFAULT_PROFILE`.

## R4 — prompt-injection posture

- **Autonomous task agents** run `--dangerously-skip-permissions`, but behind
  **both** the filesystem and the egress membrane. `standard` auto-spawns are
  refused outright (`src/sandbox.ts` `autoHoldReason`, ~L501-502).
- **Unattended reviewers** (PR critic + plan-gate) run **read-only**, not
  skip-permissions: `--safe-mode --disable-slash-commands --allowedTools Read
Grep Glob Bash(git diff *) Bash(git log *) Bash(git show *) Bash(git status)
Write --permission-mode dontAsk` (`src/transient-agent-argv.ts`,
  `buildTransientAgentArgv("reviewer", …)`).
- **Research is the deliberately egress-UNCONFINED surface.** A research session
  that would resolve to `autonomous` is **downgraded to `standard`**
  (`src/service.ts` `researchSafeProfileOverride`, ~L2153-2171, warns once),
  because research needs **open** web egress (search/fetch + sub-agents) that the
  autonomous firewall would block. It is operator-_created_ (cannot be
  auto-drained — `standard` refuses auto-spawn) but **autopilot-steerable, so it
  runs unattended in practice** (`RESEARCH_PROCEED_STEER`,
  `src/autopilot.ts:24-29`, dispatched at L307). It ingests **untrusted web**
  content on `trusted`/`standard` with the **network open**, and can
  `gh pr create` / open issues via the bound gh token — so a hijacked research
  agent has **both** readable tokens **and** open egress.

  **Compensating factors:** the downgrade is explicit and warns once; research
  delivers a **report PR or GitHub issue only, never a code PR**
  (`src/autopilot.ts:309-313`). The residual is **accepted**.

## See also

- `src/egress.ts`, `src/sandbox.ts`, `src/service.ts`, `src/autopilot.ts`,
  `src/transient-agent-argv.ts`.
