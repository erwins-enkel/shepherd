# iOS Agent Sessions: epics with their chain

Date: 2026-10-14

Status: proposed specification; direction approved by the operator ("Vorschlag A"); awaiting
written-spec review; no implementation authorized

Design canvas (private): <https://claude.ai/artifact/LqND3TDZd3rzqyPHiHVL9E> — four artboards
built on the real epic #111 of `media-bib-and-rendering`: the list, the epic sheet, component
states, and the rejected alternative B.

## Problem

In the iOS session list an epic is hard to recognise, and nothing shows how its children depend
on each other.

- The epic group header is drawn in amber (`IOSEpicGroupHeader`). Under DESIGN.md's Four-Light
  Rule amber means "agent working", so the header reads as one more running session. The web
  draws epics in blue (`EpicGroupHeader.svelte`, `EpicBadge.svelte`, the blue rail in
  `HerdEpicGroups.svelte`).
- iOS only loads `GET /api/epics` (`IOSEpicDirectory`): parent title and merged/total counts. It
  never sees the children, their `blockedBy` edges or their states, so it cannot show
  predecessors and successors the way the web's epic detail does ("Braucht zuerst → Dieses
  Issue → Gibt frei", the "Ablauf" flow).

## Selected design (A)

| Option                                                           | Consequence                                                         | Decision |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- | -------- |
| A: blue epic group, chain strip on each card, sheet with the flow | List stays scannable; dependencies visible where the work is        | Selected |
| B: the whole chain as a timeline inside the list                  | One 10-child epic fills the screen; other sessions scroll away      | Rejected |
| C: recolour only, dependencies only in a sheet                    | Cheapest, but predecessor/successor stays hidden behind a tap       | Rejected |

### 1. Epic group header

