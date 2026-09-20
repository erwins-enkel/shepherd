# Stream S11 — Composer parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** bring the Mac's *Neue Aufgabe* sheet up to the web's. Today it is the milestone-1 shell —
repo, base branch, agent, model, prompt — and the thing the operator actually reaches for, **start
from an issue**, is not there at all. This stream builds the web's composer in the web's own visual
order, starting with the issue picker, and reuses the web's copy keys verbatim so the German UI is
the German UI.

**Why this stream is in the first wave.** The operator put the two dialogs side by side. The create
sheet is the app's most-used surface and the furthest from parity, and "pick an issue and start it"
is a daily action the Mac app cannot perform. That outranks every other composer gap.

**Architecture:** Ten operations enter `contracts/openapi.yaml` inside this stream's `compose`
block; Swift is regenerated from the derived file; one kit extension
(`ShepherdClient+Compose.swift`) wraps them. The app side is a new `Sources/Compose/**` sheet
installed by assigning `NewSessionSlot.content` — S0-prep-2's seam — so `MainWindow`'s "+" opens the
composer when the slot is filled and the milestone-1 form otherwise. No S0 file is edited and
`Sources/Main/NewSessionSheet.swift` does not change ownership.

**Tech Stack:** Bun + ajv (contract drift test), OpenAPI 3.1, swift-openapi-generator 1.13.1,
Swift 6 (language mode 6, strict concurrency `complete`), SwiftUI, Swift Testing (`import Testing`),
XcodeGen 2.46, `os.Logger`.

---

## Global Constraints

- **Swift 6 strict concurrency** (`SWIFT_STRICT_CONCURRENCY: complete`, `swiftLanguageModes: [.v6]`).
  No `@preconcurrency`, no `@unchecked Sendable`, no `nonisolated(unsafe)`.
- **No hand-written `Codable` for server payloads.** The contract is the only type source: a route
  enters `contracts/openapi.yaml` first, then `bun run gen:contract-swift` +
  `./native/scripts/sync-contract.sh` regenerate and copy the derived file. Never hand-edit
  `contracts/openapi.swift.yaml` or `native/Sources/ShepherdKit/openapi.yaml`.
- **ShepherdKit has no UI dependency.** Nothing under `native/Sources/` imports SwiftUI or AppKit.
- **Every new view is AppKit-free.** The one place this bites is the file picker for *Anhängen*:
  use SwiftUI's `.fileImporter`, never `NSOpenPanel`. `Welcome/FirstRunSheet.swift` still uses
  `NSOpenPanel` and is not this stream's to change.
- **Strings only via `L.t()`**, with every key present in **both** `ui/messages/en.json` and
  `ui/messages/de.json` and listed in `KEYS_COMPOSE` in `native/scripts/gen-strings.ts`.
  **Almost every key this stream needs already exists** — the `newtask_*`, `promptsources_*`,
  `issues_filter_*`, `issue_filter_*`, `model_cost_*`, `model_tag_*`, `model_guidance_*`,
  `effort_*`, `sandbox_profile_*`, `guardtl_*`, `shape_*`, `keymap_*` and `micbtn_*` families are
  all in both catalogs. **Reuse them.** Writing a second German translation of "Erstellen & Starten
  in {repo}" is a review rejection.
- **No Keychain prompts.** Build and test through `./native/scripts/build-app.sh` and
  `./native/scripts/test-app.sh`. `SHEPHERD_KEYCHAIN_TESTS` is **never** set locally.
- **`bun run test`, never bare `bun test`** (repo `CLAUDE.md`).
- **`bun run typecheck` is a gate**, alongside `bun run lint` and `bun run test:contract`.
- **Live tests read `SHEPHERD_LIVE_BASE_URL` / `SHEPHERD_LIVE_PASSWORD` from the environment only**
  — or `SHEPHERD_LIVE_TOKEN` for the read-only suite. Never from a file, never in CI. The
  `TEST_RUNNER_` prefix is how `xcodebuild` forwards them; set
  `TEST_RUNNER_SHEPHERD_REVOKE_ON_EXIT=1` for any live run. A base URL always goes through
  `RemoteServerForm.normalize` before it reaches a `ServerProfile`.
- **The live suite is read-only.** A live `POST /api/sessions` would spawn a real agent in a real
  worktree on the operator's machine. Nothing in this branch creates a session against a live
  server.
- **XCUITest runs serialised** — one worktree at a time.
- **`git checkout -- native/Package.resolved` after `swift test --package-path native`.**
- **No `.toolbar` inside a `DetailTab`.** This stream registers no tab; the rule is restated
  because the composer is a sheet and a sheet's own toolbar is fine.
- **A cancelled event tap still hands you its buffered frames**, so stamp work with a generation
  rather than trusting cancellation, and **finish** every `AsyncStream` watcher in `teardown()`.
- **Commits:** conventional, lowercase subject; body lines ≤ 100 chars; a **blank line** before the
  trailer, and the body ends with
  `Co-Authored-By: <executing model name> <noreply@anthropic.com>`.
- **Push with `git push --no-verify`.**
- **Never edit `native/Apps/ShepherdMac/Sources/App/StreamRegistrations.swift`** inside this
  stream. It ships `ComposeStream.install(app)` and the integration lane adds the one line.
- **Logging:** `run.shepherd.mac` (app), `run.shepherd.kit` (kit).
- **Branch:** `feat/native-compose`, cut from `origin/main` **after S0-prep-2 merges**. Rebase to
  update; never `git merge main`.

| Command (repo root) | What it proves |
| --- | --- |
| `bun run test:contract` | the contract matches the real server |
| `bun run gen:contract-swift` | regenerates `contracts/openapi.swift.yaml` |
| `./native/scripts/sync-contract.sh` | copies the derived file into the kit target |
| `bun run typecheck` | the fixtures typecheck |
| `swift test --package-path native` | kit compiles, kit tests pass |
| `./native/scripts/test-app.sh -only-testing:ShepherdTests` | app unit tests pass |
| `./native/scripts/build-app.sh` | `Shepherd.app` builds |
| `bun run check:strings` | `Localizable.xcstrings` is current |
| `bun run lint` · `bun run test` | repo gates |

### File ownership (hard rule)

Create or modify **only**: `contracts/openapi.yaml` (between `# ── stream: compose ──` and
`# ── /stream: compose ──` only, in all three sections) · the generated
`contracts/openapi.swift.yaml` and `native/Sources/ShepherdKit/openapi.yaml` ·
`test/contract/compose.test.ts`, `test/contract/compose-fixtures.ts` ·
`native/Sources/ShepherdKit/Client/ShepherdClient+Compose.swift` ·
`native/Tests/ShepherdKitTests/ShepherdClientComposeTests.swift` ·
`native/Apps/ShepherdMac/Sources/Compose/**` ·
`native/Apps/ShepherdMac/Tests/{ComposeModel,IssuePicker,ComposeShape,ModelGuidance,
ComposeKeymap,ComposeStrings,ComposeLive}Tests.swift` · the `KEYS_COMPOSE` array in
`native/scripts/gen-strings.ts` · `ui/messages/{en,de}.json` (append-only) · the generated
`native/Apps/ShepherdMac/Resources/Localizable.xcstrings`.

Never edit `AppModel.swift`, `AppModel+Extensions.swift`, `MainWindow.swift`,
**`NewSessionSheet.swift`**, `NewSessionSlot.swift`, `SessionDetailView.swift`, `SessionRow.swift`,
`SidebarModel.swift`, `ShepherdApp.swift`, `StreamRegistrations.swift`, `SessionSignals.swift`, any
other `*Slot.swift`, `SessionStore.swift`, `ServerEvent.swift`, `EventStream.swift`,
`ShepherdClient.swift`, `project.yml`, `native.yml`, or
`test/contract/{harness,deps,stream-blocks,openapi.test}.ts`.

