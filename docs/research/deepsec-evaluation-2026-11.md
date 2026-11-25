# Spike: Vercel deepsec on Shepherd vs the Cloudflare audit skill (issue #4155)

**Verdict: ADOPT as an operator-run, diff-scoped skill.** Do not build it into Shepherd and do not
run it on the whole repo. Pointed at the files behind the 22 published GHSAs from audit runs 1–2,
deepsec found **18 of 22 (82%)** with the right root cause, plus 1 partial. Its regex scan alone
would not have pointed it at all of them. It also produced **net-new findings, which were filed
privately**. Cost was about $132 API-equivalent, drawn from plan limits.
It misses flaws that need knowledge across sessions or across time, so it complements the
Cloudflare skill rather than replacing it.

Background and the billing analysis are in
[`lutke-senra-podcast-ai-coding-2026-11.md` §6](lutke-senra-podcast-ai-coding-2026-11.md#6-deepsec-different-from-the-cloudflare-skill-so-check-it-first).

---

## Setup

| Item         | Value                                                                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deepsec      | `2.3.16` (npm `latest`, 2026-11-25)                                                                                                                            |
| Agent, model | `--agent claude`, `claude-opus-5-5`, deepsec's default thinking level (`xhigh`)                                                                                |
| Auth         | `--model-auth local` with a `claude setup-token` OAuth token. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` were unset for every call, so plan usage, not API |
| Isolation    | Incus container (per-user restricted project, own netns, no host mounts), unprivileged user, in-container nft drop to all private ranges                       |
| Targets      | `e03de2986` (run-1 baseline), `ea077da62` (run-2 baseline), `f523176ed` (main, coverage only)                                                                  |
| Processing   | `process --files <positives> --no-ignore --batch-size 1 --concurrency 3`, then `revalidate`                                                                    |

`--batch-size 1` gives every file its own agent. That is the most favourable setting for recall
and the most expensive per file.

**Contamination check.** The clones contained future commits, including the GHSA fixes, and the
agent had Bash and internet access. I read all 680 agent Bash commands and every WebFetch in the
SDK transcripts. `git log` and `git show` were only ever HEAD-relative or on ancestors (no `--all`,
no refs from after the baseline). There was no GitHub or advisory access. The only two WebFetches
went to prettier's source. The recall below is not leaked.

## Coverage: the free regex scan

The built-in matchers ran in about 5 s per checkout, with no AI.

| Checkout    | Files flagged | Flagged only by noise matchers¹ | `src/` flagged / non-test | `ui/src/`  | `cli/` (Rust) | `native/` (Swift) |
| ----------- | ------------- | ------------------------------- | ------------------------- | ---------- | ------------- | ----------------- |
| `e03de2986` | 533           | 363 (68%)                       | 262 / 367                 | 174 / 1187 | 0 / 21        | 6 / 732           |
| `ea077da62` | 542           | 368 (68%)                       | 269 / 376                 | 175 / 1189 | 0 / 22        | 6 / 740           |
| `main`      | 664           | 465 (70%)                       | 336 / 476                 | 217 / 1533 | 0 / 25        | 7 / 803           |

¹ The `insecure-crypto` "weak cipher" pattern is `/DES|RC4|Blowfish/i` with no word boundary, so
it matches "**des**troys", "**des**cription" and "mo**des**". Files whose only hits are that
pattern, `process-env-access` or `crypto-usage` are counted as noise.

`init` then runs an AI setup stage: a threat model (`INFO.md`), a surface inventory and
**generated matchers**. On `e03de2986` it produced 58 repo-specific matchers (27 Swift, 15 Svelte,
6 Rust, 5 deploy, 4 forge, 1 xterm). That raised flagged files to **1362 of 2680** source files:
`cli/` 19/21, `native/` 278/732, `ui/src/` 697/1187. Its inventory covered all 20 surfaces it had
identified, including the agent-ingress listener, preview proxy, membrane spawn and forge CLI.

Two corrections to the research doc: deepsec **does** ship a `js-bun-serve` matcher (6 hits in
`src/server.ts`), and Swift and Rust get coverage through the generated matchers.

**Setup friction.** The threat-model task is capped at 40 turns, and on Shepherd it failed twice
with a bare "Claude setup task failed". The cap is hard-coded (`runClaudeSetupTask`, `maxTurns ??
40`), and `deepsec.config.ts` cannot raise it. I patched it to 120 in the workspace copy, after
which setup completed. It took about 60 min of Opus time: threat model 12 min, generated matchers
14 + 35 min. In local mode deepsec records no cost for setup. The agent also kept calling Bash,
which the setup task does not allow, and each denied call burns a turn.

**Scanner recall** at the file level, over the 19 positive file/commit pairs:

| Outcome                                   | Count | Files                                                                                                                |
| ----------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------- |
| Flagged by a relevant built-in matcher    | 11    | `preview-launch`, `sandbox` ×2, `agent-control`, `server` ×2, `service`, `preview` ×2, `doc-agent`, `egress` (weak²) |
| Flagged only by noise                     | 5     | `landing-rebase`, `worktree`, `automerge`, `validate`, `operator-assistant-actions`                                  |
| Not flagged by built-ins                  | 3     | `src/diff.ts`, `scripts/egress-runner.sh`, `cli/src/lib.rs`                                                          |
| …of those, flagged by a generated matcher | 1     | `cli/src/lib.rs` (`rs-cli-bearer-credential-handling`)                                                               |

² `egress.ts` was flagged only via `secret-in-log`, which is unrelated to the DNS bug.

In a normal whole-repo run, deepsec investigates every flagged file, noise included. Ironically,
that noise is the only reason the 5 noise-only positives would have been reached. `src/diff.ts`
(R1-F01, a high) is never flagged, so a run that is not forced would miss it.

## Recall on the published GHSAs

Each positive file was investigated at its baseline commit, forced via `--files`.

- **Hit:** a finding in that file with the GHSA's root-cause mechanism.
- **Partial:** same file and sink, but a different source or attacker.

| ID     | GHSA                | File                                        | Built-in scan | Result   |
| ------ | ------------------- | ------------------------------------------- | ------------- | -------- |
| R1-F01 | GHSA-943p-f84m-xhfc | `src/diff.ts`                               | not flagged   | **hit**  |
| R1-F02 | GHSA-c827-pvp8-ffxh | `src/landing-rebase.ts`                     | noise         | **hit**  |
| R1-F03 | GHSA-jw39-3m4m-wh84 | `src/preview-launch.ts`                     | relevant      | **hit**  |
| R1-F04 | GHSA-c6mq-xh95-639q | `src/sandbox.ts`                            | relevant      | **hit**  |
| R1-F05 | GHSA-mmrx-4748-5f23 | `src/sandbox.ts`                            | relevant      | **hit**  |
| R1-F06 | GHSA-wf7h-35x9-68wc | `src/sandbox.ts`                            | relevant      | **hit**  |
| R1-F07 | GHSA-8mr8-c2pc-phq6 | `src/worktree.ts`                           | noise         | partial³ |
| R1-F08 | GHSA-8qfh-964w-q56h | `src/agent-control.ts`                      | relevant      | **hit**  |
| R1-F09 | GHSA-qxgg-vw73-3fp3 | `src/automerge.ts`                          | noise         | **hit**  |
| R1-F10 | GHSA-8qxp-7233-6fp8 | `src/server.ts`                             | relevant      | **hit**  |
| R1-F11 | GHSA-6hf7-739j-35gj | `src/service.ts`                            | relevant      | **hit**  |
| R1-F12 | GHSA-qc5h-9wv7-v7xq | `src/service.ts`                            | relevant      | **hit**  |
| R1-F13 | GHSA-rhhv-c4hx-24mf | `src/validate.ts`                           | noise         | **hit**  |
| R1-N03 | GHSA-8j7w-mpw3-vf8p | `src/preview.ts`                            | relevant      | **hit**  |
| R1-N06 | GHSA-2c4r-f3gm-r7ff | `src/egress.ts`, `scripts/egress-runner.sh` | weak / no     | **hit**⁴ |
| R2-F01 | GHSA-jgcp-ghcq-w69r | `src/sandbox.ts`                            | relevant      | **hit**  |
| R2-F02 | GHSA-vj4w-qr44-m5cv | `cli/src/lib.rs`                            | not flagged⁵  | **hit**  |
| R2-F03 | GHSA-4p6g-w9pq-4hr9 | `src/preview.ts`                            | relevant      | miss     |
| R2-F04 | GHSA-7gqr-j38c-vq7j | `src/doc-agent.ts`                          | relevant      | **hit**  |
| R2-F05 | GHSA-jc95-3hqx-v8f9 | `src/operator-assistant-actions.ts`         | noise         | miss     |
| R2-F06 | GHSA-9cc5-r595-34jw | `src/sandbox.ts`                            | relevant      | miss     |
| R2-F07 | GHSA-rv59-v3vg-8rph | `src/server.ts`                             | relevant      | **hit**  |

³ deepsec found host-side `WorktreeMgr` git running hooks and config that a _sandboxed agent_
planted (the R1-F05 family), not the _untrusted PR head's_ relative `core.hooksPath` firing during
`createDetached`.
⁴ Found in `egress.ts`. For `egress-runner.sh` the agent hit a model refusal partway through and
returned only two non-security bugs.
⁵ Not flagged by built-ins. A generated matcher flagged it on `e03de2986`; `ea077da62` only got
the built-in scan.

| Measure                                                  | Run-1 (15) | Run-2 (7) | Total           |
| -------------------------------------------------------- | ---------- | --------- | --------------- |
| Agent recall (forced), hit                               | 14         | 4         | **18/22 (82%)** |
| Agent recall incl. partial                               | 15         | 4         | 19/22 (86%)     |
| End-to-end estimate (flagged by any matcher **and** hit) | 13         | 4         | 17/22 (77%)     |

The misses share a pattern. All three run-2 misses need knowledge **across sessions or across
time** that a single-file read does not surface: a browser origin reused across sessions, an
approval that is not bound to a later head, and a `--ro-bind-try` that silently skips when a
directory is absent at spawn. Run-2 found those by modelling trust boundaries. Run-1's
higher hit rate partly reflects how obvious its bug class was: host git trusting agent-writable
state shows up in nearly every file that touches git.

deepsec also rediscovered several **public low-severity** issues and leads in the same files. At
`e03de2986`: epic-draft approval binding (#3324) and the single-pass paste-marker strip (run-1
lead). At `ea077da62`: the uncapped `/api/pair` body (#3369) and preview cookie shadowing (#3365).
On `e03de2986` it also found R2-F01 and R2-F07 a day before run-2 did.

## Revalidation

The revalidate pass re-checked all 80 findings. It confirmed 79 as true positive and marked 1 as a
false positive: the `CODEX_HOME` read-write bind, which matches the accepted residual from run-1.
It checks whether a finding is _true_, not whether it is _new_ or _still present_, so on this
codebase it filtered nothing meaningful. Manual triage did that work instead.

## Net-new findings triage

deepsec produced **80 findings** on the 19 positive files. Each was checked against current `main`
(`a46a3416f`), the run-1/run-2 artifacts and the public `security` issues.

| Bucket                                                                     | Count  |
| -------------------------------------------------------------------------- | ------ |
| Rediscovers a published GHSA, a public low or a prior-run lead             | 35     |
| Fixed on `main` since the baseline                                         | 5      |
| Still present but already known (documented residual or design, open lead) | 4      |
| Real defect, but no trust boundary crossed (non-security bug)              | 18     |
| **Net-new security issue, filed privately**                                | **18** |

The net-new issues were filed as private advisories. Per `SECURITY.md`, nothing more about them is
published until fixes ship. Severity and impact will be added here once the advisories are public.

- **The tail is long but useful.** About 1 in 4 findings was a real non-security bug. Triage judged
  none of the 80 wrong on the merits. The one finding the revalidator called a false positive is a
  documented accepted residual. Most of the cost of a run goes into triage, not into weeding out
  noise.
- **Severity and novelty still need a human.** The revalidator confirms that a finding is true. It
  does not set severity or check whether a finding is new or already fixed.

## Plan usage

In local mode, deepsec's per-analysis records still carry the SDK's token counts and its
API-equivalent `costUsd`. No API key was used: this is the price the work would have cost on
the API, and it is drawn from plan limits.

| Stage                                 | Wall time         | Turns | Output tokens | Cache-read tokens | API-equivalent |
| ------------------------------------- | ----------------- | ----- | ------------- | ----------------- | -------------- |
| `init` setup (threat model, matchers) | ~60 min           | n/a   | n/a           | n/a               | not recorded   |
| `process`, 19 files                   | 18 + 45 + 33 min⁶ | 1,072 | 1.6M          | 148M              | $95.00         |
| `revalidate`, 80 findings             | 25 + 19 min⁶      | 401   | 0.6M          | 67M               | $36.62         |
| **Total AI** (excluding setup)        |                   | 1,473 | 2.2M          | 215M              | **$131.62**    |

⁶ Separate runs, partly in parallel (r1 and r2 at the same time), each with `--concurrency 3`.

The operator's weekly `/usage` percentage was not captured before and after the run. The plan has
no 5-hour window any more, so the planned 50%-of-window stop rule did not apply. The SDK figures
above are the only usage measure.

Average `process` cost was about **$5 per file** at batch size 1. A whole-repo pass would cover the
1,362 flagged files, roughly $6.8k API-equivalent at that rate. The default batch size of 5 lowers
that, but a whole-repo pass is still impractical on plan limits. Diff-sized runs of 5–20 files cost
$25–100 equivalent.

## How it compares

| Axis                 | Cloudflare skill (runs 1–2)                    | deepsec (this spike)                                                                                           |
| -------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Finds                | Cross-file, cross-session trust-boundary flaws | Per-file flaws, including deep ones when the file is the sink. It misses cross-session and time-of-check flaws |
| Targeting            | Ledger of trust-boundary units                 | Matcher hits. 68–70% of built-in hits are noise; one high (R1-F01) is never flagged                            |
| False-positive guard | Independent verifier per candidate             | Revalidate pass: 79/80 kept. Few false positives, but novelty and current-state triage stay manual             |
| Cost shape           | Budgeted per agent invocation                  | About $5 per file. Linear in files, so diff scope is the only affordable mode                                  |
| Ergonomics           | Methodology, run by the interactive agent      | CLI with resumable state. A hard-coded setup turn cap needed a patch; local auth worked once the env was clean |

## Recommendation

**Adopt, scoped:**

1. **Operator-run skill, diff mode.** Run `deepsec process --diff origin/main` (or `--files`) on
   security-sensitive PRs and on a pre-release diff. Don't scan the whole repo. Keep it out of the
   product, because the Agent SDK terms forbid offering claude.ai login inside a third-party
   product (§6 of the research doc). It runs in an isolated container, with the same env hygiene
   as this spike.
2. **Keep the Cloudflare skill for periodic audits.** It owns cross-session and boundary reasoning,
   which is exactly where deepsec missed.
3. **Optional later:** a Security Watch source that ingests the `deepsec export --format json`
   output into the existing grouping, triage and redacted filing pipeline.

A Readiness `security_scan` guardrail is still not justified by this spike.

## Reproduce

Inside an isolated container, as a user with only a setup-token:

```bash
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
export CLAUDE_CODE_OAUTH_TOKEN=…   # from `claude setup-token`
git clone https://github.com/erwins-enkel/shepherd.git && cd shepherd && git checkout <baseline>
npx -y deepsec@2.3.16 init --model-auth local --agent claude --model claude-opus-5-5 \
  --package-manager npm --headless --through coverage --no-tui --output jsonl
# threat-model step fails on the 40-turn cap → raise maxTurns in
# .deepsec/node_modules/deepsec/dist/cli.mjs (runClaudeSetupTask) and run init via
# .deepsec/node_modules/.bin/deepsec (npx would use its own cached copy)
cd .deepsec
node_modules/.bin/deepsec process --agent claude --model claude-opus-5-5 \
  --files <csv> --no-ignore --batch-size 1 --concurrency 3
node_modules/.bin/deepsec revalidate --agent claude --model claude-opus-5-5 --concurrency 3
node_modules/.bin/deepsec export --format json
```
