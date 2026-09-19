# Stream S2 — Session detail tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Shepherd for Mac the four session-detail tabs the web UI has — activity, diff (with inline annotations), files (scratchpad + worktree, read-only) and git/PR — contract-first, without touching a file another parallel stream owns.

**Architecture:** Nine routes and two events go into `contracts/openapi.yaml` inside the `# ── stream: detail ──` markers, exercised by a self-contained `test/contract/detail.test.ts`, derived into `contracts/openapi.swift.yaml` and generated into ShepherdKit. The kit gains one file, `ShepherdClient+Detail.swift`, mapping generated `Output` enums onto values or `ShepherdError` like every existing method. The app gains `native/Apps/ShepherdMac/Sources/Detail/**`: an `@Observable` `DetailModel` (an `AppExtension`, so it is born with the `SessionStore` and dies with it), four `DetailTab` registrations and four views. Tabs refresh by polling while visible, exactly as the web UI does (`pollWhileVisible`: activity 5 s, diff 15 s, git 15 s).

**Tech Stack:** Bun + ajv, `scripts/gen-contract-swift.ts`, swift-openapi-generator 1.13.1, Swift 6 language mode with `SWIFT_STRICT_CONCURRENCY: complete`, SwiftUI (macOS 15), Swift Testing, XcodeGen 2.46.

## Global Constraints

- **The contract is the only type source.** No hand-written `Codable` for a server payload. The one hand-written model here (`UnifiedPatch`) parses a **string** the contract already types (`DiffFile.patch`).
- **ShepherdKit has no UI dependency.** No `import SwiftUI` under `native/Sources/`.
- **Swift 6 strict concurrency.** No `@preconcurrency`, `nonisolated(unsafe)` or `@unchecked Sendable`.
- **i18n:** EN + DE only. New copy goes into `ui/messages/en.json` **and** `de.json` first with the `native_` prefix, then into `KEYS_DETAIL`. Never a string only in Swift. Reuse an existing web key verbatim where the copy already fits.
- **Hover text** (`CLAUDE.md`): plain strings are for short action/status labels only. This plan adds no multi-sentence `help(...)`.
- **Commits:** conventional, lowercase subject, body lines ≤ 100 chars, ending with `Co-Authored-By: <the model executing this task> <noreply@anthropic.com>`.
- **Branch:** `feat/native-detail-tabs`, cut from `origin/main` **after S0-prep merges**. Rebase; never `git merge main`.
- **Never bare `bun test`.** Root: `bun run test`; contract only: `bun run test:contract`.
- **Commands:** `bun run test:contract` · `bun run test` · `bun run lint` · `bun run typecheck` · `bun run gen:contract-swift` · `bun run check:contract-swift` · `./native/scripts/sync-contract.sh [--check]` · `swift build --package-path native` · `swift test --package-path native` · `./native/scripts/test-app.sh -only-testing:ShepherdTests` · `./native/scripts/build-app.sh` · `bun run check:strings`.

### File ownership (hard rule)

May create/modify **only**: the `detail` blocks of `contracts/openapi.yaml`; the regenerated `contracts/openapi.swift.yaml` and `native/Sources/ShepherdKit/openapi.yaml`; `test/contract/detail.test.ts` + `detail-fixtures.ts`; `test/contract/harness.ts` and `openapi.test.ts` (**Task 1 Step 2 only**, only if the stream-scoped gate is not already on main); `native/Sources/ShepherdKit/Client/ShepherdClient+Detail.swift`; `native/Tests/ShepherdKitTests/{ShepherdClientDetailTests,DetailFixtures}.swift`; `native/Apps/ShepherdMac/Sources/Detail/**`; `native/Apps/ShepherdMac/Tests/{DetailModelTests,UnifiedPatchTests,GitPanelTests}.swift`; the `KEYS_DETAIL` array in `native/scripts/gen-strings.ts`; `ui/messages/{en,de}.json`; the regenerated `Localizable.xcstrings`; **one line** at the S0 stream-install point.

**Never touch:** `AppModel.swift`, `MainWindow.swift`, `SessionDetailView.swift`, `WelcomeView.swift`, `ShepherdApp.swift`, `SessionStore.swift`, `ServerEvent.swift`, `EventStream.swift`, `OpenEnum.swift`, `PublicTypes.swift`, `Fixtures.swift`, `test/contract/deps.ts`, `project.yml`, `native.yml`, `src/**`, `ui/src/**`.

`project.yml` needs no edit — the app and test targets take whole directories (`sources: - path: Sources`), so `xcodegen generate` picks up `Sources/Detail/`. `deps.ts` needs no edit either: `makeContractDeps()` exposes `stubs.worktree` for in-place swaps, and `AppDeps.resolveForge` is an optional **mutable** property the routes read per call, so the test installs a fake forge with `s.deps.resolveForge = …` after `startContractServer()`.

### Gate S0 — seams this plan codes against

From `2026-09-19-native-parallel-streams.md`, Appendix B. **Verify before Task 5.** If one is missing, stop and tell the orchestrator — never write a stand-in.

```swift
protocol DetailTab: Identifiable, Sendable where ID == String {
    var id: String { get }; var title: String { get }
    var systemImage: String { get }; var order: Int { get }
    @MainActor func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView
}
@MainActor enum DetailTabRegistry { static func register(_ tab: any DetailTab); static var tabs: [any DetailTab] }
@MainActor protocol AppExtension: AnyObject { init(store: SessionStore, app: AppModel); func teardown() }
extension AppModel { func register<E: AppExtension>(_ type: E.Type); func extension<E: AppExtension>(_ type: E.Type) -> E? }
```

```bash
grep -rn "enum DetailTabRegistry" native/Apps/ShepherdMac/Sources/App/
grep -rn "protocol AppExtension" native/Apps/ShepherdMac/Sources/App/
grep -rn "StreamBootstrap\|installAll\|stream install" native/Apps/ShepherdMac/Sources/App/
```

The third grep names the **stream install point** — the one place every stream adds a single line. This stream's line, added in Task 6: `DetailFeature.install(app)`.

### Decisions locked before Task 1

1. **No `hunks` in the contract.** `GET /diff` runs its result through `toSessionDiff` (`src/diff.ts:217`), which strips `files[].hunks` and sends `files[].patch` — the raw patch block — instead. Task 7 parses it, as the web UI does.
2. **One `GitState` schema for all five git responses.** `GET /git` and ready/draft/close answer the full object; `POST /git/pr|merge` answer the bare PR status with **no `kind`** (the web UI re-attaches it locally, `GitRail.svelte:281`). So `kind` is optional; `state`, `checks`, `deployConfigured` are required everywhere.
3. **Events declared, not dispatched.** Adding `session:git`/`session:activity` to `EventName` adds cases to the generated `EventNameKnown`, which makes the exhaustive `switch name.known` in `ServerEvent.swift:43` non-exhaustive — an S0-owned file. So the contract declares both under `x-shepherd-events` with full payload schemas (the drift test pins them), `EventName` is left alone, and the typed dispatch is an S0 handoff (end of this plan). Until then the tabs poll, which is what the web UI does today.
4. **Downloads out of scope.** `/scratchpad/download` and `/worktree/download` are not in the contract.
5. **`GET /git` 404 is not an error.** It answers 404 both for an unknown session and for a repo with no forge, so the kit maps 404 → `nil` and the panel renders "no PR", mirroring `gitState()` (`ui/src/lib/api.ts:1460`).

### Task order

| # | Task | Deliverable |
| --- | --- | --- |
| 1 | Contract block, fixtures, drift test | `bun run test:contract` green with 9 routes + 2 events |
| 2 | Derivation, sync, generated client | `check:contract-swift` + `swift build` green |
| 3 | Kit reads | `swift test --package-path native` green |
| 4 | Kit PR actions | `swift test --package-path native` green |
| 5 | Copy (`KEYS_DETAIL`, EN + DE) and `DetailModel` | `check:strings` + `ShepherdTests` green |
| 6 | Tab registration + activity tab | activity tab renders |
| 7 | Diff tab + unified-patch parser | diff renders with inline annotations |
| 8 | Files tab | both roots browse |
| 9 | Git/PR tab, live check, PR | branch green, live smoke, PR opened |

---

## Task 1: Contract block, fixtures and the drift test

**Files:**
- Modify: `contracts/openapi.yaml` (the `detail` markers under `components.schemas:`, `paths:` and `x-shepherd-events:`)
- Modify (conditionally): `test/contract/harness.ts`, `test/contract/openapi.test.ts`
- Create: `test/contract/detail-fixtures.ts`, `test/contract/detail.test.ts`

**Interfaces:**
- Consumes: `harness.ts` — `startContractServer`, `withAuth`, `restoreAuth`, `login`, `mintToken`, `bearer`, `validateResponse`, `validateEvent`, `collectEvents`, `coverage`, `declaredOperations`, `loadContract`, `HTTP_METHODS`.
- Produces: schemas `ActivityEntry`, `ActivityList`, `SessionActivitySignal`, `SessionActivityEvent`, `DiffFile`, `DiffResult`, `DiffNote`, `DiffAnnotations`, `BrowseEntry`, `BrowseListing`, `PrReview`, `GitState`, `SessionGitEvent`, `PrReviewerOptions`, `ReviewRequestAck`, `ReviewRequestBody`, `OpenPrBody`, `MergePrBody`, `CodeError`; open enums `ActivityStatus`, `DiffFileStatus`, `DiffNoteKind`, `DiffNoteSide`, `BrowseEntryType`, `ForgeKind`, `PrState`, `ChecksState`, `MergeStateStatus`, `PrReviewState`; closed `MergeMethod`. Operation ids `getSessionActivity`, `getSessionDiff`, `getSessionDiffAnnotations`, `getSessionScratchpad`, `getSessionWorktree`, `getSessionGit`, `openPullRequest`, `mergePullRequest`, `setPullRequestReady`, `setPullRequestDraft`, `closePullRequest`, `requestPullRequestReview`, `getPullRequestReviewers`.

- [ ] **Step 1: Cut the branch, confirm the markers**

```bash
git fetch origin && git switch -c feat/native-detail-tabs origin/main
grep -n "stream: detail" contracts/openapi.yaml
```

Expected: two marker pairs (`# ── stream: detail ──` / `# ── /stream: detail ──`), one under `components.schemas:` and one under `paths:`. No hits ⇒ S0-prep has not merged; stop.

- [ ] **Step 2: Make the base coverage gate stream-aware (skip if already done)**

`bun test` gives every test file its **own module registry** — verified: a `Set` exported from a shared module is empty in the second file. So coverage recorded in `detail.test.ts` is invisible to the gate in `openapi.test.ts`, which would fail on every route declared here.

```bash
grep -n "streamBlockSurface" test/contract/harness.ts
```

A hit ⇒ another stream already landed this; skip to Step 3. Otherwise append to `test/contract/harness.ts`:

```ts
/** Path templates and event names declared inside a `# ── stream: <name> ──` block, per stream.
 *  Each stream owns one contract-test file and asserts its own coverage there, so the base gate
 *  skips what a block claims. Read off the raw YAML because `Bun.YAML.parse` drops comments. */
export function streamBlockSurface(): Record<string, { templates: string[]; events: string[] }> {
  const out: Record<string, { templates: string[]; events: string[] }> = {};
  let section = "";
  let stream: string | null = null;
  for (const line of readFileSync(CONTRACT_PATH, "utf8").split("\n")) {
    const top = /^([A-Za-z][\w-]*):/.exec(line);
    if (top) section = top[1]!;
    const open = /^\s*# ── stream: (\S+) ──/.exec(line);
    if (open) {
      stream = open[1]!;
      out[stream] ??= { templates: [], events: [] };
      continue;
    }
    if (/^\s*# ── \/stream: \S+ ──/.test(line)) {
      stream = null;
      continue;
    }
    if (stream === null) continue;
    const key = /^ {2}(\S+?):\s*$/.exec(line);
    if (!key) continue;
    if (section === "paths" && key[1]!.startsWith("/")) out[stream]!.templates.push(key[1]!);
    if (section === "x-shepherd-events") out[stream]!.events.push(key[1]!);
  }
  return out;
}

/** The union of every stream block's claim — what the base coverage gate skips. */
export function claimedSurface(): { templates: Set<string>; events: Set<string> } {
  const templates = new Set<string>();
  const events = new Set<string>();
  for (const claim of Object.values(streamBlockSurface())) {
    for (const t of claim.templates) templates.add(t);
    for (const e of claim.events) events.add(e);
  }
  return { templates, events };
}
```

Then replace the body of the last test in `test/contract/openapi.test.ts` and add `claimedSurface` to its `./harness` imports:

```ts
  test("every declared operation and event was exercised", () => {
    const { operations, events } = coverage();
    // Surface inside a `# ── stream: … ──` block belongs to that stream's own contract-test
    // file, which runs in its own module registry and gates its own coverage there.
    const claimed = claimedSurface();
    const missingOps = declaredOperations().filter(
      (o) => !operations.has(o) && !claimed.templates.has(o.split(" ")[1]!),
    );
    const missingEvents = declaredEvents().filter((e) => !events.has(e) && !claimed.events.has(e));
    expect(missingOps).toEqual([]);
    expect(missingEvents).toEqual([]);
  });
