# Standing prompt: situational notices moved out

**Issue:** #2002 (epic #2005) · **Measured:** 2026-08-03 · **Claude Code:** as installed on the host

**Result.** An attended Claude spawn's Shepherd-authored system prompt drops from **8,389 to 2,148
characters (−74%)**; a drain-shaped spawn from 9,968 to 3,727. Nothing was deleted outright: each
moved notice is delivered by a mechanism at the moment it is relevant, and stays resident wherever
that mechanism does not reach.

## What moved, and to what

| block                        |         chars | delivered instead by                                                                                                |
| ---------------------------- | ------------: | ------------------------------------------------------------------------------------------------------------------- |
| `worktree-stash-notice`      |           942 | `PreToolUse` **denial** of a shared-stack `git stash`                                                               |
| `tmpfs-worktree-notice`      |         1,307 | `PreToolUse` **denial** of a tmpfs worktree-add / dependency install                                                |
| `single-pr-invariant`        |         1,685 | `shepherd-pull-requests` skill + injected context at `gh pr create`                                                 |
| `manual-steps-notice`        |         1,189 | same skill + same injection point                                                                                   |
| `preview-hint-notice`        |           550 | `shepherd-preview` skill                                                                                            |
| `engineering-posture` (part) |         ~1.0k | think-before-coding → the plan-gate directive; detached-job hazard → injected context on a backgrounded `Bash` call |
| `branch-rename-notice`       |           302 | still resident, but only where a background rename can actually land                                                |
| per-fence untrusted caveat   | ~250 × fences | stated once per prompt (`UNTRUSTED_CONTENT_DIRECTIVE`)                                                              |

## Measurements

Shepherd's own payload, via the #1999/#2008 instrument (`measurePromptBlocks`). Chars are exact;
tokens are the instrument's chars/4 estimate.

| spawn shape                     | before | after | est. tokens after |
| ------------------------------- | -----: | ----: | ----------------: |
| attended Claude                 |  8,389 | 2,148 |               538 |
| attended Claude + autopilot     |  9,347 | 3,106 |               777 |
| drain (trimmed, autopilot)      |  9,968 | 3,727 |               932 |
| plan-gate interactive           | 13,171 | 7,130 |             1,783 |
| research                        |  6,320 | 2,957 |               740 |
| Codex attended                  |  6,860 | 5,750 |             1,439 |
| Claude, `SHEPHERD_TOOL_GUARD=0` |  8,389 | 7,279 |             1,821 |

The two fallback rows are the point of the design, not an oversight: a block leaves the prompt only
where the mechanism replacing it exists. Codex has neither Claude Code hooks nor `--add-dir` skill
loading, so it keeps every moved block (it still gains the posture trim and the fence dedup). The
guard-off row is the same rule under `SHEPHERD_TOOL_GUARD=0`.

### The other side of the ledger

The skills are reached with `--add-dir`, and Claude Code makes every available skill's name +
description resident in its own prefix. Measured on the fixture repo, `claude -p` reporting
`input + cache_creation + cache_read`, n=2 per variant (identical both times):

| variant                       | prefix tokens |
| ----------------------------- | ------------: |
| without `--add-dir`           |        32,761 |
| with `--add-dir agent-skills` |        33,027 |

**+266 tokens/turn** for the two skills' listing entries, against ≈ **−1,560 est. tokens/turn** of
Shepherd payload on an attended spawn. Net ≈ −1,300 tokens/turn — but note the two figures are not
the same kind of number: the −1,560 is the instrument's chars/4 estimate, the +266 is what the API
reported. Both are machine- and CLI-version-specific; re-run rather than quoting these.

## Verification

Every mechanic was spiked with real `claude -p` runs before implementation, and re-verified after:

1. **A `PreToolUse` command hook denies a call under `--dangerously-skip-permissions`** — which is
   how Shepherd spawns every session. Both hazards were denied with the reason quoted back verbatim.
2. **The deny also covers SUB-AGENT tool calls.** A dispatched sub-agent's bare `git stash` was
   denied with the same reason. This is strictly stronger than the retired notice, which could only
   ask the top-level agent to restate the constraint into each sub-agent's prompt by hand.
3. **Both denials fire inside the bwrap membrane** (`standard` profile), not only in a trusted
   spawn — see "Reachability" below.
