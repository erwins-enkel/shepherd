# Codex / Claude Code release and parity review

The `cli-parity-review` skill compares both CLI integrations in Shepherd. It reads official
release notes, checks current Shepherd code, maintains a capability matrix and creates concrete
GitHub issues **for review**. It also identifies automatic CLI improvements, regressions and
workarounds that may no longer be necessary. Functional parity means equivalent user outcomes,
not matching command names or reducing the stronger integration's capabilities.

The shared implementation is
[the repository skill](../.claude/skills/cli-parity-review/SKILL.md); its
[review contract](../.claude/skills/cli-parity-review/references/review-contract.md) defines the
matrix, durable state, issue templates and verification scenarios.

## Run manually

In Claude Code:

```text
/cli-parity-review dry-run
```

In Codex:

```text
$cli-parity-review dry-run
```

Omit `dry-run` to publish. Dry run prints proposed findings and progress changes without writing
issues, comments, labels or the ledger. Both entry points use the same contract. The reviewer
does not update/install CLIs, run paid CLI sessions, change product code or start implementation.
Source/API failures remain visible as incomplete reviews.

## Activate after merge

This is an operator setup step; merging the skill does not create a schedule. In Shepherd's
**Settings → Schedules**, inspect existing schedules for this repository first. Reuse an existing
equivalent schedule or create exactly one in **Repo settings → Schedules**. Do not run two live
reviewers concurrently, including a manual invocation alongside the scheduled one.

1. Run a manual dry run from the merged default branch. Confirm GitHub read access to both
   upstreams and Shepherd, current-code evidence and the proposed issue destinations. Use the
   existing GitHub authentication; never put tokens in the prompt, skill or ledger.
2. In the repository's automation settings, confirm the configured drain label (normally
   `shepherd:auto`) is **not** `cli-parity`, `needs-review` or a taxonomy label this reviewer or
   `/issue-labels` may add. Check other repository automations do not enqueue these findings.
   The reviewer never grants execution labels; `needs-review` is not a technical drain lock.
3. Configure the schedule:

   | Field                 | Value                                                                                                        |
   | --------------------- | ------------------------------------------------------------------------------------------------------------ |
   | Name                  | CLI release and parity review                                                                                |
   | Prompt                | `/cli-parity-review` followed by `Operator preflight: review/taxonomy labels do not trigger implementation.` |
   | Days / time           | Daily, 09:00 **server-local time**                                                                           |
   | Agent                 | Claude                                                                                                       |
   | Model / effort        | Existing defaults                                                                                            |
   | Autopilot / plan gate | On / off                                                                                                     |
   | Base branch           | Repository default branch                                                                                    |
   | Sandbox               | Existing repository profile, unchanged                                                                       |

   Include the preflight sentence only after checking step 2. The skill stops live publication
   without this operator assertion; a manual live invocation needs it too. Check the repository's
   skill allowlist permits this skill and existing egress rules permit the official sources.
   If access is blocked, resolve it through the operator controls; do not disable the sandbox.

4. Use **Run now** once. Inspect the baseline coverage, release backlog, ledger and proposed
   issues. Verify every new finding has review checkboxes and no execution label. Archive the
   session after reviewing its report so the next slot can run.

The schedule uses Claude because the existing no-op completion tool is available there. The
review still evaluates both providers equally; Codex supports manual invocation.

## Review and release findings

New issues carry `[CLI-Parität][Prüfen]`, `cli-parity` and `needs-review`, plus applicable existing
type/platform/requirement labels. They have source versions, code evidence, prerequisites,
uncertainty and acceptance criteria for both providers. The generic `parity` label is reserved
for the existing iOS parity workflow and is not used here.

Check the evidence, make the product decision, then explicitly release implementation through
the normal Shepherd queue controls. Complete the issue's checkboxes and remove `needs-review`
when appropriate. The reviewer neither performs these approvals nor closes/reopens issues.
Material evidence for an existing issue is added as a deduplicated comment, preserving its scope
and existing approvals. Rejected decisions remain respected.

## Progress, missed days and session closure

One GitHub tracking issue, identified by `<!-- cli-parity-review:ledger:v1 -->`, stores the matrix,
reviewed release fingerprints and pending work. The first run inventories stable releases from
29 July 2026, using the earlier research only as a starting point. Each run reviews at most ten
releases; initial catch-up may take several runs. Changed release-note text is reviewed again.
The entire matrix is rechecked at least every seven days **when runs can execute**, even if no
CLI release arrived. An interrupted baseline is not recorded as complete.

Writes happen before their completion checkpoint. If publication or checkpointing fails, the
next run reconciles existing issues/comments before retrying. Missing, closed, duplicated or
malformed ledger state is reported rather than silently discarded. Do not delete the ledger.

An unchanged complete run can close through `schedule_noop`. A run that writes anything, has
findings, errors or backlog stays open for review. **An open previous session causes later
scheduled slots to be skipped until the operator archives it.** Archive after reading the
report; issue review can continue separately. After several missed days the next run reconciles
all unreviewed releases, not just the latest release or the previous 24 hours.

This setup produces a review backlog. It does not itself establish full feature parity, enforce
a new technical issue gate, or provide automatic closure for runs with findings.
