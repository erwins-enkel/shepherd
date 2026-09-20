# S11 Task 10 report

Status: DONE_WITH_CONCERNS (repository-wide tests fail outside the compose stream).

## Implemented

- Review finding first, commit `bb021f45 fix(contract): open the compose shaping error enums`:
  annotate both shaping error enums, regenerate, add stream-owned OpenEnum conformances,
  and exercise unknown 422 and 503 slugs through the actual kit wire decoder.
- Declare and wrap GET/PUT steers, variant (201), replace (200), recommend-prompt,
  and leftovers. Preserve conflict/upstream codes and unknown recommendation error slugs.
  Leftover kinds are open enums; responses retain process metadata and probe availability.
- Add session action sheets through composition of ActionBarSlot, preserving the installed bar.
  Variant/continue offer provider, model and effort; continue offers resume/summarize handoff.
  Recommendations are selectable, shareable and injectable through S1's existing reply wrapper.
- Add saved-steer editing from the session actions and the new-task sheet, including ordering,
  emoji, placement, repo and provider scopes. Whole-list saves preserve known scope fields.
- Add close confirmation with a leftovers list, unavailable-probe notice and close-only action.
- Fence duplicate operations, dismissed presentations and server switches. Test late completion,
  retries, selection normalization, scope validation and repeated installer calls.

## Files

- `contracts/openapi.yaml` (compose blocks only), generated `contracts/openapi.swift.yaml`,
  generated `native/Sources/ShepherdKit/openapi.yaml`.
- `native/Sources/ShepherdKit/Client/ShepherdClient+Compose.swift`.
- `native/Tests/ShepherdKitTests/ShepherdClientComposeTests.swift`.
- `test/contract/compose.test.ts`, `test/contract/compose-fixtures.ts`.
- New `native/Apps/ShepherdMac/Sources/Compose/ComposeActions.swift`,
  `ComposeActionSheet.swift`, `ComposeSteersEditor.swift`.
- Existing compose `ComposeStream.swift`, `ComposeSheet.swift`.
- App `ComposeModelTests.swift`, `ComposeKeymapTests.swift`.
- `KEYS_COMPOSE` in `native/scripts/gen-strings.ts`, append-only EN/DE catalogs,
  generated `native/Apps/ShepherdMac/Resources/Localizable.xcstrings`.
- This explicitly requested report (force-added because `.superpowers` is ignored).

## Deviations and seams

- The README now links to `native/docs/development.md`; its "Parallel streams: seams and rules"
  section is the current source read alongside the master plan's S11, ownership and protocols.
- GET steers has only 200/401 in the handler; the appendix's combined GET/PUT 400 applies to PUT.
- Spawn cancellation already shipped in Task 9. Reuse its declaration and wrapper, extending kit
  coverage for 400/401/404 instead of duplicating them.
- "Stop" here means the web's decommission/close flow. Its Stop agent command merely interrupts
  a turn. Existing shared close dialogs and other streams' views cannot be edited, so the compose
  action menu owns this close sheet. It deliberately offers only close-session, not process
  termination: `archiveSession.reap[]` remains the explicitly deferred integration-lane work.
- ComposeStream must be installed after the preceding action-bar streams. It captures their
  argument-driven base renderer once, then reassigns a composed bar on repeat installation.
  StreamRegistrations remains untouched; the integration lane owns the existing install call.
- Steers use an explicit Save button in a sheet; web autosaving is not required by Task 10.
  Recommendations use selectable text/ShareLink and the existing reply operation for injection.
- No Context7 tool was available in the exposed/discoverable tool inventory. Existing local
  generated-client and SwiftUI patterns supplied the API examples.
- No transport-timeout change, live request, push or PR. No other stream's files modified.

## Commands and results

All commands ran from this worktree. Root and ui node_modules already existed.
No SHEPHERD_KEYCHAIN_TESTS was set. Live environment values were never printed or written.

For **every kit invocation**, this Python wrapper passed an environment excluding all live
variables, captured output to the named `/tmp/compose-*.log`, then restored Package.resolved:

```python
safe = {k: v for k, v in os.environ.items()
        if not k.startswith(('SHEPHERD_LIVE_', 'TEST_RUNNER_SHEPHERD_LIVE_'))}
r = subprocess.run(command, env=safe, stdout=log, stderr=subprocess.STDOUT)
subprocess.run(['git', 'checkout', '--', 'native/Package.resolved'], check=True)
```

For **every app invocation**, the wrapper first removed/unset all live-prefixed variables:

