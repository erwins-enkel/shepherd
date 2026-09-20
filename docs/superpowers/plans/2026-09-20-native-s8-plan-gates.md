# Stream S8 — Plan gates and questions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** give Shepherd for Mac the operator's main blocking interaction. A gated session waits for
two things and neither exists natively today: **release the gate** (`POST /api/sessions/{id}/go`)
and **answer the planning agent's open questions**
(`POST /api/sessions/{id}/answer-plan-questions`). This stream declares the plan-gate surface,
renders the plan itself — including the thirteen-member `VisualBlock` union the web uses for both
plans and recaps — and puts both actions in front of the operator with the right confirmations.

**Architecture:** Seven operations enter `contracts/openapi.yaml` inside this stream's `plan` block
with three events and the `PlanGate` / `VisualBlock` families; Swift is regenerated from the derived
file; one kit extension (`ShepherdClient+Plan.swift`) wraps them. The app side is a pure derivation
module (`PlanGateChip`, mirroring `ui/src/lib/components/plan-gate-badge.ts`), one `AppExtension`
(`PlanModel`) owning the gate snapshots and a tap on `SessionStore.events()`, a `plan` `DetailTab`
and a badge registered through the existing registries, and a blocks renderer that degrades an
unfamiliar block type to its markdown rather than failing.

**Tech Stack:** Bun + ajv (contract drift test), OpenAPI 3.1, swift-openapi-generator 1.13.1,
Swift 6 (language mode 6, strict concurrency `complete`), SwiftUI, Swift Testing (`import Testing`),
XcodeGen 2.46, `os.Logger`.

---

## Global Constraints

- **Swift 6 strict concurrency** (`SWIFT_STRICT_CONCURRENCY: complete`, `swiftLanguageModes: [.v6]`).
  No `@preconcurrency`, no `@unchecked Sendable`, no `nonisolated(unsafe)`.
- **No hand-written `Codable` for server payloads.** The contract is the only type source: a route
  or event enters `contracts/openapi.yaml` first, then `bun run gen:contract-swift` +
  `./native/scripts/sync-contract.sh` regenerate and copy the derived file. Never hand-edit
  `contracts/openapi.swift.yaml` or `native/Sources/ShepherdKit/openapi.yaml`.
- **ShepherdKit has no UI dependency.** Nothing under `native/Sources/` imports SwiftUI or AppKit.
- **Every new view is AppKit-free.**
- **Strings only via `L.t()`**, with every key present in **both** `ui/messages/en.json` and
  `ui/messages/de.json` and listed in `KEYS_PLAN` in `native/scripts/gen-strings.ts`. Never add a
  string only in Swift. German copy matches the web UI verbatim — the whole `planpanel_*`,
  `plangate_*`, `qform_*` and `vblock_*` families already exist in both catalogs; **reuse those
  keys**.
- **No Keychain prompts.** Build and test through `./native/scripts/build-app.sh` and
  `./native/scripts/test-app.sh`. `SHEPHERD_KEYCHAIN_TESTS` is **never** set locally.
- **`bun run test`, never bare `bun test`** (repo `CLAUDE.md`).
- **`bun run typecheck` is a gate**, alongside `bun run lint` and `bun run test:contract`.
- **Live tests read `SHEPHERD_LIVE_BASE_URL` / `SHEPHERD_LIVE_PASSWORD` from the environment only**
  — or `SHEPHERD_LIVE_TOKEN` for the read-only suite. Never from a file, never in CI. The
  `TEST_RUNNER_` prefix is how `xcodebuild` forwards them; set
  `TEST_RUNNER_SHEPHERD_REVOKE_ON_EXIT=1` for any live run. A base URL always goes through
  `RemoteServerForm.normalize` before it reaches a `ServerProfile`.
- **The live suite in this stream is read-only.** `/go` releases a real gate and
  `/answer-plan-questions` steers a real agent; neither is ever issued from a test.
- **XCUITest runs serialised** — one worktree at a time.
- **`git checkout -- native/Package.resolved` after `swift test --package-path native`.**
- **No `.toolbar` inside a `DetailTab`.** This stream registers a tab, so the rule bites directly:
  every control goes in the tab's own body. `DetailRefreshBar` (`Sources/Detail/DetailFeature.swift`)
  is the shape to copy.
- **A cancelled event tap still hands you its buffered frames**, so stamp work with a generation
  rather than trusting cancellation, and **finish** every `AsyncStream` watcher in `teardown()`.
- **Commits:** conventional, lowercase subject; body lines ≤ 100 chars; a **blank line** before the
  trailer, and the body ends with
  `Co-Authored-By: <executing model name> <noreply@anthropic.com>`.
- **Push with `git push --no-verify`.**
- **Never edit `native/Apps/ShepherdMac/Sources/App/StreamRegistrations.swift`** inside this
  stream. It ships `PlanStream.install(app)` and the integration lane adds the one line.
- **Logging:** `run.shepherd.mac` (app), `run.shepherd.kit` (kit).
- **Branch:** `feat/native-plan`, cut from `origin/main` **after S0-prep-2 merges**. Rebase to
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

Create or modify **only**: `contracts/openapi.yaml` (between `# ── stream: plan ──` and
`# ── /stream: plan ──` only, in all three sections) · the generated `contracts/openapi.swift.yaml`
and `native/Sources/ShepherdKit/openapi.yaml` · `test/contract/plan.test.ts`,
`test/contract/plan-fixtures.ts` ·
`native/Sources/ShepherdKit/Client/ShepherdClient+Plan.swift` ·
`native/Tests/ShepherdKitTests/ShepherdClientPlanTests.swift` ·
`native/Apps/ShepherdMac/Sources/Plan/**` ·
`native/Apps/ShepherdMac/Tests/{PlanGateChip,PlanModel,VisualBlocks,QuestionForm,PlanStrings,
PlanLive}Tests.swift` · the `KEYS_PLAN` array in `native/scripts/gen-strings.ts` ·
`ui/messages/{en,de}.json` (append-only) · the generated
`native/Apps/ShepherdMac/Resources/Localizable.xcstrings`.

Never edit `AppModel.swift`, `AppModel+Extensions.swift`, `MainWindow.swift`,
`SessionDetailView.swift`, `SessionRow.swift`, `SidebarModel.swift`, `HerdPartition.swift`,
`ShepherdApp.swift`, `StreamRegistrations.swift`, `SessionSignals.swift`, any `*Slot.swift`,
`SessionStore.swift`, `ServerEvent.swift`, `EventStream.swift`, `ShepherdClient.swift`,
`project.yml`, `native.yml`, or `test/contract/{harness,deps,stream-blocks,openapi.test}.ts`.

**`Recap` is off-limits.** It lives in S4's `actions` block. See deviation 4.

### Preconditions — verify before Task 1

```bash
grep -c "── stream: plan ──" contracts/openapi.yaml \
  && grep -q "KEYS_PLAN" native/scripts/gen-strings.ts \
  && grep -q "planQuestionsUnanswered" native/Apps/ShepherdMac/Sources/App/SessionSignals.swift \
  && grep -q "planGateCache" test/contract/deps.ts \
  && grep -qE "^\s+(internal )?let generated: Client" native/Sources/ShepherdKit/Client/ShepherdClient.swift \
  && test -f native/Apps/ShepherdMac/Sources/App/DetailTabs.swift \
  && echo OK || echo "S0-prep-2 MISSING — stop and tell the orchestrator"
```

Expected: `3` then `OK`. Two of those deserve spelling out.

1. **`test/contract/deps.ts` must wire `planGateCache`.** Without S0-prep-2's harness task,
   `GET /api/plan-gates` answers `{}` and this stream can prove the status code but not the payload
   — and `PlanGate` plus thirteen `VisualBlock` members is the largest schema family in the
   document. Do not edit `deps.ts`; it is shared.
2. **`SessionSignals.planQuestionsUnanswered` must exist.** It is the seam this stream fills, and
   S7's row badge and the Dock badge read it.

### Deliberate deviations from the stream brief

The brief said "a plan tab or panel via `DetailTabRegistry` + the hold-row CTA via the
sidebar/detail seam". Reading the web and the server changed five things. Each is intentional and
must survive review.

