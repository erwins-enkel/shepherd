# Pre-execution Plan Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pre-execution gate that, when opted in, spawns a session in a grill/plan phase, runs an adversarial Claude reviewer over the written plan in bounded rounds, and only lets the task enter autonomous execution after the reviewer approves (manual "Go" interactive; auto-release for drain).

**Architecture:** New session `planPhase` flag + `PlanGate` store record + `PlanGateService` (a focused sibling of `ReviewService` reusing the critic spawn hardening). Spawn-prompt branches in `SessionService.create`; autopilot is suppressed while planning; poller drives `PlanGateService.consider/tick`; server exposes Go/review-plan routes; a thin UI surface (NewTask checkbox, repo toggle, badge, plan panel).

**Tech Stack:** Bun + TypeScript (server, `bun test`), SQLite (`bun:sqlite`), SvelteKit 5 + Tailwind 4 (UI, vitest), Paraglide i18n (EN+DE).

**Conventions (read before starting):**
- Fresh worktree: `bun install` at root and `cd ui && bun install` before checks. Root lint `bun run lint`, tests `bun test ./test`. UI `cd ui && bun run check`, tests `cd ui && bun run test`, i18n `cd ui && bun run check:i18n`.
- Server LLM spawns are transient interactive `claude` (subscription OAuth), never `claude -p`. The critic argv in `src/review.ts` `criticArgv` is the canonical hardening — mirror it verbatim.
- Agent-facing prompt text is NOT i18n'd (English). Only operator UI chrome is i18n'd (both `en.json` + `de.json`).
- Commit per task with conventional-commit subjects. This is a `feat`; the feature-announcement gate (Task 14) requires a catalog entry in the same branch.

---

## File Structure

- `src/types.ts` — extend `Session`, `RepoConfig`-adjacent types; add `PlanGate`, `PlanDecision`.
- `src/store.ts` — migrations (session cols, repo_config col), `plan_gates` table + CRUD, archive cascade.
- `src/plan-gate.ts` *(new)* — `planReviewPrompt`, `reviewerArgv`, `PlanGateService`.
- `src/service.ts` — `composeSystemPrompt` plan-gate branch, `create` sets `planPhase`/suppresses autopilot directive, `releasePlanGate`.
- `src/autopilot.ts` — `eligible` returns null during planning.
- `src/index.ts` — construct + wire `PlanGateService`, poll loop, events.
- `src/server.ts` — create-body field, repo-config validator, `POST /api/sessions/:id/go`, `POST /api/sessions/:id/review-plan`, bootstrap snapshot.
- `src/config.ts` — (reuse `reviewCyclesCap`; no new knob).
- UI: `ui/src/lib/components/NewTask.svelte`, `AutomationPanel.svelte`, `PlanGateBadge.svelte` *(new)*, `PlanPanel.svelte` *(new)*, the session-card host, `ui/src/lib/reviews.svelte.ts` (RepoConfigStore + a planGates store), `ui/src/lib/api.ts`, `ui/src/lib/store.svelte.ts` (event reducers), `ui/messages/en.json` + `de.json`, `ui/src/lib/feature-announcements.ts`.

---

## Task 1: Types — Session/PlanGate/RepoConfig fields

**Files:**
- Modify: `src/types.ts`
- Test: `test/plan-gate-types.test.ts` *(new, compile-only smoke)*

- [ ] **Step 1: Add the types.** In `src/types.ts`:
  - Extend `Session` (after the autopilot fields block):
    ```ts
    /** Plan-gate opt-in: true/false override, or null to inherit the repo default. */
    planGateEnabled: boolean | null;
    /** Plan-gate phase: "planning" (grill+review) → "executing" (gate passed); null = gate off. */
    planPhase: "planning" | "executing" | null;
    ```
  - Add near `ReviewVerdict`:
    ```ts
    // ── pre-execution plan gate ──────────────────────────────────────────────
    export type PlanDecision = "approved" | "changes_requested" | "error";

    export interface PlanGate {
      sessionId: string;
      planHash: string; // sha256 of the reviewed plan text; dedups re-reviews of an unchanged plan
      decision: PlanDecision;
      summary: string; // <=100 char one-liner for the badge tooltip
      body: string; // full markdown reviewer write-up
      findings: string[]; // discrete actionable items; [] = nothing to address
      round: number; // adversarial rounds spent on the current plan streak (0 = reset)
      cap: number; // the round cap this run used — surfaced so the UI badge need not mirror it
      approved: boolean; // load-bearing gate flag: execution allowed only when true
      plan: string; // snapshot of the reviewed plan text (surfaced in the UI panel)
      updatedAt: number;
    }
    ```
  - Extend `CreateSessionInput` with `planGateEnabled?: boolean | null;` (per-task override; absent → inherit repo default).
- [ ] **Step 2: Write a compile smoke test** `test/plan-gate-types.test.ts`:
    ```ts
    import { expect, test } from "bun:test";
    import type { PlanGate, Session } from "../src/types";
    test("PlanGate + Session plan fields are shaped", () => {
      const g: PlanGate = { sessionId: "s", planHash: "h", decision: "approved", summary: "",
        body: "", findings: [], round: 0, cap: 3, approved: true, plan: "p", updatedAt: 1 };
      const phase: Session["planPhase"] = "planning";
      expect(g.approved).toBe(true);
      expect(phase).toBe("planning");
    });
    ```