```

- [ ] **Step 3: Write the schemas**

Between the `detail` markers under `components.schemas:`:

```yaml
    CodeError:
      type: object
      additionalProperties: true
      description: The review-request family answers with a machine code rather than prose.
      required: [code]
      properties:
        code: { type: string }
        error: { type: string }
    ActivityStatus:
      type: string
      enum: [ok, error, pending]
      x-shepherd-open-enum: true
    ActivityEntry:
      type: object
      additionalProperties: true
      description: One tool-use line of the agent transcript (src/activity.ts).
      required: [ts, tool, summary, status]
      properties:
        ts: { type: integer, description: Epoch ms of the tool-use message. }
        tool: { type: string, description: 'Raw tool name, e.g. "Edit".' }
        summary: { type: string }
        status:
          $ref: "#/components/schemas/ActivityStatus"
    ActivityList:
      type: array
      description: Oldest first, capped server-side (30 by default).
      items:
        $ref: "#/components/schemas/ActivityEntry"
    SessionActivitySignal:
      type: object
      additionalProperties: true
      description: The poller's per-session heartbeat (src/activity-signal.ts).
      required: [lastActivityTs, summary, recentTs, recentErrTs]
      properties:
        lastActivityTs: { type: integer, description: Epoch ms of the newest record; 0 when there is none. }
        summary: { type: [string, "null"] }
        recentTs: { type: array, items: { type: integer } }
        recentErrTs: { type: array, items: { type: integer } }
        runtimeModel: { type: string }
        runtimeEffort: { type: string }
    SessionActivityEvent:
      type: object
      additionalProperties: true
      required: [id, activity]
      properties:
        id: { type: string }
        activity:
          $ref: "#/components/schemas/SessionActivitySignal"
    DiffFileStatus:
      type: string
      enum: [added, modified, deleted, renamed]
      x-shepherd-open-enum: true
    DiffFile:
      type: object
      additionalProperties: true
      required: [path, status, additions, deletions, binary]
      properties:
        path: { type: string, description: New path; the /dev/null side is resolved away. }
        oldPath: { type: string, description: Set only when the file was renamed. }
        status:
          $ref: "#/components/schemas/DiffFileStatus"
        additions: { type: integer }
        deletions: { type: integer }
        binary: { type: boolean }
        truncated: { type: boolean, description: Over the line cap; no patch is sent. }
        patch:
          type: string
          description: >-
            Raw unified git patch block. This route strips the parsed hunks (src/diff.ts
            toSessionDiff) and sends the patch text instead; absent for binary and truncated files.
    DiffResult:
      type: object
      additionalProperties: true
      required: [base, baseRef, head, fetchFailed, truncated, files]
      properties:
        base: { type: string, description: 'Logical base branch, e.g. "main".' }
        baseRef: { type: string, description: 'Ref actually diffed against, e.g. "origin/main".' }
        head: { type: [string, "null"], description: Session branch; null when not isolated. }
        fetchFailed: { type: boolean, description: git fetch failed; the local base was used. }
        truncated: { type: boolean }
        files: { type: array, items: { $ref: "#/components/schemas/DiffFile" } }
    DiffNoteKind:
      type: string
      enum: [agent, review]
      x-shepherd-open-enum: true
    DiffNoteSide:
      type: string
      enum: [additions, deletions]
      x-shepherd-open-enum: true
    DiffNote:
      type: object
      additionalProperties: true
      description: >-
        An annotation on the diff. `agent` notes carry side+lineNumber+tool; `review` notes are
        file-level (path) or panel-level (path is the empty string).
      required: [path, kind, text]
      properties:
        path: { type: string }
        kind:
          $ref: "#/components/schemas/DiffNoteKind"
        text: { type: string }
        side:
          $ref: "#/components/schemas/DiffNoteSide"
        lineNumber: { type: integer }
        tool: { type: string }
    DiffAnnotations:
      type: object
      additionalProperties: true
      required: [notes]
      properties:
        notes: { type: array, items: { $ref: "#/components/schemas/DiffNote" } }
    BrowseEntryType:
      type: string
      enum: [file, dir]
      x-shepherd-open-enum: true
    BrowseEntry:
      type: object
      additionalProperties: true
      required: [name, type, path]
      properties:
        name: { type: string }
        type:
          $ref: "#/components/schemas/BrowseEntryType"
        path: { type: string, description: Relative to the root, forward slashes, no leading slash. }
        createdMs: { type: integer, description: Birth time when recorded, else mtime; absent when stat failed. }
        linkOutside: { type: boolean, description: Worktree only — a symlink resolving outside the root. }
        attachments: { type: boolean, description: Scratchpad only — the synthetic Attachments folder. }
    BrowseListing:
      type: object
      additionalProperties: true
      required: [path, parent, entries]
      properties:
        path: { type: string, description: The directory listed, relative to the root ("" is the root). }
        parent: { type: [string, "null"] }
        entries: { type: array, items: { $ref: "#/components/schemas/BrowseEntry" } }
    ForgeKind:
      type: string
      enum: [github, gitea, local]
      x-shepherd-open-enum: true
    PrState:
      type: string
      enum: [none, open, merged, closed]
      x-shepherd-open-enum: true
    ChecksState:
      type: string
      enum: [none, pending, success, failure]
      x-shepherd-open-enum: true
    MergeStateStatus:
      type: string
      enum: [behind, blocked, clean, dirty, draft, has_hooks, unknown, unstable]
      x-shepherd-open-enum: true
    PrReviewState:
      type: string
      enum: [approved, changes_requested, commented]
      x-shepherd-open-enum: true
    PrReview:
      type: object
      additionalProperties: true
      required: [state, author, submittedAt]
      properties:
        state:
          $ref: "#/components/schemas/PrReviewState"
        author: { type: string }
        submittedAt: { type: integer }
    GitState:
      type: object
      additionalProperties: true
      description: >-
        PR + forge state for one session. GET /git and ready/draft/close answer the full object;
        POST /git/pr and /git/merge answer the bare PR status, which carries no `kind` (the web UI
        re-attaches it client-side). Treat `kind` as optional.
      required: [state, checks, deployConfigured]
      properties:
        kind:
          $ref: "#/components/schemas/ForgeKind"
        state:
          $ref: "#/components/schemas/PrState"
        number: { type: integer }
        url: { type: string }
        title: { type: string }
        createdAt: { type: integer }
        mergeable: { type: [boolean, "null"], description: null while the host is still computing. }
        checks:
          $ref: "#/components/schemas/ChecksState"
        mergeStateStatus:
          $ref: "#/components/schemas/MergeStateStatus"
        isDraft: { type: boolean }
        isFork: { type: boolean }
        noCi: { type: boolean }
        authorLogin: { type: string }
        requestedReviewers: { type: array, items: { type: string } }
        latestReview:
          $ref: "#/components/schemas/PrReview"
        issueUrl: { type: string }
        deployConfigured: { type: boolean }
    SessionGitEvent:
      type: object
      additionalProperties: true
      required: [id, git]
      properties:
        id: { type: string }
        git:
          $ref: "#/components/schemas/GitState"
    PrReviewerOptions:
      type: object
      additionalProperties: true
      required:
        [logins, unavailable, prNumber, repoSlug, isFork, requestedReviewers, authorLogin, defaultReviewer, isDraft]
      properties:
        logins: { type: array, items: { type: string } }
        unavailable: { type: boolean, description: The host refused the list, or the forge has none. }
        prNumber: { type: integer }
        repoSlug: { type: [string, "null"] }
        isFork: { type: boolean }
        requestedReviewers: { type: array, items: { type: string } }
        authorLogin: { type: [string, "null"] }
        defaultReviewer: { type: [string, "null"] }
        isDraft: { type: boolean }
    ReviewRequestAck:
      type: object
      additionalProperties: true
      required: [ok]
      properties:
        ok: { type: boolean, const: true }
        refreshPending:
          type: boolean
          description: Requested, but the server's follow-up status read failed; re-read GET /git.
    ReviewRequestBody:
      type: object
      additionalProperties: false
      required: [prNumber, reviewer]
      properties:
        prNumber: { type: integer, minimum: 1 }
        reviewer: { type: string, pattern: "^[a-z\\d](?:[a-z\\d]|-(?=[a-z\\d])){0,38}$" }
    OpenPrBody:
      type: object
      additionalProperties: false
      description: Both optional; the server falls back to the session's name and prompt.
      properties:
        title: { type: string }
        body: { type: string }
    MergeMethod:
      type: string
      enum: [merge, squash, rebase]
    MergePrBody:
      type: object
      additionalProperties: false
      description: Both optional; the server falls back to the forge default and deleteBranch true.
      properties:
        method:
          $ref: "#/components/schemas/MergeMethod"
        deleteBranch: { type: boolean }