1. **`POST /api/sessions/{id}/go` has no 404.** `handleSessionGo` (`src/server.ts:2905-2911`) calls
   `service.releasePlanGate(id)`, which answers `false` for an unknown id exactly as it does for a
   gate that is not approved — so every failure is one 409 with the body
   `{"error":"plan not approved or not in planning phase"}`. Declaring a 404 the server never sends
   would make the coverage gate unsatisfiable. The kit maps the 409 to a typed "not releasable"
   error and the UI never offers the button unless `canRelease` is true anyway.
2. **`/review-plan` and both `/quota/*` routes answer 202, not 200**, each with `{ok, status}`;
   only `/go` and `/answer-plan-questions` answer 200. This is not cosmetic: a generated client
   switching on `.ok` for a 202 falls into `.undocumented` and the operator sees a server error for
   a successful action.
3. **415 stays undeclared** on `/answer-plan-questions`, per `contracts/README.md`'s "deliberately
   undeclared" rule — the generated client always sends `application/json`. Its other five statuses
   (200, 400 ×2 bodies, 404, 409 ×2 bodies) are all declared and exercised.
4. **`Recap.blocks` is not added here.** The web's `Recap` (`ui/src/lib/types.ts:780`) and the
   server's (`src/types.ts:991`) both carry `blocks?: VisualBlock[]`, and adding it to the contract
   would unlock C15's full recap panel — but the contract's `Recap` sits in S4's `actions` block and
   a stream may not edit another stream's block. This stream declares `VisualBlock`; the integration
   lane adds the one optional property after this PR merges. The PR body says so.
5. **The plan surface is a `DetailTab`, plus a badge, and no hold-row CTA.** The web reaches the
   plan panel from the row's plan-gate badge and from the hold-row "Answer" CTA
   (`ui/src/lib/hold-row.ts:85`), which lives in `UnitRow.svelte` — natively `SessionRow.swift`,
   an S0 file, and `Sources/Sidebar/**`, which is **S7's** for this milestone. This stream therefore
   ships the tab and a badge view registered through `DetailTabRegistry`, and exposes
   `PlanModel.openPlanTick` as the seam a row CTA drives. S7 or the integration lane connects it.
   A stream that edited the other stream's row would guarantee the rebase conflict the whole
   protocol exists to avoid.

**Known parity gap, documented not fixed.** The web's plan-gate badge shows a spawn-notice pip
(`spawnNotices.for(id, "plan")`, a corner marker for a clamped or failed reviewer launch) and the
plan panel renders `SpawnFailureNotice`. `GET /api/spawn-notices` and `session:spawn-notices` are in
no block and this stream does not claim them — a notice family is a surface of its own, and the
`error` verdict plus the `planpanel_review_failed_*` copy already tell the operator that the review
did not complete. Recorded for a later stream.

### Task order

| # | Task | Key files |
| --- | --- | --- |
| 1 | Contract: seven operations, `PlanGate`, `VisualBlock`, three events | `contracts/openapi.yaml`, `test/contract/plan{,-fixtures}.ts` |
| 2 | Kit: `ShepherdClient+Plan.swift` | `ShepherdClient+Plan.swift` |
| 3 | Strings: `KEYS_PLAN` + the web's existing keys | `gen-strings.ts`, `ui/messages/*.json` |
| 4 | `PlanGateChip` — pure derivation | `Sources/Plan/PlanGateChip.swift` |
| 5 | `PlanModel` — the `AppExtension` | `Sources/Plan/PlanModel.swift` |
| 6 | The blocks renderer | `Sources/Plan/VisualBlocksView.swift` |
| 7 | The question form | `Sources/Plan/QuestionFormView.swift` |
| 8 | The plan tab, the badge and the install point | `Sources/Plan/{PlanTabView,PlanGateBadgeView,PlanStream}.swift` |
| 9 | Live check, gate sweep, PR | `Tests/PlanLiveTests.swift` |

---

### Task 1: Contract — the plan-gate surface

**Files:** modify `contracts/openapi.yaml` (plan blocks only); create
`test/contract/plan-fixtures.ts`, `test/contract/plan.test.ts`; regenerate
`contracts/openapi.swift.yaml` and `native/Sources/ShepherdKit/openapi.yaml`.

**Interfaces:**
- Consumes: the core block's `Error`, `AgentProvider`, `#/components/responses/Unauthorized`; the
  **`herd` block's `ReviewerEnv`** (declared there because S7 merges first — do **not** declare a
  second copy); `harness.ts`'s helpers; `deps.ts`'s `ContractDeps.stubs.planGateCache`.
- Produces: schemas `PlanDecision`, `PlanSummaryCode`, `VisualBlock` and its thirteen member
  schemas plus `CalloutTone`, `FileTreeChange`, `FileTreeEntry`, `DiffAnnotation`, `PlanQuestion`,
  `QuestionKind`; `PlanGate`, `PlanGateMap`, `PlanGateInflightEntry`, `PlanReviewTrigger`,
  `PlanReviewResult`, `PlanQuotaStatus`, `PlanQuotaResult`, `RawAnswer`,
  `AnswerPlanQuestionsRequest`, `AnswerPlanQuestionsResult`, `SessionPlanGateEvent`,
  `SessionPlanGateReviewingEvent`, `SessionPlanGateActivityEvent`; operations `listPlanGates`,
  `listPlanGatesInflight`, `releasePlanGate`, `answerPlanQuestions`, `reviewPlan`,
  `resumePlanQuota`, `dismissPlanQuota`; events `session:plangate`, `session:plangate-reviewing`,
  `session:plangate-activity`.

- [ ] **Step 1: Cut the branch and write the fixtures**

```bash
cd /Users/kai.osthoff/githubrepos/shepherd
git fetch origin main
git worktree add .claude/worktrees/feat-native-plan -b feat/native-plan origin/main
cd .claude/worktrees/feat-native-plan && bun install
```

`test/contract/plan-fixtures.ts`:

```ts
import type { PlanGate } from "../../src/types";
import type { VisualBlock } from "../../src/visual-blocks";

/** One block of each of the five types the native renderer implements first, plus one the
 *  contract declares and the renderer degrades. Typed with the SERVER's VisualBlock, so a member
 *  rename in src/visual-blocks.ts breaks `bun run typecheck` before it can drift past the
 *  contract. */
export const blocks: VisualBlock[] = [
  { type: "rich-text", id: "b1", markdown: "Adds the token bucket and its tests." },
  { type: "callout", id: "b2", tone: "risk", markdown: "Two call sites bypass the limiter." },
  {
    type: "file-tree",
    id: "b3",
    title: "Touched",
    entries: [
      { path: "src/limiter.ts", change: "modified", note: "the bucket" },
      { path: "src/admin/route.ts", change: "added" },
    ],
  },
  {
    type: "checklist",
    id: "b4",
    items: [
      { id: "i1", label: "wire the admin route", checked: false },
      { id: "i2", label: "document the burst window", checked: true, note: "in README" },
    ],
  },
  {
    type: "question-form",
    id: "b5",
    questions: [
      { id: "q1", prompt: "Per-IP or per-token?", kind: "single", options: ["per-IP", "per-token"] },
      { id: "q2", prompt: "Which routes are exempt?", kind: "multi", options: ["/health", "/metrics"] },
      { id: "q3", prompt: "Burst window?", kind: "freeform" },
    ],
  },
  { type: "table", id: "b6", columns: ["route", "limit"], rows: [["/api", "100/m"]] },
];

/** A gate in the state the two actions care about: planning, approved, with open questions. */
export const gate: PlanGate = {
  sessionId: "sess_fixture",
  planHash: "7f2a".repeat(16),
  decision: "approved",
  summary: "Plan is sound; two questions open",
  body: "The bucket design is fine. Two decisions are still open.",
  findings: [],
  round: 1,
  cap: 3,
  approved: true,
  plan: "# Rate limiter\n\nAdd a token bucket in front of the admin route.",
  livePlanHash: "7f2a".repeat(16),
  reviewerProvider: "claude",
  reviewerModel: "claude-opus-5",
  reviewerEffort: "high",
  blocks,
  answeredQuestionKeys: ["b5 q1"],
  finalRoundPending: false,
  updatedAt: 1_800_000_060_000,
};

/** The rework shape at cap, which is what `canShowPlanStallActions` keys on. */
export const stalledGate: PlanGate = {
  ...gate,
  decision: "changes_requested",
  approved: false,
  summary: "Rework requested",
  findings: ["name the exempt routes", "state the burst window"],
  round: 3,
  cap: 3,
  finalRoundPending: false,
};

export const inflight = {
  id: "sess_fixture",
  provider: "claude" as const,
  model: "claude-opus-5",
  effort: "high",
};
```