**The ownership decision, stated once.** S0-prep-2 gave `NewSessionSheet.body` a two-line branch on
`NewSessionSlot.content`, so a filled slot replaces the sheet's body and an empty one keeps the
milestone-1 form. `MainWindow`'s "+" already sets `app.sheet = .newSession` and `RootView` already
presents `NewSessionSheet()`; neither changes. This stream therefore builds a **complete new sheet**
under `Sources/Compose/**` and assigns the slot. The milestone-1 form stays on disk as the fallback
and as the thing the `NewSessionSlot` tests assert against.

### Preconditions — verify before Task 1

```bash
grep -c "── stream: compose ──" contracts/openapi.yaml \
  && grep -q "KEYS_COMPOSE" native/scripts/gen-strings.ts \
  && test -f native/Apps/ShepherdMac/Sources/App/NewSessionSlot.swift \
  && grep -q "resolveForge" test/contract/deps.ts \
  && grep -q "shapeTask" test/contract/deps.ts \
  && grep -q "issueRef" contracts/openapi.yaml \
  && grep -qi "x-shepherd-spawn-id" contracts/openapi.yaml \
  && grep -qE "^\s+(internal )?let generated: Client" native/Sources/ShepherdKit/Client/ShepherdClient.swift \
  && echo OK || echo "S0-prep-2 MISSING — stop and tell the orchestrator"
```

Expected: `3` then `OK`. Five of those deserve spelling out.

1. **`NewSessionSlot.swift` must exist**, with both `content` and `options`. This stream uses
   `content`; `options` is the additive path S0-prep-2 built for the case where this stream had
   been deferred.
2. **`deps.ts` must wire `resolveForge`.** Without it `GET /api/issues` answers an empty listing on
   every call and Task 1 — the whole reason this stream is in the first wave — is declared and
   unproven. Do not edit `deps.ts`; it is shared.
3. **`deps.ts` must wire `shapeTask`.** Without it `POST /api/shape` answers **503**.
4. **The `X-Shepherd-Spawn-Id` header parameter must already be on `POST /api/sessions`.** It is a
   parameter on a **core** path, so S0-prep-2 declares it, not this stream — see Task 9. If the
   grep fails, Task 9's progress panel ships without the correlation id rather than editing the
   core path from here.
5. **`issueRef` must already be on `CreateSessionRequest`.** S0-prep-2 declared it along with
   `mergeTrainPrs`, `research`, `epicAuthoring`, `attachmentNames` and `launchUiState`, because S9
   needs one of them and this stream needs the other five. If the grep fails, the create payload
   cannot carry an issue and Task 1 stops at the picker.

### Deliberate deviations from the stream brief

The brief listed the dialog top to bottom from a screenshot. Reading the web changed seven things.
Each is intentional and must survive review.

1. **The peek route `GET /api/issues/{number}` is not declared.** It exists, but the New Task dialog
   never calls it: the `#` menu filters the already-loaded `issueData.issues` client-side, and the
   peek is the *session card's* hover preview. Declaring it would add a status the coverage gate
   requires this stream to exercise for a call it never makes.
2. **The mic is deferred, with a note.** `MicButton` needs either the browser Web Speech API — which
   has no AppKit-free SwiftUI equivalent that does not pull in `Speech.framework` and a microphone
   entitlement — or the `voice-whisper` **plugin** routes (`GET /api/plugins`,
   `GET /api/plugins/voice-whisper/status`,
   `POST /api/plugins/voice-whisper/transcribe`), which are a plugin surface no stream owns and
   which the milestone explicitly defers. Dictation is one task in a later stream, after the plugin
   family is declared. Everything else in the toolbar row ships.
3. **`GET /api/branch-status` is declared but tested without a network.** The handler performs a
   bounded real `git fetch` and writes `refs/remotes/origin/<branch>`
   (`BRANCH_STATUS_TTL_MS = 10_000`). The contract test exercises it against the harness's
   commitless local repo, where the fetch has no remote to reach and the route still answers its
   documented 200 with `hasUpstream: false` — which is the branch the composer's "base branch
   missing" notice actually keys on.
4. **The clean-terminal create (C23/G12) is out.** `POST /api/sessions` is a **union**:
   `src/validate.ts:530-533` branches on `obj.terminal !== undefined` *before* the standard
   allowlist, and the terminal arm is `TERMINAL_ALLOWED_KEYS = {repoPath, terminal}` and nothing
   else. Expressing that needs `CreateSessionRequest` to become a `oneOf` of two object schemas —
   a shape change to a **core** schema, plus an open question about how
   swift-openapi-generator renders a `oneOf` request body. It is a task of its own, not a field.
5. **`RelaunchRequest` (G8) and `archiveSession`'s `reap[]` body (G13, B21) are out.** Both attach a
   request body to a path another block already owns (`/relaunch` is S4's,
   `DELETE /api/sessions/{id}` is core). They land as integration-lane commits after this PR merges,
   which the master plan's §7 records.
6. **`POST /api/sessions/{id}/reply` stays S1's.** The composer never sends a reply; the terminal
   pane does. A path appears in exactly one block.
7. **`GET /api/epics` is declared but only feeds the "hide sub-issues" filter.** The web uses it for
   two things: the epic badge on an issue row, and the sub-issue filter's epic-parent set. This
   stream ships the filter; the epic **panel** is milestone-4 work and is not claimed.

**Known parity gaps, documented not fixed.** The web's first-task automation interstitial
(`FirstTaskAutomationConfirm`) and its repo-config seeding need `GET/PUT /api/repo-config`, which is
**S12's**; the composer therefore sends `planGateEnabled`/`autopilotEnabled` as `null` (inherit)
until the operator touches a toggle, which is the same wire value the web sends for an untouched
toggle. The `hold_likely` advisory and its dual "Bis zum Reset zurückhalten" / "Trotzdem einreichen"
CTA pair read `UsageLimits`, which the app already has — so that one ships. The mobile bottom-sheet
layout has no macOS meaning and is not ported.

### Task order

| # | Task | Key files |
| --- | --- | --- |
| 1 | **Mit einem Issue starten** — contract, kit, and the issue/command picker | `contracts/openapi.yaml`, `test/contract/compose{,-fixtures}.ts`, `Sources/Compose/{ComposeModel,IssuePickerView,SourceToggle}.swift` |
| 2 | Repo and base branch: pickers, status, base repair | `Sources/Compose/RepoBranchRow.swift` |
| 3 | Mode tabs — CODE / RECHERCHE / EPIC / ROH | `Sources/Compose/ModeTabs.swift` |
| 4 | Engine picker and the per-engine capacity meter | `Sources/Compose/{EnginePicker,CapacityLine}.swift` |
| 5 | Model · Aufwand · cost row, with the badges and the guidance text | `Sources/Compose/{ModelPicker,ModelGuidance,EffortPicker}.swift` |
| 6 | Sandbox, the alpha warning, and the Leitplanken toggles | `Sources/Compose/{SandboxPicker,GuardToggles}.swift` |
| 7 | Anhängen — uploads, chips, paste and drop | `Sources/Compose/AttachmentsRow.swift` |
| 8 | Schärfen — the shaping round | `Sources/Compose/ShapeRoundView.swift` |
| 9 | The sheet, the footer, the keymap and the install point | `Sources/Compose/{ComposeSheet,ComposeFooter,ComposeKeymap,ComposeStream}.swift` |
| 10 | The rest of the compose block: variant, replace, recommend, leftovers, steers, cancel | `Sources/Compose/ComposeActions.swift` |
| 11 | Live check, gate sweep, PR | `Tests/ComposeLiveTests.swift` |

---

### Task 1: "Mit einem Issue starten"