```

- [ ] **Step 4: Write the paths**

Between the `detail` markers under `paths:`. Every operation is secured (no `security: []`), so the sweep in Step 7 covers its 401.

```yaml
  /api/sessions/{id}/activity:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    get:
      operationId: getSessionActivity
      description: Recent tool use from the agent transcript. An unreadable transcript is an empty list.
      responses:
        "200":
          description: Activity, oldest first.
          content: { application/json: { schema: { $ref: "#/components/schemas/ActivityList" } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown id.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
  /api/sessions/{id}/diff:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    get:
      operationId: getSessionDiff
      description: The session branch against its base. Files carry `patch`, not parsed hunks.
      responses:
        "200":
          description: Diff.
          content: { application/json: { schema: { $ref: "#/components/schemas/DiffResult" } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown id.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
        "500":
          description: git failed (missing worktree, unresolvable base).
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
  /api/sessions/{id}/diff/annotations:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    get:
      operationId: getSessionDiffAnnotations
      description: Agent and review notes on the diff. Best effort — any failure answers an empty list.
      responses:
        "200":
          description: Notes.
          content: { application/json: { schema: { $ref: "#/components/schemas/DiffAnnotations" } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown id.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
  /api/sessions/{id}/scratchpad:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
      - name: path
        in: query
        required: false
        description: Directory relative to the scratchpad root; omitted lists the root.
        schema: { type: string }
    get:
      operationId: getSessionScratchpad
      responses:
        "200":
          description: One directory of the scratchpad.
          content: { application/json: { schema: { $ref: "#/components/schemas/BrowseListing" } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown or archived session, or a path that is not a directory under the root.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
  /api/sessions/{id}/worktree:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
      - name: path
        in: query
        required: false
        description: Directory relative to the worktree root; omitted lists the root.
        schema: { type: string }
    get:
      operationId: getSessionWorktree
      description: Read-only worktree listing. `.git` is hidden; symlinks out of the root are marked.
      responses:
        "200":
          description: One directory of the worktree.
          content: { application/json: { schema: { $ref: "#/components/schemas/BrowseListing" } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown or archived session, or a path that is not a directory under the root.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
  /api/sessions/{id}/git:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    get:
      operationId: getSessionGit
      description: PR and forge state. 404 covers both an unknown session and a repo with no forge.
      responses:
        "200":
          description: Git state.
          content: { application/json: { schema: { $ref: "#/components/schemas/GitState" } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown id, or no forge for this repo.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
        "502":
          description: The forge failed.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
  /api/sessions/{id}/git/pr:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    post:
      operationId: openPullRequest
      description: Opens a PR for the session branch. Answers the bare PR status — no `kind`.
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/OpenPrBody" } } }
      responses:
        "200":
          description: PR opened.
          content: { application/json: { schema: { $ref: "#/components/schemas/GitState" } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown id, or no forge for this repo.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
        "409":
          description: No commits to merge.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
        "502":
          description: The forge failed.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
  /api/sessions/{id}/git/merge:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    post:
      operationId: mergePullRequest
      description: Merges the open PR. Answers the bare PR status — no `kind`.
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/MergePrBody" } } }
      responses:
        "200":
          description: Merged.
          content: { application/json: { schema: { $ref: "#/components/schemas/GitState" } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown id, or no forge for this repo.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
        "409":
          description: No open PR, a merge conflict, or a busy base checkout (see the error text).
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
        "502":
          description: The forge failed, or the host only enqueued the merge (see `code`).
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
  /api/sessions/{id}/git/ready:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    post:
      operationId: setPullRequestReady
      description: Marks the PR ready for review. Idempotent when it already is.
      responses:
        "200":
          description: Git state after the change.
          content: { application/json: { schema: { $ref: "#/components/schemas/GitState" } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown id, or no forge for this repo.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
        "409":
          description: No open PR, or draft mode still awaiting sign-off (`code: draft_awaiting_signoff`).
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
        "502":
          description: The forge failed.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
  /api/sessions/{id}/git/draft:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    post:
      operationId: setPullRequestDraft
      description: Converts the PR back to a draft. Idempotent when it already is one.
      responses:
        "200":
          description: Git state after the change.
          content: { application/json: { schema: { $ref: "#/components/schemas/GitState" } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown id, or no forge for this repo.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
        "409":
          description: No open PR.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
        "502":
          description: The forge failed.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
  /api/sessions/{id}/git/close:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    post:
      operationId: closePullRequest
      responses:
        "200":
          description: Git state after the close.
          content: { application/json: { schema: { $ref: "#/components/schemas/GitState" } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown id, or no forge for this repo.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
        "409":
          description: No open PR.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
        "502":
          description: The forge failed.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
  /api/sessions/{id}/git/reviewers:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    get:
      operationId: getPullRequestReviewers
      description: Candidate reviewers for the open PR. GitHub only.
      responses:
        "200":
          description: Reviewer options.
          content: { application/json: { schema: { $ref: "#/components/schemas/PrReviewerOptions" } } }
        "400":
          description: This forge cannot request reviews (`code: review_request_unsupported`).
          content: { application/json: { schema: { $ref: "#/components/schemas/CodeError" } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown id, or no forge for this repo.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
        "409":
          description: No open PR to request a review on (`code: review_request_stale`).
          content: { application/json: { schema: { $ref: "#/components/schemas/CodeError" } } }
  /api/sessions/{id}/git/request-review:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    post:
      operationId: requestPullRequestReview
      description: Requests a human review. GitHub only; an already-requested reviewer is a no-op success.
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/ReviewRequestBody" } } }
      responses:
        "200":
          description: Requested.
          content: { application/json: { schema: { $ref: "#/components/schemas/ReviewRequestAck" } } }
        "400":
          description: Unsupported forge, or an invalid body/reviewer (`code`).
          content: { application/json: { schema: { $ref: "#/components/schemas/CodeError" } } }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown id, or no forge for this repo.
          content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
        "409":
          description: The PR is stale or still a draft (`code`).
          content: { application/json: { schema: { $ref: "#/components/schemas/CodeError" } } }
```

- [ ] **Step 5: Declare the two events**

Between the `detail` markers under the top-level `x-shepherd-events:`:

```yaml
  # NOT added to the EventName enum on this branch: a new member adds a case to the generated
  # EventNameKnown, which makes the exhaustive `switch name.known` in ServerEvent.swift
  # non-exhaustive — an S0-owned file. See this plan's S0 handoff. Until it lands these names
  # decode as ServerEvent.unknown and are ignored by the client.
  session:git:
    description: PR/forge state for one session changed (poller push, or a PR action).
    schema:
      $ref: "#/components/schemas/SessionGitEvent"
  session:activity:
    description: The agent transcript heartbeat moved.
    schema:
      $ref: "#/components/schemas/SessionActivityEvent"
```

- [ ] **Step 6: Write the fixtures**

Create `test/contract/detail-fixtures.ts`:

```ts
import type { SessionActivity } from "../../src/activity-signal";
import { EmptyDiffError, type GitForge, type GitState, type PrStatus } from "../../src/forge/types";

/** Event payloads, annotated with the server's own types so a shape change in src/ breaks
 *  `bun run typecheck` before it can drift out of the contract. */
export const gitEvent: { id: string; git: GitState } = {
  id: "sess_fixture",
  git: {
    kind: "github",
    state: "open",
    number: 12,
    url: "https://github.com/acme/demo/pull/12",
    title: "add the thing",
    createdAt: 1_800_000_000_000,
    mergeable: true,
    checks: "success",
    mergeStateStatus: "clean",
    isDraft: false,
    deployConfigured: false,
    requestedReviewers: ["octocat"],
    authorLogin: "shepherd-bot",
    latestReview: { state: "approved", author: "octocat", submittedAt: 1_800_000_100_000 },
  },
};

export const activityEvent: { id: string; activity: SessionActivity } = {
  id: "sess_fixture",
  activity: {
    lastActivityTs: 1_800_000_000_000,
    summary: "edited server.ts",
    recentTs: [1_800_000_000_000],
    recentErrTs: [],
    runtimeModel: "fable",
    runtimeEffort: "high",
  },
};

const openStatus: PrStatus = {
  state: "open",
  number: 12,
  url: "https://github.com/acme/demo/pull/12",
  title: "add the thing",
  checks: "success",
  isDraft: false,
  deployConfigured: false,
  authorLogin: "shepherd-bot",
  requestedReviewers: [],
};

/** A hand-rolled forge. `GitForge` is a wide interface and these routes touch only these
 *  members, so the cast mirrors how deps.ts stubs herdr and worktree. Nothing shells out. */
export function makeForge(over: Record<string, unknown> = {}): GitForge {
  return {
    kind: "github",
    slug: "acme/demo",
    mergeMethod: "squash",
    deployWorkflow: null,
    isFork: false,
    prStatus: async () => openStatus,
    openPr: async () => openStatus,
    mergePr: async () => undefined,
    closePr: async () => undefined,
    markReady: async () => undefined,
    convertToDraft: async () => undefined,
    requestReview: async () => undefined,
    listCollaborators: async () => ({ logins: ["octocat", "hubot"], unavailable: false }),
    ...over,
  } as unknown as GitForge;
}

/** No PR at all — every action needing one answers 409. */
export const noPrForge = (): GitForge =>
  makeForge({ prStatus: async () => ({ state: "none", checks: "none", deployConfigured: false }) });

/** Every call fails, so the /git family's 502 catch-all is reachable. */
export const angryForge = (): GitForge =>
  makeForge({
    prStatus: async () => {
      throw new Error("boom");
    },
  });

/** openPr rejects with the typed "nothing to land" error the route maps to 409. */
export const emptyDiffForge = (): GitForge =>
  makeForge({
    openPr: async () => {
      throw new EmptyDiffError("shepherd/x", "main");
    },
  });
```

- [ ] **Step 7: Write the drift test**

Create `test/contract/detail.test.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fx from "./detail-fixtures";
import {
  bearer, collectEvents, coverage, declaredOperations, HTTP_METHODS, loadContract, login,
  mintToken, restoreAuth, startContractServer, streamBlockSurface, validateEvent, validateResponse,
  withAuth, type ContractServer, type Operation,
} from "./harness";

const STREAM = "detail";
let s: ContractServer;
let token: string;
/** A session with a REAL worktree directory and a null branch: the diff route then takes
 *  computeDiff's non-isolated short circuit instead of shelling out to git. */
let ok = "";
/** A session whose worktree path does not exist, so git throws and /diff answers 500. */
let broken = "";

async function create(): Promise<string> {
  const res = await fetch(`${s.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ repoPath: s.validRepo, baseBranch: "main", prompt: "detail" }),
  });
  return ((await res.json()) as { id: string }).id;
}
const get = (path: string) => fetch(`${s.baseUrl}${path}`, { headers: bearer(token) });
const post = (path: string, body?: unknown) =>
  fetch(`${s.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify(body ?? {}),
  });

beforeAll(async () => {
  await withAuth();
  s = startContractServer();
  ({ token } = await mintToken(s, await login(s)));
  broken = await create();

  const worktree = join(s.tmpRoot, "wt-ok");
  mkdirSync(join(worktree, "docs"), { recursive: true });
  writeFileSync(join(worktree, "README.md"), "hi\n");
  const create0 = s.stubs.worktree.create;
  s.stubs.worktree.create = () => ({ worktreePath: worktree, branch: null, isolated: false });
  try {
    ok = await create();
  } finally {
    s.stubs.worktree.create = create0;
  }
  // A non-empty claudeSessionId makes the scratchpad root resolve to the synthetic empty listing
  // instead of 404, and resolveGitState reads worktree.currentBranch, which the shared stub does
  // not define — a missing method would otherwise surface as the /git family's 502.
  s.deps.store.update(ok, { claudeSessionId: "claude-ok" });
  s.stubs.worktree.currentBranch = () => null;
});
afterAll(() => {
  try {
    s?.stop();
  } finally {
    restoreAuth();
  }
});

describe("detail: reads", () => {
  test("GET /activity answers a list; an unknown id is 404", async () => {
    const res = await get(`/api/sessions/${ok}/activity`);
    const body = (await validateResponse("GET", "/api/sessions/{id}/activity", res)) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    const missing = await get(`/api/sessions/nope/activity`);
    await validateResponse("GET", "/api/sessions/{id}/activity", missing);
    expect(missing.status).toBe(404);
  });

  test("GET /diff short-circuits for a branchless session, 500s without a worktree, 404s for an unknown id", async () => {
    const res = await get(`/api/sessions/${ok}/diff`);
    const body = (await validateResponse("GET", "/api/sessions/{id}/diff", res)) as {
      head: string | null;
      files: unknown[];
    };
    expect(body.head).toBe(null);
    expect(body.files).toEqual([]);
    const failed = await get(`/api/sessions/${broken}/diff`);
    await validateResponse("GET", "/api/sessions/{id}/diff", failed);
    expect(failed.status).toBe(500);
    const missing = await get(`/api/sessions/nope/diff`);
    await validateResponse("GET", "/api/sessions/{id}/diff", missing);
    expect(missing.status).toBe(404);
  });

  test("GET /diff/annotations degrades to an empty list; an unknown id is 404", async () => {
    const res = await get(`/api/sessions/${broken}/diff/annotations`);
    const body = (await validateResponse("GET", "/api/sessions/{id}/diff/annotations", res)) as {
      notes: unknown[];
    };
    expect(body.notes).toEqual([]);
    const missing = await get(`/api/sessions/nope/diff/annotations`);
    await validateResponse("GET", "/api/sessions/{id}/diff/annotations", missing);
    expect(missing.status).toBe(404);
  });

  test("GET /scratchpad lists the synthetic root; an escaping path is 404", async () => {
    const res = await get(`/api/sessions/${ok}/scratchpad`);
    const body = (await validateResponse("GET", "/api/sessions/{id}/scratchpad", res)) as {
      parent: string | null;
    };
    expect(body.parent).toBe(null);
    const bad = await get(`/api/sessions/${ok}/scratchpad?path=../escape`);
    await validateResponse("GET", "/api/sessions/{id}/scratchpad", bad);
    expect(bad.status).toBe(404);
  });

  test("GET /worktree lists a real directory and descends into it", async () => {
    const root = await get(`/api/sessions/${ok}/worktree`);
    const body = (await validateResponse("GET", "/api/sessions/{id}/worktree", root)) as {
      entries: { name: string }[];
    };
    expect(body.entries.map((e) => e.name).sort()).toEqual(["README.md", "docs"]);
    const child = await get(`/api/sessions/${ok}/worktree?path=docs`);
    await validateResponse("GET", "/api/sessions/{id}/worktree", child);
    expect(child.status).toBe(200);
    const missing = await get(`/api/sessions/nope/worktree`);
    await validateResponse("GET", "/api/sessions/{id}/worktree", missing);
    expect(missing.status).toBe(404);
  });
});

describe("detail: git", () => {
  const actions = ["pr", "merge", "ready", "draft", "close"] as const;

  test("every git route 404s while no forge is configured", async () => {
    for (const path of ["git", "git/reviewers"]) {
      const res = await get(`/api/sessions/${ok}/${path}`);
      await validateResponse("GET", `/api/sessions/{id}/${path}`, res);
      expect(res.status).toBe(404);
    }
    for (const action of [...actions, "request-review"]) {
      const res = await post(`/api/sessions/${ok}/git/${action}`, {
        prNumber: 12,
        reviewer: "octocat",
      });
      await validateResponse("POST", `/api/sessions/{id}/git/${action}`, res);
      expect(res.status, action).toBe(404);
    }
  });

  test("an open PR answers 200 everywhere", async () => {
    s.deps.resolveForge = () => fx.makeForge();
    try {
      const state = await get(`/api/sessions/${ok}/git`);
      const git = (await validateResponse("GET", "/api/sessions/{id}/git", state)) as {
        kind: string;
        state: string;
      };
      expect(git.kind).toBe("github");
      expect(git.state).toBe("open");
      for (const action of actions) {
        const res = await post(`/api/sessions/${ok}/git/${action}`);
        await validateResponse("POST", `/api/sessions/{id}/git/${action}`, res);
        expect(res.status, action).toBe(200);
      }
      const reviewers = await get(`/api/sessions/${ok}/git/reviewers`);
      const options = (await validateResponse(
        "GET", "/api/sessions/{id}/git/reviewers", reviewers,
      )) as { logins: string[] };
      expect(options.logins).toContain("octocat");
      const requested = await post(`/api/sessions/${ok}/git/request-review`, {
        prNumber: 12,
        reviewer: "octocat",
      });
      const ack = (await validateResponse(
        "POST", "/api/sessions/{id}/git/request-review", requested,
      )) as { ok: boolean };
      expect(ack.ok).toBe(true);
    } finally {
      delete s.deps.resolveForge;
    }
  });

  test("no open PR is 409 everywhere it matters", async () => {
    s.deps.resolveForge = () => fx.noPrForge();
    try {
      for (const action of ["merge", "ready", "draft", "close"]) {
        const res = await post(`/api/sessions/${ok}/git/${action}`);
        await validateResponse("POST", `/api/sessions/{id}/git/${action}`, res);
        expect(res.status, action).toBe(409);
      }
      const reviewers = await get(`/api/sessions/${ok}/git/reviewers`);
      const body = (await validateResponse(
        "GET", "/api/sessions/{id}/git/reviewers", reviewers,
      )) as { code: string };
      expect(reviewers.status).toBe(409);
      expect(body.code).toBe("review_request_stale");
      const review = await post(`/api/sessions/${ok}/git/request-review`, {
        prNumber: 12,
        reviewer: "octocat",
      });
      await validateResponse("POST", "/api/sessions/{id}/git/request-review", review);
      expect(review.status).toBe(409);
    } finally {
      delete s.deps.resolveForge;
    }
  });

  test("an empty diff is 409 on /git/pr", async () => {
    s.deps.resolveForge = () => fx.emptyDiffForge();
    try {
      const res = await post(`/api/sessions/${ok}/git/pr`);
      await validateResponse("POST", "/api/sessions/{id}/git/pr", res);
      expect(res.status).toBe(409);
    } finally {
      delete s.deps.resolveForge;
    }
  });

  test("a forge that throws is 502; a forge that cannot review is 400", async () => {
    s.deps.resolveForge = () => fx.angryForge();
    try {
      const state = await get(`/api/sessions/${ok}/git`);
      await validateResponse("GET", "/api/sessions/{id}/git", state);
      expect(state.status).toBe(502);
      for (const action of actions) {
        const res = await post(`/api/sessions/${ok}/git/${action}`);
        await validateResponse("POST", `/api/sessions/{id}/git/${action}`, res);
        expect(res.status, action).toBe(502);
      }
    } finally {
      delete s.deps.resolveForge;
    }
    s.deps.resolveForge = () => fx.makeForge({ kind: "local", requestReview: undefined });
    try {
      const reviewers = await get(`/api/sessions/${ok}/git/reviewers`);
      const body = (await validateResponse(
        "GET", "/api/sessions/{id}/git/reviewers", reviewers,
      )) as { code: string };
      expect(reviewers.status).toBe(400);
      expect(body.code).toBe("review_request_unsupported");
      const review = await post(`/api/sessions/${ok}/git/request-review`, {
        prNumber: 12,
        reviewer: "octocat",
      });
      await validateResponse("POST", "/api/sessions/{id}/git/request-review", review);
      expect(review.status).toBe(400);
    } finally {
      delete s.deps.resolveForge;
    }
  });
});

describe("detail: events", () => {
  test("typed fixtures for session:git and session:activity match the contract", async () => {
    const emits: [string, unknown][] = [
      ["session:git", fx.gitEvent],
      ["session:activity", fx.activityEvent],
    ];
    const frames = await collectEvents(s, token, async () => {
      for (const [name, data] of emits) s.deps.events.emit(name, data);
    });
    for (const [name, data] of emits) {
      const seen = frames.find(
        (f) => f.event === name && JSON.stringify(f.data) === JSON.stringify(data),
      );
      expect(seen, `frame ${name} not received`).toBeTruthy();
      validateEvent(name, seen!.data);
    }
  });
});

describe("detail: unauthenticated sweep", () => {
  test("every detail route rejects a credential-less request with 401", async () => {
    for (const template of streamBlockSurface()[STREAM]!.templates) {
      for (const [method, op] of Object.entries(loadContract().paths[template]!)) {
        if (!HTTP_METHODS.includes(method as never)) continue;
        if (!(op as Operation).responses["401"]) continue;
        const init: RequestInit = { method: method.toUpperCase() };
        if (method === "post") {
          init.headers = { "content-type": "application/json" };
          init.body = "{}";
        }
        const res = await fetch(`${s.baseUrl}${template.replace(/\{[^}]+\}/g, "x")}`, init);
        await validateResponse(method.toUpperCase(), template, res);
        expect(res.status, `${method} ${template}`).toBe(401);
      }
    }
  });
});

// Stays the LAST describe in this file: it gates everything above it.
describe("detail: coverage gate", () => {
  test("every operation and event in the detail block was exercised", () => {
    const { operations, events } = coverage();
    const claim = streamBlockSurface()[STREAM]!;
    const templates = new Set(claim.templates);
    expect(
      declaredOperations().filter((o) => templates.has(o.split(" ")[1]!) && !operations.has(o)),
    ).toEqual([]);
    expect(claim.events.filter((e) => !events.has(e))).toEqual([]);
  });
});
```

- [ ] **Step 8: Run the contract suite, lint and typecheck**

```bash
bun run test:contract && bun run typecheck && bun run lint
```

Expected: every contract file passes, both coverage gates report `[]`, `tsc` silent, `eslint` exits 0. A missing `METHOD /template status` in the detail gate means that status was never driven — add the case, never delete the declaration.

- [ ] **Step 9: Commit**

```bash
git add contracts/openapi.yaml test/contract/
git commit -m "feat(contract): session detail routes and events for the native client"
```

---

## Task 2: Derivation, sync and the generated client

**Files:**
- Modify (generated): `contracts/openapi.swift.yaml`, `native/Sources/ShepherdKit/openapi.yaml`
- Create: `native/Tests/ShepherdKitTests/DetailFixtures.swift`

**Interfaces:**
- Consumes: Task 1's contract block.
- Produces: the generated `Components.Schemas.*` detail types with their `<Name>Known` companions, plus `enum DetailFixtures` (raw JSON reused by Tasks 3–4).

- [ ] **Step 1: Derive, sync, prove both fresh**

```bash
bun run gen:contract-swift && ./native/scripts/sync-contract.sh
bun run check:contract-swift && ./native/scripts/sync-contract.sh --check
```

Expected: `sync-contract: contracts/openapi.swift.yaml -> native/Sources/ShepherdKit/openapi.yaml`, then no diff and `sync-contract: up to date`. A thrown JSON pointer means a schema used a construct the derivation refuses (a nullable union outside `properties`, a flagged enum inside `allOf`) — fix the schema, never the derivation.

- [ ] **Step 2: Build the kit**

```bash
swift build --package-path native
```

Expected: `Build complete!` with **zero** unsupported-schema warnings.

- [ ] **Step 3: Write the fixtures and the shape test**

Create `native/Tests/ShepherdKitTests/DetailFixtures.swift` (a new file, not an addition to the shared `Fixtures.swift`):

```swift
import Foundation
import Testing

@testable import ShepherdKit

/// Raw JSON for the detail routes, kept as text so the tests prove the generated models decode
/// what the server actually sends rather than what a Swift initialiser can build.
enum DetailFixtures {
  static let activity = Data(
    #"[{"ts":1800000000000,"tool":"Edit","summary":"edited server.ts","status":"ok"}]"#.utf8)
  static let diff = Data(
    """
    {"base":"main","baseRef":"origin/main","head":"shepherd/x","fetchFailed":false,
     "truncated":false,"files":[{"path":"src/a.ts","status":"modified","additions":2,
     "deletions":1,"binary":false,"patch":"@@ -1,2 +1,3 @@\\n ctx\\n-old\\n+new\\n+extra\\n"}]}
    """.utf8)
  static let annotations = Data(
    """
    {"notes":[{"path":"src/a.ts","kind":"agent","text":"renamed","side":"additions",
     "lineNumber":3,"tool":"Edit"},{"path":"","kind":"review","text":"boundary moved"}]}
    """.utf8)
  static let listing = Data(
    """
    {"path":"","parent":null,"entries":[
     {"name":"docs","type":"dir","path":"docs","createdMs":1800000000000},
     {"name":"README.md","type":"file","path":"README.md"}]}
    """.utf8)
  static let gitState = Data(
    """
    {"kind":"github","state":"open","number":12,"url":"https://example.invalid/pull/12",
     "title":"add the thing","createdAt":1800000000000,"mergeable":true,"checks":"success",
     "mergeStateStatus":"clean","isDraft":false,"deployConfigured":false,
     "requestedReviewers":["octocat"],"authorLogin":"shepherd-bot",
     "latestReview":{"state":"approved","author":"octocat","submittedAt":1800000100000}}
    """.utf8)
  static let reviewers = Data(
    """
    {"logins":["octocat","hubot"],"unavailable":false,"prNumber":12,"repoSlug":"acme/demo",
     "isFork":false,"requestedReviewers":[],"authorLogin":"shepherd-bot",
     "defaultReviewer":"octocat","isDraft":false}
    """.utf8)
}

@Suite("Generated detail contract types")
struct GeneratedDetailContractTests {
  @Test("open enums decode both a known and an unknown member")
  func openEnums() throws {
    let list = try JSONDecoder().decode(
      [Components.Schemas.ActivityEntry].self, from: DetailFixtures.activity)
    #expect(list[0].status.known == .ok)
    let odd = try JSONDecoder().decode(
      [Components.Schemas.ActivityEntry].self,
      from: Data(#"[{"ts":1,"tool":"X","summary":"s","status":"quarantined"}]"#.utf8))
    #expect(odd[0].status.known == nil)
    #expect(odd[0].status.rawValue == "quarantined")
  }

  @Test("the session diff carries patch text, and annotations keep both kinds")
  func diffAndNotes() throws {
    let diff = try JSONDecoder().decode(
      Components.Schemas.DiffResult.self, from: DetailFixtures.diff)
    #expect(diff.files[0].status.known == .modified)
    #expect(diff.files[0].patch?.hasPrefix("@@ -1,2 +1,3 @@") == true)
    let notes = try JSONDecoder().decode(
      Components.Schemas.DiffAnnotations.self, from: DetailFixtures.annotations
    ).notes
    #expect(notes[0].side?.known == .additions)
    #expect(notes[1].kind.known == .review)
    #expect(notes[1].path.isEmpty)
  }

  @Test("a listing keeps a null parent and an absent createdMs")
  func listing() throws {
    let listing = try JSONDecoder().decode(
      Components.Schemas.BrowseListing.self, from: DetailFixtures.listing)
    #expect(listing.parent == nil)
    #expect(listing.entries[0]._type.known == .dir)
    #expect(listing.entries[1].createdMs == nil)
  }

  @Test("git state keeps its optional kind and nullable mergeable, and decodes the bare form")
  func gitState() throws {
    let git = try JSONDecoder().decode(
      Components.Schemas.GitState.self, from: DetailFixtures.gitState)
    #expect(git.kind?.known == .github)
    #expect(git.mergeable == true)
    #expect(git.latestReview?.state.known == .approved)
    // The PR-action responses answer the same schema WITHOUT `kind`.
    let bare = try JSONDecoder().decode(
      Components.Schemas.GitState.self,
      from: Data(#"{"state":"merged","checks":"none","deployConfigured":false}"#.utf8))
    #expect(bare.kind == nil)
    #expect(bare.state.known == .merged)
  }

  @Test("reviewer options keep their nullable fields")
  func reviewers() throws {
    let options = try JSONDecoder().decode(
      Components.Schemas.PrReviewerOptions.self, from: DetailFixtures.reviewers)
    #expect(options.logins == ["octocat", "hubot"])
    #expect(options.defaultReviewer == "octocat")
  }
}
```

> `BrowseEntry.type` collides with a Swift keyword, so the generator names it `_type`. If the compiler disagrees, read the generated spelling (`grep -rn "case dir" native/.build/**/Types.swift`) and use it — never rename the wire field to suit Swift.

- [ ] **Step 4: Run the shape tests**

```bash
swift test --package-path native --filter GeneratedDetailContractTests
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add contracts/openapi.swift.yaml native/Sources/ShepherdKit/openapi.yaml \
  native/Tests/ShepherdKitTests/DetailFixtures.swift
git commit -m "feat(kit): generate the session detail client from the contract"
```

---

## Task 3: Kit reads

**Files:**
- Create: `native/Sources/ShepherdKit/Client/ShepherdClient+Detail.swift`
- Create: `native/Tests/ShepherdKitTests/ShepherdClientDetailTests.swift`

**Interfaces:**
- Consumes: `ShepherdClient`, `ShepherdError.from(_:route:)`, `ShepherdError.fromUndocumented(statusCode:route:)`, `ShepherdError.fromConflict(_:)`, `OpenEnum`, `DetailFixtures` (Task 2).
- Produces, on `ShepherdClient`:

```swift
public func activity(sessionID: String) async throws -> [ActivityEntry]
public func diff(sessionID: String) async throws -> DiffResult
public func diffAnnotations(sessionID: String) async throws -> [DiffNote]
public func scratchpad(sessionID: String, path: String?) async throws -> BrowseListing
public func worktreeFiles(sessionID: String, path: String?) async throws -> BrowseListing
public func git(sessionID: String) async throws -> GitState?
public func reviewers(sessionID: String) async throws -> PrReviewerOptions
```

plus the typealiases `ActivityEntry`, `DiffResult`, `DiffFile`, `DiffNote`, `BrowseListing`, `BrowseEntry`, `GitState`, `PrReview`, `PrReviewerOptions`, `MergeMethod`, `PrStateKnown`, `ChecksStateKnown`, `MergeStateStatusKnown`, `ForgeKindKnown`, and the `OpenEnum` conformances for the ten new open enums.

- [ ] **Step 1: Check the one thing this file needs from an S0-owned file**

```bash
grep -n "let generated" native/Sources/ShepherdKit/Client/ShepherdClient.swift
```

- `let generated: Client` (module-internal) ⇒ proceed; the extension reaches it directly.
- `private let generated: Client` ⇒ **stop and request the S0 handoff edit** (`private let generated` → `let generated`, one word, listed at the end of this plan). Do **not** build a second `Client`: two clients mean two middleware chains and two `needsLogin` signals for one profile.

- [ ] **Step 2: Write the failing tests**

Create `native/Tests/ShepherdKitTests/ShepherdClientDetailTests.swift`:

```swift
import Foundation
import Testing

@testable import ShepherdKit

/// A client wired to an in-process fake, like ShepherdClientReadTests.
@MainActor
func detailClient(_ fake: FakeShepherdServer) throws -> ShepherdClient {
  let credentials = InMemoryCredentialStore()
  let profile = ServerProfile(name: "fake", baseURL: fake.baseURL, mode: .local)
  try credentials.save(StoredCredential(token: "shp_test", tokenId: "t1"), for: profile.credentialKey)
  return try ShepherdClient(profile: profile, credentials: credentials, urlSession: fake.urlSession())
}

@Suite("ShepherdClient detail reads")
@MainActor
struct ShepherdClientDetailReadTests {
  @Test("activity comes back as generated entries; a 404 is notFound")
  func activity() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub("GET", "/api/sessions/s1/activity", status: 200, json: DetailFixtures.activity)
    #expect(try await detailClient(fake).activity(sessionID: "s1").count == 1)

    let missing = FakeShepherdServer()
    defer { missing.tearDown() }
    missing.stub(
      "GET", "/api/sessions/s1/activity", status: 404, json: Data(#"{"error":"not found"}"#.utf8))
    await #expect(throws: ShepherdError.notFound) {
      _ = try await detailClient(missing).activity(sessionID: "s1")
    }
  }

  @Test("the diff comes back with its patch text; a 500 carries the server's sentence")
  func diff() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub("GET", "/api/sessions/s1/diff", status: 200, json: DetailFixtures.diff)
    let diff = try await detailClient(fake).diff(sessionID: "s1")
    #expect(diff.baseRef == "origin/main")
    #expect(diff.files[0].patch?.contains("+extra") == true)

    let broken = FakeShepherdServer()
    defer { broken.tearDown() }
    broken.stub(
      "GET", "/api/sessions/s1/diff", status: 500,
      json: Data(#"{"error":"fatal: not a git repository"}"#.utf8))
    await #expect(throws: ShepherdError.upstreamFailure("fatal: not a git repository")) {
      _ = try await detailClient(broken).diff(sessionID: "s1")
    }
  }

  @Test("annotations are unwrapped to the note list")
  func annotations() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub(
      "GET", "/api/sessions/s1/diff/annotations", status: 200, json: DetailFixtures.annotations)
    #expect(try await detailClient(fake).diffAnnotations(sessionID: "s1").count == 2)
  }

  @Test("a listing sends its path as a query item, and nil sends none")
  func listings() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub("GET", "/api/sessions/s1/worktree", status: 200, json: DetailFixtures.listing)
    _ = try await detailClient(fake).worktreeFiles(sessionID: "s1", path: "docs/api")
    let query = try #require(fake.requests().last?.query)
    #expect(query.contains("path=docs/api") || query.contains("path=docs%2Fapi"))

    let root = FakeShepherdServer()
    defer { root.tearDown() }
    root.stub("GET", "/api/sessions/s1/scratchpad", status: 200, json: DetailFixtures.listing)
    #expect(try await detailClient(root).scratchpad(sessionID: "s1", path: nil).parent == nil)
    #expect(root.requests().last?.query?.contains("path=") != true)
  }

  @Test("git state comes back whole; a 404 is nil and a 502 is an upstream failure")
  func git() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub("GET", "/api/sessions/s1/git", status: 200, json: DetailFixtures.gitState)
    let git = try #require(try await detailClient(fake).git(sessionID: "s1"))
    #expect(git.number == 12)
    #expect(git.checks.known == .success)

    let absent = FakeShepherdServer()
    defer { absent.tearDown() }
    absent.stub(
      "GET", "/api/sessions/s1/git", status: 404,
      json: Data(#"{"error":"no forge for this repo"}"#.utf8))
    #expect(try await detailClient(absent).git(sessionID: "s1") == nil)

    let angry = FakeShepherdServer()
    defer { angry.tearDown() }
    angry.stub(
      "GET", "/api/sessions/s1/git", status: 502, json: Data(#"{"error":"forge error"}"#.utf8))
    await #expect(throws: ShepherdError.upstreamFailure("forge error")) {
      _ = try await detailClient(angry).git(sessionID: "s1")
    }
  }

  @Test("reviewers come back whole; an unsupported forge is a bad request with its code")
  func reviewers() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub("GET", "/api/sessions/s1/git/reviewers", status: 200, json: DetailFixtures.reviewers)
    #expect(try await detailClient(fake).reviewers(sessionID: "s1").logins.count == 2)

    let other = FakeShepherdServer()
    defer { other.tearDown() }
    other.stub(
      "GET", "/api/sessions/s1/git/reviewers", status: 400,
      json: Data(#"{"code":"review_request_unsupported"}"#.utf8))
    await #expect(throws: ShepherdError.badRequest("review_request_unsupported")) {
      _ = try await detailClient(other).reviewers(sessionID: "s1")
    }
  }
}
```

- [ ] **Step 3: Run them and watch them fail**

```bash
swift test --package-path native --filter ShepherdClientDetailReadTests
```

Expected: compile failure — `value of type 'ShepherdClient' has no member 'activity'`.

- [ ] **Step 4: Write the kit extension**

Create `native/Sources/ShepherdKit/Client/ShepherdClient+Detail.swift`:

```swift
import Foundation

// MARK: - Short names for the generated detail schemas

public typealias ActivityEntry = Components.Schemas.ActivityEntry
public typealias DiffResult = Components.Schemas.DiffResult
public typealias DiffFile = Components.Schemas.DiffFile
public typealias DiffNote = Components.Schemas.DiffNote
public typealias BrowseListing = Components.Schemas.BrowseListing
public typealias BrowseEntry = Components.Schemas.BrowseEntry
public typealias GitState = Components.Schemas.GitState
public typealias PrReview = Components.Schemas.PrReview
public typealias PrReviewerOptions = Components.Schemas.PrReviewerOptions
public typealias MergeMethod = Components.Schemas.MergeMethod

// The closed enum each detail open enum splits off (see OpenEnum.swift for the mechanism).
public typealias ActivityStatusKnown = Components.Schemas.ActivityStatusKnown
public typealias DiffFileStatusKnown = Components.Schemas.DiffFileStatusKnown
public typealias PrStateKnown = Components.Schemas.PrStateKnown
public typealias ChecksStateKnown = Components.Schemas.ChecksStateKnown
public typealias MergeStateStatusKnown = Components.Schemas.MergeStateStatusKnown
public typealias ForgeKindKnown = Components.Schemas.ForgeKindKnown

// The ten read-side enums this stream adds. The conformances live here, not in OpenEnum.swift,
// which other streams also extend.
extension Components.Schemas.ActivityStatus: OpenEnum {}
extension Components.Schemas.DiffFileStatus: OpenEnum {}
extension Components.Schemas.DiffNoteKind: OpenEnum {}
extension Components.Schemas.DiffNoteSide: OpenEnum {}
extension Components.Schemas.BrowseEntryType: OpenEnum {}
extension Components.Schemas.ForgeKind: OpenEnum {}
extension Components.Schemas.PrState: OpenEnum {}
extension Components.Schemas.ChecksState: OpenEnum {}
extension Components.Schemas.MergeStateStatus: OpenEnum {}
extension Components.Schemas.PrReviewState: OpenEnum {}

// MARK: - Reads

extension ShepherdClient {
  /// Recent tool use from the agent transcript, oldest first. An unreadable transcript is an
  /// empty list server-side, never an error.
  public func activity(sessionID: String) async throws -> [ActivityEntry] {
    do {
      switch try await generated.getSessionActivity(.init(path: .init(id: sessionID))) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "getSessionActivity")
      }
    } catch { throw ShepherdError.from(error, route: "getSessionActivity") }
  }

  /// The session branch against its base. `files[].patch` carries the raw unified patch; this
  /// route sends no parsed hunks.
  public func diff(sessionID: String) async throws -> DiffResult {
    do {
      switch try await generated.getSessionDiff(.init(path: .init(id: sessionID))) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .internalServerError(let bad):
        throw ShepherdError.upstreamFailure(try bad.body.json.error)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "getSessionDiff")
      }
    } catch { throw ShepherdError.from(error, route: "getSessionDiff") }
  }

  /// Agent and review notes on the diff. Best effort server-side, so a caller may ignore a
  /// failure here and still show the diff.
  public func diffAnnotations(sessionID: String) async throws -> [DiffNote] {
    do {
      switch try await generated.getSessionDiffAnnotations(.init(path: .init(id: sessionID))) {
      case .ok(let ok): return try ok.body.json.notes
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "getSessionDiffAnnotations")
      }
    } catch { throw ShepherdError.from(error, route: "getSessionDiffAnnotations") }
  }

  /// One directory of the session scratchpad; `nil` lists the root.
  public func scratchpad(sessionID: String, path: String? = nil) async throws -> BrowseListing {
    do {
      switch try await generated.getSessionScratchpad(
        .init(path: .init(id: sessionID), query: .init(path: path))
      ) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "getSessionScratchpad")
      }
    } catch { throw ShepherdError.from(error, route: "getSessionScratchpad") }
  }

  /// One directory of the session worktree, read-only; `nil` lists the root.
  public func worktreeFiles(sessionID: String, path: String? = nil) async throws -> BrowseListing {
    do {
      switch try await generated.getSessionWorktree(
        .init(path: .init(id: sessionID), query: .init(path: path))
      ) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "getSessionWorktree")
      }
    } catch { throw ShepherdError.from(error, route: "getSessionWorktree") }
  }

  /// PR and forge state, or `nil` when the server has none to give.
  ///
  /// 404 is deliberately not an error: the route answers it both for an unknown session and for
  /// a repo with no forge, and the panel renders nothing either way — the mapping `gitState()`
  /// makes in the web client.
  public func git(sessionID: String) async throws -> GitState? {
    do {
      switch try await generated.getSessionGit(.init(path: .init(id: sessionID))) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: return nil
      case .badGateway(let bad): throw ShepherdError.upstreamFailure(try bad.body.json.error)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "getSessionGit")
      }
    } catch { throw ShepherdError.from(error, route: "getSessionGit") }
  }

  /// Candidate reviewers for the open PR. GitHub only; any other forge is a `.badRequest`
  /// carrying the server's machine code, which `ShepherdErrorCopy` renders.
  public func reviewers(sessionID: String) async throws -> PrReviewerOptions {
    do {
      switch try await generated.getPullRequestReviewers(.init(path: .init(id: sessionID))) {
      case .ok(let ok): return try ok.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.code)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict):
        let code = try conflict.body.json.code
        throw ShepherdError.conflict(code: code, message: try conflict.body.json.error ?? code)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "getPullRequestReviewers")
      }
    } catch { throw ShepherdError.from(error, route: "getPullRequestReviewers") }
  }
}
```

- [ ] **Step 5: Run the tests**

```bash
swift test --package-path native --filter ShepherdClientDetailReadTests
```

Expected: `Suite 'ShepherdClient detail reads' passed` with 6 tests.

- [ ] **Step 6: Commit**

```bash
git add native/Sources/ShepherdKit/Client/ShepherdClient+Detail.swift \
  native/Tests/ShepherdKitTests/ShepherdClientDetailTests.swift
git commit -m "feat(kit): detail reads over the generated client"
```

---

## Task 4: Kit PR actions

**Files:**
- Modify: `native/Sources/ShepherdKit/Client/ShepherdClient+Detail.swift`
- Modify: `native/Tests/ShepherdKitTests/ShepherdClientDetailTests.swift`

**Interfaces:**
- Consumes: Task 3's typealiases and `detailClient(_:)`.
- Produces, on `ShepherdClient`:

```swift
public func openPR(sessionID: String, title: String?, body: String?) async throws -> GitState
public func mergePR(sessionID: String, method: MergeMethod?, deleteBranch: Bool?) async throws -> GitState
public func markPRReady(sessionID: String) async throws -> GitState
public func markPRDraft(sessionID: String) async throws -> GitState
public func closePR(sessionID: String) async throws -> GitState
@discardableResult public func requestPRReview(sessionID: String, prNumber: Int, reviewer: String) async throws -> Bool
```

`requestPRReview` returns the server's `refreshPending`: `true` means the review was requested but the follow-up status read failed, so the caller should re-read `git(sessionID:)`.

- [ ] **Step 1: Write the failing tests**

Append to `native/Tests/ShepherdKitTests/ShepherdClientDetailTests.swift`:

```swift
@Suite("ShepherdClient detail writes")
@MainActor
struct ShepherdClientDetailWriteTests {
  private func sentJSON(_ fake: FakeShepherdServer) throws -> [String: Any] {
    let body = try #require(fake.requests().last?.body)
    return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
  }

  @Test("opening a PR sends the title and body it was given")
  func openPR() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub("POST", "/api/sessions/s1/git/pr", status: 200, json: DetailFixtures.gitState)
    #expect(try await detailClient(fake).openPR(sessionID: "s1", title: "T", body: "B").number == 12)
    let json = try sentJSON(fake)
    #expect(json["title"] as? String == "T")
    #expect(json["body"] as? String == "B")
  }

  @Test("an empty diff is a conflict carrying the server's sentence")
  func openPRConflict() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub(
      "POST", "/api/sessions/s1/git/pr", status: 409,
      json: Data(#"{"error":"no commits to merge"}"#.utf8))
    await #expect(throws: ShepherdError.conflict(code: nil, message: "no commits to merge")) {
      _ = try await detailClient(fake).openPR(sessionID: "s1", title: nil, body: nil)
    }
  }

  @Test("merging sends the method and the delete-branch choice; an enqueued merge is a failure")
  func mergePR() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub("POST", "/api/sessions/s1/git/merge", status: 200, json: DetailFixtures.gitState)
    _ = try await detailClient(fake).mergePR(sessionID: "s1", method: .squash, deleteBranch: false)
    let json = try sentJSON(fake)
    #expect(json["method"] as? String == "squash")
    #expect(json["deleteBranch"] as? Bool == false)

    let enqueued = FakeShepherdServer()
    defer { enqueued.tearDown() }
    enqueued.stub(
      "POST", "/api/sessions/s1/git/merge", status: 502,
      json: Data(#"{"error":"merge enqueued","code":"merge_enqueued"}"#.utf8))
    await #expect(throws: ShepherdError.upstreamFailure("merge enqueued")) {
      _ = try await detailClient(enqueued).mergePR(
        sessionID: "s1", method: nil, deleteBranch: nil)
    }
  }

  @Test("ready, draft and close all answer the full git state")
  func draftStateAndClose() async throws {
    for route in ["ready", "draft", "close"] {
      let fake = FakeShepherdServer()
      defer { fake.tearDown() }
      fake.stub("POST", "/api/sessions/s1/git/\(route)", status: 200, json: DetailFixtures.gitState)
      let client = try detailClient(fake)
      let state =
        switch route {
        case "ready": try await client.markPRReady(sessionID: "s1")
        case "draft": try await client.markPRDraft(sessionID: "s1")
        default: try await client.closePR(sessionID: "s1")
        }
      #expect(state.kind?.known == .github)
    }
  }

  @Test("a draft still awaiting sign-off is a conflict with its code")
  func readyBlocked() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub(
      "POST", "/api/sessions/s1/git/ready", status: 409,
      json: Data(#"{"code":"draft_awaiting_signoff","error":"Draft mode."}"#.utf8))
    await #expect(
      throws: ShepherdError.conflict(code: "draft_awaiting_signoff", message: "Draft mode.")
    ) { _ = try await detailClient(fake).markPRReady(sessionID: "s1") }
  }

  @Test("requesting a review reports refreshPending and sends both fields")
  func requestReview() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub(
      "POST", "/api/sessions/s1/git/request-review", status: 200,
      json: Data(#"{"ok":true,"refreshPending":true}"#.utf8))
    #expect(
      try await detailClient(fake).requestPRReview(
        sessionID: "s1", prNumber: 12, reviewer: "octocat") == true)
    let json = try sentJSON(fake)
    #expect(json["prNumber"] as? Int == 12)
    #expect(json["reviewer"] as? String == "octocat")
  }

  @Test("a draft PR is a conflict carrying the machine code")
  func requestReviewDraft() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub(
      "POST", "/api/sessions/s1/git/request-review", status: 409,
      json: Data(#"{"code":"review_request_draft"}"#.utf8))
    await #expect(
      throws: ShepherdError.conflict(
        code: "review_request_draft", message: "review_request_draft")
    ) {
      _ = try await detailClient(fake).requestPRReview(
        sessionID: "s1", prNumber: 12, reviewer: "octocat")
    }
  }
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
swift test --package-path native --filter ShepherdClientDetailWriteTests
```

Expected: compile failure — `value of type 'ShepherdClient' has no member 'openPR'`.

- [ ] **Step 3: Write the six actions**

Append to `native/Sources/ShepherdKit/Client/ShepherdClient+Detail.swift`:

```swift
// MARK: - PR actions

extension ShepherdClient {
  /// Opens a PR for the session branch. `nil` for either field lets the server fall back to the
  /// session's name and prompt. The response carries no `kind` — see `GitState`.
  public func openPR(sessionID: String, title: String?, body: String?) async throws -> GitState {
    do {
      switch try await generated.openPullRequest(
        .init(path: .init(id: sessionID), body: .json(.init(title: title, body: body)))
      ) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .badGateway(let bad): throw ShepherdError.upstreamFailure(try bad.body.json.error)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "openPullRequest")
      }
    } catch { throw ShepherdError.from(error, route: "openPullRequest") }
  }

  /// Merges the open PR. `nil` takes the forge's own defaults (its merge method, and deleting
  /// the branch). A 502 here often means the host only *enqueued* the merge — still not a
  /// success, and the server's sentence says which it was.
  public func mergePR(
    sessionID: String, method: MergeMethod?, deleteBranch: Bool?
  ) async throws -> GitState {
    do {
      switch try await generated.mergePullRequest(
        .init(
          path: .init(id: sessionID),
          body: .json(.init(method: method, deleteBranch: deleteBranch)))
      ) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .badGateway(let bad): throw ShepherdError.upstreamFailure(try bad.body.json.error)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "mergePullRequest")
      }
    } catch { throw ShepherdError.from(error, route: "mergePullRequest") }
  }

  /// Marks the PR ready for review. Idempotent server-side.
  public func markPRReady(sessionID: String) async throws -> GitState {
    do {
      switch try await generated.setPullRequestReady(.init(path: .init(id: sessionID))) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .badGateway(let bad): throw ShepherdError.upstreamFailure(try bad.body.json.error)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "setPullRequestReady")
      }
    } catch { throw ShepherdError.from(error, route: "setPullRequestReady") }
  }

  /// Converts the PR back to a draft. Idempotent server-side.
  public func markPRDraft(sessionID: String) async throws -> GitState {
    do {
      switch try await generated.setPullRequestDraft(.init(path: .init(id: sessionID))) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .badGateway(let bad): throw ShepherdError.upstreamFailure(try bad.body.json.error)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "setPullRequestDraft")
      }
    } catch { throw ShepherdError.from(error, route: "setPullRequestDraft") }
  }

  public func closePR(sessionID: String) async throws -> GitState {
    do {
      switch try await generated.closePullRequest(.init(path: .init(id: sessionID))) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .badGateway(let bad): throw ShepherdError.upstreamFailure(try bad.body.json.error)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "closePullRequest")
      }
    } catch { throw ShepherdError.from(error, route: "closePullRequest") }
  }

  /// Requests a human review on the open PR. GitHub only.
  ///
  /// - Returns: `true` when the server requested the review but its own follow-up status read
  ///   failed (`refreshPending`), so the caller should re-read `git(sessionID:)`. This route's
  ///   error bodies carry a machine code and often no prose, so the code stands in for both.
  @discardableResult
  public func requestPRReview(
    sessionID: String, prNumber: Int, reviewer: String
  ) async throws -> Bool {
    do {
      switch try await generated.requestPullRequestReview(
        .init(path: .init(id: sessionID), body: .json(.init(prNumber: prNumber, reviewer: reviewer)))
      ) {
      case .ok(let ok): return try ok.body.json.refreshPending ?? false
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.code)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict):
        let code = try conflict.body.json.code
        throw ShepherdError.conflict(code: code, message: try conflict.body.json.error ?? code)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "requestPullRequestReview")
      }
    } catch { throw ShepherdError.from(error, route: "requestPullRequestReview") }
  }
}
```

`ShepherdError.fromConflict(_:)` already exists — it is what `createSession` uses — and maps `{error, code}` onto `.firstRunPending` or `.conflict(code:message:)`. If the compiler rejects the argument, check its parameter with `grep -n "fromConflict" native/Sources/ShepherdKit/Model/ShepherdError.swift` and pass the decoded body it expects.

- [ ] **Step 4: Run the whole kit and contract suites**

```bash
swift test --package-path native && bun run test:contract
```

Expected: all green — 6 read tests, 7 write tests, 5 shape tests, and nothing in `SessionStoreTests`/`ServerEventTests`/`GeneratedContractTests` changed.

- [ ] **Step 5: Commit**

```bash
git add native/Sources/ShepherdKit/Client/ShepherdClient+Detail.swift \
  native/Tests/ShepherdKitTests/ShepherdClientDetailTests.swift
git commit -m "feat(kit): pull-request actions over the generated client"
```

---

## Task 5: Copy (`KEYS_DETAIL`, EN + DE) and `DetailModel`

**Files:**
- Modify: `ui/messages/en.json`, `ui/messages/de.json` (additive), `native/scripts/gen-strings.ts` (`KEYS_DETAIL` only)
- Modify (generated): `native/Apps/ShepherdMac/Resources/Localizable.xcstrings`
- Create: `native/Apps/ShepherdMac/Sources/Detail/DetailModel.swift`, `native/Apps/ShepherdMac/Tests/DetailModelTests.swift`

**Interfaces:**
- Consumes: Tasks 3–4's client methods; `AppExtension` (Gate S0); `ShepherdErrorCopy.message(_:)`; `Log.ui`.
- Produces: `enum Loaded<Value>`, `enum DetailFeed`, and `@Observable @MainActor final class DetailModel: AppExtension` with `activity/diff/files/git` caches keyed by session id, `load(_:session:)`, `browse(session:source:path:)`, `poll(_:session:)`, `refreshGit(session:)`, `teardown()`, the `Loaders` seam and the `sleep` seam.

- [ ] **Step 1: Add the new copy to both catalogs**

To `ui/messages/en.json` (the union merge driver makes this conflict-free):

```json
  "native_detail_tab_activity": "Activity",
  "native_detail_tab_diff": "Diff",
  "native_detail_tab_files": "Files",
  "native_detail_tab_git": "PR",
  "native_detail_refresh": "Refresh",
  "native_detail_annotation_agent": "Agent",
  "native_detail_git_none": "No pull request for this session.",
  "native_detail_action_failed": "The action failed: {reason}",
  "native_detail_reviewer_label": "Reviewer",
  "native_detail_merge_confirm_title": "Merge this pull request?",
  "native_detail_merge_confirm_body": "The branch is merged on the host and deleted afterwards.",
  "native_detail_merge_confirm_action": "Merge",
  "native_detail_close_confirm_title": "Close this pull request?",
  "native_detail_close_confirm_body": "The pull request is closed without merging. The branch stays.",
  "native_detail_close_confirm_action": "Close pull request",
```

and the same keys to `ui/messages/de.json`:

```json
  "native_detail_tab_activity": "Aktivität",
  "native_detail_tab_diff": "Diff",
  "native_detail_tab_files": "Dateien",
  "native_detail_tab_git": "PR",
  "native_detail_refresh": "Aktualisieren",
  "native_detail_annotation_agent": "Agent",
  "native_detail_git_none": "Kein Pull Request für diese Session.",
  "native_detail_action_failed": "Die Aktion ist fehlgeschlagen: {reason}",
  "native_detail_reviewer_label": "Reviewer",
  "native_detail_merge_confirm_title": "Diesen Pull Request mergen?",
  "native_detail_merge_confirm_body": "Der Branch wird auf dem Host gemergt und danach gelöscht.",
  "native_detail_merge_confirm_action": "Mergen",
  "native_detail_close_confirm_title": "Diesen Pull Request schließen?",
  "native_detail_close_confirm_body": "Der Pull Request wird ohne Merge geschlossen. Der Branch bleibt.",
  "native_detail_close_confirm_action": "Pull Request schließen",
```

- [ ] **Step 2: Fill `KEYS_DETAIL`**

In `native/scripts/gen-strings.ts`, replace the empty `KEYS_DETAIL` array S0-prep left with this. Everything without the `native_detail_` prefix is an existing web key reused verbatim, which is what the i18n rule prefers.

```ts
/** Stream S2 — session detail tabs. Only this stream edits this array. Keep alphabetical. */
export const KEYS_DETAIL: readonly string[] = [
  "activity_empty",
  "diff_empty",
  "diff_note_binary",
  "diff_note_no_changes",
  "diff_note_truncated",
  "diff_refresh",
  "diff_stale",
  "files_created_unknown",
  "files_empty",
  "files_link_outside_title",
  "files_load_error",
  "files_source_scratchpad",
  "files_source_worktree",
  "files_worktree_empty",
  "files_worktree_load_error",
  "gitrail_ci_failing",
  "gitrail_ci_none",
  "gitrail_ci_passing",
  "gitrail_ci_pending",
  "gitrail_create_pr",
  "gitrail_merge",
  "gitrail_status_failed",
  "native_detail_action_failed",
  "native_detail_annotation_agent",
  "native_detail_close_confirm_action",
  "native_detail_close_confirm_body",
  "native_detail_close_confirm_title",
  "native_detail_git_none",
  "native_detail_merge_confirm_action",
  "native_detail_merge_confirm_body",
  "native_detail_merge_confirm_title",
  "native_detail_refresh",
  "native_detail_reviewer_label",
  "native_detail_tab_activity",
  "native_detail_tab_diff",
  "native_detail_tab_files",
  "native_detail_tab_git",
  "prbadge_mark_draft",
  "prbadge_mark_ready",
  "prreview_load_failed",
  "prreview_loading",
  "prreview_no_candidates",
  "prreview_title",
  "viewport_diff_annotation_review",
];
```

- [ ] **Step 3: Regenerate and check the catalog**

```bash
bun run gen:strings && bun run check:strings
```

Expected: `Wrote …/Localizable.xcstrings (N keys, en + de).` then `Localizable.xcstrings is up to date (N keys).` A `missing catalog keys:` error names a key absent from **both** JSON catalogs — add it there, never only in Swift.

- [ ] **Step 4: Write the failing tests**

Create `native/Apps/ShepherdMac/Tests/DetailModelTests.swift`:

```swift
import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

/// Yields until `condition` holds or the budget runs out — the seam `AppModelTests` uses.
@MainActor
func settleDetail(until condition: () -> Bool, yields: Int = 500) async -> Bool {
    for _ in 0..<yields {
        if condition() { return true }
        await Task.yield()
    }
    return condition()
}

/// Holds an injected read open, so a load can be caught mid-flight and raced.
@MainActor
final class LoadGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var opened = false
    private(set) var isWaiting = false

    func wait() async {
        if opened { return }
        isWaiting = true
        await withCheckedContinuation { self.continuation = $0 }
    }

    func open() {
        opened = true
        isWaiting = false
        continuation?.resume()
        continuation = nil
    }
}

@MainActor
struct DetailModelTests {
    private func entry(_ n: Int, _ summary: String) -> ActivityEntry {
        ActivityEntry(ts: n, tool: "Edit", summary: summary, status: .init(known: .ok))
    }

    @Test func startsWithNothingCachedForAnySession() {
        #expect(DetailModel(loaders: .stubbed()).activity["s1"] == nil)
    }

    @Test func aSuccessfulLoadLandsAsReady() async {
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in [self.entry(1, "did")] }
        let model = DetailModel(loaders: loaders)
        await model.load(.activity, session: "s1")
        #expect(model.activity["s1"]?.value?.first?.summary == "did")
    }

    @Test func aFailedLoadCarriesLocalisedCopy() async {
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in throw ShepherdError.notFound }
        let model = DetailModel(loaders: loaders)
        await model.load(.activity, session: "s1")
        #expect(model.activity["s1"] == .failed(ShepherdErrorCopy.message(ShepherdError.notFound)))
    }

    @Test func aReadThatOutlivesItsStoreIsDropped() async {
        let gate = LoadGate()
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in
            await gate.wait()
            return [self.entry(1, "late")]
        }
        let model = DetailModel(loaders: loaders)
        let task = Task { await model.load(.activity, session: "s1") }
        #expect(await settleDetail(until: { gate.isWaiting }))
        model.teardown()   // the store this extension belongs to went away
        gate.open()
        await task.value
        #expect(model.activity["s1"] == .loading)
    }

    @Test func anOlderLoadNeverOverwritesANewerOne() async {
        let slow = LoadGate()
        var calls = 0
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in
            calls += 1
            let n = calls
            if n == 1 { await slow.wait() }
            return [self.entry(n, "call \(n)")]
        }
        let model = DetailModel(loaders: loaders)
        let first = Task { await model.load(.activity, session: "s1") }
        #expect(await settleDetail(until: { slow.isWaiting }))
        await model.load(.activity, session: "s1")   // the second call wins
        slow.open()
        await first.value
        #expect(model.activity["s1"]?.value?.first?.summary == "call 2")
    }

    @Test func browsingKeepsTheSourceItWasAskedFor() async {
        var loaders = DetailModel.Loaders.stubbed()
        loaders.worktree = { _, path in
            BrowseListing(path: path ?? "", parent: path == nil ? nil : "", entries: [])
        }
        let model = DetailModel(loaders: loaders)
        await model.browse(session: "s1", source: .worktree, path: "docs")
        #expect(model.files["s1"]?.value?.source == .worktree)
        #expect(model.files["s1"]?.value?.listing.path == "docs")
    }

    @Test func theDiffSurvivesAnAnnotationFailure() async {
        var loaders = DetailModel.Loaders.stubbed()
        loaders.diff = { _ in
            DiffResult(
                base: "main", baseRef: "origin/main", head: "x", fetchFailed: false,
                truncated: false, files: [])
        }
        loaders.annotations = { _ in throw ShepherdError.transport("offline") }
        let model = DetailModel(loaders: loaders)
        await model.load(.diff, session: "s1")
        #expect(model.diff["s1"]?.value?.result.head == "x")
        #expect(model.diff["s1"]?.value?.notes.isEmpty == true)
    }

    @Test func pollingStopsWhenItsTaskIsCancelled() async {
        var calls = 0
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in
            calls += 1
            return []
        }
        let model = DetailModel(loaders: loaders)
        model.sleep = { _ in try await Task.sleep(for: .milliseconds(1)) }
        let task = Task { await model.poll(.activity, session: "s1") }
        #expect(await settleDetail(until: { calls >= 2 }))
        task.cancel()
        await task.value
        let seen = calls
        _ = await settleDetail(until: { false }, yields: 50)
        #expect(calls == seen)
    }
}
```

- [ ] **Step 5: Run them and watch them fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/DetailModelTests
```