- [ ] **Step 3: Run** `bun test ./test/plan-gate-types.test.ts` → PASS.
- [ ] **Step 4: Commit** `git add -A && git commit -m "feat(plan-gate): types for session phase + PlanGate record (#348)"`

---

## Task 2: Store — migrations, plan_gates table, CRUD, cascade

**Files:**
- Modify: `src/store.ts`
- Test: `test/store-plan-gate.test.ts` *(new)*

Mirror the `reviews` table + `getReview/putReview/dropReview/snapshotReviews` (store.ts:134-144, 526-592) and the `RepoConfig` get/set (the `getRepoConfig/setRepoConfig`).

- [ ] **Step 1: Failing test** `test/store-plan-gate.test.ts`:
    ```ts
    import { expect, test } from "bun:test";
    import { SessionStore } from "../src/store";
    import type { PlanGate } from "../src/types";

    const g = (over: Partial<PlanGate> = {}): PlanGate => ({
      sessionId: "s1", planHash: "h1", decision: "changes_requested", summary: "x",
      body: "b", findings: ["f1"], round: 1, cap: 3, approved: false, plan: "PLAN", updatedAt: 1, ...over,
    });

    test("plan_gate CRUD round-trips + snapshot", () => {
      const s = new SessionStore(":memory:");
      expect(s.getPlanGate("s1")).toBeNull();
      s.putPlanGate(g());
      expect(s.getPlanGate("s1")?.findings).toEqual(["f1"]);
      s.putPlanGate(g({ decision: "approved", approved: true, findings: [], round: 0 }));
      expect(s.getPlanGate("s1")?.approved).toBe(true);
      expect(Object.keys(s.snapshotPlanGates())).toEqual(["s1"]);
      s.dropPlanGate("s1");
      expect(s.getPlanGate("s1")).toBeNull();
    });

    test("repo_config + session carry planGateEnabled / planPhase defaults", () => {
      const s = new SessionStore(":memory:");
      expect(s.getRepoConfig("/r").planGateEnabled).toBe(false);
      s.setRepoConfig("/r", { ...s.getRepoConfig("/r"), planGateEnabled: true });
      expect(s.getRepoConfig("/r").planGateEnabled).toBe(true);
      const row = s.create({ name: "n", prompt: "p", repoPath: "/r", baseBranch: "main",
        branch: "shepherd/n", worktreePath: "/wt", isolated: true, herdrSession: "default",
        herdrAgentId: "t1", claudeSessionId: "c", model: null, auto: false, issueNumber: null });
      expect(row.planPhase).toBeNull();
      expect(row.planGateEnabled).toBeNull();
    });
    ```
  Note: if `create`'s `NewSession` input requires more fields, copy the existing `test/store.test.ts` factory.
- [ ] **Step 2: Run** `bun test ./test/store-plan-gate.test.ts` → FAIL (no `getPlanGate`).
- [ ] **Step 3: Implement.** In `src/store.ts`:
  - In the constructor after `migrateReviewColumns()`, add the table:
    ```ts
    this.db.run(`CREATE TABLE IF NOT EXISTS plan_gates (
      sessionId TEXT PRIMARY KEY, planHash TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
      findings TEXT NOT NULL DEFAULT '[]', round INTEGER NOT NULL DEFAULT 0,
      cap INTEGER NOT NULL DEFAULT 3, approved INTEGER NOT NULL DEFAULT 0,
      plan TEXT NOT NULL DEFAULT '', updatedAt INTEGER NOT NULL)`);
    ```
  - In `migrateSessionColumns()` add: `add("planGateEnabled", \`planGateEnabled INTEGER\`);` and `add("planPhase", \`planPhase TEXT\`);`
  - In `migrateRepoConfigColumns()` add: `add("planGateEnabled", \`planGateEnabled INTEGER NOT NULL DEFAULT 0\`);`
  - Add `planGateEnabled` to the `RepoConfig` interface (default false) and thread it through `getRepoConfig`/`setRepoConfig` (mirror `criticEnabled`: SELECT it, coerce `!!row.planGateEnabled`, default false; INSERT/UPDATE it).
  - Add `planGateEnabled`/`planPhase` to the session `COLS` list AND to the session hydrator (mirror `autopilotEnabled` nullable coercion: `row.planGateEnabled === null ? null : !!row.planGateEnabled`, `planPhase: row.planPhase ?? null`) AND the INSERT in `create` (new rows: `planGateEnabled` = input override ?? null, `planPhase` = null unless input sets it). Add `planGateEnabled?: boolean | null` and `planPhase?: Session["planPhase"]` to `NewSession`.
  - Add CRUD mirroring reviews:
    ```ts
    getPlanGate(sessionId: string): PlanGate | null { /* SELECT … hydratePlanGate */ }
    putPlanGate(g: PlanGate): void { /* INSERT … ON CONFLICT DO UPDATE … */ }
    dropPlanGate(sessionId: string): void { /* DELETE */ }
    snapshotPlanGates(): Record<string, PlanGate> { /* SELECT all → map */ }
    setPlanPhase(id: string, phase: Session["planPhase"]): void {
      this.db.run(`UPDATE sessions SET planPhase = ?, updatedAt = ? WHERE id = ?`,
        [phase, Date.now(), id]);
    }
    ```
    `hydratePlanGate`: parse `findings` with the existing `parseFindings`; `approved: !!row.approved`.
  - In `archive(id)` (and wherever `dropReview` is cascaded), also call `this.dropPlanGate(id)` so an archived session's gate is cleaned up. Grep for `dropReview(` to find the cascade site.