`test/contract/plan.test.ts` follows `herd.test.ts`'s shape exactly: a `beforeAll` that mints a
token, per-route `describe`s, an events `describe` and a coverage `describe` gating on
`operationsForStream("plan")` / `eventsForStream("plan")`. The cases that must be present, because
each pins a status or body a naive port gets wrong:

```ts
describe("plan gates", () => {
  test("the map and the in-flight list answer, and both 401", async () => {
    const id = await createSession("plan me");
    s.deps.stubs.planGateCache.rows[id] = { ...fx.gate, sessionId: id };
    s.deps.stubs.planGateCache.inflight = [{ ...fx.inflight, id }];
    try {
      const map = await get("/api/plan-gates");
      expect(map.status).toBe(200);
      const body = (await validateResponse("GET", "/api/plan-gates", map)) as Record<string, any>;
      expect(body[id].approved).toBe(true);
      // Six block types on one gate: the union's discriminator and every member schema are
      // exercised by this single assertion path.
      expect(body[id].blocks.map((b: { type: string }) => b.type)).toEqual([
        "rich-text", "callout", "file-tree", "checklist", "question-form", "table",
      ]);
      expect(body[id].answeredQuestionKeys).toEqual(["b5 q1"]);

      const flight = await get("/api/plan-gates/inflight");
      expect(flight.status).toBe(200);
      const rows = (await validateResponse("GET", "/api/plan-gates/inflight", flight)) as any[];
      expect(rows[0].effort).toBe("high");
    } finally {
      delete s.deps.stubs.planGateCache.rows[id];
      s.deps.stubs.planGateCache.inflight = [];
    }
    for (const path of ["/api/plan-gates", "/api/plan-gates/inflight"]) {
      const anon = await get(path, false);
      expect(anon.status).toBe(401);
      await validateResponse("GET", path, anon);
    }
  });
});

describe("go", () => {
  test("409 for an unreleasable gate AND for an unknown id — there is no 404", async () => {
    const id = await createSession("not approved");
    const refused = await post(`/api/sessions/${id}/go`);
    expect(refused.status).toBe(409);
    const body = (await validateResponse("POST", "/api/sessions/{id}/go", refused)) as {
      error: string;
    };
    expect(body.error).toBe("plan not approved or not in planning phase");

    // The same 409, not a 404: releasePlanGate answers false for a missing session
    // (src/server.ts:2905-2911). Declaring a 404 here would be a status the server never sends.
    const unknown = await post("/api/sessions/nope/go");
    expect(unknown.status).toBe(409);
    await validateResponse("POST", "/api/sessions/{id}/go", unknown);

    const anon = await post(`/api/sessions/${id}/go`, false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/sessions/{id}/go", anon);
  });
});

describe("answer plan questions", () => {
  test("walks the whole guard ladder: 400, 404, 409, 409, 400, then 200", async () => {
    const id = await createSession("answer me");

    const badBody = await postJson(`/api/sessions/${id}/answer-plan-questions`, { answers: "no" });
    expect(badBody.status).toBe(400);
    await validateResponse("POST", "/api/sessions/{id}/answer-plan-questions", badBody);

    const unknown = await postJson("/api/sessions/nope/answer-plan-questions", { answers: [] });
    expect(unknown.status).toBe(404);
    await validateResponse("POST", "/api/sessions/{id}/answer-plan-questions", unknown);

    // planPhase is null on a fresh stub session, so this is the "not in planning phase" 409.
    const notPlanning = await postJson(`/api/sessions/${id}/answer-plan-questions`, { answers: [] });
    expect(notPlanning.status).toBe(409);
    const phase = (await validateResponse(
      "POST", "/api/sessions/{id}/answer-plan-questions", notPlanning)) as { error: string };
    expect(phase.error).toBe("not in planning phase");

    s.deps.store.update(id, { planPhase: "planning" });
    const noQuestions = await postJson(`/api/sessions/${id}/answer-plan-questions`, { answers: [] });
    expect(noQuestions.status).toBe(409);
    const none = (await validateResponse(
      "POST", "/api/sessions/{id}/answer-plan-questions", noQuestions)) as { error: string };
    expect(none.error).toBe("no plan questions");

    s.deps.store.putPlanGate({ ...fx.gate, sessionId: id });
    const unresolvable = await postJson(`/api/sessions/${id}/answer-plan-questions`, {
      answers: [{ blockId: "b5", questionId: "q1", optionIndices: [99] }],
    });
    // An out-of-range single index is DROPPED by resolvePlanAnswers, leaving nothing resolved.
    expect(unresolvable.status).toBe(400);
    await validateResponse("POST", "/api/sessions/{id}/answer-plan-questions", unresolvable);

    const ok = await postJson(`/api/sessions/${id}/answer-plan-questions`, {
      answers: [
        { blockId: "b5", questionId: "q1", optionIndices: [0] },
        { blockId: "b5", questionId: "q2", optionIndices: [] },
        { blockId: "b5", questionId: "q3", text: "60 seconds" },
      ],
    });
    expect(ok.status).toBe(200);
    const result = (await validateResponse(
      "POST", "/api/sessions/{id}/answer-plan-questions", ok)) as { ok: boolean; delivered: boolean };
    expect(result.ok).toBe(true);
    expect(typeof result.delivered).toBe("boolean");
    // An EMPTY multi selection is a real answer ("none of these"), so its key is recorded.
    const merged = s.deps.store.getPlanGate(id);
    expect(merged?.answeredQuestionKeys).toContain("b5 q2");
  });
});

describe("review-plan and quota", () => {
  test("all three answer 202 with a status, and 404 on an unknown id", async () => {
    const id = await createSession("review my plan");
    for (const path of ["review-plan", "quota/resume", "quota/dismiss"]) {
      const ok = await post(`/api/sessions/${id}/${path}`);
      expect(ok.status).toBe(202);
      const template = `/api/sessions/{id}/${path}`;
      const body = (await validateResponse("POST", template, ok)) as { ok: boolean; status: string };
      expect(body.ok).toBe(true);
      expect(typeof body.status).toBe("string");

      const unknown = await post(`/api/sessions/nope/${path}`);
      expect(unknown.status).toBe(404);
      await validateResponse("POST", template, unknown);

      const anon = await post(`/api/sessions/${id}/${path}`, false);
      expect(anon.status).toBe(401);
      await validateResponse("POST", template, anon);
    }
  });
});
```