Expected: compile failure — `cannot find 'DetailModel' in scope`.

- [ ] **Step 6: Write `DetailModel`**

Create `native/Apps/ShepherdMac/Sources/Detail/DetailModel.swift`:

```swift
import Foundation
import Observation
import ShepherdKit

/// Where one tab's data stands. `failed` carries copy that has already been through
/// `ShepherdErrorCopy`, so a view never maps an error itself.
enum Loaded<Value: Equatable & Sendable>: Equatable, Sendable {
    case idle
    case loading
    case ready(Value)
    case failed(String)

    var value: Value? {
        if case .ready(let value) = self { return value }
        return nil
    }
    var isLoading: Bool {
        if case .loading = self { return true }
        return false
    }
    var failure: String? {
        if case .failed(let message) = self { return message }
        return nil
    }
}

/// The four detail tabs, and how often a visible one re-reads.
///
/// The intervals mirror the web UI's `pollWhileVisible` (ActivityFeed 5 s, DiffPanel 15 s,
/// GitRail 15 s). Files are not polled — neither does the web panel; it reloads when the
/// operator navigates or presses Refresh.
enum DetailFeed: String, CaseIterable, Sendable {
    case activity, diff, files, git

    var interval: Duration? {
        switch self {
        case .activity: .seconds(5)
        case .diff, .git: .seconds(15)
        case .files: nil
        }
    }
}

/// Per-server caches for the detail tabs.
///
/// One instance per `SessionStore`: `AppModel` builds it in `activate(_:)` and calls
/// `teardown()` when the store goes away, so a read that comes back after a profile switch
/// finds `alive == false` and touches nothing. Keyed by session id because the operator can
/// switch rows faster than a request completes.
@Observable
@MainActor
final class DetailModel: AppExtension {
    struct DiffPayload: Equatable, Sendable {
        var result: DiffResult
        /// Empty when the annotations read failed: they are chrome, and a diff must not vanish
        /// because its notes did.
        var notes: [DiffNote]
    }

    enum FilesSource: String, CaseIterable, Sendable { case scratchpad, worktree }

    struct FilesPayload: Equatable, Sendable {
        var source: FilesSource
        var listing: BrowseListing
    }

    /// Every server read, as closures, so tests drive the model without a server.
    struct Loaders: Sendable {
        var activity: @MainActor (String) async throws -> [ActivityEntry]
        var diff: @MainActor (String) async throws -> DiffResult
        var annotations: @MainActor (String) async throws -> [DiffNote]
        var scratchpad: @MainActor (String, String?) async throws -> BrowseListing
        var worktree: @MainActor (String, String?) async throws -> BrowseListing
        var git: @MainActor (String) async throws -> GitState?

        static func live(_ client: ShepherdClient) -> Loaders {
            Loaders(
                activity: { try await client.activity(sessionID: $0) },
                diff: { try await client.diff(sessionID: $0) },
                annotations: { try await client.diffAnnotations(sessionID: $0) },
                scratchpad: { try await client.scratchpad(sessionID: $0, path: $1) },
                worktree: { try await client.worktreeFiles(sessionID: $0, path: $1) },
                git: { try await client.git(sessionID: $0) })
        }

        /// Empty answers for every read — a test overrides only the one it is about.
        static func stubbed() -> Loaders {
            Loaders(
                activity: { _ in [] },
                diff: { _ in
                    DiffResult(
                        base: "main", baseRef: "main", head: nil, fetchFailed: false,
                        truncated: false, files: [])
                },
                annotations: { _ in [] },
                scratchpad: { _, path in BrowseListing(path: path ?? "", parent: nil, entries: []) },
                worktree: { _, path in BrowseListing(path: path ?? "", parent: nil, entries: []) },
                git: { _ in nil })
        }
    }

    private(set) var activity: [String: Loaded<[ActivityEntry]>] = [:]
    private(set) var diff: [String: Loaded<DiffPayload>] = [:]
    private(set) var files: [String: Loaded<FilesPayload>] = [:]
    private(set) var git: [String: Loaded<GitState?>] = [:]

    /// How a poll waits. Replaced in tests so the loop runs at full speed.
    @ObservationIgnored var sleep: @Sendable (Duration) async throws -> Void = {
        try await Task.sleep(for: $0)
    }

    private let loaders: Loaders
    /// False after `teardown()`. Every completion checks it, so a read that outlives the store
    /// it was made against writes nothing.
    @ObservationIgnored private var alive = true
    /// Bumped at the start of every load, per feed and session. A completion whose stamp is no
    /// longer the newest is dropped: a poll tick and a manual Refresh overlap routinely, and the
    /// earlier one holds the older answer by construction.
    @ObservationIgnored private var stamps: [String: Int] = [:]

    init(store: SessionStore, app: AppModel) { self.loaders = .live(store.client) }

    /// Test initialiser: the same model with hand-driven reads.
    init(loaders: Loaders) { self.loaders = loaders }

    func teardown() { alive = false }

    /// Reads one feed for one session. Safe to call while a read is already in flight.
    func load(_ feed: DetailFeed, session id: String) async {
        let stamp = nextStamp(feed, id)
        set(feed, id, .loading)
        do {
            switch feed {
            case .activity:
                let entries = try await loaders.activity(id)
                commit(feed, id, stamp) { self.activity[id] = .ready(entries) }
            case .diff:
                let result = try await loaders.diff(id)
                var notes: [DiffNote] = []
                do { notes = try await loaders.annotations(id) } catch {
                    Log.ui.debug("diff annotations failed; keeping the diff")
                }
                commit(feed, id, stamp) {
                    self.diff[id] = .ready(DiffPayload(result: result, notes: notes))
                }
            case .files:
                let listing = try await loaders.scratchpad(id, nil)
                commit(feed, id, stamp) {
                    self.files[id] = .ready(FilesPayload(source: .scratchpad, listing: listing))
                }
            case .git:
                let state = try await loaders.git(id)
                commit(feed, id, stamp) { self.git[id] = .ready(state) }
            }
        } catch {
            let copy = ShepherdErrorCopy.message(error)
            commit(feed, id, stamp) { self.set(feed, id, .failed(copy)) }
        }
    }

    /// Lists one directory of one files source, replacing whatever the files tab held.
    func browse(session id: String, source: FilesSource, path: String?) async {
        let stamp = nextStamp(.files, id)
        set(.files, id, .loading)
        do {
            let listing =
                switch source {
                case .scratchpad: try await loaders.scratchpad(id, path)
                case .worktree: try await loaders.worktree(id, path)
                }
            commit(.files, id, stamp) {
                self.files[id] = .ready(FilesPayload(source: source, listing: listing))
            }
        } catch {
            let copy = ShepherdErrorCopy.message(error)
            commit(.files, id, stamp) { self.set(.files, id, .failed(copy)) }
        }
    }

    /// Loads once, then re-loads on the feed's interval until the calling task is cancelled. A
    /// view runs this from `.task(id:)`, which cancels it when the session or tab changes.
    func poll(_ feed: DetailFeed, session id: String) async {
        guard let interval = feed.interval else {
            await load(feed, session: id)
            return
        }
        while !Task.isCancelled {
            await load(feed, session: id)
            do { try await sleep(interval) } catch { return }
        }
    }

    /// Re-reads git after an action, so the panel shows what the server now believes rather than
    /// what the action returned.
    func refreshGit(session id: String) async { await load(.git, session: id) }

    // MARK: - Internals

    /// The two states that carry no value. A single `Loaded` value cannot be written into four
    /// differently-typed dictionaries, so this carries the intent instead.
    private enum Mark { case loading, failed(String) }

    private func key(_ feed: DetailFeed, _ id: String) -> String { "\(feed.rawValue):\(id)" }

    private func nextStamp(_ feed: DetailFeed, _ id: String) -> Int {
        let next = (stamps[key(feed, id)] ?? 0) + 1
        stamps[key(feed, id)] = next
        return next
    }

    /// Applies `mutate` only while this model belongs to a live store AND `stamp` is still the
    /// newest load of this feed+session.
    private func commit(_ feed: DetailFeed, _ id: String, _ stamp: Int, _ mutate: () -> Void) {
        guard alive else {
            Log.ui.debug("dropping a detail read for a store that went away")
            return
        }
        guard stamps[key(feed, id)] == stamp else {
            Log.ui.debug("dropping a superseded detail read")
            return
        }
        mutate()
    }

    private func set(_ feed: DetailFeed, _ id: String, _ mark: Mark) {
        switch (feed, mark) {
        case (.activity, .loading): activity[id] = .loading
        case (.diff, .loading): diff[id] = .loading
        case (.files, .loading): files[id] = .loading
        case (.git, .loading): git[id] = .loading
        case (.activity, .failed(let m)): activity[id] = .failed(m)
        case (.diff, .failed(let m)): diff[id] = .failed(m)
        case (.files, .failed(let m)): files[id] = .failed(m)
        case (.git, .failed(let m)): git[id] = .failed(m)
        }
    }
}
```