- [ ] **Step 4: Run** `bun test ./test/store-plan-gate.test.ts` → PASS. Then `bun test ./test/store.test.ts` → PASS (no regression).
- [ ] **Step 5: Commit** `git commit -am "feat(plan-gate): store table, CRUD, migrations, archive cascade (#348)"`

---

## Task 3: Spawn — composeSystemPrompt plan-gate branch + create() wiring

**Files:**
- Modify: `src/service.ts`
- Test: `test/service-plan-gate.test.ts` *(new)*

- [ ] **Step 1: Failing test** `test/service-plan-gate.test.ts` — assert the directive selection:
    ```ts
    import { expect, test } from "bun:test";
    import { composeSystemPrompt, PLAN_GATE_DIRECTIVE_INTERACTIVE, PLAN_GATE_DIRECTIVE_AUTO } from "../src/service";

    test("plan-gate directive replaces autopilot directive at spawn", () => {
      const p = composeSystemPrompt(null, /*autopilot*/ true, { planGate: "interactive" });
      expect(p).toContain("plan-gate-directive");
      expect(p).toContain(".shepherd-plan.md");
      expect(p).not.toContain("autopilot-directive"); // suppressed during planning
    });
    test("auto variant skips human Q&A", () => {
      const p = composeSystemPrompt(null, true, { planGate: "auto" });
      expect(p).toContain(PLAN_GATE_DIRECTIVE_AUTO.slice(0, 24));
    });
    test("no plan gate → unchanged autopilot behavior", () => {
      const p = composeSystemPrompt(null, true);
      expect(p).toContain("autopilot-directive");
      expect(p).not.toContain("plan-gate-directive");
    });
    ```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** In `src/service.ts`:
  - Add two agent-facing constants (English, NOT i18n'd — same precedent as `AUTOPILOT_DIRECTIVE`):
    ```ts
    const PLAN_GATE_DIRECTIVE_INTERACTIVE =
      "You are in Shepherd's pre-execution PLAN GATE. Do NOT write or modify any product code yet.\n" +
      "1. Research the codebase enough to plan confidently.\n" +
      "2. Grill the user: ask sharp, specific clarifying questions until you and the user are genuinely " +
      "aligned on scope, approach, and success criteria. Misalignment now is the costliest failure.\n" +
      "3. When aligned, write the plan to `.shepherd-plan.md` at the repo root (goal, approach, files, " +
      "steps, risks, success criteria) and tell the user it's ready for review.\n" +
      "An adversarial reviewer will critique the plan; address its findings by revising `.shepherd-plan.md`. " +
      "Begin implementing ONLY after the plan is approved and you are told to execute.";
    const PLAN_GATE_DIRECTIVE_AUTO =
      "You are in Shepherd's pre-execution PLAN GATE, running unattended (no human to ask). Do NOT write " +
      "or modify product code yet. Research the codebase, then write a concrete plan to `.shepherd-plan.md` " +
      "at the repo root (goal, approach, files, steps, risks, success criteria). An adversarial reviewer " +
      "will critique it; revise `.shepherd-plan.md` to address findings. Begin implementing ONLY after you " +
      "are told the plan is approved.";
    export { PLAN_GATE_DIRECTIVE_INTERACTIVE, PLAN_GATE_DIRECTIVE_AUTO };
    ```
  - Change the signature to `composeSystemPrompt(houseRules, autopilotActive = false, opts: { planGate?: "interactive" | "auto" } = {})`. When `opts.planGate` is set, push the matching `<plan-gate-directive>…</plan-gate-directive>` block and DO NOT push the autopilot block (planning suppresses autopilot). Otherwise behavior is exactly as today.
  - In `create()`: compute
    ```ts
    const planGateOn = input.planGateEnabled ?? this.deps.store.getRepoConfig(input.repoPath).planGateEnabled;
    const planGate = planGateOn ? (input.auto ? "auto" : "interactive") : undefined;
    ```
    Pass `composeSystemPrompt(houseRules, autopilotActive, { planGate })`. When `planGateOn`, persist the new session with `planPhase: "planning"` and `planGateEnabled: input.planGateEnabled ?? null` (add these to the `store.create({…})` call; the store maps them).
- [ ] **Step 4: Run** `bun test ./test/service-plan-gate.test.ts` → PASS; `bun test ./test/service.test.ts` → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(plan-gate): spawn planning phase + grill directive, suppress autopilot (#348)"`

---

## Task 4: Plan-review prompt + reviewer argv (pure functions)

**Files:**
- Create: `src/plan-gate.ts`
- Test: `test/plan-gate-prompt.test.ts` *(new)*

- [ ] **Step 1: Failing test** `test/plan-gate-prompt.test.ts`:
    ```ts
    import { expect, test } from "bun:test";
    import { planReviewPrompt, reviewerArgv } from "../src/plan-gate";

    test("prompt embeds task + plan + prior findings + verdict file", () => {
      const p = planReviewPrompt("do X", "PLAN TEXT", ["earlier nit"]);
      expect(p).toContain("do X");
      expect(p).toContain("PLAN TEXT");
      expect(p).toContain("earlier nit");
      expect(p).toContain(".shepherd-plan-review.json");
      expect(p).toContain("read-only");
    });
    test("reviewerArgv mirrors critic hardening: dontAsk last, no --bare, disableAllHooks", () => {
      const a = reviewerArgv(null, "PROMPT");
      expect(a).not.toContain("--bare");
      expect(a).toContain("--disable-slash-commands");
      expect(a.join(" ")).toContain('{"disableAllHooks":true}');
      // dontAsk must sit AFTER the variadic --allowedTools and BEFORE the trailing prompt
      const dontAsk = a.indexOf("dontAsk");
      expect(a[dontAsk - 1]).toBe("--permission-mode");
      expect(a[a.length - 1]).toBe("PROMPT");
      const tools = a.indexOf("--allowedTools");
      expect(tools).toBeLessThan(dontAsk);
    });
    ```
- [ ] **Step 2: Run** → FAIL (no module).
- [ ] **Step 3: Implement** `src/plan-gate.ts` (prompt + argv only for now). Mirror `src/review.ts` `reviewPrompt` + `criticArgv` exactly (copy the argv array + ordering comments verbatim, but allowlist for plan review is the same read-only set; the trailing positional is the prompt). The verdict file constant: `export const PLAN_VERDICT_FILE = ".shepherd-plan-review.json";`
    ```ts
    export function planReviewPrompt(task: string, plan: string, priorFindings: string[] = []): string {
      const lines = [
        "You are an adversarial plan reviewer. Read-only — do NOT modify, build, commit, or run anything.",
        "A coding agent wrote the PLAN below to accomplish a TASK, BEFORE writing any code. Your job is to",
        "try to REFUTE the plan: is it the best path? Does it actually satisfy the task? What are the hidden",
        "risks, missing steps, wrong assumptions, or a materially simpler approach it ignored? You MAY inspect",
        "the codebase read-only (git log/show/diff, Read, Grep) to ground your critique.",
        "", "TASK:", task, "", "PLAN (.shepherd-plan.md):", plan, "",
      ];
      if (priorFindings.length) {
        lines.push("This is a RE-REVIEW. For EACH prior point, confirm the revised plan addresses it; if not, re-raise it verbatim:",
          ...priorFindings.map((f, i) => `${i + 1}. ${f}`), "");
      }
      lines.push(
        `Write your verdict as JSON to \`${PLAN_VERDICT_FILE}\` in the current directory, EXACTLY:`,
        '{"decision": "approve" | "request-changes", "summary": "<=100 chars", "body": "<full markdown>", "findings": ["<discrete actionable revision>", ...]}',
        'Use "approve" ONLY when the plan is genuinely the best reasonable path and fully satisfies the task — no remaining blocking concerns. Otherwise "request-changes" with at least one finding. Write the file as your final action, then stop.');
      return lines.join("\n");
    }
    ```
    `reviewerArgv(model, prompt)` = copy `criticArgv`'s array construction (lines src/review.ts:312-356) verbatim, dropping the `session`/findings params (the prompt is pre-built).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(plan-gate): adversarial plan-review prompt + reviewer argv (#348)"`

