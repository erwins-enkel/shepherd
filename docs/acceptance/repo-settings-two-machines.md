# Repository settings: Linux and MacBook acceptance

**Status: NOT ACCEPTED — real-device scenarios have not been executed.**

This is the reproducible handoff and result record for
[issue #3015](https://github.com/erwins-enkel/shepherd/issues/3015), part of
[epic #3016](https://github.com/erwins-enkel/shepherd/issues/3016).
Automated regression results below do not certify the six real-device scenarios.
See [shared repository rules](../repo-config.md) for setup and operating semantics.

## Preparation observed in this session

| Item                        | Observation                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Preparation date            | 2026-11-12 UTC                                                                                                                                  |
| Execution host              | Linux x86_64                                                                                                                                    |
| Epic base inspected         | `d039ba446a97deeedce06b52487205e387b187f5`                                                                                                      |
| Prerequisite implementation | Web #3951, protected-branch rules #3950 and iOS resolution #3973 are integrated in that base                                                    |
| Backend API access          | `SHEPHERD_SESSION_BASE_URL` and `SHEPHERD_SESSION_TOKEN` are absent; the supplied agent-ingress credential is not access to federation routes   |
| MacBook and iOS access      | No authenticated MacBook backend, iOS device/app control or dedicated two-machine fixture was available through the provided session interfaces |
| Native toolchain            | `swift --version` and `xcodebuild -version` each report `command not found`; PATH entries are shims without underlying binaries                 |
| Live mutations              | No production backend, machine settings, forge protection or jobs changed for acceptance                                                        |

The branch was updated to the current epic base before documentation changes. The
original checkout included prerequisite commits under different commit IDs; those are
not changes introduced by this acceptance task.

## Preconditions for the real run

Use an isolated backend started from the same branch-checkout revision on **each real
machine**, a dedicated forge test repository cloned on both, and an iOS app containing
#3973. Do not use the `install.sh` backend inadvertently. Configure connections in both
directions, and connect iOS to only one coordinator to exercise federation. Verify
origin and forge access, including permission to manage protection on the test repository.

Before enabling automation, prepare harmless test issues/PRs and prevent unintended
production work or merges. Save the initial local rules and machine settings for cleanup.
Use the supported no-file configuration path or an isolated fixture store to establish
initial differing database rules; do not edit a live database or briefly enable both
production backlogs. Introduce the test `origin` after fixture setup if needed.

Record these values before any scenario; the missing values below must be filled from
observations, not inferred from the current documentation checkout:

| Run identity    | Required value                                                                      |
| --------------- | ----------------------------------------------------------------------------------- |
| Start/end time  | UTC timestamps                                                                      |
| Linux backend   | Revision, checkout path, start command, process ID/start time, instance ID and name |
| MacBook backend | Revision, checkout path, start command, process ID/start time, instance ID and name |
| iOS app         | Version/build, source revision, device/OS and coordinator connection                |
| Web app         | Build/source revision and backend used                                              |
| Repository      | Forge slug, both clone paths, default branch and initial remote SHA                 |
| Test inputs     | Issue/PR numbers, labels, initial rule values, local limits and sandbox profiles    |
| Connectivity    | Both machines registered for the same slug and readable through the coordinator     |

Retain only sanitized evidence: timestamps, instance IDs, rule fields/SHAs, job events,
Git logs and screenshots. Never attach tokens, authorization headers, full stores or
unrelated session prompts. Store small evidence files beside this record in
`repo-settings-two-machines/`, or link durable PR attachments. Include actual filenames
and links in the per-scenario results.

## Scenario results

| #   | Scenario                                                              | Result       | Evidence                                                 |
| --- | --------------------------------------------------------------------- | ------------ | -------------------------------------------------------- |
| 1   | No-file differences, iOS merge and leader selection                   | Not executed | Requires real Linux/Mac backends and iOS control         |
| 2   | Web and iOS edits, one commit per save, adoption without restart      | Not executed | Requires both backends and both clients                  |
| 3   | Submit on Linux, automatic Mac routing, shared critic/autopilot rules | Not executed | Requires actual machine selection and Mac execution      |
| 4   | Offline leader, no takeover, manual switch and old leader return      | Not executed | Requires isolated two-machine backends                   |
| 5   | Protected `main`, one rules PR and visible waiting state              | Not executed | Requires test-repository protection and Web/iOS evidence |
| 6   | Different local limits/sandboxes, no commits or rule divergence       | Not executed | Requires effective values from both machines             |

For every scenario add the actual start/end time, actions, expected/observed values,
result and evidence links. An unavailable machine or skipped step is **not executed**,
not a pass. A violated expectation is **failed**, with reproduction details.

### 1. Publish rules from the no-file comparison

Start with no `.shepherd/config.json` on the test repository's default branch, different
critic/autopilot rule values in each local store, and backlog processing enabled on both.
Capture both machines' local values and the absence of the file at the remote SHA.

In iOS open **Repos → project settings → Merge differences**. Capture the differing
rules, the multiple-backlog warning and comparison completeness. Select values from both
machines, inspect equal rules, select one Leitrechner and confirm a single save.

Pass requires exactly one new rule commit containing the chosen rules and persistent
leader ID, identical effective rule values on both machines after refresh, and new
repository jobs allowed only on the selected machine. Attach before/after screenshots,
project/machine API fields, leader status and the commit/file diff. Use an unprotected
test default branch here; scenario 5 covers a pending first-file proposal separately.

### 2. Change rules from Web and iOS

From **Backlog → Settings** stage multiple rule changes and confirm once. Then change
multiple shared rules in iOS and confirm once. For each save record the remote default
SHA before/after, `git rev-list --count <before>..<after>`, the commit subject and changed
paths. A changed save should produce one commit affecting `.shepherd/config.json`.

Capture the save receipt/notification outcomes and both machines' effective values and
SHAs after adoption. Record PID/start time before and after: neither backend restarts.
Compare literal shared model/effort values; per-machine resolution of `inherit` can differ.
A notification failure requires follow-up evidence of adoption, not a second blind save.

### 3. Route Linux submission to the MacBook

Keep the old Mac database critic/autopilot values intentionally different from the
published rules. Submit a harmless Xcode-specific task on Linux through the automatic
machine-choice path from #2778. Capture placement reason, dispatch ID and receiving
Mac session ID, plus the actual session's critic/autopilot events and effective rules.

Pass requires automatic selection of the MacBook and behavior matching shared rules,
not the retained old Mac database values. Manual machine selection or a mocked dispatch
does not pass this scenario. Record whether both enabled and disabled rule behavior
was exercised; preserve the test task/PR links.

### 4. Pause, change ownership and return

Start with Linux as Leitrechner and both backlog and all-PR critic rules enabled. Make
only its isolated test backend unreachable; retain its configured connection/instance ID.
Provide eligible test backlog and PR-sweep inputs. Observe at least one actual drain and
sweep attempt after a successful rule refresh on the MacBook. Record the scheduler
interval and timestamps so absence of new starts is meaningful. Existing sessions may
continue; count new repository-wide starts separately.

Pass first requires paused global starts on the MacBook, with a remote/unreachable owner
status and no automatic takeover. Then change Leitrechner manually in iOS to the MacBook,
commit (and merge if required), refresh and observe new eligible jobs starting there.
Return the old Linux test backend. Capture its startup fetch, new effective SHA/leader,
and another scheduler cycle proving it leaves new repository jobs to the MacBook.

Account for the 30-second ownership refresh window and existing issue-claim deduplication;
this is not an atomic distributed lock. Removing the connection makes the leader ID
unknown and invalidates this test's premise. A fetch failure with known ownership must
pause new global starts rather than use stale authorization.

### 5. Save against protected main

Protect `main` in the dedicated test repository so the test writer cannot bypass protection.
Record protection and initial effective SHA/rules. Save a rule change, inspect one commit
on `shepherd/repo-config` and its single open PR. Capture the waiting PR link in Web and
iOS and unchanged effective rules/default SHA. Save another change from the other machine
and verify reuse of the same PR. Retrying identical proposed values must add no commit.

Merge through the test forge's normal review process. Refresh both machines and capture
the merged effective rules, pending-state clearance and SHA. An unmerged first proposal
must retain local database behavior until merge. Authentication/network failures are
errors, not evidence of the protected-branch fallback.

### 6. Keep machine values local

In each machine's settings select different valid concurrency limits and sandbox profiles.
Read back each target's values and `fieldSources`, and capture the project comparison.
Shared rules remain identical; differences between machine values must not appear as
rule divergence. Verify local values persist when reloading the UI/API.

Compare remote default **and proposal** refs before/after these saves: neither changes,
and no rules PR is created. No `.shepherd/config.json` initialization should result from
machine-only writes in the no-file case either. Use only isolated backend settings.

## Automated checks

Local runs on 2026-11-12 used the epic base above plus this documentation change.
The product sources were unchanged. Full suites remain in GitHub CI; targeted tests
are supporting regression coverage, not evidence of the six scenarios above.

| Local check                                                 | Observed result                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Root repo-config regressions (10 explicit files below)      | 86 passed, 0 failed, 441 assertions                                                                     |
| Docs generation/ignore regressions (2 explicit files below) | 3 passed, 0 failed, 8 assertions                                                                        |
| UI editor node test                                         | 13 passed in 1 selected file                                                                            |
| UI `bun run check`                                          | 0 errors, 0 warnings                                                                                    |
| Changed-file ESLint                                         | Passed for both Docs-Site scripts and generated docs manifest                                           |
| Prettier                                                    | Passed for changed Markdown and generated manifest; Docs-Site is excluded by the root formatting policy |
| Docs manifest freshness                                     | Passed                                                                                                  |
| Docs-Site `bun run check`                                   | 0 errors, 0 warnings, 0 hints                                                                           |
| Docs-Site `bun run build`                                   | Passed, 3977 pages, including `/repo-config/`                                                           |
| Swift package/iOS checks                                    | Not executed locally: no underlying Swift/Xcode toolchain or Mac buildhost access                       |

Reproduce the targeted tests from the repository root:

```bash
bun test ./test/repo-config-file.test.ts ./test/repo-config-write.test.ts ./test/repo-config-pr.test.ts ./test/remote-repo-config.test.ts ./test/repo-config-refresh.test.ts ./test/repo-config-startup.test.ts ./test/repo-leitrechner.test.ts ./test/leitrechner-two-instances.test.ts ./test/server-remote-repo-config.test.ts ./test/server-repo-config-pr.test.ts
bun test ./test/docs-site-gitignore.test.ts ./test/doc-agent-gendocs.test.ts
bunx eslint docs-site/astro.config.mjs docs-site/scripts/sync-docs.mjs ui/src/lib/docs-manifest.ts
bunx prettier --check docs/repo-config.md docs/machines.md docs/acceptance/repo-settings-two-machines.md ui/src/lib/docs-manifest.ts
```

From `ui/`, run `bun run check`,
`bun run test src/lib/components/repo-settings/repo-config-editor.svelte.test.ts --project node`
and `bun run check:docs-manifest`. From `docs-site/`, install its own dependencies and
run `bun run check` and `bun run build`. The build reported warnings about the existing
empty i18n collection and missing 404 content entry; no build failure.

The guide importer regression was first observed failing for the missing ignore entry,
then passed after registering the generated destination. The scoped lint also exposed an
existing implicit `process` reference in the importer; importing `node:process` explicitly
resolved it without changing the generator's behavior.

Remaining gates: the delivery PR's Root lint/test and UI check/test results, plus native
checks for the revision used for the real run. Path-filtered or skipped jobs do not count
as executed checks. Record those run links/revisions here or in the PR when available.

Historical prerequisite checks are available on
[PR #3973](https://github.com/erwins-enkel/shepherd/pull/3973), for its head
`d12fd9132628123f956e6c50e148a9be0f6677db`:
[Root/UI static and test run](https://github.com/erwins-enkel/shepherd/actions/runs/43234271082),
[native package/core/app run](https://github.com/erwins-enkel/shepherd/actions/runs/43234271269),
and [iOS simulator run](https://github.com/erwins-enkel/shepherd/actions/runs/43234271279).
Those successful checks precede this documentation PR and do not certify its head or
real hardware acceptance. The Mac XCUITest job was skipped; it is not a green execution.

## Cleanup and sign-off

After a real run, stop only test-created jobs/backends, restore saved local rules and
machine values and test-repository protection, and record what was restored. Keep evidence
and identify any remaining test resources. This preparation session created no live
acceptance resources to clean up.

Keep the delivery PR in draft until all six scenario results contain real evidence and
Root lint/test, UI check/test and native checks for the relevant tested revision are green.
Do not close #3015 based on this preparation record. If a TestFlight build is distributed
for the run, verify build-specific **What to Test** notes per the
[TestFlight checklist](../../native/docs/testflight-ios.md#release-notes-required-for-every-build).