- [ ] **Step 7: Run the tests**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/DetailModelTests
```

Expected: `** TEST SUCCEEDED **`, 8 cases.

- [ ] **Step 8: Commit**

```bash
git add ui/messages/en.json ui/messages/de.json native/scripts/gen-strings.ts \
  native/Apps/ShepherdMac/Resources/Localizable.xcstrings \
  native/Apps/ShepherdMac/Sources/Detail/DetailModel.swift \
  native/Apps/ShepherdMac/Tests/DetailModelTests.swift
git commit -m "feat(mac): detail caches and the copy the detail tabs use"
```

---

## Task 6: Tab registration and the activity tab

**Files:**
- Create: `native/Apps/ShepherdMac/Sources/Detail/DetailTabs.swift`, `native/Apps/ShepherdMac/Sources/Detail/ActivityTabView.swift`
- Modify: the S0 stream-install call site (**one line**)

**Interfaces:**
- Consumes: `DetailTab`, `DetailTabRegistry`, `AppModel.register/extension` (Gate S0); `DetailModel` (Task 5); `L.t`.
- Produces: `enum DetailFeature { static func install(_ app: AppModel); static func model(_ app: AppModel) -> DetailModel? }`, `enum DetailStatePhase`, `struct DetailStateView<Content: View>`, `struct ActivityTab: DetailTab` (order 10), `struct ActivityTabView: View`. Tasks 7–9 add their tabs to the same two extension points.

- [ ] **Step 1: Confirm the seams and the install point**

```bash
grep -rn "enum DetailTabRegistry\|protocol AppExtension" native/Apps/ShepherdMac/Sources/App/
grep -rn "StreamBootstrap\|installAll\|stream install" native/Apps/ShepherdMac/Sources/App/
```

Expected: both seams exist, and one file holds the place every stream adds its install line. If the install point does not exist, stop and ask the orchestrator — do not put the registration into `ShepherdApp`'s own body.

- [ ] **Step 2: Write the registration and the shared state view**

Create `native/Apps/ShepherdMac/Sources/Detail/DetailTabs.swift`:

```swift
import SwiftUI
import ShepherdKit