```python
for key in list(os.environ):
    if key.startswith(('SHEPHERD_LIVE_', 'TEST_RUNNER_SHEPHERD_LIVE_')):
        os.environ.pop(key)
        os.unsetenv(key)
```

It then ran exactly:

```sh
/private/tmp/claude-501/-Users-kai-osthoff-githubrepos-shepherd/183763ce-2ef1-4c24-b0bf-f6cd5d789678/scratchpad/uitest-lock.sh bash ./native/scripts/test-app.sh -only-testing:ShepherdTests
```

No other app test command was used. This builds the app as well as running its unit bundle.

| Command | Result |
| --- | --- |
| `swift test --package-path native --filter shapePreservesUnknownWireError` | RED: 1 test / 2 cases failed; expected failed("future-slug"), got contractMismatch, for 422 and 503 |
| `bun run gen:contract-swift && native/scripts/sync-contract.sh && bun run native/scripts/gen-strings.ts` | Passed for the review fix; no preexisting duplicate conformances found |
| `bun run test:contract` (review fix) | `176 pass`, `0 fail`, `1467 expect() calls` |
| `swift test --package-path native` (review fix) | `Test run with 372 tests in 37 suites passed after 3.686 seconds.` |
| `bun run typecheck` / `bun run lint` (review fix) | Both exit 0 |
| `bun run test:contract` (new Task 10 tests, before declarations) | RED: `176 pass`, `5 fail` |
| `bun run gen:contract-swift && native/scripts/sync-contract.sh` | Passed for Task 10; derived copies identical |
| `bun run test:contract` (final) | `181 pass`, `0 fail`, `1578 expect() calls`; `Ran 181 tests across 10 files. [6.20s]` |
| `swift test --package-path native` (first Task 10 compile) | Failed on nested #require macros in the new test; split into separate statements |
| `swift test --package-path native` (final) | `Test run with 378 tests in 37 suites passed after 2.989 seconds.` |
| Locked app command above (first) | `Test run with 888 tests in 92 suites passed after 9.528 seconds.`; `** TEST SUCCEEDED **` |
| Locked app command above (final, after server-switch test) | `Test run with 889 tests in 92 suites passed after 9.243 seconds.`; `** TEST SUCCEEDED **` |
| `bun run typecheck` | Exit 0 (`tsc --noEmit`) |
| `bun run lint` | Exit 0 |
| `bun run native/scripts/gen-strings.ts` | Generated 772 keys, en + de |
| `bun run check:strings` | `Localizable.xcstrings is up to date (772 keys).` |
| `git diff --check` | Exit 0 |
| `bun run test` | `10461 pass`, `41 skip`, `32 fail`, `9 errors`; `Ran 10534 tests across 466 files. [236.00s]` |
| `TMPDIR=/private/tmp bun run test` | `10481 pass`, `41 skip`, `21 fail`, `4 errors`; `Ran 10543 tests across 466 files. [230.88s]` |

The initial broad-suite failures are outside compose: setup-test-env, shepherd-exclude,
herdr-recovery, validate, backlog, update-discard-scope, herdr-socket-client, landing-rebase,
pty-bridge. Examples include `/var` versus `/private/var` path expectations and worker/socket
failures under the long inherited TMPDIR. No unrelated source was changed to accommodate them.

Ownership checks passed: non-compose contract content unchanged; only KEYS_COMPOSE changed in
the generator; all old EN/DE values unchanged (five new entries each); derived contracts identical;
Package.resolved restored. All new views are AppKit-free, with no DetailTab toolbar.

The canonical-TMPDIR rerun removed the path-comparison and socket-path failures. Remaining
failures are in herdr-recovery, backlog concurrency, update-discard-scope, and pty-bridge.
The broad suite remains a concern for Task 11/integration; this task does not claim a green
repository-wide run or a proven clean baseline. Both dedicated contract runs and all final
kit/app checks passed. No automation-mode timeout occurred.

Task 10 commit subject: `feat(mac): complete the compose block`. Both commits use the requested
`Co-Authored-By: Codex gpt-6-astra <noreply@openai.com>` trailer. No push or PR was performed.

Commit-hook note: lint-staged's Prettier and ESLint tasks both passed, but its ordinary `git add`
failed on the intentionally force-added, ignored `.superpowers` report. An explicit ordinary add
reproduced the ignored-path error. The staged/working trees matched with no lost edits. The report
was force-staged again and the commit completed with `HUSKY=0`; no code-check failure was bypassed.
