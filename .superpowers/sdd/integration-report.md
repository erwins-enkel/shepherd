# Milestone 3 wave-1 integration — S0-int

Branch: `feat/native-wave1-integration`. Initial base: `69d4bb91` (merged S7, S8, S10 and S0); rebased without conflicts onto `4deb48da`, including the long-running client fix #2417 and documentation sync #2359.
Host: `<live-host>`. No operator session command was issued; no operator profile or token was removed.

## Outcomes

1. **Installation and reset:** queue factories register at scene time; model order is milestone-2 consumers → `SessionSignals.connect` → Plan → Herd → Queues. Production installer tests exercise registry population/reset, repeated activation, signal ownership and teardown. Reset includes the scene guard, PlanSignals and QueuesPanels.
2. **Cross-stream facts:** Herd owns git classification/review/merged state; Plan supplies plan review, rework and questions; one activation observer unions CI failures and unanswered questions for Notifications. The notification owner intersects with live sessions and clears on teardown. Optional `Recap.blocks` references S8's shared schema and renders alongside Markdown in Done. SessionStore now patches plan-phase and halt pushes before broadcasting to consumers.
3. **Production surfaces:** queue panel factories control both lens enablement and rendering; held/queue actions mount above the sidebar lenses. Plan badges/Answer select the session and Plan tab. The existing S7 stepper tint matches the web; visibility/heartbeat rules, issue-link precedence, and named/anonymous handoff headings now match too. Plan badges expose status help and a stalled outline; approved Review remains focusable with an inert action and explanation; unknown-block documentation matches intentional omission.
4. **Conformance hygiene:** no duplicate OpenEnum conformance found. A contract test normalizes schema type names (rather than comparing path-prefixed grep lines), excludes build directories, and fails on duplicate declarations across native sources/apps.
5. **Live-smoke diagnosis:** reproduced the original `waitForMainWindow` failure at line 116, after automation had successfully attached. The app logged an isolated launch/live seed armed, but RootView's task never ran. Compared scene startup with the passing S3-era `2886cb82`; removing Settings alone or command registrations alone still failed the 15-second welcome probe. `-ApplePersistenceIgnoreState YES -NSQuitAlwaysKeepsWindows NO` made the unchanged scenes/menus open their window. Profile isolation did not isolate AppKit saved-window restoration. Both UI test hosts now pass the flags. Once live sign-in worked, the test exposed inherited accessibility identifier shadowing: MainWindow applied the fallback sidebar ID over the stream's root, and HeaderStrip did not expose a separate container. IDs now survive through explicit containers. Current macOS exposes native tab controls as `.tab`, not the legacy `.radioButton`; the UI host accepts both. Lens buttons expose selection and use a rectangular hit region across their complete frame. The terminal container preserves its descendants, and SwiftTerm’s ignored NSView is explicitly exposed as an accessibility group; the real emulator, prompt and resize smoke now pass. Live teardown requests real Quit so token revocation can run.
6. **Verification:** see gate results below. The inherited LocalHealthCheck flake already has a 10-second stub budget and one-minute suite bound on this base; both final package runs passed. The merged kit-hang fix is retained; no broad timeout workaround was added. PTY issue #2416 remains separately tracked.
7. **Delivery:** one PR against main; no merge. Every implementation commit uses a conventional lowercase subject and the requested Codex coauthor trailer.

## Seam table

| Consumer seam                          | Owner/source                                                    | Before activation / after teardown              |
| -------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------- |
| SidebarModel.gitStage                  | HerdSignals classifier                                          | nil                                             |
| SidebarModel.inReview                  | Herd critic review OR PlanSignals review                        | false                                           |
| SessionSignals.gitMerged               | HerdSignals bulk git snapshot                                   | false                                           |
| NotificationsModel.extraAttention      | HerdBindings union of CI failures and unanswered plan questions | empty                                           |
| SessionSignals.planQuestionsUnanswered | PlanModel                                                       | false                                           |
| HerdSignals.planReviewing              | PlanSignals → current PlanModel                                 | false                                           |
| HerdSignals.planRework → HerdContext   | PlanModel gate/stall predicate                                  | false                                           |
| HerdLens.isAvailable + sidebar content | QueuesPanels scene factories                                    | Next/Owed/Done disabled before registration     |
| SessionSignals.manualStepsOutstanding  | S9 (not in wave 1)                                              | empty dictionary; Owed is an honest empty panel |
| Recap.blocks                           | Optional shared VisualBlock array                               | absent                                          |
| NewSessionSlot / relaunch/archive body | S11 (not in wave 1)                                             | existing conservative defaults                  |

## Gate results

- `bun run typecheck`: passed.
- `bun run test:contract`: 175 passed, zero failed (includes duplicate-conformance checks).
- `bun run check:strings`: passed, 647 keys.
- `bun run lint`: passed.
- `bun run check:contract-swift` and `sync-contract.sh --check`: passed.
- `swift test --package-path native`: 375 passed, 38 suites after rebase; all plain/prefixed live variables removed for unit runs; Package.resolved restored.
- Debug app build: passed.
- App unit bundle: 889 passed, 92 suites. Initial failures were three S10 assertions explicitly expecting unpatched halt pushes; updated to the integrated contract. No remaining unit failures.
- UI bundle: all 10 passed (six live smoke, four welcome), zero failures after rebase. Includes original sidebar/tallies regression, seven detail tabs, all registered queue lenses, and terminal attach/render/resize.
- Read-only live model suites: passed after rebase across seven suites (12 tests reported: 11 executed, one pre-minted-token test skipped). Observed 22 active sessions, 22 git/alive entries, three reviews, four plan gates, zero inflight reviews/question forms, zero held/stranded tasks, 14 done sessions and 272 recaps. Live question-form behavior is covered by fixtures because this snapshot contained none. PlanLiveTests verified its minted token was revoked with a subsequent 401.
- Root `bun run test`: not rerun; operator supplied the unchanged main baseline (~32 failures / 7 errors).

Every app/UI test invocation used the supplied shared `uitest-lock.sh`. No `pkill`, Keychain-test opt-in, normal-mode app launch, or live credential value in reports/commits. Test output was redacted in memory before writing logs. Live model tests mint unique `Shepherd UI test (…)` tokens and revoke only their own; caller-supplied tokens are not revoked.

**Live-run qualification:** the first integrated launch probes exercised S10's existing automatic `POST /api/up-next/refresh` cache recomputation. This was discovered during the navigation audit and disabled for isolated live models before the final UI/model runs. No real session was started, retried, halted, restored, archived, or broadcast to. The final harness regression verifies zero recomputation calls in live read-only mode and normal recomputation outside it.

## Later integration

S9 fills outstanding manual steps; S11 supplies composition and relaunch/archive body changes; S12 supplies settings panes. Richer visual-block rendering and spawn-notice UI remain the streams' explicit deferrals. Other active worktrees were not rebased or modified by this combined post-wave lane. Context7 tools were unavailable; implementation reused local SwiftUI/ShepherdKit APIs and tests.