**Files:** modify `contracts/openapi.yaml` (compose blocks only); create
`test/contract/compose-fixtures.ts`, `test/contract/compose.test.ts`,
`native/Sources/ShepherdKit/Client/ShepherdClient+Compose.swift`,
`native/Tests/ShepherdKitTests/ShepherdClientComposeTests.swift`,
`native/Apps/ShepherdMac/Sources/Compose/{ComposeModel,IssuePickerView,SourceToggle,IssueFilter}.swift`,
`native/Apps/ShepherdMac/Tests/IssuePickerTests.swift`; regenerate the derived contract files.

**Interfaces:**
- Consumes: the core block's `Error`, `AgentProvider`, `CreateSessionRequest` (with S0-prep-2's
  `issueRef`), `#/components/responses/Unauthorized`; `harness.ts`'s helpers; `deps.ts`'s
  `ContractDeps.stubs.resolveForge`.
- Produces: schemas `Issue`, `IssueFetchAttempt`, `IssueListing`, `SlashCommandScope`,
  `SlashCommandKind`, `SlashCommand`, `CommandListing`, `EpicSummary`, `EpicListing`; operations
  `listIssues`, `listCommands`, `listEpics`; on `ShepherdClient`: `issues(repoPath:)`,
  `commands(repoPath:provider:)`, `epics(repoPath:)`; the app types `IssueFilterState`,
  `ComposeModel`, `IssuePickerView`, `SourceToggle`.

**This is the task the operator asked for**, so it carries the whole vertical slice: the route, the
kit method, the list with its open count, the Filter popover, the ISSUES/BEFEHLE toggle, `#` search
in the prompt, and a create that carries the chosen issue.

- [ ] **Step 1: Cut the branch and write the fixtures**

```bash
cd /Users/kai.osthoff/githubrepos/shepherd
git fetch origin main
git worktree add .claude/worktrees/feat-native-compose -b feat/native-compose origin/main
cd .claude/worktrees/feat-native-compose && bun install
```

`test/contract/compose-fixtures.ts`:

```ts
import type { Issue } from "../../src/types";
import type { SlashCommand } from "../../src/commands";

/** Every field the picker and the filter pipeline read, across four rows that exercise each
 *  filter stage: one plain, one assigned to somebody else, one labelled shepherd:active, one
 *  blocked. Typed with the SERVER's Issue, so a rename in src/types.ts breaks `bun run typecheck`
 *  before it can drift past the contract. */
export const issues: Issue[] = [
  {
    number: 412,
    title: "Rate-limit the admin route",
    body: "The admin route bypasses the limiter entirely.",
    url: "https://example.test/i/412",
    labels: ["bug"],
    labelColors: { bug: "#d73a4a" },
    createdAt: 1_800_000_000_000,
    assignees: [],
    author: "operator",
  },
  {
    number: 413,
    title: "Document the burst window",
    body: "",
    url: "https://example.test/i/413",
    labels: [],
    createdAt: 1_800_000_010_000,
    assignees: ["somebody-else"],
    author: "somebody-else",
  },
  {
    number: 414,
    title: "Already being worked on",
    body: "",
    url: "https://example.test/i/414",
    labels: ["shepherd:active"],
    createdAt: 1_800_000_020_000,
    assignees: ["operator"],
    author: "operator",
  },
  {
    number: 415,
    title: "Waiting on upstream",
    body: "",
    url: "https://example.test/i/415",
    labels: ["blocked-upstream"],
    createdAt: 1_800_000_030_000,
    assignees: [],
    author: "operator",
    blockedBy: [999],
  },
];

export const commands: SlashCommand[] = [
  {
    id: "project:ship",
    name: "ship",
    displayName: "ship",
    description: "Open a PR and hand it to the reviewer",
    scope: "project",
    kind: "command",
    invocationName: "ship",
    sourceNamespace: "",
    providers: ["claude"],
    invocations: { claude: "/ship" },
  },
  {
    id: "user:video-brief",
    name: "video-brief",
    displayName: "video-brief",
    description: "Read a screen recording",
    scope: "user",
    kind: "skill",
    invocationName: "video-brief",
    sourceNamespace: "",
    providers: ["claude", "codex"],
    invocations: { claude: "/video-brief", codex: "$video-brief" },
  },
];

/** The minimum `GitForge` the two routes touch: `listIssues`, `currentUser`, `slug`, `webUrl`,
 *  `isLightweight`. `listBlockedByOpen` is deliberately absent — the route's blocker attachment
 *  fails open, and that is the path most real repos take. */
export function fakeForge(overrides: Record<string, unknown> = {}): unknown {
  return {
    slug: "owner/repo",
    webUrl: "https://example.test",
    isLightweight: false,
    listIssues: async () => issues,
    currentUser: async () => "operator",
    ...overrides,
  };
}
```

`test/contract/compose.test.ts` follows `herd.test.ts`'s shape. The Task-1 cases that must be
present:

```ts
describe("issues", () => {
  test("answers the listing with the viewer, and 400 on a repo outside the root", async () => {
    s.stubs.resolveForge.forge = fx.fakeForge();
    try {
      const ok = await get(`/api/issues?repo=${encodeURIComponent(s.validRepo)}`);
      expect(ok.status).toBe(200);
      const body = (await validateResponse("GET", "/api/issues", ok)) as {
        slug: string | null; issues: unknown[]; viewer: string | null; lightweight?: boolean;
      };
      expect(body.slug).toBe("owner/repo");
      expect(body.issues.length).toBe(4);
      // `viewer` is what the "mine & unassigned" filter fails open on when null, so it is
      // asserted rather than assumed.
      expect(body.viewer).toBe("operator");
      expect(body.lightweight).toBe(false);
    } finally {
      s.stubs.resolveForge.forge = null;
    }

    // A repo path outside config.repoRoot is the only 400 this route has.
    const bad = await get("/api/issues?repo=/etc");
    expect(bad.status).toBe(400);
    await validateResponse("GET", "/api/issues", bad);
  });

  test("a repo with no forge is a 200 empty listing, not an error", async () => {
    // resolveForge returns null by default in the harness, which is exactly the real
    // "this repo has no GitHub upstream" case the picker shows `promptsources_no_github` for.
    const ok = await get(`/api/issues?repo=${encodeURIComponent(s.validRepo)}`);
    expect(ok.status).toBe(200);
    const body = (await validateResponse("GET", "/api/issues", ok)) as {
      slug: string | null; issues: unknown[];
    };
    expect(body.slug).toBeNull();
    expect(body.issues).toEqual([]);
  });

  test("a throwing listing answers 200 with error: fetch_failed", async () => {
    s.stubs.resolveForge.forge = fx.fakeForge({
      listIssues: async () => {
        throw new Error("rate limited");
      },
    });
    try {
      const ok = await get(`/api/issues?repo=${encodeURIComponent(s.validRepo)}`);
      // NEVER a 5xx: the picker renders `common_issues_load_failed` from this body, and a
      // client that treated it as a transport failure would show the wrong message.
      expect(ok.status).toBe(200);
      const body = (await validateResponse("GET", "/api/issues", ok)) as { error?: string };
      expect(body.error).toBe("fetch_failed");
    } finally {
      s.stubs.resolveForge.forge = null;
    }
  });

  test("401 without a credential", async () => {
    const anon = await get(`/api/issues?repo=${encodeURIComponent(s.validRepo)}`, false);
    expect(anon.status).toBe(401);
    await validateResponse("GET", "/api/issues", anon);
  });
});

describe("commands", () => {
  test("answers a list, 400 on a bad provider, and 401", async () => {
    // No dep to seed: handleCommands reads the real filesystem (the repo dir, ~/.claude,
    // $CODEX_HOME). An empty list is a legitimate answer and the schema must allow it.
    const ok = await get(`/api/commands?repo=${encodeURIComponent(s.validRepo)}&provider=claude`);
    expect(ok.status).toBe(200);
    const body = (await validateResponse("GET", "/api/commands", ok)) as { commands: unknown[] };
    expect(Array.isArray(body.commands)).toBe(true);

    const bad = await get(`/api/commands?repo=${encodeURIComponent(s.validRepo)}&provider=nope`);
    expect(bad.status).toBe(400);
    await validateResponse("GET", "/api/commands", bad);

    const anon = await get("/api/commands", false);
    expect(anon.status).toBe(401);
    await validateResponse("GET", "/api/commands", anon);
  });
});

describe("create from an issue", () => {
  test("a create carrying issueRef is accepted and the session records it", async () => {
    const res = await fetch(`${s.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify({
        repoPath: s.validRepo,
        baseBranch: "main",
        prompt: "Bearbeite Issue #412: Rate-limit the admin route",
        issueRef: {
          number: 412,
          url: "https://example.test/i/412",
          title: "Rate-limit the admin route",
          body: "The admin route bypasses the limiter entirely.",
        },
      }),
    });
    expect(res.status).toBe(201);
    const session = (await res.json()) as { id: string; issueNumber: number | null };
    // The whole point of the field: the session remembers which issue it came from, which is
    // what the row's issue badge and the drain's claim label read.
    expect(session.issueNumber).toBe(412);
  });
});
```

The create test deliberately does **not** call `validateResponse` on `POST /api/sessions` — that
path is core, covered by `openapi.test.ts`, and calling it here would record coverage for an
operation outside this block.

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run test:contract 2>&1 | tail -20
```