The three events are emitted through `s.deps.events` and validated: `session:plangate` **twice**,
once with `{id, gate}` and once with `{id, planPhase: "executing"}`, because the frame is
polymorphic and a schema that required either key would reject half the real traffic.

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run test:contract 2>&1 | tail -20
```

Expected: failures naming `GET /api/plan-gates` as undeclared.

- [ ] **Step 3: Add the schemas inside the plan block in `components.schemas`**

The `VisualBlock` union is the bulk. It is a **read-side open enum by shape**: every member is a
concrete schema, the union is a `oneOf` discriminated on `type`, and the native renderer treats an
unfamiliar `type` as "render its markdown if it has one, otherwise skip", exactly as
`DiffTabView.swift:142` already does for an unknown value.

```yaml
    PlanDecision:
      type: string
      x-shepherd-open-enum: true
      description: Copied verbatim from PlanDecision in src/types.ts:713.
      enum: [approved, changes_requested, error]
    PlanSummaryCode:
      type: string
      x-shepherd-open-enum: true
      description: A server-authored plan summary rendered per-locale by the client (src/types.ts:721). Only `error` verdicts carry one.
      enum: [no-verdict, membrane-launch]
    CalloutTone:
      type: string
      x-shepherd-open-enum: true
      description: Copied verbatim from CalloutTone in src/visual-blocks.ts.
      enum: [info, decision, risk, warning, success]
    FileTreeChange:
      type: string
      x-shepherd-open-enum: true
      enum: [added, modified, removed, renamed]
    FileTreeEntry:
      type: object
      additionalProperties: true
      required: [path, change]
      properties:
        path: { type: string, description: Slash-separated; the renderer splits it into the tree. }
        change: { $ref: "#/components/schemas/FileTreeChange" }
        note: { type: string }
    DiffAnnotation:
      type: object
      additionalProperties: true
      required: [note]
      properties:
        label: { type: string }
        note: { type: string, description: Prose only — annotations carry no line anchors. }
    QuestionKind:
      type: string
      x-shepherd-open-enum: true
      description: Copied verbatim from QuestionKind in src/visual-blocks.ts.
      enum: [single, multi, freeform]
    PlanQuestion:
      type: object
      additionalProperties: true
      required: [id, prompt, kind]
      properties:
        id: { type: string, description: Unique within its block only. The answer key is "<blockId> <questionId>", space-separated. }
        prompt: { type: string }
        kind: { $ref: "#/components/schemas/QuestionKind" }
        options:
          type: array
          items: { type: string }
          description: Non-empty only for single/multi. An answer names an INDEX into this array, never a label.
    VisualBlockRichText:
      type: object
      additionalProperties: true
      required: [type, id, markdown]
      properties:
        type: { type: string, enum: [rich-text] }
        id: { type: string }
        markdown: { type: string }
    VisualBlockCallout:
      type: object
      additionalProperties: true
      required: [type, id, tone, markdown]
      properties:
        type: { type: string, enum: [callout] }
        id: { type: string }
        tone: { $ref: "#/components/schemas/CalloutTone" }
        markdown: { type: string }
    VisualBlockFileTree:
      type: object
      additionalProperties: true
      required: [type, id, entries]
      properties:
        type: { type: string, enum: [file-tree] }
        id: { type: string }
        title: { type: string }
        entries: { type: array, items: { $ref: "#/components/schemas/FileTreeEntry" } }
    VisualBlockDiff:
      type: object
      additionalProperties: true
      description: 'The `file` member is a server-joined real diff and is deliberately undeclared here: the native renderer shows `summary` and the annotations, and the diff tab is S2''s surface.'
      required: [type, id, path, summary]
      properties:
        type: { type: string, enum: [diff] }
        id: { type: string }
        path: { type: string }
        summary: { type: string }
        annotations: { type: array, items: { $ref: "#/components/schemas/DiffAnnotation" } }
    VisualBlockCode:
      type: object
      additionalProperties: true
      required: [type, id, filename]
      properties:
        type: { type: string, enum: [code] }
        id: { type: string }
        filename: { type: string }
        code: { type: string, description: Server-populated; absent when the source could not be joined. }
        truncated: { type: boolean }
    VisualBlockAnnotatedCode:
      type: object
      additionalProperties: true
      required: [type, id, filename]
      properties:
        type: { type: string, enum: [annotated-code] }
        id: { type: string }
        filename: { type: string }
        annotations: { type: array, items: { $ref: "#/components/schemas/DiffAnnotation" } }
        code: { type: string }
        truncated: { type: boolean }
    VisualBlockTable:
      type: object
      additionalProperties: true
      required: [type, id, columns, rows]
      properties:
        type: { type: string, enum: [table] }
        id: { type: string }
        columns: { type: array, items: { type: string } }
        rows: { type: array, items: { type: array, items: { type: string } } }
    VisualBlockChecklist:
      type: object
      additionalProperties: true
      description: Display-only. The web's checkboxes are not interactive and neither are the native ones; `checked` is tri-state (absent is neither done nor open).
      required: [type, id, items]
      properties:
        type: { type: string, enum: [checklist] }
        id: { type: string }
        items:
          type: array
          items:
            type: object
            additionalProperties: true
            required: [id, label]
            properties:
              id: { type: string }
              label: { type: string }
              note: { type: string }
              checked: { type: boolean }
    VisualBlockMermaid:
      type: object
      additionalProperties: true
      required: [type, id, source]
      properties:
        type: { type: string, enum: [mermaid] }
        id: { type: string }
        source: { type: string, description: At most MERMAID_SOURCE_MAX_CHARS (8000) characters. }
        caption: { type: string }
        inferred: { type: boolean }
    VisualBlockWireframe:
      type: object
      additionalProperties: true
      required: [type, id, surface, html]
      properties:
        type: { type: string, enum: [wireframe] }
        id: { type: string }
        surface: { type: string, enum: [browser, desktop, mobile, popover, panel] }
        html: { type: string, description: At most WIREFRAME_HTML_MAX_CHARS (20000) characters. Untrusted — never rendered as markup by the native client. }
        caption: { type: string }
    VisualBlockApiEndpoint:
      type: object
      additionalProperties: true
      required: [type, id, method, path]
      properties:
        type: { type: string, enum: [api-endpoint] }
        id: { type: string }
        method: { type: string }
        path: { type: string }
        summary: { type: string }
        change: { type: string }
        deprecated: { type: boolean }
        inferred: { type: boolean }
        params:
          type: array
          items:
            type: object
            additionalProperties: true
            required: [name, in, type]
            properties:
              name: { type: string }
              in: { type: string }
              type: { type: string }
              required: { type: boolean }
              note: { type: string }
        responses:
          type: array
          items:
            type: object
            additionalProperties: true
            required: [status]
            properties:
              status: { type: integer }
              description: { type: string }
              example: { type: string }
    VisualBlockDataModel:
      type: object
      additionalProperties: true
      required: [type, id, entities]
      properties:
        type: { type: string, enum: [data-model] }
        id: { type: string }
        inferred: { type: boolean }
        entities:
          type: array
          items:
            type: object
            additionalProperties: true
            required: [id, name, fields]
            properties:
              id: { type: string }
              name: { type: string }
              fields:
                type: array
                items:
                  type: object
                  additionalProperties: true
                  required: [name, type]
                  properties:
                    name: { type: string }
                    type: { type: string }
                    pk: { type: boolean }
                    fk: { type: string }
                    nullable: { type: boolean }
                    change: { $ref: "#/components/schemas/FileTreeChange" }
                    was: { type: string }
        relations:
          type: array
          items:
            type: object
            additionalProperties: true
            required: [from, to, kind]
            properties:
              from: { type: string }
              to: { type: string }
              kind: { type: string }
    VisualBlockQuestionForm:
      type: object
      additionalProperties: true
      required: [type, id, questions]
      properties:
        type: { type: string, enum: [question-form] }
        id: { type: string }
        questions: { type: array, items: { $ref: "#/components/schemas/PlanQuestion" } }
    VisualBlock:
      description: >-
        The thirteen typed plan/recap blocks (src/visual-blocks.ts:10-107), discriminated on `type`.
        Shared by plan gates and recaps. A client that meets an unfamiliar `type` must degrade to the
        block's own markdown where it has one and skip it otherwise — never fail the whole decode.
      oneOf:
        - $ref: "#/components/schemas/VisualBlockRichText"
        - $ref: "#/components/schemas/VisualBlockCallout"
        - $ref: "#/components/schemas/VisualBlockFileTree"
        - $ref: "#/components/schemas/VisualBlockDiff"
        - $ref: "#/components/schemas/VisualBlockCode"
        - $ref: "#/components/schemas/VisualBlockAnnotatedCode"
        - $ref: "#/components/schemas/VisualBlockDataModel"
        - $ref: "#/components/schemas/VisualBlockApiEndpoint"
        - $ref: "#/components/schemas/VisualBlockTable"
        - $ref: "#/components/schemas/VisualBlockChecklist"
        - $ref: "#/components/schemas/VisualBlockMermaid"
        - $ref: "#/components/schemas/VisualBlockWireframe"
        - $ref: "#/components/schemas/VisualBlockQuestionForm"
    PlanGate:
      type: object
      additionalProperties: true
      description: >-
        A plan-gate verdict, keyed by session id. Ported from src/types.ts:713-811. `approved` is the
        load-bearing flag: execution is allowed only when it is true.
      required: [sessionId, planHash, decision, summary, body, findings, round, cap, approved, plan, updatedAt]
      properties:
        sessionId: { type: string }
        planHash: { type: string, description: sha256 of the reviewed plan; dedups re-reviews of an unchanged plan. }
        decision: { $ref: "#/components/schemas/PlanDecision" }
        summary: { type: string, description: 'At most 100 characters; "" when summaryCode is set.' }
        summaryCode:
          oneOf:
            - $ref: "#/components/schemas/PlanSummaryCode"
            - type: "null"
        body: { type: string, description: Markdown. }
        findings: { type: array, items: { type: string } }
        round: { type: integer, description: Adversarial rounds spent on the current plan streak. }
        cap: { type: integer, description: The cap THIS run used. Read it; never mirror a config value. }
        approved: { type: boolean }
        plan: { type: string, description: Snapshot of the reviewed plan text. }
        livePlanHash:
          type: [string, "null"]
          description: >-
            sha256 of the LIVE .shepherd-plan.md at the last settle-edge check. Differs from planHash
            on an APPROVED gate ⇒ the plan was edited after sign-off, which is the only source of the
            "edited" chip and the only bypass for re-reviewing an approved gate.
        approvedAt: { type: [integer, "null"], description: 'When the plan was last APPROVED. approvedAt != null && !approved identifies a session deliberately re-gated out of execution.' }
        reviewerProvider:
          oneOf:
            - $ref: "#/components/schemas/AgentProvider"
            - type: "null"
        reviewerModel: { type: [string, "null"] }
        reviewerEffort: { type: [string, "null"] }
        blocks:
          type: array
          items: { $ref: "#/components/schemas/VisualBlock" }
          description: Absent ⇒ render `plan` as flat markdown.
        answeredQuestionKeys:
          type: array
          items: { type: string }
          description: 'Keys of the form "<blockId> <questionId>", space-separated. Absent ⇒ [].'
        finalRoundPending: { type: boolean, description: 'Absent ⇒ false. The cap-th rework steer landed and the FINAL round is in flight.' }
        dismissed: { type: boolean, description: 'Absent ⇒ false. The operator took this stalled rework over.' }
        updatedAt: { type: integer }
    PlanGateMap:
      type: object
      additionalProperties: { $ref: "#/components/schemas/PlanGate" }
      description: GET /api/plan-gates. Session id -> gate. Absent means no gate has ever been written for that session.
    PlanGateInflightEntry:
      type: object
      additionalProperties: true
      description: One in-flight plan review, with the CLI/model/effort doing it — so a reload mid-review restores WHICH reviewer is running, not merely that one is.
      required: [id, provider, model, effort]
      properties:
        id: { type: string }
        provider:
          oneOf:
            - $ref: "#/components/schemas/AgentProvider"
            - type: "null"
        model: { type: [string, "null"] }
        effort: { type: [string, "null"] }
    PlanReviewTrigger:
      type: string
      x-shepherd-open-enum: true
      description: >-
        What POST /api/sessions/{id}/review-plan did (src/plan-gate.ts:77-84). `started-at-cap` means
        the review ran but any further findings will NOT be delivered to the planning agent.
      enum: [started, started-at-cap, skipped, plan-unavailable, error-spawn, error-worktree, error-auth]
    PlanReviewResult:
      type: object
      additionalProperties: true
      required: [ok, status]
      properties:
        ok: { type: boolean }
        status: { $ref: "#/components/schemas/PlanReviewTrigger" }
    PlanQuotaStatus:
      type: string
      x-shepherd-open-enum: true
      description: >-
        The outcome of a quota resume/dismiss. The plan branch produces resumed/unreachable/dismissed/
        not-stalled; the SAME routes serve the critic branch, which produces pr-merged, pr-closed,
        started, skipped and error — hence the open enum.
      enum: [resumed, unreachable, dismissed, not-stalled, pr-merged, pr-closed, started, skipped, error]
    PlanQuotaResult:
      type: object
      additionalProperties: true
      required: [ok, status]
      properties:
        ok: { type: boolean }
        status: { $ref: "#/components/schemas/PlanQuotaStatus" }
    RawAnswer:
      type: object
      additionalProperties: false
      description: >-
        One answer to one plan question (src/plan-gate.ts:1979-1986). `optionIndices` indexes
        PlanQuestion.options. Resolution is fail-closed: a single answer must carry exactly one
        in-range index or it is DROPPED; a multi answer may be empty, which is the real answer
        "none of these"; a freeform answer must be non-blank after trimming.
      required: [blockId, questionId]
      properties:
        blockId: { type: string }
        questionId: { type: string }
        optionIndices: { type: array, items: { type: integer } }
        text: { type: string }
    AnswerPlanQuestionsRequest:
      type: object
      additionalProperties: false
      required: [answers]
      properties:
        answers: { type: array, items: { $ref: "#/components/schemas/RawAnswer" } }
    AnswerPlanQuestionsResult:
      type: object
      additionalProperties: true
      required: [ok, delivered]
      properties:
        ok: { type: boolean }
        delivered:
          type: boolean
          description: >-
            Whether the steer reached the live planning pane. False is NOT an error — the answers are
            recorded either way — but the operator must be told, because the agent may have moved on.
    SessionPlanGateEvent:
      type: object
      additionalProperties: true
      description: >-
        POLYMORPHIC. A fresh verdict carries `gate`; a phase flip carries `planPhase`. Both keys are
        optional and a client must handle each independently — requiring either would reject half
        the real traffic.
      required: [id]
      properties:
        id: { type: string }
        gate: { $ref: "#/components/schemas/PlanGate" }
        planPhase: { type: string, enum: [planning, executing] }
    SessionPlanGateReviewingEvent:
      type: object
      additionalProperties: true
      description: A plan review started or ended. `env` rides the start edge only; both edges clear the activity feed.
      required: [id, reviewing]
      properties:
        id: { type: string }
        reviewing: { type: boolean }
        env: { $ref: "#/components/schemas/ReviewerEnv" }
    SessionPlanGateActivityEvent:
      type: object
      additionalProperties: true
      required: [id, summary]
      properties:
        id: { type: string }
        summary: { type: string }