/// Stream S2's entry point. The S0 install site calls this exactly once at launch.
enum DetailFeature {
    @MainActor
    static func install(_ app: AppModel) {
        // One per SessionStore: AppModel builds it in activate(_:) and tears it down with the
        // store, so every cache dies with the server it belongs to.
        app.register(DetailModel.self)
        DetailTabRegistry.register(ActivityTab())
    }

    /// The model for the active store, or nil between activations. Every tab view starts here.
    @MainActor
    static func model(_ app: AppModel) -> DetailModel? { app.extension(DetailModel.self) }
}

/// What a tab should render. A tab maps its own `Loaded` value onto this.
enum DetailStatePhase: Equatable {
    case loading
    case empty(String)
    case failed(String)
    case content
}

/// The loading / empty / error chrome every detail tab shares, so the four cannot drift apart on
/// how a failure reads.
struct DetailStateView<Content: View>: View {
    let state: DetailStatePhase
    let retry: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        switch state {
        case .loading:
            ProgressView(L.t("common_loading")).frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty(let message):
            ContentUnavailableView(message, systemImage: "tray")
        case .failed(let message):
            VStack(spacing: 12) {
                Text(verbatim: message).foregroundStyle(.secondary)
                Button(L.t("common_retry"), action: retry)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("detail-error")
        case .content:
            content()
        }
    }
}

struct ActivityTab: DetailTab {
    let id = "activity"
    var title: String { L.t("native_detail_tab_activity") }
    let systemImage = "list.bullet.rectangle"
    let order = 10

    @MainActor
    func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView {
        guard let model = DetailFeature.model(app) else { return AnyView(EmptyView()) }
        return AnyView(ActivityTabView(session: session, model: model))
    }
}
```

- [ ] **Step 3: Write the activity tab**

Create `native/Apps/ShepherdMac/Sources/Detail/ActivityTabView.swift`:

```swift
import SwiftUI
import ShepherdKit

/// The agent's recent tool use, newest first — the native reading of ActivityFeed.svelte.
///
/// `.task(id:)` is keyed on the session id, so SwiftUI cancels the 5 s poll when the operator
/// selects another row, and the model drops whatever read was still in flight.
struct ActivityTabView: View {
    let session: Session
    let model: DetailModel

    private var state: Loaded<[ActivityEntry]> { model.activity[session.id] ?? .idle }
    /// Newest first: the server sends oldest-first and the operator reads the latest line.
    private var entries: [ActivityEntry] { (state.value ?? []).reversed() }

    var body: some View {
        DetailStateView(state: phase, retry: reload) {
            List(Array(entries.enumerated()), id: \.offset) { _, entry in row(entry) }
                .listStyle(.inset)
                .accessibilityIdentifier("activity-list")
        }
        .toolbar {
            ToolbarItem {
                Button(L.t("native_detail_refresh"), systemImage: "arrow.clockwise", action: reload)
                    .labelStyle(.iconOnly)
                    .disabled(state.isLoading)
            }
        }
        .task(id: session.id) { await model.poll(.activity, session: session.id) }
    }

    private var phase: DetailStatePhase {
        if let failure = state.failure { return .failed(failure) }
        if state.value == nil { return .loading }
        return entries.isEmpty ? .empty(L.t("activity_empty")) : .content
    }

    private func row(_ entry: ActivityEntry) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(verbatim: Self.clock(entry.ts))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            Text(verbatim: entry.tool)
                .font(.caption.monospaced().weight(.semibold))
                .frame(width: 88, alignment: .leading)
            Text(verbatim: entry.summary)
                .font(.callout)
                // An open enum: only the error we know about earns the red tint.
                .foregroundStyle(entry.status.known == .error ? Color.red : Color.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
        .opacity(entry.status.known == .pending ? 0.6 : 1)
    }

    private static func clock(_ ms: Int) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(date: .omitted, time: .standard)
    }

    private func reload() { Task { await model.load(.activity, session: session.id) } }
}
```

- [ ] **Step 4: Add the install line**

At the stream-install point Gate S0 named, add exactly:

```swift
        DetailFeature.install(app)
```

- [ ] **Step 5: Build, test, look at it**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests
./native/scripts/build-app.sh Debug
open native/Apps/ShepherdMac/.build/Build/Products/Debug/Shepherd.app
```