Blue replaces amber throughout (`SessionListStyle.blue`; a new `SessionListStyle.epicRail` token
for blue at 30 % over `line`, the web's `color-mix(… blue 30%, line)`). Three lines:

1. Chevron (collapse toggle, as today) · repo name (muted) · **EPIC badge** on the right: the
   `epic_badge` label over a meter with one segment per child in epic order — blue merged, amber
   in flight (`running` or `in-review`), line colour otherwise (the web's `epicMeter`). The badge
   is its own button and opens the epic sheet (section 4).
2. Display title (bright) and `#<parent>` (blue). The display title drops a leading `Epic:`
   prefix (case-insensitive) because the badge already says EPIC; accessibility keeps the full
   title.
3. Status line: a neutral chip from `run.status` (`running` → `epic_role_leading` "führt",
   `paused` → "pausiert", `idle` → no chip) · the epic clock "seit 2h 47m" when `timing` is
   present · "Stufe x/y", where x is the lowest stage that still has an unmerged child and y the
   stage count · right-aligned cue chips.

Cue chips mirror the web's `cuesFor`: per group, count rows whose existing `HerdStage` is
`ciFailed` (red, `✕`), `ready` (green, `✓`), `needsRework` or `branchProtectionBlocked` (amber,
`!`), and rows whose display status is blocked (red, `!`). A chip shows only when its count is
above zero, and the chips stay visible while the group is collapsed. Each chip carries the web's
`epic_group_cue_*` text as its accessibility label.

The group's session rows sit behind a 1 pt `epicRail` line on their leading edge, tying them to
the header like the web's `.epic-children`.

### 2. Chain strip on a session card

A session card inside an epic group gains one strip between its body and its meta line, when
the full epic is loaded and the row matches a child (`child.sessionId == session.id`, else
`child.number == session.issueNumber`):

```
BRAUCHT          STUFE 1/4        GIBT FREI
nichts     →     #101       →     #102 · #103
                                  2 parallel
```

- **Braucht** (needs): the child's in-epic blockers. A merged blocker shows as `✓ #n` (muted);
  an unmerged one as `#n offen` with an amber warning glyph (the child was started out of
  order). None: "nichts". At most two numbers, then `+k`.
- **Stufe s/S**: the child's stage and the stage count, over its number.
- **Gibt frei** (unlocks): unmerged siblings whose `blockedBy` contains this child (the web's
  `childUnlocks`), at most two numbers, then `+k`. Below it, "{n} parallel" when at least two
  of them become startable once this child lands. None: "nichts wartet"; if every other child
  is merged, the second line reads "dann landet das Epic".

The strip is one accessibility element ("Braucht nichts. Stufe 1 von 4, #101. Gibt frei #102,
#103, 2 parallel.").

### 3. Children without a session

After the group's cards, one dashed row folds every child that is not merged and matches no row
in the group: "9 WEITERE SCHRITTE" on the left; on the right, for the lowest stage among them,
"{n} bereit" when any of them is ready, else "{n} warten auf #a · #b" (their open blockers, at
most two, then `+k`). No row when nothing is folded. Collapsed by default; the expanded state is
per group and in memory only.

Expanded, the folded children are listed by stage. Stage label: "Stufe s · nach #a · #b" (the
union of the listed members' in-epic blockers). Row: state dot (hollow = waiting, green =
ready), number, step title (the web's `stepTitle`: drop a `#<parent>`-naming prefix), and
"gibt {n} frei" when the child unlocks any sibling. Tapping a row opens the epic sheet.

### 4. Epic sheet

Opened from the EPIC badge; `.sheet` with `.medium` and `.large` detents. It only shows
information. Controlling an epic (start, pause, approve, reorder) stays in the browser, as the
native README already states.

1. Head: repo, display title, `EPIC #<parent>`, the status chip from section 1, close button
   (44 pt).
2. Progress: a wide meter (same tones), "{merged} von {total} zusammengeführt · {k} läuft"
   (`epicflow_merged` plus a new suffix), and a clock line when `timing` is present: running
   time, then "landet ~{when} · Sicherheit {word}" when `forecast.finishAt` is set, or "noch
   ~{dur} ab Fortsetzen" when only `remainingMsFromResume` is (the web's `runMs`,
   `confidenceWord`).
3. **Jetzt**: children in `running` or `in-review` — amber dot, number, step title, `PR #n`
   chip, the session name. Tap opens that session and dismisses the sheet. No slot count: that
   needs the drain status, which is out of scope.
4. **Ablauf**: the stages as a vertical list (the web's flow graph also stacks below 480 px).
   Stage header "1 · zuerst" / "{s} · parallel möglich" (`epicflow_stage_first`,
   `epicflow_stage_parallel`; a single-child later stage shows just its number) and, on the right,
   "nach #a · #b". Nodes: tone dot (green ready, amber active, hollow waiting, slate merged),
   number, step title, and on the right the state for active nodes or "gibt {n} frei". A node
   with a session opens it. Below: the legend (`epicflow_legend_*`) and the slots hint
   (`epicflow_slots_hint`) when the first parallel stage exists.
5. "Im Browser öffnen": opens the active profile's web UI. A deep link to the epic is out of
   scope.

### 5. Degraded states

- Full epic not (yet) loaded, `getEpic` failed (400/404/503) or an older server: the header is
  still blue and shows the summary (badge meter from merged/total only, like `EpicBadge`
  without `live`); no status line beyond what the summary carries, no chain strip, no folded
  row, and the badge is not a button. A failed reload keeps the last known epic.
- Summary unknown too: today's number-only header, in blue.
- A cycle in `blockedBy`: the edge that closes it is ignored for staging (the web's rule), so
  every child gets a finite stage.

## Data and freshness

No server or contract change. `getEpic` and the `Epic`/`EpicChild`/`EpicTiming`/`EpicForecast`
schemas are already generated from `contracts/openapi.swift.yaml`.

- **ShepherdKit**: `ShepherdClient.epic(repoPath:parent:) async throws -> Epic`, mapped like
  `epics(repoPath:)` plus 404 and 503. Public typealiases for the schemas it returns.
- **IOSEpicDirectory**: also keeps the full `Epic` per group, with the same owner, activation
  generation and request guards as the summaries. After a repo's summary read, it fetches
  `getEpic` for each visible parent of that repo.
- **Reload triggers**: today's identity (group, owner, activation) plus a per-group fingerprint:
  each row's session id, `HerdStage` and PR number. A changed fingerprint reloads that group's
  epic, so the chain follows sessions as they move from running to review to merged.
  Pull-to-refresh forces a reload, as today.
- **Not in scope**: subscribing to the server's `epic:update` socket event. It is not in the
  Swift contract; adding it is a follow-up if fingerprint reloads prove too coarse.

## Where the code goes

Pure derivations go in **ShepherdAppCore** (new `Epics/` folder), so they run under
`swift test --package-path native`:

- `EpicFlow`: stages by longest path over in-epic `blockedBy` (cycle-safe, self-references and
  outside edges ignored, walk in `order`; within a stage sort by the mean row of the blockers,
  then `order`). Plus `firstParallelStage`. A port of `ui/src/lib/epic-flow.ts`.
- `EpicChain`: needs (with merged flag), stage, stage count, unlocks, parallel count, "last
  step". A port of `ui/src/lib/components/epic-child.ts`.
- `EpicMeter` tones, `EpicClock.runMs`, display title and `stepTitle`.
- `EpicFold`: the children without a row, grouped by stage, plus the right-hand summary.

**ShepherdIOS** owns only views and wiring: `IOSEpicGroupHeader` (rebuilt), a new
`IOSEpicChainStrip`, a new `IOSEpicFoldRow`, a new `IOSEpicSheet`, an optional chain parameter on
`SessionCardView`, the rail in `SessionListView`, and the `IOSEpicDirectory` changes.

The Mac app does not change.

## Copy

Reuse the web keys that fit: `epic_badge`, `epic_role_leading`, `epic_group_cue_*`,
`childrun_step_unlocks`, `epic_run_after_none`, `epicflow_title`, `epicflow_merged`,
`epicflow_stage_first`, `epicflow_stage_parallel`, `epicflow_legend_*`, `epicflow_slots_hint`,
`epic_state_*`, `epic_tip_confidence_*`. New keys use the `native_ios_epic_` prefix and go into
`ui/messages/en.json` and `de.json`. Examples: the short "Braucht" label, "nichts", "{n}
parallel", "Stufe {s}/{total}", "{n} weitere Schritte", "{n} warten auf {deps}", "gibt {n} frei",
"pausiert", "Jetzt", the clock lines and the strip's accessibility sentence. All keys used go
into `KEYS_IOS_EPICS` in `native/scripts/gen-strings.ts`, and the catalog is regenerated with
`bun native/scripts/gen-strings.ts`. `--check` must pass.

## Accessibility

- Every tappable element has a target of at least 44 pt: header toggle, badge, folded row,
  sheet nodes and close.
- Text uses `sessionFont`, so Dynamic Type works. Hue never stands alone: every coloured chip
  and dot has a label or a glyph, and the dots differ in fill as well as hue.
- The badge button reads "Epic #111 öffnen, 0 von 10 zusammengeführt"; the folded row reports
  expanded or collapsed; the sheet's stages are headers.

## Testing and verification

- **ShepherdAppCoreTests**: `EpicFlowTests` with the #111 graph (stages
  `[101] [102 103] [104 105 106 108 109 110] [107]`, first parallel stage 2), a cycle, a
  self-reference and an outside edge; `EpicChainTests` (101 → unlocks 102, 103 with 2 parallel;
  103 → 6 parallel; 107 → nothing waits, last step once all others merge; an out-of-order start
  shows an open blocker); meter, clock, title and fold tests.
- **ShepherdKitTests**: `epic(repoPath:parent:)` decodes a fixture and maps 404 and 503.
- **ShepherdIOS tests** (extend `IOSEpicGroupingTests`): the directory keeps the full epic, falls
  back to the summary on failure, drops stale responses after a profile switch, and reloads on
  a fingerprint change. Row-to-child matching by session id, then issue number.
- This Linux host has no Swift toolchain. The Swift builds and tests run in the macOS CI, and the
  catalog check runs locally with `bun`. The UI is checked on a device through a TestFlight
  build whose "What to Test" notes describe the epic header, the chain strip, the folded row and
  the sheet (CLAUDE.md requirement).

## Acceptance

1. An epic group in the iOS list is blue (header, badge, rail) and shows progress, status and
   cues, also when collapsed.
2. Every epic session card shows its predecessors, its stage and its successors.
3. Children without a session are reachable from the list, by stage.
4. The EPIC badge opens a sheet with progress, clock and forecast, what runs now, and the whole
   flow by stage.
5. Without the full epic, the list degrades to the blue summary header and nothing breaks.
6. No server, contract or Mac change; Swift tests pass in CI; `gen-strings --check` passes.

## Out of scope

Epic controls on iOS, the `epic:update` socket subscription, the drain status (slot counts and
the "läuft aus" and "eingereiht" roles), a deep link into the web backlog, and the Mac app.