```

`ReviewerEnv` is `$ref`'d, not declared — it lives in the **herd** block, and a schema name may sit
in exactly one marked block. If S7 has not merged yet, the `$ref` will not resolve and
`bun run test:contract` says so; rebase onto a main that has it rather than declaring a second copy.

- [ ] **Step 4: Add the seven operations inside the plan block in `paths`**

Every one of them, with the statuses the server actually sends:

```yaml
  /api/plan-gates:
    get:
      operationId: listPlanGates
      description: Every session's plan-gate verdict in one read. Bootstraps the badge, the plan tab and the unanswered-question signal.
      responses:
        "200":
          description: Session id to gate.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/PlanGateMap" }
        "401": { $ref: "#/components/responses/Unauthorized" }
  /api/plan-gates/inflight:
    get:
      operationId: listPlanGatesInflight
      description: The plan reviews running right now, each with its reviewer environment.
      responses:
        "200":
          description: One row per in-flight review.
          content:
            application/json:
              schema:
                type: array
                items: { $ref: "#/components/schemas/PlanGateInflightEntry" }
        "401": { $ref: "#/components/responses/Unauthorized" }
  /api/sessions/{id}/go:
    parameters:
      - name: id
        in: path
        required: true
        schema: { type: string }
    post:
      operationId: releasePlanGate
      description: >-
        Release an approved plan gate and start execution. Succeeds only when the session is in the
        planning phase, its gate is approved, and the steer reaches the live pane. There is NO 404:
        an unknown id answers the same 409 as a gate that is not releasable.
      responses:
        "200":
          description: Execution started.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Ok" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "409":
          description: 'error is "plan not approved or not in planning phase". Also the answer for an unknown id.'
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
  /api/sessions/{id}/answer-plan-questions:
    parameters:
      - name: id
        in: path
        required: true
        schema: { type: string }
    post:
      operationId: answerPlanQuestions
      description: >-
        Deliver the operator's answers to the planning agent and record which questions are answered.
        Answers are resolved fail-closed, and only RESOLVED answers record a key — a dropped answer
        never marks its question done.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/AnswerPlanQuestionsRequest" }
      responses:
        "200":
          description: Recorded. `delivered` says whether the steer reached the live pane.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/AnswerPlanQuestionsResult" }
        "400":
          description: 'Two bodies: "body must be {answers: RawAnswer[]}" for a malformed payload, and "no answers resolved" when every answer was dropped.'
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown id.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "409":
          description: 'Two bodies: "not in planning phase", and "no plan questions" when the gate carries no question-form block.'
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
  /api/sessions/{id}/review-plan:
    parameters:
      - name: id
        in: path
        required: true
        schema: { type: string }
    post:
      operationId: reviewPlan
      description: Force an adversarial plan review. 202 — the review itself is asynchronous and lands as session:plangate-reviewing then session:plangate.
      responses:
        "202":
          description: Accepted. `status` says what actually happened.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/PlanReviewResult" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown id.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
  /api/sessions/{id}/quota/resume:
    parameters:
      - name: id
        in: path
        required: true
        schema: { type: string }
    post:
      operationId: resumePlanQuota
      description: Reset a stalled plan's round budget and re-deliver its findings to the planning agent. 202 even when nothing was stalled.
      responses:
        "202":
          description: Accepted. `status` distinguishes resumed, unreachable and not-stalled.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/PlanQuotaResult" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: 'Two bodies, same status: "not found" for an unknown id, and "no forge for this repo" on the critic branch of this shared route.'
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "502":
          description: The critic branch's forge lookup threw.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
  /api/sessions/{id}/quota/dismiss:
    parameters:
      - name: id
        in: path
        required: true
        schema: { type: string }
    post:
      operationId: dismissPlanQuota
      description: Reset a stalled plan's round budget WITHOUT re-delivering findings — the operator is taking it over.
      responses:
        "202":
          description: Accepted.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/PlanQuotaResult" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown id.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