Expected: `** TEST SUCCEEDED **` (`StringCatalogTests` passes, which is what catches a typo'd `L.t(…)`), then `Built: …/Shepherd.app`, and the detail pane shows an "Activity" tab that renders lines or "No activity yet.".

- [ ] **Step 6: Commit**

```bash
git add native/Apps/ShepherdMac/Sources/Detail/ \
  "$(grep -rl 'DetailFeature.install' native/Apps/ShepherdMac/Sources/App/)"
git commit -m "feat(mac): register the detail tabs and add the activity timeline"
```

---

## Task 7: Diff tab and the unified-patch parser

**Files:**
- Create: `native/Apps/ShepherdMac/Sources/Detail/UnifiedPatch.swift`, `.../DiffTabView.swift`, `native/Apps/ShepherdMac/Tests/UnifiedPatchTests.swift`
- Modify: `native/Apps/ShepherdMac/Sources/Detail/DetailTabs.swift`

**Interfaces:**
- Consumes: `DetailModel.diff`, `DetailStateView`, `DiffFile`, `DiffNote`.
- Produces: `struct UnifiedPatch { struct Hunk { var header: String; var lines: [Line] }; struct Line { enum Kind { case add, del, context }; var kind: Kind; var text: String; var oldNumber: Int?; var newNumber: Int? }; var hunks: [Hunk]; static func parse(_ patch: String) -> UnifiedPatch }`, `struct DiffTab: DetailTab` (order 20), `struct DiffTabView: View`.

- [ ] **Step 1: Write the failing parser test**

Create `native/Apps/ShepherdMac/Tests/UnifiedPatchTests.swift`:

```swift
import Testing
@testable import Shepherd

struct UnifiedPatchTests {
    @Test func parsesHunkHeadersAndNumbersBothSides() {
        let parsed = UnifiedPatch.parse("""
            @@ -10,3 +10,4 @@ func thing()
             context
            -gone
            +new
            +extra
            """)
        #expect(parsed.hunks.count == 1)
        #expect(parsed.hunks[0].header == "@@ -10,3 +10,4 @@ func thing()")
        let lines = parsed.hunks[0].lines
        #expect(lines.map(\.kind) == [.context, .del, .add, .add])
        #expect(lines[0].oldNumber == 10 && lines[0].newNumber == 10)
        #expect(lines[1].oldNumber == 11 && lines[1].newNumber == nil)
        #expect(lines[2].oldNumber == nil && lines[2].newNumber == 11)
        #expect(lines[3].newNumber == 12)
    }

    @Test func keepsSeveralHunksApart() {
        let parsed = UnifiedPatch.parse("@@ -1 +1 @@\n-a\n+b\n@@ -20,2 +20,2 @@\n ctx\n-c")
        #expect(parsed.hunks.count == 2)
        #expect(parsed.hunks[1].lines.first?.oldNumber == 20)
    }

    @Test func aRangeWithNoCountIsOneLine() {
        let parsed = UnifiedPatch.parse("@@ -7 +9 @@\n-x\n+y")
        #expect(parsed.hunks[0].lines[0].oldNumber == 7)
        #expect(parsed.hunks[0].lines[1].newNumber == 9)
    }

    @Test func ignoresThePreambleBeforeTheFirstHunk() {
        let parsed = UnifiedPatch.parse(
            "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n+y")
        #expect(parsed.hunks.count == 1)
        #expect(parsed.hunks[0].lines.map(\.text) == ["y"])
    }

    @Test func aNoNewlineMarkerIsNotAContextLine() {
        let parsed = UnifiedPatch.parse("@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file")
        #expect(parsed.hunks[0].lines.count == 2)
    }

    @Test func emptyOrGarbageInputIsAnEmptyPatch() {
        #expect(UnifiedPatch.parse("").hunks.isEmpty)
        #expect(UnifiedPatch.parse("not a patch at all").hunks.isEmpty)
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/UnifiedPatchTests
```

Expected: compile failure — `cannot find 'UnifiedPatch' in scope`.

- [ ] **Step 3: Write the parser**

Create `native/Apps/ShepherdMac/Sources/Detail/UnifiedPatch.swift`:

```swift
import Foundation

/// A parsed unified git patch for one file.
///
/// `GET /api/sessions/{id}/diff` strips the server's parsed hunks and sends `DiffFile.patch` —
/// the raw patch block — instead, which is what the web UI hands to its diff renderer. This
/// models **no server payload**: the wire type is a `String` the contract already declares, so
/// the "no hand-written Codable" rule is intact.
struct UnifiedPatch: Equatable, Sendable {
    struct Line: Equatable, Sendable {
        enum Kind: Equatable, Sendable { case add, del, context }
        var kind: Kind
        /// The text WITHOUT its leading `+`, `-` or space marker.
        var text: String
        /// 1-based number on the old side; nil on an added line.
        var oldNumber: Int?
        /// 1-based number on the new side; nil on a deleted line.
        var newNumber: Int?
    }

    struct Hunk: Equatable, Sendable {
        /// The raw `@@ -a,b +c,d @@ …` line, shown as the hunk's header.
        var header: String
        var lines: [Line]
    }

    var hunks: [Hunk]

    /// Parses a patch block. Anything before the first `@@` (the `diff --git`/`index`/`---`/`+++`
    /// preamble) is skipped, and a malformed body yields an empty patch rather than a crash — a
    /// diff the operator cannot read must not take the window with it.
    static func parse(_ patch: String) -> UnifiedPatch {
        var hunks: [Hunk] = []
        var current: Hunk?
        var oldNo = 0
        var newNo = 0

        func flush() {
            if let hunk = current { hunks.append(hunk) }
            current = nil
        }

        for raw in patch.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix("@@") {
                flush()
                guard let start = parseHeader(line) else { continue }
                (oldNo, newNo) = start
                current = Hunk(header: line, lines: [])
                continue
            }
            guard current != nil else { continue }
            // "\ No newline at end of file" annotates the previous line; it is not content.
            if line.hasPrefix("\\") { continue }
            switch line.first {
            case "+":
                current?.lines.append(
                    Line(kind: .add, text: String(line.dropFirst()), oldNumber: nil, newNumber: newNo))
                newNo += 1
            case "-":
                current?.lines.append(
                    Line(kind: .del, text: String(line.dropFirst()), oldNumber: oldNo, newNumber: nil))
                oldNo += 1
            case " ":
                current?.lines.append(
                    Line(kind: .context, text: String(line.dropFirst()), oldNumber: oldNo, newNumber: newNo))
                oldNo += 1
                newNo += 1
            case nil:
                // A bare empty line inside a hunk is an unmarked context line: git writes it that
                // way when the file's own line is empty and the trailing space was stripped.
                current?.lines.append(
                    Line(kind: .context, text: "", oldNumber: oldNo, newNumber: newNo))
                oldNo += 1
                newNo += 1
            default:
                flush()   // anything else ends the hunk (the next file's `diff --git`, say)
            }
        }
        flush()
        return UnifiedPatch(hunks: hunks)
    }

    /// `@@ -oldStart[,count] +newStart[,count] @@ …` → the two start numbers. A range with no
    /// count is one line, which is why the count is never read.
    private static func parseHeader(_ header: String) -> (Int, Int)? {
        let fields = header.split(separator: " ")
        guard fields.count >= 3 else { return nil }
        func start(_ field: Substring, _ marker: Character) -> Int? {
            guard field.first == marker, let first = field.dropFirst().split(separator: ",").first
            else { return nil }
            return Int(first)
        }
        guard let old = start(fields[1], "-"), let new = start(fields[2], "+") else { return nil }
        return (old, new)
    }
}
```

- [ ] **Step 4: Run the parser tests**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/UnifiedPatchTests
```

Expected: `** TEST SUCCEEDED **`, 6 cases.

- [ ] **Step 5: Write the diff tab**

Create `native/Apps/ShepherdMac/Sources/Detail/DiffTabView.swift`:

```swift
import SwiftUI
import ShepherdKit

/// The session branch against its base: a file list on the left, unified hunks on the right,
/// annotations inline — the native reading of DiffPanel.svelte. Monospace and syntax-neutral on
/// purpose: no highlighter ships with this app.
struct DiffTabView: View {
    let session: Session
    let model: DetailModel
    @State private var selectedPath: String?

    private var state: Loaded<DetailModel.DiffPayload> { model.diff[session.id] ?? .idle }
    private var files: [DiffFile] { state.value?.result.files ?? [] }
    private var notes: [DiffNote] { state.value?.notes ?? [] }

    var body: some View {
        DetailStateView(state: phase, retry: reload) {
            HSplitView {
                fileList.frame(minWidth: 200, idealWidth: 260, maxWidth: 380)
                VStack(alignment: .leading, spacing: 0) {
                    header
                    noteList(notes.filter { $0.path.isEmpty })   // panel-level review findings
                    ScrollView { body(for: selected).padding(.horizontal, 12) }
                }
            }
        }
        .toolbar {
            ToolbarItem {
                Button(L.t("diff_refresh"), systemImage: "arrow.clockwise", action: reload)
                    .labelStyle(.iconOnly)
                    .disabled(state.isLoading)
            }
        }
        .task(id: session.id) {
            selectedPath = nil
            await model.poll(.diff, session: session.id)
        }
    }

    private var selected: DiffFile? {
        files.first { $0.path == selectedPath } ?? files.first
    }

    private var phase: DetailStatePhase {
        if let failure = state.failure { return .failed(failure) }
        if state.value == nil { return .loading }
        return files.isEmpty
            ? .empty(L.t("diff_empty", state.value?.result.baseRef ?? ""))
            : .content
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text(verbatim: "\(files.count) · +\(files.reduce(0) { $0 + $1.additions }) −\(files.reduce(0) { $0 + $1.deletions })")
                .font(.caption.monospaced())
            if state.value?.result.fetchFailed == true {
                Label(
                    L.t("diff_stale", state.value?.result.base ?? ""),
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.caption)
                .foregroundStyle(.orange)
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var fileList: some View {
        List(files, id: \.path, selection: $selectedPath) { file in
            HStack(spacing: 8) {
                Text(verbatim: glyph(file.status))
                    .font(.caption.monospaced().weight(.bold))
                    .foregroundStyle(.secondary)
                Text(verbatim: file.path).font(.callout).lineLimit(1).truncationMode(.head)
                Spacer(minLength: 4)
                Text(verbatim: "+\(file.additions) −\(file.deletions)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            .tag(file.path)
        }
        .accessibilityIdentifier("diff-file-list")
    }

    /// An open enum: an unknown status keeps its first wire character rather than pretending to
    /// be one of the four this build knows.
    private func glyph(_ status: Components.Schemas.DiffFileStatus) -> String {
        switch status.known {
        case .added: "A"
        case .modified: "M"
        case .deleted: "D"
        case .renamed: "R"
        case nil: String(status.rawValue.prefix(1)).uppercased()
        }
    }

    @ViewBuilder
    private func body(for file: DiffFile?) -> some View {
        if let file {
            VStack(alignment: .leading, spacing: 10) {
                // File-level findings, then the hunks with their per-line notes.
                noteList(notes.filter { $0.path == file.path && $0.lineNumber == nil })
                if file.binary {
                    Text(verbatim: L.t("diff_note_binary")).foregroundStyle(.secondary)
                } else if file.truncated == true {
                    Text(verbatim: L.t("diff_note_truncated")).foregroundStyle(.secondary)
                } else {
                    let hunks = UnifiedPatch.parse(file.patch ?? "").hunks
                    if hunks.isEmpty {
                        Text(verbatim: L.t("diff_note_no_changes")).foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(hunks.enumerated()), id: \.offset) { _, hunk in
                            hunkView(hunk, file: file)
                        }
                    }
                }
            }
            .padding(.vertical, 8)
        }
    }

    private func hunkView(_ hunk: UnifiedPatch.Hunk, file: DiffFile) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: hunk.header)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .padding(.vertical, 4)
            ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                lineView(line)
                // An agent annotation sits under the line it is anchored to, the way the web
                // panel renders it inline rather than in a side list.
                noteList(anchored(line, file: file)).padding(.leading, 24)
            }
        }
    }

    /// Notes anchored to this exact line. `side` decides which number to match: an `additions`
    /// note counts the new side, a `deletions` note the old one.
    private func anchored(_ line: UnifiedPatch.Line, file: DiffFile) -> [DiffNote] {
        notes.filter { note in
            guard note.path == file.path, let number = note.lineNumber else { return false }
            return switch note.side?.known {
            case .deletions: line.oldNumber == number
            default: line.newNumber == number
            }
        }
    }

    private func lineView(_ line: UnifiedPatch.Line) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(verbatim: line.oldNumber.map(String.init) ?? " ")
                .frame(width: 42, alignment: .trailing)
                .foregroundStyle(.secondary)
            Text(verbatim: line.newNumber.map(String.init) ?? " ")
                .frame(width: 42, alignment: .trailing)
                .foregroundStyle(.secondary)
            Text(verbatim: marker(line.kind) + line.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
        .font(.system(.caption, design: .monospaced))
        .background(background(line.kind))
    }

    private func marker(_ kind: UnifiedPatch.Line.Kind) -> String {
        switch kind {
        case .add: "+"
        case .del: "-"
        case .context: " "
        }
    }

    private func background(_ kind: UnifiedPatch.Line.Kind) -> Color {
        switch kind {
        case .add: .green.opacity(0.14)
        case .del: .red.opacity(0.14)
        case .context: .clear
        }
    }

    @ViewBuilder
    private func noteList(_ list: [DiffNote]) -> some View {
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(list.enumerated()), id: \.offset) { _, note in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(
                            verbatim: note.kind.known == .review
                                ? L.t("viewport_diff_annotation_review")
                                : L.t("native_detail_annotation_agent")
                        )
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.secondary.opacity(0.15), in: Capsule())
                        Text(verbatim: note.text)
                            .font(.caption)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func reload() { Task { await model.load(.diff, session: session.id) } }
}
```

- [ ] **Step 6: Register the tab**

In `DetailTabs.swift`, add `DetailTabRegistry.register(DiffTab())` to `install(_:)` and this type at the end of the file:

```swift
struct DiffTab: DetailTab {
    let id = "diff"
    var title: String { L.t("native_detail_tab_diff") }
    let systemImage = "plusminus"
    let order = 20

    @MainActor
    func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView {
        guard let model = DetailFeature.model(app) else { return AnyView(EmptyView()) }
        return AnyView(DiffTabView(session: session, model: model))
    }
}
```

- [ ] **Step 7: Build and test**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests && ./native/scripts/build-app.sh Debug
```

Expected: `** TEST SUCCEEDED **`, then `Built: …/Shepherd.app`.

- [ ] **Step 8: Commit**

```bash
git add native/Apps/ShepherdMac/Sources/Detail/ native/Apps/ShepherdMac/Tests/UnifiedPatchTests.swift
git commit -m "feat(mac): unified diff tab with inline annotations"
```

---

## Task 8: Files tab (scratchpad + worktree)

**Files:**
- Create: `native/Apps/ShepherdMac/Sources/Detail/FilesTabView.swift`
- Modify: `native/Apps/ShepherdMac/Sources/Detail/DetailTabs.swift`, `native/Apps/ShepherdMac/Tests/DetailModelTests.swift`

**Interfaces:**
- Consumes: `DetailModel.browse(session:source:path:)`, `DetailModel.files`, `DetailStateView`.
- Produces: `enum FilesBreadcrumb { static func trail(_ path: String) -> [(label: String, path: String?)] }`, `struct FilesTab: DetailTab` (order 30), `struct FilesTabView: View`.

- [ ] **Step 1: Write the failing breadcrumb test**

Append to `native/Apps/ShepherdMac/Tests/DetailModelTests.swift`:

```swift
struct FilesBreadcrumbTests {
    @Test func theRootIsASingleCrumbWithNoPath() {
        let trail = FilesBreadcrumb.trail("")
        #expect(trail.count == 1)
        #expect(trail[0].path == nil)
    }

    @Test func eachSegmentGetsItsOwnCumulativePath() {
        let trail = FilesBreadcrumb.trail("docs/api/v2")
        #expect(trail.map(\.label) == ["", "docs", "api", "v2"])
        #expect(trail.map(\.path) == [nil, "docs", "docs/api", "docs/api/v2"])
    }

    @Test func aTrailingSlashDoesNotCreateAnEmptyCrumb() {
        #expect(FilesBreadcrumb.trail("docs/").map(\.label) == ["", "docs"])
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/FilesBreadcrumbTests
```

Expected: compile failure — `cannot find 'FilesBreadcrumb' in scope`.

- [ ] **Step 3: Write the files tab**

Create `native/Apps/ShepherdMac/Sources/Detail/FilesTabView.swift`:

```swift
import SwiftUI
import ShepherdKit

/// The cumulative path behind each breadcrumb. The root crumb carries `nil`, which is what the
/// client sends to list the root.
enum FilesBreadcrumb {
    static func trail(_ path: String) -> [(label: String, path: String?)] {
        var trail: [(label: String, path: String?)] = [(label: "", path: nil)]
        var cumulative = ""
        for segment in path.split(separator: "/") where !segment.isEmpty {
            cumulative = cumulative.isEmpty ? String(segment) : "\(cumulative)/\(segment)"
            trail.append((label: String(segment), path: cumulative))
        }
        return trail
    }
}

/// A read-only browser over the session's two file roots — the native reading of
/// FilesPanel.svelte, minus upload and download.
///
/// One directory at a time, like the web panel: the server answers one listing per request, and
/// a tree would have to walk it — a lot of requests for a pane the operator glances at.
struct FilesTabView: View {
    let session: Session
    let model: DetailModel
    @State private var source: DetailModel.FilesSource = .scratchpad

    private var state: Loaded<DetailModel.FilesPayload> { model.files[session.id] ?? .idle }
    /// Only the listing for the source currently selected; a stale one from the other source
    /// must not flash while the new read is in flight.
    private var listing: BrowseListing? {
        guard let payload = state.value, payload.source == source else { return nil }
        return payload.listing
    }

    var body: some View {
        VStack(spacing: 0) {
            controls
            Divider()
            DetailStateView(state: phase, retry: { browse(nil) }) {
                List(listing?.entries ?? [], id: \.path) { entry in row(entry) }
                    .listStyle(.inset)
                    .accessibilityIdentifier("files-list")
            }
        }
        .task(id: session.id) { await model.browse(session: session.id, source: source, path: nil) }
        .onChange(of: source) { _, _ in browse(nil) }
    }

    private var controls: some View {
        HStack(spacing: 10) {
            Picker("", selection: $source) {
                Text(verbatim: L.t("files_source_scratchpad")).tag(DetailModel.FilesSource.scratchpad)
                Text(verbatim: L.t("files_source_worktree")).tag(DetailModel.FilesSource.worktree)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 220)
            ForEach(Array(FilesBreadcrumb.trail(listing?.path ?? "").enumerated()), id: \.offset) {
                _, crumb in
                Button(crumb.path == nil ? rootLabel : crumb.label) { browse(crumb.path) }
                    .buttonStyle(.link)
            }
            Spacer()
            Button(L.t("native_detail_refresh"), systemImage: "arrow.clockwise") {
                browse(listing?.path)
            }
            .labelStyle(.iconOnly)
            .disabled(state.isLoading)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var rootLabel: String {
        source == .scratchpad ? L.t("files_source_scratchpad") : L.t("files_source_worktree")
    }

    private var phase: DetailStatePhase {
        // The two roots word their failure differently, as the web panel does; the mapped error
        // itself is in the log, not in a line that would read as a server error to the operator.
        if state.failure != nil {
            return .failed(
                source == .scratchpad ? L.t("files_load_error") : L.t("files_worktree_load_error"))
        }
        guard let listing else { return .loading }
        return listing.entries.isEmpty
            ? .empty(source == .scratchpad ? L.t("files_empty") : L.t("files_worktree_empty"))
            : .content
    }

    @ViewBuilder
    private func row(_ entry: BrowseEntry) -> some View {
        let outside = entry.linkOutside == true
        HStack(spacing: 8) {
            // An open enum: anything that is not a directory this build knows reads as a file
            // rather than disappearing from the list.
            Text(verbatim: outside ? "↗" : (entry._type.known == .dir ? "▸" : "▢"))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            if entry._type.known == .dir, !outside {
                Button(entry.name) { browse(entry.path) }
                    .buttonStyle(.plain)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text(verbatim: entry.name)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .foregroundStyle(outside ? .secondary : .primary)
                    .help(outside ? L.t("files_link_outside_title") : "")
            }
            Text(verbatim: created(entry))
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 160, alignment: .trailing)
                .help(entry.createdMs == nil ? L.t("files_created_unknown") : "")
        }
    }

    private func created(_ entry: BrowseEntry) -> String {
        guard let ms = entry.createdMs else { return "—" }
        return Date(timeIntervalSince1970: Double(ms) / 1000)
            .formatted(date: .abbreviated, time: .shortened)
    }

    private func browse(_ path: String?) {
        Task { await model.browse(session: session.id, source: source, path: path) }
    }
}
```

- [ ] **Step 4: Register the tab**

In `DetailTabs.swift`, add `DetailTabRegistry.register(FilesTab())` to `install(_:)` and:

```swift
struct FilesTab: DetailTab {
    let id = "files"
    var title: String { L.t("native_detail_tab_files") }
    let systemImage = "folder"
    let order = 30

    @MainActor
    func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView {
        guard let model = DetailFeature.model(app) else { return AnyView(EmptyView()) }
        return AnyView(FilesTabView(session: session, model: model))
    }
}
```

- [ ] **Step 5: Test and build**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests && ./native/scripts/build-app.sh Debug
```

Expected: `** TEST SUCCEEDED **` with 3 new `FilesBreadcrumbTests` cases, then `Built: …/Shepherd.app`.

- [ ] **Step 6: Commit**

```bash
git add native/Apps/ShepherdMac/Sources/Detail/ native/Apps/ShepherdMac/Tests/DetailModelTests.swift
git commit -m "feat(mac): read-only scratchpad and worktree browser"
```

---

## Task 9: Git/PR tab, live check and the PR

**Files:**
- Create: `native/Apps/ShepherdMac/Sources/Detail/GitTabView.swift`, `native/Apps/ShepherdMac/Tests/GitPanelTests.swift`
- Modify: `native/Apps/ShepherdMac/Sources/Detail/DetailTabs.swift`

**Interfaces:**
- Consumes: `DetailModel.git`/`refreshGit`, the six client actions plus `reviewers`, `SessionCommandState` and `NoticeBar` (both already in `Sources/Main/MainWindow.swift`, same module — reused, not re-implemented), `ShepherdErrorCopy`.
- Produces: `enum GitPanelRules { static func mergeBlocked(_ git: GitState, busy: Bool) -> Bool; static func ciLabel(_ git: GitState) -> String; static func ciTint(_ git: GitState) -> Color; static func canRequestReview(_ git: GitState) -> Bool }`, `struct GitTab: DetailTab` (order 40), `struct GitTabView: View`.

- [ ] **Step 1: Write the failing rules test**

Create `native/Apps/ShepherdMac/Tests/GitPanelTests.swift`:

```swift
import Testing
import ShepherdKit
@testable import Shepherd