4. **`--add-dir <dir>` loads `<dir>/.claude/skills/`** into a session started in a different repo,
   inside the membrane: the agent listed and invoked both Shepherd skills and quoted their bodies.
5. **`additionalContext` with no `permissionDecision`** is injected alongside the call and the
   command still executes — no auto-approval, no block.

**Regression proof.** Two canonical tasks were run end-to-end on the trimmed prompt, using the real
composed payload (`composeSystemPrompt` + `spawnSettingsOverlay` + `agentSkillsArgs`) in a throwaway
repo:

- _attended_ (2,429-char system prompt): add a helper + `node:test` coverage, run the tests, commit
  on a branch. Completed: 5 tests passing, committed.
- _drain-shaped_ (4,008-char system prompt: autopilot + trimmed + preview + branch-rename): add a
  second helper + tests, run them, commit and push. Completed: 6 tests passing, pushed.

The drain run stopped at the push because the fixture's `origin` is a local bare repo, so there is
no GitHub for `gh pr create` to target; the PR-time context injection is verified separately (5).

## Reachability is the load-bearing part

The decision to drop a block is taken on the **host**, at prompt-composition time. If the mechanism
then does not exist inside the sandbox, that session runs with neither the notice nor the deny.

`buildMembraneFlags` binds `/usr`, `/etc`, `/opt`, a tmpfs `$HOME`, a tmpfs `/tmp`, the Claude config
dir, the node toolchain, `~/.gitconfig`, `~/.config/gh` and the worktree — **no part of the Shepherd
checkout**, and `$HOME` is tmpfs'd. So `MembraneInputs.agentSupportPaths` now carries the guard
script and the agent-skills directory, each `--ro-bind-try`'d at its own path (the `apiKeyHelperPath`
precedent), populated by both the session spawn path and `resolveSpawnMembrane`. The guard's
interpreter is the node binary the membrane already binds — deliberately not `process.execPath`
(bun), which lives under the tmpfs'd `$HOME`.

## Design notes

- **A command hook, not the existing HTTP ingest hook.** HTTP hooks are documented fail-open on
  timeout/non-2xx, and under the autonomous membrane `--clearenv` strips `SHEPHERD_TOKEN` so the
  restricted ingress 401s by design — every deny would evaporate for exactly the unattended sessions
  that need it. A blocking HTTP hook on every `Bash` call would also put a synchronous round-trip on
  the single Bun loop that pumps the live web terminal.
- **Skills are model-invoked, so each one has a deterministic backstop.** The PR rules are injected
  at `gh pr create` whether or not the skill was ever opened; the skill holds the full text.
- **`engineering-posture` was compressed, not moved.** It is standing behavioural law, and
  model-invoked disclosure cannot guarantee it loads. Only its two genuinely situational clauses
  moved.
- **Every guard rule fails open.** Unparseable input, an unknown shape, a relative path with no
  usable cwd → no decision. It blocks only the two shapes it positively recognizes, and an ordinary
  `bun install` in a worktree is untouched. The command splitter is quoting- and heredoc-aware for
  the same reason: a naive split on `;`/newlines would read a hazard MENTIONED as data (a commit
  message, a PR body) as one INVOKED and hard-block a legitimate call — so an ambiguous command
  line (unterminated quote or heredoc) yields no segments, and therefore no decision.
- **Aux prompts grew slightly.** The critic, plan-gate reviewer, recap, rundown, namer, classifier
  and prompt-recommend builders each now state `UNTRUSTED_CONTENT_DIRECTIVE` once. Multi-fence
  prompts (the critic's eight) shrink; a single-fence one (the namer) grows ~0.5 KB per transient
  spawn. `src/rundown-core.ts` fences external issue/PR titles and previously carried no directive
  at all, so it gains injection defence it did not have.

## Caveats

- **CLI-version-specific.** `additionalContext` on `PreToolUse` and `--add-dir` skill discovery are
  current-CLI behaviours. An older CLI ignoring `additionalContext` degrades to "guidance not
  delivered"; a deny that does not fire degrades to pre-#1632 behaviour. Neither breaks a spawn.
- **A deny is a hard block.** A false positive costs one wasted call, and the reason names the
  sanctioned alternative, so the agent self-corrects. `SHEPHERD_TOOL_GUARD=0` is the code-free
  revert, and it restores the notices.
- **Per-`Bash`-call process spawn.** The guard runs a short node script on every `Bash` call. It is a
  dependency-free single file and exits immediately when nothing matches.