```

`Ok` is the core block's existing `{ok: true}` schema — read it and use the real name.

- [ ] **Step 5: Add the three events**

```yaml
  session:plangate:
    description: Polymorphic — a fresh verdict carries `gate`, a phase flip carries `planPhase`. Handle each key independently.
    schema: { $ref: "#/components/schemas/SessionPlanGateEvent" }
  session:plangate-reviewing:
    description: A plan review started or ended. `env` rides the start edge only.
    schema: { $ref: "#/components/schemas/SessionPlanGateReviewingEvent" }
  session:plangate-activity:
    description: One line of plan-reviewer progress. Cleared on both edges of session:plangate-reviewing.
    schema: { $ref: "#/components/schemas/SessionPlanGateActivityEvent" }
```

Do **not** add these names to the `EventName` enum — it is `x-shepherd-open-enum`, and adding a
member would break the exhaustive switches in `ServerEvent.swift` and `SessionStore.applyNow`, both
off-limits here.

- [ ] **Step 6: Run green, regenerate, sync, prove freshness**

```bash
bun run test:contract && bun run typecheck && bun run gen:contract-swift \
  && ./native/scripts/sync-contract.sh && bun run check:contract-swift \
  && ./native/scripts/sync-contract.sh --check \
  && swift build --package-path native 2>&1 | tail -3
```

Expected: contract tests pass · `tsc` clean · no derived-file diff · `sync-contract: up to date` ·
`Build complete!`. **The `VisualBlock` `oneOf` is the one to watch.** The derivation rewrites
`oneOf: [X, {type: "null"}]` and refuses a flagged enum inside `allOf`; a plain thirteen-way `oneOf`
of named object schemas is neither and passes through untouched, and swift-openapi-generator turns
it into a Swift enum with thirteen cases. If it instead warns "Schema … is not supported", the
cause is a member schema, not the union — the likeliest culprit is an inline `enum` inside a nested
`items` that is missing `type: string`.

- [ ] **Step 7: Commit**

```bash
git add contracts/openapi.yaml contracts/openapi.swift.yaml \
  native/Sources/ShepherdKit/openapi.yaml test/contract/plan.test.ts test/contract/plan-fixtures.ts
git commit -m "feat(contract): plan gates, visual blocks and the two unblock actions"
```

---

### Task 2: Kit — `ShepherdClient+Plan.swift`

**Files:** create `native/Sources/ShepherdKit/Client/ShepherdClient+Plan.swift` and
`native/Tests/ShepherdKitTests/ShepherdClientPlanTests.swift`.

**Interfaces:**
- Consumes: Task 1's generated operations; `ShepherdClient.generated`; `ShepherdError`'s cases;
  `FakeShepherdServer`, `InMemoryCredentialStore`, `StoredCredential`, `ServerProfile`; `OpenEnum`.
- Produces on `ShepherdClient`: `planGates() -> [String: PlanGate]`,
  `planGatesInflight() -> [PlanGateInflightEntry]`, `releasePlanGate(sessionID:) -> Bool`,
  `answerPlanQuestions(sessionID:answers:) -> AnswerPlanQuestionsResult`,
  `reviewPlan(sessionID:) -> PlanReviewResult`, `resumePlanQuota(sessionID:) -> PlanQuotaResult`,
  `dismissPlanQuota(sessionID:) -> PlanQuotaResult`; the typealiases for every schema Task 1
  produced; `OpenEnum` conformances for `PlanDecision`, `PlanSummaryCode`, `CalloutTone`,
  `FileTreeChange`, `QuestionKind`, `PlanReviewTrigger`, `PlanQuotaStatus`.

Two mappings deserve their own tests because they are the ones a straightforward port gets wrong:

```swift
    /// `POST /api/sessions/{id}/go`. **Answers whether the gate actually released** rather than
    /// throwing on the refusal, because the refusal is an ordinary outcome: the server answers one
    /// 409 for every reason, including an unknown id (`src/server.ts:2905-2911`), and the web's own
    /// client is literally `return r.ok` (`ui/src/lib/api.ts:2132-2135`). A caller that wants to
    /// say *why* reads `PlanGateChip.canRelease` before offering the button.
    public func releasePlanGate(sessionID: String) async throws -> Bool {
        do {
            switch try await generated.releasePlanGate(.init(path: .init(id: sessionID))) {
            case .ok: return true
            case .conflict: return false
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "releasePlanGate")
            }
        } catch { throw ShepherdError.from(error, route: "releasePlanGate") }
    }
```

and

```swift
    /// `POST /api/sessions/{id}/answer-plan-questions`.
    ///
    /// `delivered == false` is **not** a failure and must not be thrown: the answers are recorded
    /// on the gate either way, and the operator needs to be told that the planning agent may have
    /// moved on — which is a different sentence from "your answers were lost".
    public func answerPlanQuestions(
        sessionID: String, answers: [RawAnswer]
    ) async throws -> AnswerPlanQuestionsResult {
        do {
            switch try await generated.answerPlanQuestions(
                .init(path: .init(id: sessionID), body: .json(.init(answers: answers)))
            ) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "answerPlanQuestions")
            }
        } catch { throw ShepherdError.from(error, route: "answerPlanQuestions") }
    }
```

The other five follow the shape `ShepherdClient+Herd.swift` established. Tests assert: the gate map
decodes with six block types; an **unknown** block `type` still decodes the surrounding gate (the
generated `oneOf` enum has an undocumented case — read `Types.swift` for its spelling and assert the
gate's other fields survive); `releasePlanGate` returns `false` for a 409 and does not throw;
`answerPlanQuestions` returns `delivered: false` without throwing; every read maps 401 to
`.unauthenticated`; and the three 202 routes decode `.accepted`, not `.ok`.

---

### Task 3: Strings — `KEYS_PLAN` and the web's existing keys

**Files:** modify `native/scripts/gen-strings.ts` (the `KEYS_PLAN` array only) and
`ui/messages/{en,de}.json` (append-only).

- [ ] **Step 1: Take the keys the web already has**

```bash
rg -n '"(planpanel_|plangate_|qform_|vblock_)' ui/messages/en.json | wc -l
rg -n '"(planpanel_|plangate_|qform_|vblock_)' ui/messages/en.json | head -60
```

The whole plan-gate copy already exists in EN **and** DE: `planpanel_*` (about forty keys),
`plangate_*` (the badge labels and tooltips), `qform_*` (ten keys for the question form) and
`vblock_*` (the callout tones and file-tree change labels). **Every one of them is reused.** Writing
a second German translation of "Plan freigeben" is a review rejection, and the i18n rule in
`CLAUDE.md` says so.

- [ ] **Step 2: Add only genuinely app-only keys**, prefixed `native_`, to both catalogs,
  alphabetically — an accessibility label for a control the web does not have, and nothing else.

- [ ] **Step 3: Fill `KEYS_PLAN`**, alphabetical, containing exactly the keys Tasks 4–8 pass to
  `L.t`, minus anything already in `KEYS_CORE`. A key in two arrays fails `duplicateKeys`.

- [ ] **Step 4: Regenerate, check both gates, write `PlanStringsTests.swift`, commit.**

```bash
bun native/scripts/gen-strings.ts && bun run check:strings && (cd ui && bun run check:i18n)
```

---

### Task 4: `PlanGateChip` — pure derivation

**Files:** create `native/Apps/ShepherdMac/Sources/Plan/PlanGateChip.swift` and
`native/Apps/ShepherdMac/Tests/PlanGateChipTests.swift`.

A direct port of `ui/src/lib/components/plan-gate-badge.ts` (193 lines, read it whole) and
`ui/src/lib/plan-status.ts`. Pure, UI-free, every rule asserted.

```swift
/// The eight chip states (`plan-gate-badge.ts:30-38`).
enum PlanGateChip: Equatable, Sendable {
    case none
    case view
    case edited
    case reviewing
    case changes(round: Int, cap: Int)
    case ready
    case error
    case planning
}
```

and the derivation, **priority-ordered exactly as the web has it** (`:40-62`):

```swift
    /// `planGateChip`. Order is the whole content of this function: `planPhase == nil` first,
    /// then the executing branch, then reviewing, changes, ready, error, and planning as the
    /// floor. `allowView: false` is what a dense list passes to suppress the read-only PLAN chip.
    static func chip(
        session: Session, gate: PlanGate?, reviewing: Bool, allowView: Bool = true
    ) -> PlanGateChip {
        guard let phase = session.planPhase else { return .none }
        if phase.known == .executing {
            guard let gate, allowView else { return .none }
            return edited(gate) ? .edited : .view
        }
        if reviewing { return .reviewing }
        if gate?.decision.known == .changesRequested {
            return .changes(round: gate?.round ?? 0, cap: gate?.cap ?? 0)
        }
        if gate?.approved == true { return .ready }
        if gate?.decision.known == .error { return .error }
        return .planning
    }