struct GitPanelTests {
    private func git(
        state: PrStateKnown = .open,
        checks: ChecksStateKnown = .success,
        mergeState: MergeStateStatusKnown? = .clean,
        isDraft: Bool? = false,
        kind: ForgeKindKnown? = .github,
        number: Int? = 12
    ) -> GitState {
        GitState(
            kind: kind.map { .init(known: $0) },
            state: .init(known: state),
            number: number,
            checks: .init(known: checks),
            mergeStateStatus: mergeState.map { .init(known: $0) },
            isDraft: isDraft,
            deployConfigured: false)
    }

    @Test func aCleanOpenPrCanBeMergedAndBusyBlocksIt() {
        #expect(GitPanelRules.mergeBlocked(git(), busy: false) == false)
        #expect(GitPanelRules.mergeBlocked(git(), busy: true))
    }

    @Test func aDraftFailingOrBlockedPrCannotBeMerged() {
        #expect(GitPanelRules.mergeBlocked(git(isDraft: true), busy: false))
        #expect(GitPanelRules.mergeBlocked(git(checks: .failure), busy: false))
        #expect(GitPanelRules.mergeBlocked(git(mergeState: .blocked), busy: false))
        #expect(GitPanelRules.mergeBlocked(git(mergeState: .behind), busy: false))
        #expect(GitPanelRules.mergeBlocked(git(mergeState: .dirty), busy: false))
    }

    @Test func aPrThatIsNotOpenCannotBeMerged() {
        #expect(GitPanelRules.mergeBlocked(git(state: .merged), busy: false))
        #expect(GitPanelRules.mergeBlocked(git(state: .none), busy: false))
    }

    @Test func aMergeStateThisBuildDoesNotKnowIsNotTreatedAsBlocking() {
        var unknown = git()
        unknown.mergeStateStatus = .init(unknown: "quiescing")
        #expect(GitPanelRules.mergeBlocked(unknown, busy: false) == false)
    }

    @Test func theCiLabelFollowsTheChecksState() {
        #expect(GitPanelRules.ciLabel(git(checks: .success)) == L.t("gitrail_ci_passing"))
        #expect(GitPanelRules.ciLabel(git(checks: .pending)) == L.t("gitrail_ci_pending"))
        #expect(GitPanelRules.ciLabel(git(checks: .failure)) == L.t("gitrail_ci_failing"))
        #expect(GitPanelRules.ciLabel(git(checks: .none)) == L.t("gitrail_ci_none"))
    }

    @Test func onlyAnOpenGithubPrWithANumberCanRequestAReview() {
        #expect(GitPanelRules.canRequestReview(git()))
        #expect(GitPanelRules.canRequestReview(git(kind: .local)) == false)
        #expect(GitPanelRules.canRequestReview(git(number: nil)) == false)
        #expect(GitPanelRules.canRequestReview(git(state: .closed)) == false)
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/GitPanelTests
```

Expected: compile failure — `cannot find 'GitPanelRules' in scope`.

- [ ] **Step 3: Write the git tab**

Create `native/Apps/ShepherdMac/Sources/Detail/GitTabView.swift`:

```swift
import SwiftUI
import ShepherdKit

/// When an action is offered and when it is refused — the native reading of GitRail's
/// `mergeBlocked` and `ciLabel`. Pure functions, so the rules are tested without hosting a view
/// (the pattern `SessionStatusStyle` uses).
enum GitPanelRules {
    /// Every open enum is read through `known`: a value this build has never heard of must not
    /// silently disable the operator's merge button, so an unknown merge state is NOT blocking.
    static func mergeBlocked(_ git: GitState, busy: Bool) -> Bool {
        if busy { return true }
        guard git.state.known == .open else { return true }
        if git.isDraft == true { return true }
        if git.checks.known == .failure { return true }
        switch git.mergeStateStatus?.known {
        case .blocked, .behind, .dirty: return true
        default: return false
        }
    }

    static func ciLabel(_ git: GitState) -> String {
        switch git.checks.known {
        case .success: L.t("gitrail_ci_passing")
        case .pending: L.t("gitrail_ci_pending")
        case .failure: L.t("gitrail_ci_failing")
        case .none: L.t("gitrail_ci_none")
        case nil: git.checks.rawValue
        }
    }

    static func ciTint(_ git: GitState) -> Color {
        switch git.checks.known {
        case .success: .green
        case .pending: .orange
        case .failure: .red
        default: .secondary
        }
    }

    /// GitHub only, and only for an open PR that has a number to request a review on.
    static func canRequestReview(_ git: GitState) -> Bool {
        git.kind?.known == .github && git.state.known == .open && git.number != nil
    }
}

/// PR status and the actions that change it.
///
/// Every action goes through `SessionCommandState` — the gate the toolbar's archive and
/// interrupt already use — so exactly one runs at a time, a failure lands in a `NoticeBar` in
/// the operator's language, and a completion for a store the operator has left touches nothing.
/// The two destructive actions are behind a confirmation dialog, like the archive flow.
struct GitTabView: View {
    let session: Session
    let model: DetailModel
    let store: SessionStore
    @State private var command = SessionCommandState()
    @State private var confirmingMerge = false
    @State private var confirmingClose = false
    @State private var reviewers: Loaded<PrReviewerOptions> = .idle
    @State private var chosenReviewer: String?

    private var state: Loaded<GitState?> { model.git[session.id] ?? .idle }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let message = command.message {
                NoticeBar(message: message) { command.clear() }
            }
            DetailStateView(state: phase, retry: reload) { content }
        }
        .confirmationDialog(
            L.t("native_detail_merge_confirm_title"), isPresented: $confirmingMerge,
            titleVisibility: .visible
        ) {
            Button(L.t("native_detail_merge_confirm_action")) { merge() }
            Button(L.t("common_cancel"), role: .cancel) {}
        } message: {
            Text(verbatim: L.t("native_detail_merge_confirm_body"))
        }
        .confirmationDialog(
            L.t("native_detail_close_confirm_title"), isPresented: $confirmingClose,
            titleVisibility: .visible
        ) {
            Button(L.t("native_detail_close_confirm_action"), role: .destructive) { closePR() }
            Button(L.t("common_cancel"), role: .cancel) {}
        } message: {
            Text(verbatim: L.t("native_detail_close_confirm_body"))
        }
        .task(id: session.id) {
            command.clear()
            reviewers = .idle
            await model.poll(.git, session: session.id)
        }
    }

    private var phase: DetailStatePhase {
        if state.failure != nil { return .failed(L.t("gitrail_status_failed")) }
        guard let value = state.value else { return .loading }
        // A null GitState is "this repo has no forge, or no PR" — not an error.
        return value == nil ? .empty(L.t("native_detail_git_none")) : .content
    }

    @ViewBuilder
    private var content: some View {
        if let git = state.value ?? nil {
            VStack(alignment: .leading, spacing: 16) {
                summary(git)
                actions(git)
                if GitPanelRules.canRequestReview(git) { reviewRequest(git) }
                Spacer()
            }
            .padding(20)
            .accessibilityIdentifier("git-panel")
        }
    }

    private func summary(_ git: GitState) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                if let number = git.number {
                    Text(verbatim: "#\(number)").font(.title3.monospaced().weight(.semibold))
                }
                Text(verbatim: git.title ?? "").font(.title3)
                Spacer()
                Text(verbatim: GitPanelRules.ciLabel(git))
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(GitPanelRules.ciTint(git).opacity(0.18), in: Capsule())
                    .foregroundStyle(GitPanelRules.ciTint(git))
            }
            HStack(spacing: 12) {
                // The raw wire value: `state` is an open enum and this line is diagnostic.
                Text(verbatim: git.state.rawValue).font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                if let url = git.url, let link = URL(string: url) {
                    Link(url, destination: link).font(.caption)
                }
            }
            if let review = git.latestReview {
                Text(verbatim: "\(review.author) · \(review.state.rawValue)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func actions(_ git: GitState) -> some View {
        HStack(spacing: 10) {
            if git.state.known == .none {
                Button(L.t("gitrail_create_pr")) { openPR() }.disabled(command.busy)
            }
            if git.state.known == .open {
                Button(L.t("gitrail_merge")) { confirmingMerge = true }
                    .disabled(GitPanelRules.mergeBlocked(git, busy: command.busy))
                Button(git.isDraft == true ? L.t("prbadge_mark_ready") : L.t("prbadge_mark_draft")) {
                    toggleDraft(isDraft: git.isDraft == true)
                }
                .disabled(command.busy)
                Button(L.t("native_detail_close_confirm_action"), role: .destructive) {
                    confirmingClose = true
                }
                .disabled(command.busy)
            }
            if command.busy { ProgressView().controlSize(.small) }
            Spacer()
        }
    }

    @ViewBuilder
    private func reviewRequest(_ git: GitState) -> some View {
        GroupBox(L.t("prreview_title")) {
            HStack(spacing: 10) {
                switch reviewers {
                case .idle, .loading:
                    Text(verbatim: L.t("prreview_loading")).foregroundStyle(.secondary)
                case .failed:
                    Text(verbatim: L.t("prreview_load_failed")).foregroundStyle(.secondary)
                    Button(L.t("common_retry")) { loadReviewers() }
                case .ready(let options):
                    if candidates(options).isEmpty {
                        Text(verbatim: L.t("prreview_no_candidates")).foregroundStyle(.secondary)
                    } else {
                        Picker(L.t("native_detail_reviewer_label"), selection: $chosenReviewer) {
                            ForEach(candidates(options), id: \.self) { login in
                                Text(verbatim: login).tag(String?.some(login))
                            }
                        }
                        .frame(maxWidth: 260)
                        Button(L.t("prreview_title")) {
                            if let login = chosenReviewer, let number = git.number {
                                requestReview(number: number, login: login)
                            }
                        }
                        .disabled(command.busy || chosenReviewer == nil || options.isDraft)
                    }
                }
                Spacer()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: session.id) { loadReviewers() }
    }

    /// The author cannot review their own PR, and an already-requested reviewer is not offered
    /// again — the filter the web popover applies.
    private func candidates(_ options: PrReviewerOptions) -> [String] {
        options.logins.filter {
            $0 != options.authorLogin && !options.requestedReviewers.contains($0)
        }
    }

    // MARK: - Commands

    /// True while the model this view was built for is still the active one. Every result is
    /// dropped when it is not: a merge that lands after a profile switch must not write a notice
    /// about a server the operator has left.
    private func isCurrent() -> Bool { model.git[session.id] != nil }

    private func run(_ body: @escaping () async throws -> Void) {
        Task {
            let ok = await command.run(
                body,
                failureCopy: { L.t("native_detail_action_failed", $0) },
                isCurrent: isCurrent)
            if ok { await model.refreshGit(session: session.id) }
        }
    }

    private func openPR() {
        run { _ = try await store.client.openPR(sessionID: session.id, title: nil, body: nil) }
    }

    private func merge() {
        run { _ = try await store.client.mergePR(sessionID: session.id, method: nil, deleteBranch: nil) }
    }

    private func toggleDraft(isDraft: Bool) {
        run {
            _ = isDraft
                ? try await store.client.markPRReady(sessionID: session.id)
                : try await store.client.markPRDraft(sessionID: session.id)
        }
    }

    private func closePR() {
        run { _ = try await store.client.closePR(sessionID: session.id) }
    }

    private func requestReview(number: Int, login: String) {
        run {
            _ = try await store.client.requestPRReview(
                sessionID: session.id, prNumber: number, reviewer: login)
        }
    }

    private func loadReviewers() {
        reviewers = .loading
        Task {
            do {
                let options = try await store.client.reviewers(sessionID: session.id)
                guard isCurrent() else { return }
                reviewers = .ready(options)
                chosenReviewer = candidates(options).first
            } catch {
                guard isCurrent() else { return }
                reviewers = .failed(ShepherdErrorCopy.message(error))
            }
        }
    }

    private func reload() { Task { await model.load(.git, session: session.id) } }
}
```

- [ ] **Step 4: Register the tab**

In `DetailTabs.swift`, add `DetailTabRegistry.register(GitTab())` to `install(_:)` and:

```swift
struct GitTab: DetailTab {
    let id = "git"
    var title: String { L.t("native_detail_tab_git") }
    let systemImage = "arrow.triangle.pull"
    let order = 40

    @MainActor
    func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView {
        guard let model = DetailFeature.model(app) else { return AnyView(EmptyView()) }
        return AnyView(GitTabView(session: session, model: model, store: store))
    }
}
```

- [ ] **Step 5: Run everything**

```bash
bun run test && bun run lint && bun run typecheck
bun run check:contract-swift && ./native/scripts/sync-contract.sh --check && bun run check:strings
swift test --package-path native
./native/scripts/test-app.sh -only-testing:ShepherdTests
./native/scripts/build-app.sh
```

Expected, in order: the Bun suite green (including `test/contract/detail.test.ts`); `eslint` and `tsc` silent; no contract diff and `sync-contract: up to date`; `Localizable.xcstrings is up to date`; `swift test` green; `** TEST SUCCEEDED **`; `Built: …/Shepherd.app`.

- [ ] **Step 6: Live check against a real server**

Only when `SHEPHERD_LIVE_BASE_URL` is set — CI never sets it, and the suite skips itself without it.

```bash
SHEPHERD_LIVE_BASE_URL="$SHEPHERD_LIVE_BASE_URL" \
SHEPHERD_LIVE_PASSWORD="$SHEPHERD_LIVE_PASSWORD" \
  ./native/scripts/test-app.sh -only-testing:ShepherdTests/LiveServerTests
```

Expected: `** TEST SUCCEEDED **` with `liveSignInAndRestore` **run**, not skipped.

Then drive the four tabs by hand against the same server and record the result in the PR body:

```bash
./native/scripts/build-app.sh Debug
open native/Apps/ShepherdMac/.build/Build/Products/Debug/Shepherd.app
```

1. Activity — a running session shows tool lines that grow within about 5 s.
2. Diff — a session with commits lists files and renders hunks; one without shows "No changes vs …".
3. Files — both sources list; entering a directory updates the breadcrumbs; the worktree hides `.git`.
4. PR — a session with an open PR shows its number, CI chip and actions; a repo with no forge shows "No pull request for this session." rather than an error.

Never revoke the saved token from automation.

- [ ] **Step 7: Commit and open the PR**

```bash
git add native/Apps/ShepherdMac/Sources/Detail/ native/Apps/ShepherdMac/Tests/GitPanelTests.swift
git commit -m "feat(mac): pull-request panel with confirmed merge and close"
git push -u origin feat/native-detail-tabs
gh pr create --fill --title "feat(mac): session detail tabs — activity, diff, files, PR"
```

The PR body must carry the route and event list, the live-check results from Step 6, and the S0 handoff below verbatim, so the integration lane can act on it without reading this plan.

---

## S0 handoff — the shared edits this stream deliberately did not make

Hand these to the integration lane (`chore/native-integrate-detail`) after this branch merges. None is needed for the stream to work; each removes a documented compromise.

1. **`native/Sources/ShepherdKit/Client/ShepherdClient.swift`** — if `generated` is still `private`, widen it so `ShepherdClient+Detail.swift` (and every later stream's extension) can reach it. Task 3 Step 1 stops and asks for this rather than building a second `Client`.

   ```diff
   -  private let generated: Client
   +  let generated: Client
   ```

2. **`contracts/openapi.yaml`** — add the two names to the `EventName` enum:

   ```diff
        - "usage:limits"
   +    - "session:git"
   +    - "session:activity"
   ```

3. **`native/Sources/ShepherdKit/Realtime/ServerEvent.swift`** — the two cases those members make mandatory (the `switch name.known` is exhaustive, which is why this cannot be an additive file):

   ```diff
      case usageLimits(Components.Schemas.UsageLimits)
   +  case sessionGit(Components.Schemas.SessionGitEvent)
   +  case sessionActivity(Components.Schemas.SessionActivityEvent)
   ```
   ```diff
   +  case .session_colon_git:
   +    self = payload(Components.Schemas.SessionGitEvent.self).map(ServerEvent.sessionGit)
   +      ?? .unknown(name: name.rawValue)
   +  case .session_colon_activity:
   +    self = payload(Components.Schemas.SessionActivityEvent.self).map(ServerEvent.sessionActivity)
   +      ?? .unknown(name: name.rawValue)
   ```

   `SessionStore.applyNow` also switches exhaustively over `ServerEvent`, so it needs two arms — ignoring both is correct, since these caches live in `DetailModel`, not in the store.

4. **A fan-out seam on `SessionStore`** (optional, the real prize). The store owns the single consumer of `EventStream.events()` and exposes no way for an `AppExtension` to see a frame, which is why the tabs poll. A tap would let `DetailModel` patch `git[id]` straight from a `session:git` frame and drop the 15 s poll:

   ```swift
   /// Frames reach every tap AFTER the store has applied them. Taps are dropped by `stop()`, so
   /// a tap never outlives the store it was installed on.
   public func addEventTap(_ tap: @escaping @MainActor (ServerEvent) -> Void)
   ```

5. **`test/contract/harness.ts` / `openapi.test.ts`** — `streamBlockSurface()`, `claimedSurface()` and the stream-aware coverage gate (Task 1 Step 2) belong in S0-prep's own PR. If another stream landed them first this stream skipped the step; if this stream added them, fold them into the shared harness review.

## Open question

Whether the integration lane would rather land handoff item 4 (a `SessionStore` event tap) **before** this branch merges, so the detail tabs ship event-driven instead of polling — the tabs would then need one more commit here and the 15 s poll plus its test would come out.