Expected: failures naming `GET /api/issues` as undeclared.

- [ ] **Step 3: Add the Task-1 schemas inside the compose block**

```yaml
    Issue:
      type: object
      additionalProperties: true
      description: An open forge issue, as GET /api/issues lists them. Copied from Issue in src/types.ts:288.
      required: [number, title, body, url, labels, createdAt, assignees]
      properties:
        number: { type: integer }
        title: { type: string }
        body: { type: string, description: May be truncated by the server. }
        url: { type: string }
        labels: { type: array, items: { type: string } }
        labelColors:
          type: object
          additionalProperties: { type: string }
          description: Label name to the forge's own "#rrggbb". Absent for forges that do not report colours.
        createdAt: { type: integer }
        assignees: { type: array, items: { type: string } }
        author: { type: string }
        blockedBy:
          type: array
          items: { type: integer }
          description: Still-open issues blocking this one. Attached best-effort — the route fails OPEN, so absent does not mean unblocked.
    IssueFetchAttempt:
      type: object
      additionalProperties: true
      description: One failed transport attempt, for the "why did issues not load" detail. Copied from src/types.ts:315.
      required: [transport, reason, detail]
      properties:
        transport: { type: string, enum: [cli, rest] }
        reason:
          type: string
          x-shepherd-open-enum: true
          enum: [rate_limit, auth, not_found, gh_missing, network, http, unknown]
        status: { type: integer }
        detail: { type: string }
    IssueListing:
      type: object
      additionalProperties: true
      description: >-
        GET /api/issues?repo=. ALWAYS 200 when the repo resolves — a forge that threw answers this
        same shape with `error: "fetch_failed"` and an empty list, never a 5xx. `slug: null` with an
        empty list is the honest "this repo has no forge" answer, which is a different message for
        the operator than a failed fetch.
      required: [slug, webUrl, issues, viewer]
      properties:
        slug: { type: [string, "null"], description: 'owner/repo, or null when there is no forge.' }
        webUrl: { type: [string, "null"] }
        issues: { type: array, items: { $ref: "#/components/schemas/Issue" } }
        viewer:
          type: [string, "null"]
          description: >-
            The authenticated forge user. The "mine & unassigned" filter fails OPEN when this is
            null — a client that hid everything instead would show an empty list for a repo whose
            issues are all assigned.
        error: { type: [string, "null"], description: '"fetch_failed" when the listing threw. The list is then empty and stale.' }
        lightweight: { type: boolean, description: 'Repo is in local-only mode — no forge by configuration. Not a failure; test with === true.' }
        attempts:
          type: array
          items: { $ref: "#/components/schemas/IssueFetchAttempt" }
          description: Present only when the error carried a gh trail.
    SlashCommandScope:
      type: string
      x-shepherd-open-enum: true
      enum: [project, user, plugin, builtin]
    SlashCommandKind:
      type: string
      x-shepherd-open-enum: true
      enum: [skill, command, plugin]
    SlashCommand:
      type: object
      additionalProperties: true
      description: One installed slash command or skill (src/commands.ts:16). `invocations` is how a command is typed per engine; fall back to "/name" for claude and "$name" for codex.
      required: [name, description, scope]
      properties:
        id: { type: string }
        name: { type: string }
        displayName: { type: string }
        description: { type: string, description: Uncapped. }
        scope: { $ref: "#/components/schemas/SlashCommandScope" }
        kind: { $ref: "#/components/schemas/SlashCommandKind" }
        invocationName: { type: string }
        sourceNamespace: { type: string }
        sourcePath: { type: string }
        providers:
          type: array
          items: { $ref: "#/components/schemas/AgentProvider" }
          description: >-
            Exactly one entry means this command constrains the engine: the composer switches to it
            and disables the others while the token is in the prompt.
        invocations:
          type: object
          additionalProperties: { type: string }
          description: Agent provider to the literal token to insert.
        argumentHint: { type: string }
    CommandListing:
      type: object
      additionalProperties: true
      required: [commands]
      properties:
        commands: { type: array, items: { $ref: "#/components/schemas/SlashCommand" } }
    EpicSummary:
      type: object
      additionalProperties: true
      description: Enough of an epic to tag an issue row and to build the sub-issue filter's parent set. The epic PANEL is out of scope for milestone 3.
      required: [number, title]
      properties:
        number: { type: integer }
        title: { type: string }
    EpicListing:
      type: object
      additionalProperties: true
      description: 'GET /api/epics?repo=. Answers {epics: [], subIssues: []} whenever the drain dep or the forge is absent — an empty answer is never an error.'
      required: [epics, subIssues]
      properties:
        epics: { type: array, items: { $ref: "#/components/schemas/EpicSummary" } }
        subIssues: { type: array, items: { type: integer }, description: Issue numbers that are children of an epic. The "hide sub-issues" filter removes these. }
```

and the three operations in `paths:`:

```yaml
  /api/issues:
    get:
      operationId: listIssues
      description: Open issues for one repo, with the authenticated forge user. Never 5xx — a failed listing is a 200 carrying `error`.
      parameters:
        - name: repo
          in: query
          required: true
          schema: { type: string }
          description: Absolute repo path; must resolve under the server's repo root.
      responses:
        "200":
          description: The listing, possibly empty and possibly carrying an error.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/IssueListing" }
        "400":
          description: 'error is "invalid repo" — the path did not resolve under the repo root.'
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "401": { $ref: "#/components/responses/Unauthorized" }
  /api/commands:
    get:
      operationId: listCommands
      description: >-
        Installed slash commands and skills for one repo and engine. An absent or unresolvable
        `repo` is NOT an error — the route then answers user-scope commands only.
      parameters:
        - name: repo
          in: query
          required: false
          schema: { type: string }
        - name: provider
          in: query
          required: false
          schema: { $ref: "#/components/schemas/AgentProvider" }
          description: Defaults to claude when absent.
      responses:
        "200":
          description: The commands, possibly empty.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/CommandListing" }
        "400":
          description: 'error is "invalid provider".'
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "401": { $ref: "#/components/responses/Unauthorized" }
  /api/epics:
    get:
      operationId: listEpics
      description: Epics and their sub-issue numbers for one repo. Feeds the issue picker's "hide sub-issues" filter.
      parameters:
        - name: repo
          in: query
          required: true
          schema: { type: string }
      responses:
        "200":
          description: The epics, possibly empty.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/EpicListing" }
        "400":
          description: 'error is "invalid repo".'
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "401": { $ref: "#/components/responses/Unauthorized" }
```