```

plus, each with its own tests:

- `edited(_:)` — `gate.approved && livePlanHash != nil && livePlanHash != planHash`. The **only**
  source of the edited state and the only bypass for re-reviewing an approved gate.
- `canRelease(session:gate:)` — `gate.approved && planPhase == .planning`.
- `canShowPlanStallActions(session:gate:reviewing:)` — five terms: planning, status ≠ running, not
  reviewing, `decision == .changesRequested`, `round >= cap`.
- `stalledNow(session:gate:reviewing:now:)` — the above **and**
  `stallStatus(gate, now:) == .stalled`.
- `stallStatus(_:now:)` — `round < cap` → `.round`; `!finalRoundPending` → `.stalled`;
  `now - updatedAt > 900_000` → `.stalled`; else `.final`. The 900 000 ms constant is
  `PLAN_FINAL_ROUND_TIMEOUT_MS` and is named as such.
- `canOfferPlanReview` / `canTriggerPlanReview` — the latter returns a *block reason*
  (`.reviewing` or `.approved`), not a Bool, so the button can stay focusable with an explanatory
  label rather than vanishing.
- `questionsUnanswered(_:)` — `ui/src/lib/tab-signal.svelte.ts:36-47`: for every `question-form`
  block, every question whose `"\(block.id) \(question.id)"` is absent from `answeredQuestionKeys`
  makes it true. The key separator is a **single space**, and a test asserts that literally,
  because the server builds the same key (`src/server.ts:2960-2966`) and a different separator
  silently marks nothing as answered.

The two "stalled" predicates are genuinely different and the plan says so: the badge tones amber on
`stalledNow` (which needs a clock), while the panel offers Resume/Dismiss on
`canShowPlanStallActions` (which is structural). A fresh `final` round inside 900 s is **not**
stalled.

---

### Task 5: `PlanModel` — the `AppExtension`

**Files:** create `native/Apps/ShepherdMac/Sources/Plan/PlanModel.swift` and
`native/Apps/ShepherdMac/Tests/PlanModelTests.swift`.

Model it on `SidebarModel`, exactly as S7's `HerdSignals` does: a `PlanReads` struct with a
`.live(client)` factory, a `generation` counter plus the `app.activationGeneration` check around
every commit, a `subscribe(store)` tap on `store.events()`, a `watchConnection` `AsyncStream` that
is **finished** in `teardown()`, and a `refreshPending` collapse.

State: `gates: [String: PlanGate]`, `reviewing: Set<String>`, `reviewerEnv: [String: ReviewerEnv]`,
`activity: [String: [String]]` (bounded to **two** lines, `MAX_ACTIVITY_LINES`), and
`openPlanTick: [String: Int]` — the monotonic seam a row CTA bumps to open the plan tab directly.

The event rules, each with a test, each quoted from `ui/src/lib/reviews.svelte.ts:168-285`:

1. **`session:plangate` is polymorphic.** `gate` present → store it; `planPhase` present → the
   session's own phase moved, which this model does **not** patch (the store owns `Session`); it
   only invalidates whatever it derived from the old phase. Both keys optional, handled
   independently.
2. **A landed gate ends the in-flight run.** `apply(id, gate)` is followed by
   `applyReviewing(id, false)` unconditionally.
3. **The env write happens *before* the transition guard.** A redundant `reviewing: true` must
   still refresh which CLI is reviewing; `false` deletes the env.
4. **Both edges clear the activity feed** — start and end.
5. **`session:archived` drops the gate**, because the store evicts the session.

`PlanModel` also publishes `questionsUnanswered(_:)` over `PlanGateChip.questionsUnanswered`, which
is what the install point points `SessionSignals.planQuestionsUnanswered` at.

---

### Task 6: The blocks renderer

**Files:** create `native/Apps/ShepherdMac/Sources/Plan/VisualBlocksView.swift` and
`native/Apps/ShepherdMac/Tests/VisualBlocksTests.swift`.

**Ship six types first**, in this order, and degrade the rest:

| Type | Native rendering |
| --- | --- |
| `rich-text` | `Text(AttributedString(markdown:))`, `.textSelection(.enabled)` |
| `callout` | a left-bordered box, the tone's colour and the tone's uppercase label from `vblock_callout_*` |
| `checklist` | a static list with `☑`/`☐`; **not interactive** — the web's are not either, and `checked` is tri-state |
| `file-tree` | a tree built by splitting each `path` on `/`, indented 12 pt per level, with the A/M/D/R change badge and its colour |
| `table` | a `Grid` with a header row |
| `question-form` | Task 7 |

Everything else — `diff`, `code`, `annotated-code`, `data-model`, `api-endpoint`, `mermaid`,
`wireframe` — renders its **own text content** where it has one (`summary` for a diff, `caption` for
a mermaid, `filename` for a code block) inside a neutral "not rendered here" container, and an
unfamiliar `type` renders nothing at all. That is the open-enum discipline the contract asks for and
`DiffTabView.swift:142` already applies: the union is not closed, and a plan whose thirteenth block
type is new must still show its other twelve.

**`wireframe.html` is never rendered as markup.** It is untrusted model output; the native client
shows the caption and a "wireframe omitted" line. A `WKWebView` here would be an arbitrary-HTML
renderer inside the app, which is not a parity question.

`inferred` is forced to `false` in a plan context — the badge is recap-specific — and the view takes
that as a parameter so the recap panel can pass `true` when the integration lane connects
`Recap.blocks`.

Tests: one per rendered type asserting the accessibility identifier and the text content; one
asserting an unknown type renders nothing and does not crash; one asserting a block list with a
mixed set renders every known member in order.

---

### Task 7: The question form

**Files:** create `native/Apps/ShepherdMac/Sources/Plan/QuestionFormView.swift` and
`native/Apps/ShepherdMac/Tests/QuestionFormTests.swift`.

The one interactive block. Three modes, matching `QuestionFormBlock.svelte`: an **answer context**
(a session id plus a `locked` flag) makes it submit; no context makes it read-only. The native app
has no "hand answers to a parent" mode, because it has no composer shaping flow yet — S11's.

State per question kind: `single: [String: Int?]`, `multi: [String: Set<Int>]`,
`freeform: [String: String]`. The rules, each tested:

- `canSubmit` requires **every** `single` answered and **every** `freeform` non-blank after
  trimming. **`multi` is optional** — an empty selection is a real answer.
- `buildAnswers()` maps **all** questions: single → `optionIndices: [i]` or `[]`; multi → the
  selection **sorted ascending**; freeform → `text`.
- `locked` = submitting ‖ submitted ‖ the context's own `locked` (which is true while a plan review
  is in flight).
- After a submit, the footer says `qform_sent` when `delivered`, and `qform_sent_undelivered`
  toned as a warning when not — never an error, because the answers were recorded.

**This is one of the stream's two irreversible actions**, so it is behind a confirmation: the submit
button opens a `confirmationDialog` naming how many questions are about to be sent to the planning
agent. The web has no such dialog, and that is a deliberate difference — on the web the operator
sees the whole form in a modal they opened on purpose, whereas the native form lives in a tab that
can be reached by a keyboard tab-cycle. A mis-sent answer steers a live agent.

---

### Task 8: The plan tab, the badge and the install point

**Files:** create `native/Apps/ShepherdMac/Sources/Plan/PlanTabView.swift`,
`native/Apps/ShepherdMac/Sources/Plan/PlanGateBadgeView.swift`,
`native/Apps/ShepherdMac/Sources/Plan/PlanStream.swift`.

**The tab** (`id: "plan"`, `order: 500`, systemImage `"list.bullet.rectangle"`) renders, top to
bottom: the env line (plan CLI + reviewer CLI, live in-flight env preferred over the persisted
`reviewer*` triple), the edited note when `PlanGateChip.edited`, the blocks or the plan markdown,
the reviewer verdict with its findings, the status note for the current chip, the stall actions when
`canShowPlanStallActions`, and the footer: **Review plan now** when `canOfferPlanReview`, and
**Go: start execution** when `canRelease`.

**No `.toolbar`.** Every control is in the body. `DetailRefreshBar` is the shape to copy.

**`/go` is the other irreversible action** and sits behind a `confirmationDialog`. The web's Go
button has none — it closes the panel unconditionally without even reading the result
(`ui/src/lib/components/PlanPanel.svelte`) — and this plan deliberately differs: on the Mac the
button sits in a tab the operator may have switched to while reading, and releasing a gate starts an
agent writing to a worktree. The dialog names the session. After the call, the tab reflects the
returned Bool: `true` → the phase flip arrives as an event and the tab goes read-only; `false` → the
"not releasable" note, because the server refuses and says nothing more specific.

The in-flight bridge is worth porting verbatim: `awaitingReview` is set on a started trigger and
cleared when the `reviewing` flag arrives, with a **4 000 ms backstop** so a lost frame cannot wedge
the spinner; a transient `outcome` self-expires after **6 000 ms**; and an arriving `reviewing`
clears `outcome`, `planUnavailable` and `quotaOutcome`.

**The badge** is a small view the row can host, derived from `PlanGateChip.chip(…)`. It ships as a
`PlanGateBadgeView` in this stream's directory; **S7 or the integration lane** places it on the row,
because `Sources/Sidebar/**` is S7's for this milestone.

**`PlanStream.install(_ app:)`** does exactly four things:

```swift
    static func install(_ app: AppModel) {
        app.register(PlanModel.self)
        DetailTabRegistry.register(PlanDetailTab())
        // The second third of the Dock badge S6 documented as missing, and S7's row badge input.
        SessionSignals.planQuestionsUnanswered = { [weak app] id in
            app?.extension(PlanModel.self)?.questionsUnanswered(id) ?? false
        }
        // The plan half of the web's `isReviewing` (Herd.svelte:262 ORs the two), which S7's
        // classifier consumes through its own seam rather than by reading this model.
        PlanSignals.planReviewing = { [weak app] id in
            app?.extension(PlanModel.self)?.reviewing.contains(id) ?? false
        }
    }
```

`PlanSignals` is this stream's own one-property enum in `Sources/Plan/`, not an edit to
`SessionSignals.swift` — that file is S0's and already has its four members. S7's `HerdContext`
reads it through the integration lane. If S7 has already merged, the lane wires
`HerdSignals.planReviewing = PlanSignals.planReviewing` in the same one-line commit.

---

### Task 9: Live check, full verification and the PR

**Files:** create `native/Apps/ShepherdMac/Tests/PlanLiveTests.swift`.

**Read-only, and emphatically so.** `/go` releases a real gate and `/answer-plan-questions` steers a
real agent; neither is ever issued from a test, and the file says so at the top. The live test reads
`planGates()` and `planGatesInflight()`, decodes every gate the server has, and asserts that every
`question-form` block's questions have ids — the one invariant a silently-empty body would satisfy.

Then the same six-step close as every stream in this milestone: run every gate, prove the ownership
rule with `git diff --name-only origin/main...HEAD | sort`, rebase and re-run the contract gate,
open the PR, watch CI.

```bash
bun run test:contract && bun run check:contract-swift && ./native/scripts/sync-contract.sh --check \
  && bun run check:strings && (cd ui && bun run check:i18n) && bun run lint && bun run typecheck \
  && bun run test && swift test --package-path native \
  && git checkout -- native/Package.resolved \
  && ./native/scripts/test-app.sh -only-testing:ShepherdTests \
  && ./native/scripts/build-app.sh
```

PR title: `feat(mac): plan gates, visual blocks and the two unblock actions`. The body names what
landed, the five deviations above, the `Recap.blocks` integration-lane follow-up, the
`StreamRegistrations` one-liner (`PlanStream.install(app)`), and the verification list. It ends with
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Self-review

**Spec coverage.** The master plan's S8 scope lists six deliverables. `/plan-gates`,
`/plan-gates/inflight`, `/go`, `/answer-plan-questions`, `/review-plan` and `/quota/*` in a
`# ── stream: plan ──` block → Task 1, all three sections, with the statuses the server actually
sends rather than the ones the brief guessed. `PlanGate` + the `VisualBlock` union as a read-side
open enum per `contracts/README.md` → Task 1 (schemas) and Task 6 (the degrade-don't-fail renderer).
`Recap.blocks` filled → **deviation 4**: declared impossible from this stream because `Recap` is in
S4's block, handed to the integration lane. A plan tab via `DetailTabRegistry` → Task 8. The
hold-row CTA via the sidebar seam → **deviation 5**: the row is S7's for this milestone, so this
stream ships `PlanModel.openPlanTick` and the badge view and lets S7 or the lane place them.
Question answering with confirmations → Task 7, plus the second confirmation on `/go` in Task 8.
Tests → every task ends with one. Final task → Task 9.

**Placeholders.** None in the contract and kit tasks, which carry their whole blocks. Tasks 4–8
carry their rules as prose-plus-signatures with the web file and line each rule comes from, because
the palette (`SessionStatusStyle.swift`), the tab shape (`DetailFeature.swift`) and the existing
`SidebarModel` are files whose real API the implementer must read — re-deriving a second status
palette or a second event-tap pattern here is the review rejection. Four deliberate forward
references, each named where it appears: the generated `oneOf` enum's case spelling (read
`Types.swift`), `ShepherdError`'s conflict/5xx case names (read `ShepherdError.swift`), the core
`Ok` schema's real name, and `PlanSignals.planReviewing`'s consumption by S7 (an integration-lane
one-liner).

**Type consistency.** `PlanGate` is one schema, one typealias, and the same type in the kit,
`PlanModel.gates`, every `PlanGateChip` signature and both views. `PlanGateChip`'s eight cases are
identical in the enum, in `chip(…)`, in `PlanGateBadgeView` and in the tests. `RawAnswer`'s four
fields are the same four in the contract, in `buildAnswers()` and in the contract test's three
answer literals. `PlanReviewTrigger`'s seven members and `PlanQuotaStatus`'s nine are each declared
once and switched over once. `VisualBlock`'s thirteen members are declared once, listed once in the
`oneOf`, and the six rendered ones are the same six in Task 6's table and in the fixture. The answer
key separator is a single space in the contract description, in `questionsUnanswered`, in the
contract test's `"b5 q1"` literal and in the server (`src/server.ts:2960-2966`).

**No duplicate path claims.** The seven paths this block adds — `/api/plan-gates`,
`/api/plan-gates/inflight`, and five under `/api/sessions/{id}/` (`go`,
`answer-plan-questions`, `review-plan`, `quota/resume`, `quota/dismiss`) — appear in no other block
and in no core path. `/api/sessions/{id}/review-pr` is **S7's** and is deliberately not claimed here
despite the adjacent name; the two are different routes with different handlers. The three event
names appear in no other block. `ReviewerEnv` is `$ref`'d from the `herd` block rather than
redeclared, which the master plan's Appendix A.2 records.
