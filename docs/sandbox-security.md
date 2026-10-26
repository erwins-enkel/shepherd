# Sandbox security posture — accepted residuals

Internal developer/operator reference. Exempt from i18n and the feature catalog —
not app chrome.

Shepherd wraps each spawned `claude` agent in a bubblewrap (`bwrap`)
filesystem/process **membrane** with three profiles: `trusted` (no sandbox),
`standard` (membrane, interactive-only — the default since #2100 wherever the bwrap
self-test passes; hosts without a backend fall back to `trusted`) and `autonomous`
(membrane + per-spawn network-egress firewall; the confined choice for `auto=true`
drain/autopilot). A repo set to **Default** (`inherit`) follows
`SHEPHERD_SANDBOX_DEFAULT_PROFILE` when set, else that built-in default; repos with
sessions from before #2100 were pinned to `trusted` once on upgrade.
The egress firewall (slirp4netns + nftables + dnsmasq, shipped in **PR #601**,
closed **#551** — `src/egress.ts`) confines outbound traffic to
`api.anthropic.com` + `statsig.anthropic.com` + the GitHub hosts, and watches
for DNS drops. Egress is keyed to the **autonomous profile**, not to
attendedness (`src/sandbox.ts` `egressApplies`).
The toolchain is bound read-only: node's bin dir and the server's own bun
(`config.bunBin`, #3351) land on the membrane PATH. Under `autonomous`,
`bun install` still fails, since no package registry is an egress host.

This note records two residuals the operator has **accepted** after the audit.

## Per-spawn overrides from access tokens (audit run-2 R2-F07)

A per-spawn `sandboxProfile`, an explicit `agentProvider: "codex"` (always
`trusted`) and the research / epic-authoring / bootstrap downgrade can loosen a
spawn below its repo's profile. Only the operator cookie and `full` tokens may do
that. A minted token below `full` may only tighten: `tokenProfileError`
(`src/server.ts`) compares `SessionService.spawnProfile` with
`repoEffectiveProfile` on the create, held-task edit and held-task spawn paths,
before any hold or spawn. A create forwarded to another machine
(`tokenRemoteProfileError`) cannot see that machine's repo profile, so a token
below `full` may only omit the override or ask for `autonomous` there. Held tasks
released by the server itself carry an input already checked when they were held.

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
  `gh pr create`). **Task sessions only.** When the host keeps the token in the
  OS keyring (`hosts.yml` has no `oauth_token`), the membrane cannot reach it (no
  D-Bus, `--clearenv`), so `prepareMembraneGhHosts` (`src/membrane-state.ts`)
  reads it host-side with `gh auth token` and writes a per-spawn 0600 github.com
  `hosts.yml` bound RO over the host file — the same readability as a file-stored
  token.

Not a token surface: task sessions also get a derived mise config
(`prepareMembraneMiseConfig`) bound RO at `/tmp/.shepherd-mise/config.toml` and
named by `MISE_SYSTEM_CONFIG_FILE`. `--tmpfs $HOME` hides the host global config,
and a mise-launched `claude` would otherwise strip every mise install dir (bun,
node, gh) from PATH. It holds only the host's string-valued `[tools]` plus the
membrane's node/bun pinned to their install versions — never `[env]`,
`[settings]`, `[hooks]` or `[tasks]`; the host `~/.config/mise` is never bound.

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

## Reviewer roles (audit N10)

The critic, the standalone PR critic, the plan-gate reviewer and the maintain
diagnosis read untrusted input and hand a verdict or draft back to the server,
which does all forge writes. They get a narrower membrane
(`MembraneInputs.reviewer`, chosen by `reviewerMembraneKind` in
`src/spawn-membrane.ts`): no `~/.gitconfig` and no `~/.config/gh` bind, and the
git common dir bound **RO**. The doc agent and plugin agents keep the task-session
membrane.

With no sandbox backend, nothing confines a role. The standalone critic then
**refuses fork PRs** (`isCrossRepository`; logged once per head). Same-repo PRs,
the session critic, the plan gate and maintain still run unconfined there, an
operator-accepted narrowing that keeps critics working on hosts without `bwrap`.

The `reviewer` and `doc` allowlists' `Bash(git diff|log|show *)` prefixes admit
any trailing option, so both kinds also pass `--disallowedTools` deny rules for
`--output`, `--ext-diff` and `--textconv` (`READONLY_GIT_DENY` in
`src/transient-agent-argv.ts`, audit N12). Deny beats allow. This is
defense-in-depth for the unconfined case: the rules match the command string,
so a shell-quoted spelling may slip past.

Everything these roles post or file (review body, post-merge comment, maintain
issue title/body) passes through `redactSecretText` first.

**Residual: credentials RW.** `.credentials.json` stays bound RW and `CODEX_HOME`
stays RW for every membrane. A read-only or per-membrane copy breaks
refresh-token rotation: the first in-membrane refresh rotates the token and
strands the host copy. Closing it needs a host-brokered refresh, which is not
built.

## Agent-ingress key (#3337)

The agent-ingress listener is exempt from the operator's auth gate. A session's
UUID rides argv and env that any local user can read from `/proc`, so it is not
the capability. Every ingress call must carry
`X-Shepherd-Ingress-Key: HMAC(key, sessionId)` (`ingressKeyAllowed`,
`src/server.ts`). The key file is `~/.shepherd/assistant-ingress.key`. A missing
or broken key file means every call is refused. The `browser` route is exempt:
it has its own HMAC `?token=`. An archived session's key is refused (#3370), so
a leaked key cannot outlive its session.

- **Claude:** `--settings` (hook headers) and `--mcp-config` reach claude as
  paths to 0600 files in `~/.shepherd/agent-spawn/` (the Operator Assistant uses
  `assistant-spawn/`), never as argv JSON. Rewritten on every spawn and resume,
  removed on archive.
- **Codex and agent skills:** `SHEPHERD_INGRESS_HEADER_FILE` names the 0600
  `<id>.header` file holding the full `x-shepherd-ingress-key: <key>` line. The
  curl directives send `-H @"$SHEPHERD_INGRESS_HEADER_FILE"`: curl reads the
  file itself, so only its path reaches argv (#3370). An agent skill calling the
  ingress (for example video-brief's self-rename) must do the same.
  `SHEPHERD_INGRESS_KEY_FILE` (the bare `<id>.key`) stays for older skills;
  never expand it into a command line.
- **Membrane:** a sandboxed session gets only its own four files, RO-bound.
- **Upgrade (#3341):** a session spawned without the current key carries none:
  pre-#3339, a rotated key file, or an older spawn-file version
  (`INGRESS_SPAWN_VERSION`). Each Claude spawn and resume records an
  `ingressStamp` (version + key fingerprint). The 15s connector-restart sweep
  force-resumes a live Claude task session whose stamp is stale once it has
  settled (idle/done ≥15s). Until then its hooks fall back to polling and its
  MCP tools fail. There is no keyless transition window. **Codex sessions and
  the Operator Assistant are not auto-resumed.** A Codex resume does not re-send
  its curl directives, and the Assistant has its own relaunch. Both need a
  manual relaunch.

## Operator Assistant approvals

An assistant action in an **Ask first** group runs only after the operator
approves that exact call (`src/action-request.ts`). The approval covers the tool,
its arguments and any state the server captured when it built the call.

- **Merges are bound to a revision.** `pr_merge` captures the PR's number, head
  commit and base branch from the cached PR state. The approval card shows them,
  and the merge sends them as its confirmation, like the HUD Merge button. If the
  head or base moved, the route refuses with `merge_confirm_stale`, and the forge
  also refuses a moved head. A new head needs a new approval. Without a cached
  head, the merge is refused.
- **Approvals expire.** An unanswered request expires after 10 minutes. An
  approval that no waiting call received is replayed to the next identical call
  only within 2 minutes.

## Shared Claude state and agent-written files

The membrane never binds Claude state that **unconfined** sessions (trusted
profile, the operator's own `claude`) execute or read as instructions writable
(`buildMembraneFlags`, `src/membrane-state.ts`):

- **`.claude.json`** — each spawn gets a private copy (seeded with trust for its
  cwd) under `$XDG_RUNTIME_DIR/shepherd/membrane/<session>/`, bound RW in place of
  the file Claude reads. Writes (onboarding, trust, `mcpServers`) die with the
  copy; nothing is merged back. Callers without a copy (launch/egress probes,
  preview) see the host file **RO**. One copy per session plus one per aux role
  kind (under the parent session, or a shared `aux/` dir for parentless roles),
  overwritten on each spawn; removed at the session's archive and swept at boot.
- **`shell-snapshots/`, `todos/`, `statsig/`** — per-membrane tmpfs.
- **`projects/`** — RO; only the spawn's own transcript dir
  (`projects/<dashified cwd>`) is RW, with its `memory/` RO.
- **Preview** — `<git-common-dir>/shepherd/preview-start.sh` is authored by a
  session agent on request. Only an unconfined session can write it, because
  `shepherd/` is read-only inside the membrane. A confined session without a
  script gets the plain start steer instead. The script
  runs inside the membrane with `--clearenv` (credentials masked) whenever the
  repo's resolved profile or the session's applied profile is sandboxed
  (`SessionService.previewLaunch`). **Residual:** it keeps host networking so the
  preview proxy can reach the dev server, so an autonomous repo's preview is not
  behind the egress firewall.
- **Relaunch uploads** — the server carries only regular, non-symlink files from
  a real `.shepherd-uploads` dir, and refuses to upload through a symlinked one.

## Attended-mode egress coverage

Egress confinement is keyed to the autonomous **profile**, not to whether a human
is watching (`willEgressConfine`, `src/sandbox.ts`; applied in
`src/service.ts`): the wrap applies iff the autonomous profile resolves
**and** the fs + egress backends are present, independent of `ctx.auto`.
Consequences:

- An **attended** session on the autonomous profile **is** egress-confined (with
  an egress-degraded banner if the backend is missing).
- `standard` (the default) is **filesystem-confined only**, never
  network-confined; `trusted` is not confined at all.

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
  tails, the recap context, and the changed-view-file markup the recap prompt
  carries (`ui-markup`) — is wrapped in unforgeable `⟦UNTRUSTED:…⟧`
  markers (`fenceUntrusted`, with a per-fence random nonce that the content cannot
  predict or close early) so the model treats it as **data, never instructions**.
  The fence carries its **label and nonce only**; the instruction hierarchy has one
  home, `UNTRUSTED_CONTENT_DIRECTIVE`, which every prompt that fences states exactly
  once — session spawns get it as the standing `<untrusted-content-boundary>` block
  (`composeSystemPromptBlocks`), and each aux prompt builder emits it itself. That
  invariant is pinned by `test/untrusted.test.ts`: a builder that fences without the
  directive fails there.
- **Pasted steers are operator messages; fences still are not.** Shepherd types
  every steer into the agent's terminal as a bracketed paste, and Claude Code shows
  a multi-line or long paste to the model as `<pasted_content>` — text it is told not to
  take instructions from unless the user's own message asks. A steer is the whole
  turn, so a session could refuse the plan-go steer and every autopilot nudge until
  the operator typed by hand. The standing `<steer-provenance-notice>` block
  (Claude spawns and resumes; Codex has no such wrapper) tells the agent that a
  turn consisting **only** of a paste is its operator's message. It widens nothing
  else: `⟦UNTRUSTED:…⟧` content stays data wherever it appears, and a paste that
  accompanies typed text is still material that text refers to. The accepted cost:
  foreign text an operator pastes as a whole turn, with no words of their own, is
  acted on.
- **Trusted-by-provenance exception: the repo review policy.** The PR critic's
  prompt carries one block _unfenced_, as genuine instruction: the repo's
  `REVIEW.md` (else `.shepherd/review.md`), read with `git show` from the PR's
  **base commit**, never from the checked-out PR head
  (`defaultReadReviewPolicy`, `src/critic-core.ts`). Fenced it would be
  contractually ignorable and therefore inert; unfenced text the PR could author
  would let a branch (notably a fork PR at the standalone critic) rewrite the
  rules it is judged by. Base provenance closes that — only already-merged policy
  is honored, at the cost that the PR _introducing_ `REVIEW.md` is not reviewed
  under it. The built-in contract stays the floor: the block may add passes and
  narrow which areas/classes get attention, never suppress a verified defect or
  touch the verdict-output contract. Text is clamped at
  `REVIEW_POLICY_MAX_BYTES` (8 KB) with a visible marker, a bad SHA or git
  failure yields no block, and the delimiters are plain markers rather than a
  nonce fence because the content is trusted by construction.
- **Trusted-by-provenance exception: operator task amendments.** The four prompts
  that treat a session's task as ground truth (session critic, plan reviewer,
  autopilot classifier, recap) carry a second unfenced block: the
  `OPERATOR TASK AMENDMENTS` text an operator added after the session started
  (`amendmentBlock`, `src/task-amendments.ts`). Fenced it would be contractually
  ignorable — `UNTRUSTED_CONTENT_DIRECTIVE` orders the reader to ignore in-fence
  claims of operator authority — so it rides outside the fences for the same
  reason the task itself does, and its preamble states the other half of that
  contract: a fenced block claiming to be an amendment is an impostor. Anything
  that can widen a task can excuse a finding, so three properties contain it:
  the write routes (`POST /api/sessions/:id/amendments`,
  `DELETE …/amendments/:id`) are **absent from `AGENT_LEAF_ROUTES`**, so the
  loopback agent ingress denies them and an agent can never amend its own task
  (pinned by `test/agent-ingress.test.ts`); no steer is ever promoted into an
  amendment, only the operator's explicit action writes a row; and the block
  grants **scope** authority while disclaiming everything else in the same
  breath — an amendment never excuses a bug, a security issue or a quality
  defect. Amendments are append-only (no UPDATE path for `text`; retraction is a
  soft delete that stops the row reaching every prompt but leaves it on the
  record) and bounded at entry by `AMENDMENT_MAX_CHARS` (2000), because they are
  non-clampable in the critic's argv budget ladder.
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

- **A `PreToolUse` tool guard denies hazards at the call site** on Claude
  spawns (`scripts/tool-guard.mjs`, wired by `src/tool-guard-hook.ts`,
  `config.toolGuard` / `SHEPHERD_TOOL_GUARD`): a bare `git stash` against the
  shared `refs/stash` stack, a worktree-add or dependency install under a
  tmpfs root, and a `bash -c` script running a `$VAR` command with a `{…,…}`
  argument — Claude Code can't check that shape and asks a bypass-immune
  "runs rm" approval (anthropics/claude-code#99630), so the guard denies it at
  once with a rewrite. It also denies `gh api rate_limit`, which misreports the
  account's GitHub budget, and points the agent at the `self_status` tool, which
  carries Shepherd's real budget (#2860). It denies the CI watchers
  `gh pr checks --watch` and `gh run watch` too, and hints on one-shot CI reads:
  Shepherd already polls each session's PR and steers the agent when its checks
  finish (#2852). It is a **local `command` hook**, not the fail-open HTTP ingest
  transport, precisely so the deny still holds for unattended sessions whose
  `--clearenv` membrane 401s the restricted ingress. Its script is bound RO into
  the membrane (`agentSupportPaths` → `agentSupportFlags`, `src/sandbox.ts`),
  because the decision to drop the equivalent prompt notices is taken host-side —
  a guard missing inside the sandbox would leave that session with neither.
- **Autonomous task agents** run `--dangerously-skip-permissions`, but behind
  **both** the filesystem and the egress membrane. `standard` auto-spawns are
  refused outright (`src/sandbox.ts` `autoHoldReason`).
- **Unattended reviewers** (PR critic, plan-gate, and the maintain loop's tier-2
  diagnosis agent — `src/maintain.ts`) run **read-only**, not
  skip-permissions: `--safe-mode --disable-slash-commands --allowedTools Read
Grep Glob Bash(git diff *) Bash(git log *) Bash(git show *) Bash(git status)
Write --permission-mode dontAsk` (`src/transient-agent-argv.ts`,
  `buildTransientAgentArgv("reviewer", …)`).
- **Codex roles are isolated from the operator's user config.** `--sandbox
workspace-write` bounds what a Codex role may WRITE; it says nothing about what
  the role is WIRED TO. Every Codex role therefore also carries
  `--ignore-user-config --ignore-rules --skip-git-repo-check -c
project_doc_fallback_filenames=["CLAUDE.md"]` (`src/codex-role-argv.ts`), which
  drops `$CODEX_HOME/config.toml` — MCP servers, connector apps, hooks, exec
  policy and the model/effort defaults — while re-asserting the one inheritance
  a Claude role also has, the repo's `CLAUDE.md`.

  **The posture is uniform across all four transient kinds; the reason is
  per-kind.** For `reviewer` and `doc` (untrusted git worktree) dropping
  `[mcp_servers.*]` is the direct analog of the Claude preset's `--safe-mode`,
  which likewise disables MCP _loading_; Codex has no interactive project-MCP
  approval gate, so nothing corresponds to `enableAllProjectMcpServers` and none
  is emitted. For `writer-ro` and `writer-only` (disposable tmpdir) the Codex
  posture is deliberately **stricter** than its Claude counterpart: those Claude
  kinds are not `mcpIsolated` because `dontAsk` plus a closed `--allowedTools`
  deny every `mcp__*` call at the call site, so a loaded server is inert —
  Codex has **no** tool allowlist, so dropping the config is the only thing
  keeping them away from the operator's servers and connectors. `--ignore-rules`
  additionally drops **project** execpolicy `.rules`, which an untrusted PR head
  could otherwise commit to widen what the reviewer runs unapproved.

  `--skip-git-repo-check` is a precondition skip, not a control: Codex refuses to
  start outside a git repo or a `[projects.*]` trust entry, and those entries
  live in the config we just stopped loading. Without it every tmpdir role dies
  at spawn. **Three residuals are accepted:** `$CODEX_HOME/AGENTS.md` still
  loads (no flag drops it — symmetric with a Claude role still reading
  `~/.claude/CLAUDE.md`); there is **no `--allowedTools` analog**, so a Codex
  role can still run arbitrary shell inside its sandbox and cannot be narrowed to
  the reviewer's read-only tool set (`--sandbox read-only` would also block the
  verdict-file write the result contract needs) — this is the largest remaining
  Claude↔Codex asymmetry; and an operator on a custom `model_provider` loses that
  wiring, unguarded because a guard would mean re-reading the ignored config.
  `--ephemeral` is deliberately **not** used: it would suppress the rollout files
  role activity and token totals are read from (`src/codex-activity.ts`).

- **Transient helpers reach outside their scratch dir only via `--add-dir`.**
  The `--allowedTools` allowlist decides WHICH tools may run, not WHERE they may
  reach: a temp-cwd kind (`writer-ro` / `writer-only`) under `--permission-mode
dontAsk` can otherwise read nothing but the files Shepherd itself wrote into
  its disposable cwd. The opt-in `addDirs` option emits `--add-dir`
  (`src/transient-agent-argv.ts`) and is the only thing that grants a helper
  repo access. Claude Code has no read-only form of the flag, so an added
  directory is also exposed to the preset's bare `Write` — callers pass only a
  directory they accept as writable-in-the-worst-case. Codex spawns ignore it
  (`--sandbox workspace-write` restricts writes and network, not reads). Today
  the only caller is the New Task **shaping** round (`src/task-shape.ts`, a
  `writer-ro` spawn over the operator's own rough prompt), and the repo path it
  passes is containment-checked against `config.repoRoot` by the `POST
/api/shape` route before the spawn.
  Because that path is the operator's REAL checkout rather than a disposable
  worktree, the residual risk is not merely "a stray new file": the agent can
  overwrite a tracked file (destroying uncommitted work, visible in `git status`
  only after the fact) or write a gitignored path `git status` never shows at
  all, and `disableAllHooks: true` rules out the tool-guard hook. What bounds it
  is the allowlist — no `Bash`, no `Edit`, no git, no network — so the ceiling is
  file writes inside one operator-chosen repo, with no exec, commit, push or
  exfiltration. The prompt's "write only your result file" instruction is
  guidance to a cooperative model, not an enforced boundary. Tightening this
  means giving the helper a read-only view (detached worktree / RO bind, as the
  reviewer roles get), not a narrower allowlist.
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

- **Bootstrap is downgraded the same way, and DOES open a code PR.** A bootstrap
  session (`input.bootstrap`, #3109) that would resolve to `autonomous` also gets
  `standard` (`researchSafeProfileOverride`), because it installs from the package
  registries and searches the web while scaffolding a new project. Unlike research its
  deliverable **is a code PR**, so it runs with open egress and the readable gh token
  while writing code. **Why the residual is accepted:** it is operator-_created_ only
  (no drain path sets it; `standard` refuses auto-spawn), the service forces autopilot
  **off** (`resolveCreateLaunch`), so it never runs unattended — the operator answers its
  P1 questions in the live pane; it targets an **empty** project (nothing to exfiltrate
  beyond the PRD/design it was given); and its one PR goes through CI, the critic and a
  human merge like any other.

## Shared browser

The per-repo **Shared Browser** (a headful Chromium on the Shepherd host with a
persistent per-repo profile the operator logs in to; opt-in per repo via
`sharedBrowserEnabled`) is reachable by agents only through a Shepherd-brokered
CDP WebSocket on the **agent-ingress listener**. Chromium runs with
`--remote-debugging-pipe`, so there is **no TCP debug port** for any other local
process to reach.

- **Credential.** Each session gets its own HMAC-signed attach token, delivered
  in a per-session config file `~/.shepherd/browser-attach/<session>.json`
  (`{"cdp": "<ws url>"}`, mode 0600 in a 0700 dir, written atomically at spawn,
  deleted on archive). Only the file's path rides the env
  (`SHEPHERD_BROWSER_CONFIG`): the spawn env reaches argv (bwrap `--setenv`,
  herdr's env shim), which any local user can read from `/proc/<pid>/cmdline`.
  A sandboxed session gets exactly its own file through a single-file read-only
  bind; `~/.shepherd` is otherwise not bound, so no session can read another
  session's token. An autonomous session gets a file only when it reaches
  Shepherd through the slirp ingress gateway (`10.0.2.2`). **Residual:**
  processes running as the operator's own uid outside the sandbox can read the
  file (they can read the broker key too); other local users cannot.
- **Attach is browser-level.** An attached agent can read every login in that
  repo's profile, not just its own tab. The **per-repo profile is the isolation
  boundary**: sessions on one repo never reach another repo's logins, but every
  agent on a repo sees all of its logins. Operators should log in there only with
  accounts they are willing to share with that repo's agents.
- **CDP is allowlisted.** The broker forwards only domains page automation needs
  (`Target`, `Page`, `Runtime`, `DOM`, `Network`, `Input`, `Emulation`,
  `Accessibility` and their in-page siblings) plus a few `Browser` window/version
  reads. Everything else is refused by default, including `PWA` (file handlers
  would read host files), `Extensions`, `Tracing`, `SystemInfo` and browser
  process control. Inside allowed domains it also refuses host-reaching methods
  (download behavior, file inputs, file chooser and file drops) and non-web URLs.
  Agents attach only to web targets (`http(s)`, `about:`, `data:`, `blob:`):
  `Target.openDevTools` is refused, attaching or auto-attaching to a `devtools://`,
  `chrome://` or other non-web target is refused, and a tab that navigates off the
  web loses its agent sessions.
  Only flat sessions are allowed:
  `Target.sendMessageToTarget` is blocked and `Target.attachToTarget` /
  `Target.setAutoAttach` need `flatten: true`, so no command can hide inside a
  nested message the broker never parses.
- **Downloads stay in the profile.** Shepherd pins the profile's download and
  save-as directory to `<profile>/Downloads` before every launch, so a
  page-triggered download never lands in the operator's `~/Downloads`. Profiles
  live under `~/.shepherd/browser-profiles/`, which the sandbox membrane does
  not bind (`$HOME` is a tmpfs inside it), so sandboxed agents cannot read
  downloaded files either.
- **Browser View is operator-only.** The live view in a session's **Browser**
  tab is a WebSocket on the operator app (`/browser-view/<session>`), never on
  agent ingress, behind the same auth and origin checks as `/pty`: read/submit
  tokens are refused, a repo-restricted token reaches only its own repos'
  sessions. It attaches as one more broker client, so the CDP allowlist above
  applies to it too. The UI never sends raw CDP: the server translates a small
  typed set (tab select, frame ack, mouse, key, paste text, http(s) navigate,
  reload) into `Page`/`Input`/`Target` commands. Pasted text is typed into the
  page and never stored or logged.
- **Only the operator answers a Login Request.** An agent asks for a login with
  the `browser_request_login` MCP tool, which opens the URL (http(s) only) in
  the Shared Browser and waits. Marking it done or cancelled is
  `POST /api/sessions/<session>/login-request` on the operator app, absent from
  agent ingress, so an agent cannot answer its own request. The agent's reason
  and URL are shown as plain text. Autonomous sessions do not get the tool.
- **Autonomous sessions attach confined** (#2883). The broker gives an
  autonomous attach its **own browser context** whose `proxyServer` is a
  per-attach SOCKS5 proxy Shepherd runs on `127.0.0.1` (`src/browser-egress-proxy.ts`),
  with the implicit loopback bypass removed (`<-loopback>`). Every connection
  the context makes goes through it: navigations, redirects, subresources,
  WebSockets, workers and popups. The proxy, not the browser, resolves DNS, and
  it connects to the address it vetted. The **browser origin allowlist**
  (`src/browser-origin-policy.ts`) allows:
  - hosts in the repo's `browserAllowedHosts` (exact match, ports 80/443),
    only when every resolved address is public;
  - the session's own **Preview port** on loopback, only inside the
    `SHEPHERD_PREVIEW_PORT_BASE` range, never Shepherd's main or agent-ingress
    port, and only while the dev port it relays to is neither of those;
  - the session's own **in-netns dev port** on loopback (#2889): the port in
    the worktree's `.shepherd-preview`, only while it is listening inside the
    session's network namespace. On first use Shepherd asks the session's
    slirp4netns (API socket in the egress temp dir) to `add_hostfwd` it to a
    fresh host `127.0.0.1` port and tunnels there, so the page keeps the origin
    `localhost:<devPort>` and never reaches a host service on that number. The
    netns `devfwd` table DNATs that forwarded traffic to the netns loopback, so
    a dev server bound to `127.0.0.1` works (an `::1`-only one does not). The
    forward dies with the netns.

  Everything else is refused: other loopback ports, IP literals, and names that
  resolve into loopback, RFC 1918, CGNAT/Tailscale (`100.64/10`), link-local,
  ULA, IPv4-mapped or other special ranges. At attach the broker copies only the
  default context's cookies for allowed hosts (and `localhost` when a Preview
  or in-netns dev origin exists, minus Shepherd's own `shepherd_session`) into the confined
  context. When there are none, the attach
  closes with `1008 no-login`: an autonomous session cannot wait for a Handoff
  Login. The confined client sees and drives only its own context: other
  contexts' targets are hidden from discovery and auto-attach, refused for
  attach/activate/close, and `Target.createTarget` and cookie calls are forced
  into its context. New contexts, other browser sessions and browser-level
  `Fetch`/`Network`/`Storage` are refused. Operator and trusted/standard
  attaches are unaffected. **Residuals:** WebRTC UDP (STUN/TURN) does not go
  through a SOCKS proxy, so it remains an exfiltration channel. Cookies the
  confined context rotates are not written back, so a rotated session cookie
  can log the operator's default context out. The proxy port is open to any
  local process but grants only the allowlist. The dev port forward is a host
  `127.0.0.1` listener open to any local process, like a host dev server.

Rationale and alternatives: [ADR 0001](adr/0001-brokered-cdp-for-shared-browser.md).

## Host-side git

The Shepherd server itself runs unconfined, and it runs git over state that
agents and PR authors control: worktree files, the shared `.git` config and
hooks, the worktree's own `.git` gitfile, and integration-branch content. Plain
git over that state would execute it as the operator. This is audit
F01/F02/F05/F07. Every server-side git call therefore goes through
`src/safe-git.ts`, and `test/safe-git-guard.test.ts` fails on any raw git
launch outside a short allowlist (plugin checkouts, a version probe, the
credential lookup run from `/`).

- **Neutralized on every call** (command-line `-c` overrides beat repo,
  worktree and included config): `core.hooksPath=/dev/null`,
  `core.fsmonitor=false`, `protocol.ext.allow=never`. `diff`/`log`/`show` also
  get `--no-ext-diff --no-textconv`.
- **Gitdir pin.** Where the caller knows the trusted repo path (session diff,
  recap, archive check, merge-train freshness, the critic and landing-rebase
  worktrees, the membrane's own git-store bind), the worktree's admin dir is
  found under `<repo>/.git/worktrees/` by its backlink, and `GIT_DIR` and
  `GIT_WORK_TREE` are set explicitly. The worktree's `.git` gitfile is never
  read. If no admin dir matches, the call fails closed.
- **Merge driver.** The epic landing rebase pins `merge.i18n-union.driver` to
  Shepherd's own `scripts/json-union-merge.mjs`, by absolute path. The driver
  self-test and the driver registration also run Shepherd's own copies, never
  the branch's.
- **Membrane.** After the read-write git-store bind, `buildMembraneFlags`
  re-binds the store's `config`, `commondir`, `config.worktree`, `hooks/`,
  `shepherd/`, `modules/`, `worktrees/`, `info/` (attributes, excludes),
  `remotes/` and `branches/` (legacy remote definitions) read-only
  (`gitStoreReadOnlyFlags`). Inside `worktrees/`, only the session's own admin
  dir (found by its trusted backlink) is read-write again, minus its
  `commondir` and `config.worktree`. Git reads a worktree's
  `config.worktree` whenever the repo has `extensions.worktreeConfig` set,
  so it stays read-only whether or not that extension is on. Git follows a
  `commondir` file in any git dir, so before the spawn the server writes the
  store's own as `.`, which names the store itself and is a no-op for git. A
  `commondir` that points anywhere else fails the spawn. This fails closed: there is
  never a `-try` bind. An absent directory is mounted as an empty read-only
  tmpfs, so the agent can't create it either. An absent `config.worktree` (the
  store's and the session's own) is created empty on the host before the
  spawn. A `/dev/null` stub won't do, because git can't open a device node
  under bwrap's binds. bwrap leaves empty mount-point stubs on the host. With
  `config` read-only, git's own config writes inside the membrane fail.
  Examples are `git config`, `git config --worktree`, `git sparse-checkout`
  and recording the upstream on `push -u`. Branch,
  commit and push still work. A membrane agent can't add or prune worktrees.
  A reviewer's store is read-only whole, so it gets
  no carve-outs. A non-isolated session gets the same carve-outs on
  `<repo>/.git` when that is a real store directory. `.git` is first bound
  onto itself, so it is a mount point that can't be renamed or replaced from
  inside.

Server-made commits (doc agent, gitignore adoption, maintenance, plugin agents,
repo bootstrap) no longer run repo hooks.

**Scope:** the neutralized set is deliberately narrow — only keys the operator's
own setup never needs from repo config. Non-isolated sessions in a confining
profile have no pin anchor (the agent owns the whole repo, working tree
included), and `WorktreeMgr.remove` and the preview-script lookup are hardened
but not pinned. In the session's own admin dir, `HEAD`, `index`, `logs/`,
`refs/`, `gitdir` and `info/sparse-checkout` stay writable. Git reads none of
them as config or attributes.

## State directory permissions (#3404)

`shepherd.db` holds the cookie-signing secret, the password hash and tokens; `shepherd.log` can
carry the first-boot generated password. So the state dir is 0700 and those files 0600 regardless
of the process umask: `openPrivateStore` (`src/state-perms.ts`) creates the dir 0700, opens the db
under umask 077 and tightens the db, its `-journal`/`-wal`/`-shm` and the log at every boot (later
SQLite side files inherit the db's mode). `shepherd.service` and `shepherd-logrotate.service` set
`UMask=0077`, `scripts/backup.ts` writes `backups/` owner-only, the installers create and tighten
the dir, and the Mac supervisor tightens `~/.shepherd` before launching. Residual: a symlinked
path or one owned by another uid is never chmod'ed — boot only warns, so a custom `SHEPHERD_DB` in
a shared dir keeps the permissions its owner chose.

## Doc-agent finalize (audit run-2 R2-F04)

The doc agent's worktree is agent-writable, and in re-target mode it is a code
PR's branch. Finalize post-processes it on the host, outside the membrane, so
it treats the worktree as data only:

- **Scope gate.** Before anything runs, finalize resolves the trusted git pin
  and runs `git status`. Any modified or untracked path outside the in-scope
  doc list (plus the run's sentinel and re-target marker) aborts the run with an
  `error` outcome. Observe mode is covered too. An in-scope path that is a
  symlink, or that resolves outside the worktree, also aborts.
- **Pinned git.** Every finalize git call in the doc worktree (status, add,
  diff, commit, push) and in the re-target owner worktree uses that pin, never
  the worktree's own `.git` gitfile.
- **Trusted code and config.** Prettier uses the server install's
  `.prettierrc`. The Docs-manifest regen runs the install's
  `ui/scripts/gen-docs-manifest.ts` with `--root <worktree>`. Its page list
  (`sync-docs.mjs`) and prettier config also come from the install. The
  generator refuses symlinked reads and writes.
- **Minimal env.** The generator gets only `PATH`, `HOME`, the pinned prettier
  module and the git pin (`GIT_DIR`/`GIT_WORK_TREE`), never the server's env.

## See also

- `src/egress.ts`, `src/sandbox.ts`, `src/membrane-state.ts`, `src/service.ts`, `src/autopilot.ts`,
  `src/transient-agent-argv.ts`, `src/task-shape.ts`, `src/maintain.ts`, `src/untrusted.ts`, `src/task-amendments.ts`,
  `src/tool-guard-hook.ts`,
  `scripts/tool-guard.mjs`.