No events. The compose block's `x-shepherd-events` markers stay empty for now — Task 9 revisits
`spawn:progress`.

- [ ] **Step 4: Regenerate, sync, and write the kit methods**

```bash
bun run test:contract && bun run typecheck && bun run gen:contract-swift \
  && ./native/scripts/sync-contract.sh && bun run check:contract-swift \
  && swift build --package-path native 2>&1 | tail -3
```

Then `ShepherdClient+Compose.swift` gains `issues(repoPath:)`, `commands(repoPath:provider:)` and
`epics(repoPath:)`, each following the `ShepherdClient+Herd.swift` shape: switch the generated
`Output`, map `.ok` to the value, `.badRequest` to `ShepherdError.badRequest(_:)`, `.unauthorized`
to `.unauthenticated`, `.undocumented` through `fromUndocumented(statusCode:route:)`, and wrap the
whole thing in `catch { throw ShepherdError.from(error, route:) }`.

Kit tests assert: a listing with four issues decodes; `error: "fetch_failed"` decodes **without
throwing** and leaves `issues` empty; an unknown `SlashCommandScope` still decodes (the open-enum
point); and every method maps 401 to `.unauthenticated`.

- [ ] **Step 5: Write the issue picker**

`Sources/Compose/ComposeModel.swift` is the sheet's single state holder — an `@Observable`
`@MainActor` class, **not** an `AppExtension`: it lives for one sheet presentation and dies with it,
which is what the web's `NewTask.svelte` does too. It owns the loaded issues, the commands, the
filter state, and the prompt.

**One `GET /api/issues` per repo selection.** The web creates exactly one `IssueData` and shares it
between the panel and the `#` menu; a second loader would double every request. `ComposeModel`
reloads on a repo change with a `#generation` guard so a slow answer for the previous repo is
dropped, and a failure does **not** evict the cached viewer.

`Sources/Compose/IssueFilter.swift` is the pure filter pipeline, in the web's order
(`ui/src/lib/components/issues-panel.ts`), each stage with its own "all hidden by X" message so the
cause stays attributable:

```swift
/// The four persisted toggles plus the two selections, with the web's defaults
/// (`ui/src/lib/issues-filter.svelte.ts`). Three of the four default to ON, which is the single
/// most surprising thing about this filter: an operator who has never opened the popover is
/// already seeing a filtered list, and the badge count says so.
struct IssueFilterState: Equatable, Sendable {
    var hideOthers = true       // "mine & unassigned"
    var hideActive = false      // shepherd:active
    var hideSubIssues = true
    var hideBlocked = true
    var author: String?
    var labels: Set<String> = []

    /// What the Filter chip's badge shows. `hideOthers` counts only when there is a viewer to
    /// compare against — with none, the stage fails open and counting it would claim a filter
    /// that is not applied.
    func activeCount(hasViewer: Bool) -> Int {
        var count = 0
        if hideOthers, hasViewer { count += 1 }
        if hideActive { count += 1 }
        if hideSubIssues { count += 1 }
        if hideBlocked { count += 1 }
        if author != nil { count += 1 }
        if !labels.isEmpty { count += 1 }
        return count
    }
}

enum IssueFilter {
    /// The pipeline, in the web's order. Each stage returns the survivors AND the stage that
    /// emptied the list, so the empty state can name the cause rather than saying "no issues".
    static func apply(
        _ issues: [Issue], viewer: String?, epicParents: Set<Int>, subIssues: Set<Int>,
        state: IssueFilterState
    ) -> (visible: [Issue], emptiedBy: Stage?)
}
```

`SourceToggle` is the ISSUES / BEFEHLE segmented control (`promptsources_issues_tab` /
`promptsources_commands_tab`), and the list header carries the open count
(`promptsources_open_count`, DE `"{count} offen"`) — rendered **only** when the repo has a forge and
the listing did not fail, exactly as the web gates it.

Rows collapse to **three** with a `promptsources_more_row` expander (DE
`"↓ {count} weitere — # im Prompt tippen zum Suchen"`). Picking an issue:

```swift
    /// The web's `pickIssue` (`NewTask.svelte:1175`). Two rules that are easy to miss:
    ///
    /// 1. The prompt is seeded **only when empty**, from `newtask_issue_prompt_template`
    ///    (DE "Bearbeite Issue #{number}: {title}"). An operator who already typed keeps what
    ///    they typed, and the issue rides along as `issueRef`.
    /// 2. The issue body is NEVER dumped into the prompt. It travels in `issueRef.body`, which
    ///    the server hands to the agent out of band.
    func pickIssue(_ issue: Issue) {
        attached = issue
        attachedRepoPath = repoPath
        if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            prompt = L.t("newtask_issue_prompt_template", issue.number, issue.title)
        }
    }

    /// The web's `activeIssue` (`NewTask.svelte:~415`) — the single repo-aware predicate that
    /// feeds readiness, the submit guard and the payload. An issue attached under one repo must
    /// not ride a create for another.
    var activeIssue: Issue? { attachedRepoPath == repoPath ? attached : nil }
```

**`#` search in the prompt** is deliberately simpler than the panel's filter, exactly as the web has
it: the trigger is `/(^|\s)#([^\s#]*)$/` on the text before the caret, and the menu filters the
**raw** issue list on "number has this prefix, or title contains this substring", capped at twenty.
No filter pipeline — an operator typing `#412` must find #412 even when a filter would hide it.

`/` and `$` do the same for commands, with the web's two placement rules:
- **Claude**: the typed token is removed and `/name ` is **hoisted to the front** of the prompt,
  because Claude only runs a leading slash command; whatever the operator had typed becomes the
  argument.
- **Codex**: the token is replaced **in place** with `$name `.

A command whose `providers` has exactly one entry sets a provider constraint: the engine switches to
it, the others are disabled, the blue `newtask_provider_constraint_title` callout renders, and
submit is hard-blocked while the token is in the prompt and the engine does not match. The
constraint is pruned on every keystroke once the token leaves the text.

- [ ] **Step 6: Tests, then commit**

`IssuePickerTests.swift` asserts: each filter stage in isolation and the `emptiedBy` attribution;
`hideOthers` failing open with a nil viewer; `activeCount` matching the web's arithmetic; the `#`
trigger regex against a caret in the middle of a line; the prefix-before-substring ordering of
command matches; `pickIssue` seeding an empty prompt and leaving a non-empty one; `activeIssue`
going nil when the repo changes; and the Claude hoist versus the Codex in-place replacement.

```bash
bun run test:contract && swift test --package-path native --filter ShepherdClientCompose \
  && git checkout -- native/Package.resolved \
  && ./native/scripts/test-app.sh -only-testing:ShepherdTests/IssuePickerTests 2>&1 | tail -3
git add contracts/ native/Sources/ShepherdKit/ test/contract/compose*.ts \
  native/Apps/ShepherdMac/Sources/Compose/ native/Apps/ShepherdMac/Tests/IssuePickerTests.swift \
  native/Tests/ShepherdKitTests/ShepherdClientComposeTests.swift
git commit -m "feat(mac): start a task from an issue"
```

---

### Task 2: Repo and base branch

**Files:** create `Sources/Compose/RepoBranchRow.swift`; extend `ShepherdClient+Compose.swift`, the
compose contract block and `compose.test.ts`.

Declares `GET /api/branches` (200 `{branches, current, default}`, 400 `invalid repo`, 401),
`GET /api/branch-status` (200 `{behind, ahead, diverged, hasUpstream, localExists}`, 400 twice —
`invalid repo` and `invalid branch` — and 401) and `POST /api/repos/init-empty-commit` (200
`{branch}`, 400, 422, 401).