---

## Task 5: PlanGateService — consider/begin (spawn the reviewer)

**Files:**
- Modify: `src/plan-gate.ts`
- Test: `test/plan-gate-service.test.ts` *(new)*

Mirror `ReviewService` structure (inflight map, `starting` set, injected deps, clock). Deps:
```ts
export interface PlanGateServiceDeps {
  store: Pick<SessionStore, "getPlanGate" | "putPlanGate" | "dropPlanGate" | "snapshotPlanGates"
    | "getRepoConfig" | "addSignal" | "setPlanPhase" | "get">;
  herdr: Pick<HerdrDriver, "start" | "stop">;
  worktree: Pick<WorktreeMgr, "createDetached" | "remove">;
  reply: (sessionId: string, text: string) => boolean; // steer findings to the live planning agent
  release: (sessionId: string) => void; // auto-release for auto sessions on approval (→ executing)
  onChange: (id: string, gate: PlanGate) => void;
  onReviewing?: (id: string, reviewing: boolean) => void;
  cap?: number | (() => number);
  model?: string | null;
  now?: () => number;
  timeoutMs?: number;
  readPlan?: (worktreePath: string) => string | null; // default: read .shepherd-plan.md
  readVerdict?: (worktreePath: string) => RawPlanVerdict | null; // default: read PLAN_VERDICT_FILE
  baseSha?: (repoPath: string, base: string) => string; // default: git rev-parse origin/<base>
}
```