`pickBaseBranch` is ported verbatim: `default ?? current ?? branches.first ?? "main"`.

Three behaviours the web has and a naive port loses:

- **`branch-status` does a real `git fetch`.** The client debounces 300 ms and drops a stale answer
  with a request guard; the server caches for ten seconds. The native model does the same, and the
  contract test clears the server cache between assertions with the exported
  `clearBranchStatusCacheForTests`.
- **`baseMissing`** is `upstream != nil && branches.isEmpty && !upstream.localExists &&
  !upstream.hasUpstream` — four terms, and it is what gates the red
  `newtask_readiness_base_missing` line and the "Create initial commit" repair button.
- The repo picker is **⌥R**, branch is **⌥B**, and **⌥[** / **⌥]** cycle repos. Those are Task 9's
  bindings; this task exposes the actions they call.

---

### Task 3: Mode tabs — CODE / RECHERCHE / EPIC / ROH

**Files:** create `Sources/Compose/ModeTabs.swift`; extend `ComposeModelTests.swift`.

Mode is **derived, not stored** (`NewTask.svelte:~801`):

```swift
    /// `research ? .research : epicAuthoring ? .epic : plain ? .plain : .code`. Derived rather
    /// than stored because the three booleans are what the wire carries, and a stored enum would
    /// be a second source of truth that can disagree with them.
    var mode: ComposeMode {
        if research { return .research }
        if epicAuthoring { return .epic }
        if plain { return .plain }
        return .code
    }

    var modeLocked: Bool { research || epicAuthoring || plain }
    var sandboxLocked: Bool { research || epicAuthoring }
```

`setMode(_:)` is ported exactly, including the part that reads like a bug and is not:

```swift
    /// Switching away from Code forces BOTH guards off and marks them touched, so the wire
    /// carries an explicit `false` rather than `null` (inherit) — the repo default must not
    /// re-enable a plan gate on a research task that has no plan.
    ///
    /// Returning to Code deliberately does NOT restore them. The web does the same: once the
    /// operator has been shown "no guards", silently re-enabling them on a mode flip would be a
    /// guard they never agreed to.
    func setMode(_ next: ComposeMode) {
        research = next == .research
        epicAuthoring = next == .epic
        plain = next == .plain
        guard next != .code else { return }
        planGateEnabled = false
        planGateTouched = true
        autopilotEnabled = false
        autopilotTouched = true
        if sandboxLocked, sandboxProfile == .autonomous { sandboxProfile = nil }
    }
```

The `/design` pre-selection ships too: a prompt whose trimmed start matches `^/design(\s|$)` selects
**ROH** while the operator has not touched the mode, and un-selects when the command is edited away.
Only the `plain` flag moves — never the guards.

When `modeLocked`, the guard toggles are replaced by one sentence: `newtask_guards_none_plain`,
`…_research` or `…_epic`.

Per-mode payload matrix, asserted field by field in `ComposeShapeTests`:

| field | CODE | RECHERCHE | EPIC | ROH |
| --- | --- | --- | --- | --- |
| `research` | false | **true** | false | false |
| `epicAuthoring` | false | false | **true** | false |
| `plain` | false | false | false | **true** |
| `planGateEnabled` | `touched ? value : nil` | **false** | **false** | **false** |
| `autopilotEnabled` | `touched ? value : nil` | **false** | **false** | **false** |
| `sandboxProfile` | any, or absent | autonomous disabled | autonomous disabled | any |
| Schärfen offered | **yes** | no | no | no |

---

### Task 4: Engine picker and the capacity meter

**Files:** create `Sources/Compose/{EnginePicker,CapacityLine}.swift`.

The meter is the line the operator reads as `CX·WK 93 % frei`. It is derived from the
`UsageLimits` the app already has — S3's `GET /api/usage/limits` is in the contract and
`SidebarModel.usage` already holds it — so **this task declares no route**.

Port `selectedProviderCapacity` from `ui/src/lib/components/usage-gauges.ts`:

- two rows, claude and codex; claude's windows from `session5h` (5H) and `week` (WK), codex's from
  the `{provider: "codex", kind: "tokens"}` snapshot;
- per window, `usedPct = clamp(pct, 0, 100)` and `remainingPct = 100 - usedPct`;
- the selected provider's **hottest** window wins — the lowest `remainingPct`;
- `code = (claude ? "CC" : "CX") + "·" + key`, so `CX·WK`;
- colour: `> 90` red, `> 50` amber, else muted. This is a **documented exception** to the repo's
  four-light rule and the comment says so;
- `stale` dims the line.

Copy: `newtask_provider_capacity_free` (DE `"{pct}% frei"`),
`newtask_provider_capacity_free_until`, `newtask_provider_capacity_unavailable`,
`newtask_capacity_all` (DE `"alle"`) for the popover listing every window.

`UsageLimits.observed` — the field S0-prep-2 added — is preferred over the local estimate where
present, because the web's meter does (`usage-gauges.ts:21-53`) and a Mac that disagreed with the
web about the same server's numbers is worse than no meter.

The Codex `newtask_agent_provider_codex_alpha_badge` ("Alpha MVP") renders in the engine picker.

---

### Task 5: Model · Aufwand · cost row

**Files:** create `Sources/Compose/{ModelPicker,ModelGuidance,EffortPicker}.swift` and
`native/Apps/ShepherdMac/Tests/ModelGuidanceTests.swift`.

The option label is `"\(configuredModelLabel(model)) · \(tag) · \(costMark)"`, which is the
`gpt-6-astra · maximal · $$$$` the operator sees. The row beneath is the two chips and the prose:
`.mg-cost` = uppercased `model_cost_premium` (DE **PREMIUM-KOSTEN**), `.mg-tag` = uppercased
`model_tag_max` (DE **MAXIMAL**), and `model_guidance_<model>` as the detail sentence.

The per-model table is ported **verbatim** from `ui/src/lib/model-guidance.ts` — twenty-four rows
plus the `unknown` fallback — and `ModelGuidanceTests` asserts every row, because a wrong cost tier
is a wrong bill. The model lists come from `ui/src/lib/types.ts`: `CLAUDE_MODELS` (nine) and
`CODEX_MODELS` (twelve).

Effort is `providerEfforts(provider, model)`:

- claude, **or** `gpt-5.6-luna` → the six minus `ultra` (five);
- `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra` → all six;
- any other curated codex model → the six minus `max` and `ultra` (four);
- unknown or `default` → all six.

Labels are `effort_label_low` … `effort_label_ultra` (DE `Niedrig`/`Mittel`/`Hoch`/`Sehr hoch`/
**`Maximal`**/`Ultra`), with `effort_default` (DE `Standard`) as the leading option.

`preselectModel` / `preselectEffort` / `normalizeRunConfig` are ported from
`new-task/run-config.ts`, and — this is the part that matters — the normalise runs in the **model**,
not in the view, so a create submitted without ever opening the picker still carries normalised
values. A manual engine change resets the model unconditionally
(`modelForManualProviderChange`).

---

### Task 6: Sandbox, the alpha warning, and the Leitplanken toggles

**Files:** create `Sources/Compose/{SandboxPicker,GuardToggles}.swift`.

Sandbox options in order: `newtask_sandbox_default` (DE **Repo-Standard**, which sends **no**
`sandboxProfile` at all), `sandbox_profile_trusted`, `sandbox_profile_standard`, and
`sandbox_profile_autonomous` — the last **disabled** when `sandboxLocked`. The long explanation is
`newtask_sandbox_hint`; in research mode `newtask_research_sandbox_note` renders beneath.

The alpha warning is Codex-only: `⚠ newtask_alpha_caution` (DE
`"Alpha: läuft unbeaufsichtigt, Sandbox auf »trusted« erzwungen."`) with a `newtask_alpha_details`
disclosure holding `newtask_agent_provider_codex_alpha_note`,
`newtask_agent_provider_codex_suggested_for_hold` (only when the hold advisory is live) and
`newtask_agent_provider_codex_note`.

**Leitplanken** (`newtask_group_guards`, DE **Leitplanken**) are two toggles, rendered only when
`!modeLocked`:

- **Plan-Gate** — `newtask_guard_plan_gate`, explanation `newtask_plan_gate_hint`
  (DE `"Plan vor dem Agentenlauf prüfen + kontradiktorisch hinterfragen"`).
- **Autopilot bis zum PR** — `newtask_guard_autopilot`, explanation `newtask_autopilot_hint`.

Both web labels carry the `[[term|Label]]` glossary marker. The native app has **no glossary
surface**, so this stream renders the label text with the marker stripped and puts the explanation
in the toggle's own description line — which is what the repo's hover-text convention asks for
anyway: a descriptive title and a short summary, not a `title` essay. `newtask_toggle_on` /
`newtask_toggle_off` (DE **AN** / **AUS**) are the status readout.

`nil` means inherit. A toggle the operator has not touched sends `nil`, and the repo default
applies server-side — the same wire value the web sends. Once touched, the boolean is explicit. The
`newtask_autopilot_repo_default_on` / `_off` tip needs `GET /api/repo-config`, which is **S12's**,
so it is omitted with a note rather than faked.

`GuardTimeline` is **not** ported. It is a twenty-five-key explanation of where a task waits for a
human, and it needs repo-config to be accurate. Recorded as a follow-up.

---

### Task 7: Anhängen

**Files:** create `Sources/Compose/AttachmentsRow.swift`; extend the compose contract block,
`compose.test.ts` and `ShepherdClient+Compose.swift`.

Declares `POST /api/uploads`: **`multipart/form-data`, field name `file`**, answering
200 `{path}`, 400 `{error: "missing file field"}`, 413 `{error: "file too large"}` and 401. The
413 is exercised through the harness's `setMaxUploadBytes` seam, which is why S0-prep-2 added it —
allocating a 250 MB fixture to prove one status would be absurd.

Multipart is the one request shape in this milestone that the generated client does not build for
free. Read the generated `Types.swift` for `uploadFile`'s input: swift-openapi-generator represents
`multipart/form-data` as a `MultipartBody` of typed parts, and the kit method assembles one part
named `file` with the filename and an `HTTPBody` over the file's bytes. If the generator refuses the
schema, the fallback is a hand-built `URLRequest` **inside the kit** — but that is a last resort and
must be justified in the PR, because it is the one place this milestone would stop generating from
the contract.

`images` and `attachmentNames` are **parallel arrays**: `images[i]` is the absolute staged path the
upload returned, `attachmentNames[i]` the original filename. The server rejects a length mismatch
with a 400 (`src/validate.ts:287-291`), so the model keeps them in one array of pairs and splits
only at submit.

Uploads drain **serially** with a byte-weighted progress figure capped at 99 % until every byte
lands, and submit is blocked while any upload is outstanding — the readiness blocker `uploading`.
A failed upload keeps its row with an inline retry.

Paste and drag-and-drop both feed the same `addFiles`: `.onPasteCommand(of: [.fileURL, .image])` and
`.dropDestination(for: URL.self)`. The file chooser is **`.fileImporter`**, never `NSOpenPanel`.

---

### Task 8: Schärfen

**Files:** create `Sources/Compose/ShapeRoundView.swift`; extend the compose block,
`compose.test.ts` and the kit.

Declares `POST /api/shape` (200 `{draft, block}`, 400 twice, **503 `{error: "unavailable"}`** when
the server has no shaper, 422 `{error: <slug>}` with slugs `empty-prompt`, `spawn-failed`,
`timeout`, `unavailable`, and 401) and `POST /api/shape/brief` (200 `{brief}`, 400
`{error: "invalid round"}`, 401).

`TaskBriefDraft` is `{problem, outcome, constraints[], nonGoals[]}`. The `block` is a
**`question-form` `VisualBlock`** — the same schema **S8 declares**. A schema name sits in exactly
one block, so this stream `$ref`s `#/components/schemas/VisualBlockQuestionForm` and
`#/components/schemas/RawAnswer` rather than declaring second copies. S8 is in the same wave; if it
has not merged when this task starts, the `$ref` fails loudly at `bun run test:contract` and the
answer is to rebase, not to duplicate.

The button is desktop-only and **CODE-mode only**, and its blockers are ordered: `running`,
`wrong_mode`, `no_repo`, `empty_prompt`. A monotonic sequence token drops a superseded round.
`useBrief(answers)` replaces the whole prompt.

Copy: `newtask_shape_label` (DE **Schärfen**), `shape_heading`, `shape_running`,
`shape_questions_count`, `shape_s_problem` / `_outcome` / `_constraints` / `_nongoals`,
`shape_use_brief` / `shape_discard`, and the `shape_err_*` family.

---

### Task 9: The sheet, the footer, the keymap and the install point

**Files:** create `Sources/Compose/{ComposeSheet,ComposeFooter,ComposeKeymap,ComposeStream}.swift`
and `native/Apps/ShepherdMac/Tests/ComposeKeymapTests.swift`.

**The sheet** assembles Tasks 1–8 in the web's order and is installed by one assignment:

```swift
@MainActor
enum ComposeStream {
    static func install(_ app: AppModel) {
        // MainWindow's "+" already sets `app.sheet = .newSession`, and RootView already presents
        // NewSessionSheet(), whose body branches on this slot (S0-prep-2). Filling it replaces the
        // milestone-1 form with the composer; clearing it puts the old form back, which is what
        // the NewSessionSlot tests assert. No S0 file changes.
        NewSessionSlot.content = { app in AnyView(ComposeSheet().environment(app)) }
    }
}
```

**The readiness model** is the single source for the footer line, the CTA's disabled state and the
submit guard — one function, not three call sites that can disagree. Blocker precedence, ported
verbatim: `submitting` → `uploading` → `repairing` → `no_repo` → `base_missing` → `empty_prompt`.
Advisories: `checking` / `diverged` / `behind` (mutually exclusive) plus `hold_likely`.

Two rules that are easy to lose:

- **An empty prompt is submittable when a same-repo issue is attached.** It materialises as
  `newtask_issue_prompt_template` at submit. Without this, "pick an issue and hit ⌘↵" — the exact
  flow this stream exists for — is blocked by the readiness guard.
- **`hold_likely` swaps the single CTA for two buttons**, `newtask_hold_for_reset` (DE
  "Bis zum Reset zurückhalten") and `newtask_submit_anyway`, and **⌘↵ binds to the hold button**
  (`force: false`), never to "submit anyway". Spending the last of a usage window on a keystroke the
  operator did not aim is the failure this ordering prevents.

**The submit button** reads `newtask_submit_in_repo` — DE **"Erstellen & Starten in {repo}"** — with
`newtask_submit` as the no-repo fallback and `newtask_spawning` while in flight.

**The footer hints** are `keymap_footer_idle` (DE **"{mod} HALTEN = TASTEN"**) and
`keymap_footer_held`, plus a `⌘↵` key cap on the button.

**The keymap** is the web's twenty-six-entry registry, ported as a value table so
`ComposeKeymapTests` can assert there are no duplicate chords — the same guard the web's
`allChords()` test provides. The four rows whose chords are deliberately *not* the obvious ones are
commented with why: `model` is **⌥M** because ⌘M minimises a macOS window; `autopilot` is **⌥A**
because ⌘⇧A is Chrome's tab search and the web chose ⌥A for parity; `sheet` (`?`) is suppressed
inside a text field; and `submit` is ⌘↵, which on macOS must not collide with the sheet's default
action — so the primary button carries `.keyboardShortcut(.defaultAction)` **only** when the CTA is
the single submit button, never in the `hold_likely` pair.