- [ ] **Step 1: Failing test** (spawn path):
    ```ts
    import { expect, test } from "bun:test";
    import { PlanGateService } from "../src/plan-gate";

    function harness(over = {}) {
      const started: any[] = [];
      const removed: string[] = [];
      const deps: any = {
        store: {
          getPlanGate: () => null, putPlanGate(g:any){ this.gate = g; }, dropPlanGate(){},
          snapshotPlanGates: () => ({}), getRepoConfig: () => ({ planGateEnabled: true }),
          addSignal(){}, setPlanPhase(){}, get: () => ({ id: "s1", baseBranch: "main", repoPath: "/r" }),
        },
        herdr: { start: (l:string,cwd:string,argv:string[]) => { started.push({l,cwd,argv}); return { terminalId: "t1" }; }, stop(){} },
        worktree: { createDetached: () => ({ worktreePath: "/wt-detached", branch: "main" }), remove:(p:string)=>removed.push(p) },
        reply: () => true, release(){}, onChange(){}, onReviewing(){},
        cap: 3, now: () => 1000, readPlan: () => "PLAN TEXT", readVerdict: () => null, baseSha: () => "abc",
        ...over,
      };
      return { deps, started, removed, svc: new PlanGateService(deps) };
    }

    test("consider spawns reviewer when a plan exists and is unreviewed", async () => {
      const h = harness();
      await h.svc.consider({ id: "s1", repoPath: "/r", baseBranch: "main", worktreePath: "/wt", planPhase: "planning" } as any);
      expect(h.started.length).toBe(1);
      expect(h.started[0].argv[h.started[0].argv.length - 1]).toContain("PLAN TEXT");
    });

    test("consider no-ops when plan missing", async () => {
      const h = harness({ readPlan: () => null });
      await h.svc.consider({ id: "s1", repoPath: "/r", baseBranch: "main", worktreePath: "/wt", planPhase: "planning" } as any);
      expect(h.started.length).toBe(0);
    });

    test("consider dedupes an unchanged plan hash", async () => {
      const hash = await PlanGateService.hashPlan("PLAN TEXT");
      const h = harness({ store: { getPlanGate: () => ({ planHash: hash, approved: false }), getRepoConfig: () => ({ planGateEnabled: true }), get: () => ({ id:"s1" }) } as any });
      await h.svc.consider({ id: "s1", repoPath: "/r", baseBranch: "main", worktreePath: "/wt", planPhase: "planning" } as any);
      expect(h.started.length).toBe(0);
    });

    test("consider no-ops when already approved", async () => {
      const h = harness({ store: { getPlanGate: () => ({ planHash: "other", approved: true }), getRepoConfig: () => ({ planGateEnabled: true }), get: ()=>({id:"s1"}) } as any });
      await h.svc.consider({ id: "s1", repoPath: "/r", baseBranch: "main", worktreePath: "/wt", planPhase: "planning" } as any);
      expect(h.started.length).toBe(0);
    });
    ```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `consider` + `begin` + a static `hashPlan` (sha256 hex via `node:crypto` `createHash`). `consider(session)`:
  - return if `session.planPhase !== "planning"`.
  - return if `inflight.has(id) || starting.has(id)`.
  - `const plan = (readPlan(session.worktreePath) ?? "").trim();` return if empty.
  - `const planHash = await hashPlan(plan);` `const prior = store.getPlanGate(id);` return if `prior?.approved`, or `prior?.planHash === planHash` (dedupe).
  - claim `starting`, call `begin(session, plan, planHash, prior)`, finally clear `starting`.
  - `begin`: `const sha = baseSha(repoPath, baseBranch);` `const wt = worktree.createDetached(repoPath, baseBranch, sha);` spawn `herdr.start(\`plan-review \${session.desig ?? id}\`, wt.worktreePath, reviewerArgv(model, planReviewPrompt(session.prompt, plan, prior?.findings ?? [])))`; record `inflight.set(id, { sessionId:id, worktreePath, terminalId, planHash, plan, startedAt: now(), priorRound: prior?.round ?? 0 })`; `onReviewing?.(id, true)`. Wrap worktree/spawn in try/catch with `worktree.remove` on failure (mirror ReviewService.begin).
  - default `readPlan` = `readFileSync(join(wt, ".shepherd-plan.md"))` guarded by existsSync; default `baseSha` = `git rev-parse` of `origin/<base>` (fallback to `<base>`), via execFileSync.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(plan-gate): PlanGateService.consider/begin spawns adversarial reviewer (#348)"`

---

## Task 6: PlanGateService — tick/finalize (verdict → steer-back / approve / cap)

**Files:**
- Modify: `src/plan-gate.ts`
- Test: `test/plan-gate-service.test.ts` *(extend)*

- [ ] **Step 1: Failing tests** (drive finalize via injected `readVerdict`):
    ```ts
    test("approve → stores approved gate, reaps, reviews-off; auto session auto-released", async () => {
      const released: string[] = [];
      const h = harness({ readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
        store: { ...baseStore(), get: () => ({ id: "s1", auto: true }) },
        release: (id:string) => released.push(id) });
      await h.svc.consider(planningSession()); // spawns
      await h.svc.tick(); // finalizes
      expect(h.gatePut.approved).toBe(true);
      expect(released).toEqual(["s1"]);
      expect(h.removed).toContain("/wt-detached");
    });

    test("request-changes → steers findings to the live agent, round++, NOT released", async () => {
      const steers: string[] = [];
      const h = harness({ readVerdict: () => ({ decision: "request-changes", summary: "no", body: "B", findings: ["fix A"] }),
        reply: (_id:string, t:string) => { steers.push(t); return true; } });
      await h.svc.consider(planningSession());
      await h.svc.tick();
      expect(steers[0]).toContain("fix A");
      expect(h.gatePut.decision).toBe("changes_requested");
      expect(h.gatePut.round).toBe(1);
      expect(h.gatePut.approved).toBe(false);
    });

    test("round at cap → stops steering, emits stall signal", async () => {
      const signals: any[] = [];
      const h = harness({ cap: 1,
        readVerdict: () => ({ decision: "request-changes", summary: "no", body: "B", findings: ["again"] }),
        store: { ...baseStore(), getPlanGate: () => ({ planHash: "x", approved: false, round: 1, findings: ["again"] }), addSignal: (s:any)=>signals.push(s) } });
      await h.svc.consider(planningSession());
      await h.svc.tick();
      expect(signals.some(s => s.kind === "stall")).toBe(true);
    });

    test("timeout → error verdict, reviews-off, not released", async () => {
      const h = harness({ readVerdict: () => null, now: makeClock([1000, 1000, 999999999]) });
      await h.svc.consider(planningSession());
      await h.svc.tick();
      expect(h.gatePut.decision).toBe("error");
    });
    ```
  (Define `planningSession()`, `baseStore()`, `makeClock()`, and capture `gatePut` via `putPlanGate(g){ this.gatePut = g }` in the harness.)
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `tick()` + `finalize()` mirroring ReviewService.tick/finalize:
  - `tick()`: for each inflight, `const raw = readVerdict(wt); const timedOut = now()-startedAt > timeoutMs;` if neither, continue; guard `finalizing`; `finalize`; always `inflight.delete`.
  - `buildGate(f, raw)`: normalize decision (`approve`→`approved`, `request-changes`→`changes_requested`, else `error`); `findings` = normalized string[]; on `request-changes` with empty findings fall back to `[summary]`.
  - finalize logic:
    - `approved` → gate `{approved:true, round:0, findings:[]}`. `putPlanGate`; `onChange`; if `store.get(id)?.auto` → `release(id)` (auto-release into execution).
    - `changes_requested` → `round = priorRound >= cap ? priorRound : priorRound + (delivered?1:0)`. Steer `reply(id, planSteerText(findings))` only when `priorRound < cap`; if `priorRound >= cap` (or steer didn't land at cap) → `addSignal({kind:"stall", …})` once. `putPlanGate({approved:false, round, decision, findings})`; `onChange`.
    - `error` → `putPlanGate({decision:"error", round: priorRound, approved:false})`; `addSignal({kind:"stall"})` optional; bias to surface.
  - Always reap: `onReviewing?.(id,false); herdr.stop(terminalId); worktree.remove(worktreePath)`.
  - `planSteerText(findings)` (English, not i18n'd): "The plan reviewer raised these points. Revise `.shepherd-plan.md` to address each, then stop so it can re-review:\n" + numbered findings.
  - Add `snapshot()` → `store.snapshotPlanGates()`, `reviewingIds()` → inflight keys, `forget(id)` → reap + `dropPlanGate` (mirror ReviewService.forget) for archive cleanup.
- [ ] **Step 4: Run** full `bun test ./test/plan-gate-service.test.ts` → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(plan-gate): finalize verdict — steer-back, approve+auto-release, cap escalation (#348)"`

---

## Task 7: releasePlanGate + autopilot suppression

**Files:**
- Modify: `src/service.ts`, `src/autopilot.ts`
- Test: `test/service-release.test.ts` *(new)*, `test/autopilot.test.ts` *(extend)*

- [ ] **Step 1: Failing tests:**
    ```ts
    // test/service-release.test.ts
    import { expect, test } from "bun:test";
    import { SessionService } from "../src/service";
    // build a SessionService with a stub store + herdr (copy an existing service test's harness)
    test("releasePlanGate flips phase + steers only when approved", () => {
      // store.get → { id, planPhase:"planning" }; store.getPlanGate → { approved:false }
      // expect releasePlanGate(id) === false, no setPlanPhase, no steer
      // then approved:true → returns true, setPlanPhase("executing"), reply called with execute steer
    });
    test("releasePlanGate is a no-op when phase !== planning", () => { /* approved but phase executing → false */ });
    ```
    ```ts
    // test/autopilot.test.ts — add
    test("eligible() returns null while planPhase==='planning'", async () => {
      // session with planPhase:"planning", autopilot enabled → onDone must not classify/steer
    });
    ```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
  - `src/service.ts` `releasePlanGate(id): boolean`:
    ```ts
    releasePlanGate(id: string): boolean {
      const s = this.deps.store.get(id);
      if (!s || s.planPhase !== "planning") return false;
      if (!this.deps.store.getPlanGate?.(id)?.approved) return false; // strict: must be approved
      this.deps.store.setPlanPhase(id, "executing");
      this.reply(id, PLAN_GO_STEER); // English steer
      this.deps.events?.emit("session:plangate", { id, planPhase: "executing" });
      return true;
    }
    ```
    Add `PLAN_GO_STEER` (English): "Plan approved. Execute `.shepherd-plan.md` now, autonomously — implement it, commit, push, and open a PR. Don't re-litigate the plan." Add `getPlanGate`/`setPlanPhase` to `ServiceDeps.store` Pick. (For drain auto-release, `PlanGateService.release` = `(id) => service.releasePlanGate(id)`.)
  - `src/autopilot.ts` `eligible(id)`: after the `archived` check add `if (s.planPhase === "planning") return null;` and add `planPhase` to the `store.get` shape (it's already a full Session). Update the doc comment to note planning suppresses autopilot.
- [ ] **Step 4: Run** both test files → PASS; `bun test ./test/autopilot.test.ts` full → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(plan-gate): release gate into execution + suppress autopilot during planning (#348)"`

---

## Task 8: Server wiring — construct service, poll loop, events, routes

**Files:**
- Modify: `src/index.ts`, `src/server.ts`
- Test: `test/server-plan-gate.test.ts` *(new, route-level)*

- [ ] **Step 1: Failing test** `test/server-plan-gate.test.ts` (mirror an existing server route test; hit the handlers):
    ```ts
    // POST /api/sessions with { planGateEnabled:true } → created session has planPhase:"planning"
    // POST /api/sessions/:id/go when gate approved → 200 + planPhase executing; when not approved → 409
    // PUT /api/repo-config { planGateEnabled:true } → persisted + echoed
    // POST /api/sessions/:id/review-plan → calls planGate.consider (spy)
    ```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
  - `src/index.ts`: construct `const planGate = new PlanGateService({ store, herdr, worktree, resolveForge?: n/a, reply: (id, t) => service.reply(id, t), release: (id) => service.releasePlanGate(id), onChange: (id, g) => events.emit("session:plangate", { id, gate: g }), onReviewing: (id, r) => events.emit("session:plangate-reviewing", { id, reviewing: r }), cap: () => store.getSettingsCap?.() ?? config.reviewCyclesCap, model: config.autopilotModel ? null : null })`. Use the same model resolution the critic uses (likely `null` or a configured review model — match `reviewService`'s `model` arg).
  - Poll wiring: where the loop reacts to `session:status` settle and calls `reviewService.consider`/autopilot, also: on a settle for a session whose `store.get(id)?.planPhase === "planning"`, call `void planGate.consider(session)`. Add `planGate.tick()` to the same interval that calls `reviewService.tick()`.
  - Bootstrap: include `planGates: planGate.snapshot()` and `planGateReviewing: planGate.reviewingIds()` in the snapshot payload the client loads (find where `snapshotReviews()`/`reviewingIds()` are added to the bootstrap).
  - Archive: where `reviewService.forget(id)` is called on archive, also call `planGate.forget(id)`.
  - `src/server.ts`:
    - create-session body parser: accept optional `planGateEnabled` (boolean|null) → pass into `service.create`.
    - `parseRepoConfigPatch`: accept `planGateEnabled` boolean.
    - Add routes: `POST /api/sessions/:id/go` → `service.releasePlanGate(id) ? 200 : 409`; `POST /api/sessions/:id/review-plan` → `await planGate.consider(store.get(id)); 202`. Thread `planGate` into the server deps (mirror how `reviewService` is threaded, if it is; else pass the two closures).
- [ ] **Step 4: Run** `bun test ./test/server-plan-gate.test.ts` → PASS; `bun test ./test` → PASS; `bun run lint` clean; `bunx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `git commit -am "feat(plan-gate): wire PlanGateService — poll, events, /go + /review-plan routes (#348)"`

---

## Task 9: UI store + API — plan-gate events & actions

**Files:**
- Modify: `ui/src/lib/api.ts`, `ui/src/lib/store.svelte.ts`, `ui/src/lib/reviews.svelte.ts`
- Test: `ui/src/lib/plan-gate.test.ts` *(new vitest)*

- [ ] **Step 1: Failing test** (store reducer + derivation):
    ```ts
    import { describe, it, expect } from "vitest";
    import { PlanGateStore } from "./reviews.svelte"; // or wherever it lands
    it("ingests session:plangate + reviewing events", () => {
      const s = new PlanGateStore();
      s.applyReviewing("s1", true);
      expect(s.isReviewing("s1")).toBe(true);
      s.apply("s1", { sessionId:"s1", decision:"approved", approved:true, findings:[], round:0, cap:3, summary:"", body:"", plan:"P", planHash:"h", updatedAt:1 });
      expect(s.map["s1"].approved).toBe(true);
      expect(s.isReviewing("s1")).toBe(false); // a verdict clears reviewing
    });
    ```
- [ ] **Step 2: Run** `cd ui && bun run test plan-gate` → FAIL.
- [ ] **Step 3: Implement.**
  - `api.ts`: `releasePlanGate(id)` → `POST /api/sessions/${id}/go`; `reviewPlan(id)` → `POST /api/sessions/${id}/review-plan`. Add `planGateEnabled` to the `createSession` body type. Add `togglePlanGate` repo-config to the existing `putRepoConfig` patch type.
  - `reviews.svelte.ts`: add a `PlanGateStore` mirroring the reviews store (`map`, `reviewing` set, `apply`, `applyReviewing`, `isReviewing`, `bootstrap`). Add `togglePlanGate(repoPath)` + `planGateEnabled` to `RepoConfigStore.flags`.
  - `store.svelte.ts`: in the WS event switch, handle `session:plangate` → `planGates.apply(data.id, data.gate)` (and `planPhase` patch onto the session row when present), `session:plangate-reviewing` → `planGates.applyReviewing(data.id, data.reviewing)`. Bootstrap `planGates`/`planGateReviewing` from the initial snapshot.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(plan-gate): UI store + API for plan-gate events and Go/review actions (#348)"`

---

## Task 10: UI components — NewTask checkbox, AutomationPanel toggle, badge, panel

**Files:**
- Modify: `ui/src/lib/components/NewTask.svelte`, `AutomationPanel.svelte`, the session-card host (where `CriticBadge`/`AutopilotBadge` render)
- Create: `ui/src/lib/components/PlanGateBadge.svelte`, `ui/src/lib/components/PlanPanel.svelte`
- Test: `ui/src/lib/components/PlanGateBadge.test.ts` *(new)*

- [ ] **Step 1: Failing test** for badge state derivation:
    ```ts
    // REVIEWING when reviewing set; CHANGES · round N/cap on changes_requested;
    // READY ✓ when approved && planPhase==="planning"; PLANNING when planning & no gate yet
    ```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (Svelte 5 runes; mirror `CriticBadge.svelte`/`AutopilotBadge.svelte`):
  - `PlanGateBadge.svelte`: props `{ session }`. Derive from `planGates.isReviewing(id)`, `planGates.map[id]`, `session.planPhase`. Render the four states with `m.*` text + a title. Click opens `PlanPanel`.
  - `PlanPanel.svelte`: a drawer/modal (reuse the app's existing modal/drawer component) showing `gate.plan` (render as preformatted markdown — reuse the existing markdown renderer if present, else `<pre>`), the verdict (`summary`/`body`/`findings`), and a **Go** button calling `releasePlanGate(id)` — `disabled` unless `gate?.approved`. A "Review plan now" button calling `reviewPlan(id)` for the manual trigger.
  - `NewTask.svelte`: add a checkbox bound to a `planGate` local, defaulting from `repoConfig.flags(repoPath).planGateEnabled`; include `planGateEnabled: planGate` in the submit payload. Add `use:coachTarget={"plan-gate"}` to the checkbox for the coachmark (Task 11).
  - `AutomationPanel.svelte`: add a "Plan gate" toggle calling `repoConfig.togglePlanGate(repoPath)` (mirror the critic toggle block).
  - Host card: render `<PlanGateBadge {session} />` next to the other badges, shown only when `session.planPhase` is non-null.
- [ ] **Step 4: Run** `cd ui && bun run test` → PASS; `cd ui && bun run check` → clean.
- [ ] **Step 5: Commit** `git commit -am "feat(plan-gate): UI — NewTask checkbox, repo toggle, badge, plan/Go panel (#348)"`

---

## Task 11: i18n + feature announcement

**Files:**
- Modify: `ui/messages/en.json`, `ui/messages/de.json`, `ui/src/lib/feature-announcements.ts`

- [ ] **Step 1:** Add every new chrome key to BOTH catalogs (snake_case, component-prefixed), e.g. `newtask_plan_gate_label`, `automation_plan_gate_label`, `plangate_planning`, `plangate_reviewing`, `plangate_changes` (with `{round}`/`{cap}`), `plangate_ready`, `planpanel_title`, `planpanel_verdict`, `planpanel_findings`, `planpanel_go`, `planpanel_review_now`, `planpanel_empty`, plus the announcement `feature_plan_gate_title`/`feature_plan_gate_body`. Replace any literal strings in the Task 10 components with `m.*` calls.
- [ ] **Step 2:** Append to `featureAnnouncements` in `ui/src/lib/feature-announcements.ts`:
    ```ts
    { id: "plan-gate", sinceVersion: "<current package version>", titleKey: "feature_plan_gate_title",
      bodyKey: "feature_plan_gate_body", targetId: "plan-gate" },
    ```
  (Read the current `sinceVersion` convention from the last entry + `package.json` version.)
- [ ] **Step 3: Run** `cd ui && bun run check:i18n` → PASS (catalog parity); `cd ui && bun run check` → clean.
- [ ] **Step 4: Commit** `git commit -am "feat(plan-gate): i18n keys (EN+DE) + What's-New catalog entry (#348)"`

---

## Task 12: Full verification + PR

- [ ] **Step 1:** Root: `bun install`, `bun run lint`, `bunx tsc --noEmit`, `bun test ./test`. All green.
- [ ] **Step 2:** UI: `cd ui && bun install && bun run check && bun run check:i18n && bun run test`. All green.
- [ ] **Step 3:** `scripts/check-feature-catalog.sh` and `scripts/check-branch-hygiene.sh` pass (run them or rely on the pre-push hook).
- [ ] **Step 4:** Rebase onto latest `origin/main` if it moved (memory: shared main); `bun install` per package after rebase.
- [ ] **Step 5:** `git push -u origin <branch>` and `gh pr create` into `main`. PR body: summarize the feature, link issue #348, list the scope decisions + the explicit out-of-scope follow-ups from the spec, and note `[no-feature-entry]` is NOT used (a real catalog entry ships).

---

## Self-review notes

- **Spec coverage:** grill phase (Task 3 directive) ✓; adversarial review bounded rounds (Tasks 4–6) ✓; opt-in per task + repo default for drain (Tasks 2,3,8,10) ✓; reuse critic hardening (Task 4 `reviewerArgv`) ✓; plan+verdict surfaced + Go before execution (Tasks 9–10) ✓; auto-release for drain (Task 6) ✓; autopilot suppression (Task 7) ✓.
- **Naming consistency:** `planGateEnabled`, `planPhase`, `PlanGate`, `PlanDecision`, `getPlanGate/putPlanGate/dropPlanGate/snapshotPlanGates`, `setPlanPhase`, `releasePlanGate`, `PlanGateService.consider/begin/tick/finalize/forget/snapshot/reviewingIds`, events `session:plangate` + `session:plangate-reviewing`, files `.shepherd-plan.md` + `.shepherd-plan-review.json` — used identically across tasks.
- **Open risks for the executor:** verify the exact session-card host component and the app's modal/markdown components before Task 10; confirm whether `server.ts` already threads service singletons or closures and match that style; confirm the bootstrap-snapshot assembly site.
```