Hold-to-reveal (⌘ held dims the sheet and shows key caps) is ported; it is pure SwiftUI over a
`.onModifierKeysChanged` observer, with no AppKit.

**`spawn:progress`** is declared in the compose block's event markers in this task: a slow spawn
(over ten seconds) shows the phase panel and a cancel button over
`POST /api/spawns/{id}/cancel`. The frame is `{spawnId, phase, startedAt, completed[]}` with phases
`base`, `worktree`, `prompt`, `launch`, `agent`.

**The spawn id rides the `X-Shepherd-Spawn-Id` request header on `POST /api/sessions`**
(`ui/src/lib/api.ts:293`, server `src/server.ts:2404`) — it is deliberately *not* a body key, because
`ALLOWED_KEYS` would reject it. That makes it a **parameter on a core path**, and a core path is
outside this stream's ownership: adding `parameters:` under `/api/sessions` here would edit a
schema-adjacent core section two streams share, which is exactly what §4's ownership rules forbid
and what S0-prep-2 exists to prevent.

So it splits, and the split is a **precondition on this task**:

- **S0-prep-2 declares the header parameter** on `POST /api/sessions` (optional, `schema: {type:
  string}`), beside `UsageLimits.observed` and the six create fields it already adds there, and
  exposes a create path that accepts it. The existing `ShepherdClient.createSession` wrapper does
  not take one.
- **This stream declares only `spawn:progress` and `POST /api/spawns/{id}/cancel`**, both of which
  are unambiguously `compose`'s.

If the parameter is not on `main` when this task starts, the progress panel ships **without** the
correlation id — the sheet shows a generic "starting…" state and no cancel button — and the cancel
affordance lands in the integration lane. It does not ship by editing the core path from here.

---

### Task 10: The rest of the compose block

**Files:** create `Sources/Compose/ComposeActions.swift`; extend the contract, the kit and the
tests.

`GET`/`PUT /api/steers`, `POST /api/sessions/{id}/variant`, `/replace`, `/recommend-prompt`,
`GET /api/sessions/{id}/leftovers`, `POST /api/spawns/{id}/cancel`. Each is declared with the
statuses its handler sends, wrapped in the kit, and surfaced where the web surfaces it — the variant
and replace pickers on an existing session, the leftovers list in the stop dialog, and the steers
editor as a small sheet.

This task is last on purpose: none of it is on the path from "pick an issue" to "a session is
running", and a reviewer who runs out of appetite should run out of it here rather than in Task 1.

---

### Task 11: Live check, full verification and the PR

**Files:** create `native/Apps/ShepherdMac/Tests/ComposeLiveTests.swift`.

**Read-only.** A live create spawns a real agent in a real worktree. The live test reads
`issues(repoPath:)` for every repo the live server reports, asserts every returned issue has a
number and a URL, reads `commands(repoPath:provider:)` for both providers, and decodes
`branches(repoPath:)`. It creates nothing.

Then the standard close: every gate, the ownership proof, a rebase, the PR, CI.

```bash
bun run test:contract && bun run check:contract-swift && ./native/scripts/sync-contract.sh --check \
  && bun run check:strings && (cd ui && bun run check:i18n) && bun run lint && bun run typecheck \
  && bun run test && swift test --package-path native \
  && git checkout -- native/Package.resolved \
  && ./native/scripts/test-app.sh -only-testing:ShepherdTests \
  && ./native/scripts/build-app.sh
```

```bash
git diff --name-only origin/main...HEAD | sort
```

Expected: exactly the files in "File ownership". **`NewSessionSheet.swift` must not appear** — if it
does, the slot was bypassed and the ownership decision was broken; revert it.

Take a side-by-side screenshot of the web dialog and the Mac sheet for the PR body; it is the
artefact that answers the feedback this stream came from.

PR title: `feat(mac): new-task composer — start from an issue`. The body names what landed per task,
the seven deviations, the deferred mic and `GuardTimeline`, the `StreamRegistrations` one-liner
(`ComposeStream.install(app)`), and the verification list. It ends with
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Self-review

**Spec coverage.** The course-corrected brief lists eleven things in visual order. Issue list with
the open count, Filter popover, ISSUES/BEFEHLE toggle, `#` search, and starting a session from a
selected issue → **Task 1**, with the routes declared in a `# ── stream: compose ── ` block and
`/reply` left to S1. Mode tabs → Task 3. Engine picker with the per-engine usage meter
(`CX·WK 93 % frei`) → Task 4. Model/effort/cost row with the PREMIUM-KOSTEN / MAXIMAL badges and the
description text → Task 5. Aufwand and Sandbox with the alpha warning → Tasks 5 and 6. Leitplanken
Plan-Gate / Autopilot bis zum PR with their explanation text, over the already-contract-legal
`planGateEnabled` / `autopilotEnabled` → Task 6. Anhängen → Task 7. Schärfen → Task 8. Microphone →
**deferred with a note** (deviation 2: it needs either `Speech.framework` plus a microphone
entitlement, or the plugin routes no stream owns). Footer hints (⌘⏎, "halten = tasten") and
ERSTELLEN & STARTEN IN &lt;repo&gt; → Task 9. Web copy keys reused under `KEYS_COMPOSE` → the Global
Constraints and every task's copy list. Ownership handover through `NewSessionSlot` → Task 9's
install point, with `MainWindow` and `NewSessionSheet.swift` both untouched.

**Placeholders.** None in Task 1, which carries its whole contract block, its whole fixture file and
its whole test body — it is the task the operator asked for and it is specified end to end. Tasks
2–10 carry their rules, their statuses and their copy keys, and name the web file each rule is
ported from, rather than a full SwiftUI body: the palette, the existing `SessionCommandState` gate
and the generated multipart input are files whose real API the implementer must read. Three
deliberate forward references, each named where it appears: the generated `uploadFile` input shape
(Task 7), `VisualBlockQuestionForm` and `RawAnswer` (`$ref`'d from **S8's** block, Task 8), and the
`x-shepherd-spawn-id` header parameter's generated spelling (Task 9).

**Type consistency.** `Issue` is one schema, one typealias, and the same type in the kit,
`ComposeModel.issues`, `IssueFilter.apply` and every test. `IssueFilterState`'s six members are the
same six in `activeCount`, in `apply` and in the popover. `SlashCommand`'s `providers` and
`invocations` are read in exactly two places — the constraint check and the token insertion — and
both are named. `ComposeMode`'s four cases are the same four in `mode`, `setMode`, the payload
matrix and the tab strip. `images` and `attachmentNames` are one array of pairs in the model and two
parallel arrays only at the wire boundary, which is where the server's length check lives.

**No duplicate path claims.** The ten paths this block adds — `/api/issues`, `/api/commands`,
`/api/epics`, `/api/branches`, `/api/branch-status`, `/api/repos/init-empty-commit`,
`/api/uploads`, `/api/shape`, `/api/shape/brief`, `/api/steers`, plus four under
`/api/sessions/{id}/` (`variant`, `replace`, `recommend-prompt`, `leftovers`) and
`/api/spawns/{id}/cancel` — appear in no other block and in no core path.
`POST /api/sessions/{id}/reply` is S1's and is not claimed. `POST /api/sessions/{id}/restore` is
S10's and is not claimed. `/api/sessions/{id}/relaunch` and `DELETE /api/sessions/{id}` are not
claimed; their request bodies are integration-lane commits. `GET /api/issues/{number}` is
deliberately left undeclared (deviation 1). The schemas `VisualBlockQuestionForm` and `RawAnswer`
are `$ref`'d from S8's `plan` block rather than redeclared.
