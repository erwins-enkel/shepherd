# Epic Runner Implementation Plan (rev 2 — epic as a drain mode)

> **Source of truth: `.shepherd-plan.md` (working-tree) is authoritative; this file is its committed
> companion with the full per-task TDD breakdown, kept in lockstep.** Where the two ever differ,
> `.shepherd-plan.md` wins. This was inverted from an earlier note: prior reviews kept inspecting a
> stale committed snapshot of *this* file, so the safety-critical spec now lives inline in
> `.shepherd-plan.md` (read live, environment-independent) and is mirrored here.
> Safety invariants (encoded in Tasks 3, 4, 7 below and inline in `.shepherd-plan.md`): native
> per-child `SubIssueRef.{closed,labels,body}` → gating escapes `listIssues()`'s 200-cap;
> `openIssuesTruncated` warns the markdown path; `emitEpicIfChanged` dedups epic emits;
> `EpicChild.body` carries Notion context to `issueRef.body`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator point SHEPHERD at a parent ("tracking") GitHub issue and have it work the child issues one-task-PR-per-issue, DAG-aware (parallel roots, gated children), advancing as blocking issues close.

**Architecture (rev 2, post-review):** "Epic" is a **mode of the existing `DrainService`**, not a sibling harness. When a repo has a running epic, drain's `buildState` sources spawn candidates from the epic's dependency-gated children (`selectEpicCandidates`) instead of the `autoLabel`, and an attended gate (`epicAttended`/`epicApprovedNext` → `awaiting_approval` hold) optionally holds each spawn for operator approval. Epic child sessions **are** drain's `s.auto` sessions — one pump, one pool, one `maxAuto` cap, one owner per repo. Retire/cap/trouble/full-auto-merge are reused unchanged; full-auto children advance off the merge→`onGit`/`onArchived` recompute path (the retire gate skips them by design). See `.shepherd-plan.md` for the architecture rationale + the reviewer-point resolutions.

**Tech Stack:** Bun + TypeScript (root), `bun:sqlite`, SvelteKit 5 + Tailwind 4 (UI), Paraglide i18n (EN+DE), `gh` CLI via `gh api`. Tests: `bun test ./test` (root), `cd ui && bun run test` (vitest).

**Integration points (verified):** `drain.ts:105-106` (`autoSessions` = `s.status!=="archived" && s.auto`), `drain.ts:130-131` (candidate source), `drain.ts:134` (`enabled`), `drain.ts:440,447,456` (pump-trigger guards on `autoDrainEnabled`), `drain-core.ts:27` (`HoldReason.code`), `drain-core.ts:173` (`!s.fullAuto && readyToRetire(...)`).

**Before starting:** `bun install` (root) and `cd ui && bun install` (this is a fresh worktree).

---

## File structure

| File | New/Mod | Responsibility |
|------|---------|----------------|
| `src/epic-core.ts` | new | Pure types + `deriveChildState` + `selectEpicCandidates`. No I/O. |
| `src/epic-parse.ts` | new | Parse parent body → `{members, order, edges}`. No I/O. |
| `src/epic-model.ts` | new | `assembleEpic(...)` → `Epic` (native-first, markdown fallback, edge hygiene). |
| `src/epic-import.ts` | new | Idempotent markdown→native-links importer. |
| `src/forge/types.ts` | mod | `SubIssueRef` + 5 optional `GitForge` methods. |
| `src/forge/github.ts` | mod | Implement the 5 via `gh api`. |
| `src/drain-core.ts` | mod | `epicAttended`/`epicApprovedNext` fields + `awaiting_approval` hold. |
| `src/drain.ts` | mod | `buildState` epic branch + `assembleEpic` wiring + `approveEpicNext` + trigger-guard update + emit `epic:update`. |
| `src/store.ts` | mod | `epic_run` table + getters. |
| `src/validate.ts` | mod | `validateEpicRunPatch`. |
| `src/server.ts` | mod | 5 epic routes + `epic:update`. |
| `src/index.ts` | mod | Pass `emitEpic` into `DrainDeps`; route deps for the new endpoints. |
| `ui/src/lib/{types,api,store.svelte}.ts` | mod | Mirror types; client calls; `epics` store + `epic:update`. |
| `ui/src/lib/components/EpicPanel.svelte` + `epic-panel.ts` | new | Child list + controls; pure helpers. |
| `ui/src/lib/components/IssuesPanel.svelte` | mod | Badge + expansion. |
| `ui/messages/{en,de}.json` | mod | New strings. |
| `ui/src/lib/feature-announcements.ts` | mod | One entry. |

---

# PHASE 1 — Reads & model

## Task 1: Epic core (types, state derivation, gating)

**Files:** Create `src/epic-core.ts`; Test `test/epic-core.test.ts`.

- [ ] **Step 1: Write the failing test** (`test/epic-core.test.ts`)

```typescript
import { test, expect, describe } from "bun:test";
import { deriveChildState, selectEpicCandidates, type EpicChild } from "../src/epic-core";

function child(over: Partial<EpicChild> = {}): EpicChild {
  return { number: 1, title: "t", url: "u", order: 0, body: "", blockedBy: [], state: "blocked",
           sessionId: null, prNumber: null, issueClosed: false, claimed: false, ...over };
}

describe("deriveChildState", () => {
  test("closed → merged", () => expect(deriveChildState(child({ issueClosed: true }), new Set())).toBe("merged"));
  test("session+PR → in-review", () => expect(deriveChildState(child({ sessionId: "s", prNumber: 9 }), new Set())).toBe("in-review"));
  test("session no PR → running", () => expect(deriveChildState(child({ sessionId: "s" }), new Set())).toBe("running"));
  test("blockers closed → ready", () => expect(deriveChildState(child({ blockedBy: [2] }), new Set([2]))).toBe("ready"));
  test("blocker open → blocked", () => expect(deriveChildState(child({ blockedBy: [2] }), new Set())).toBe("blocked"));
});

describe("selectEpicCandidates", () => {
  test("ready, unclaimed, unspawned, in order → Issue[]", () => {
    const kids = [
      child({ number: 320, order: 0, issueClosed: true }),       // merged
      child({ number: 322, order: 1, blockedBy: [320] }),         // ready (320 closed)
      child({ number: 326, order: 2 }),                           // ready root
      child({ number: 323, order: 3, blockedBy: [321] }),         // blocked (321 open)
      child({ number: 321, order: 4, claimed: true }),            // claimed → skip
      child({ number: 999, order: 5, sessionId: "s" }),           // running → skip
    ];
    expect(selectEpicCandidates(kids).map((i) => i.number)).toEqual([322, 326]);
  });
  test("returns Issue-shaped objects carrying the real body", () => {
    const [i] = selectEpicCandidates([child({ number: 5, title: "x", url: "ux", body: "full Notion body" })]);
    expect(i).toEqual({ number: 5, title: "x", body: "full Notion body", url: "ux", labels: [], createdAt: 0 });
  });
});
```

- [ ] **Step 2: Run, verify fail** — `bun test test/epic-core.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/epic-core.ts`**

```typescript
import type { Issue } from "./forge/types";

export type EpicSource = "native" | "markdown";
export type EpicMode = "auto" | "attended";
export type EpicRunStatus = "idle" | "running" | "paused";
export type EpicChildState = "merged" | "in-review" | "running" | "ready" | "blocked";

export interface EpicChild {
  number: number; title: string; url: string; order: number;
  body: string; // real issue body — forwarded as issueRef.body on spawn (drain.ts:329)
  blockedBy: number[]; state: EpicChildState;
  sessionId: string | null; prNumber: number | null;
  issueClosed: boolean; claimed: boolean;
}
export interface EpicRun { repoPath: string; parentIssueNumber: number; mode: EpicMode; status: EpicRunStatus; }
export interface Epic {
  repoPath: string; parentIssueNumber: number; parentTitle: string;
  source: EpicSource; children: EpicChild[]; warnings: string[]; run: EpicRun;
}

/** Child lifecycle state from its issue/session/PR facts. `closed` = closed member #s. */
export function deriveChildState(c: EpicChild, closed: Set<number>): EpicChildState {
  if (c.issueClosed) return "merged";
  if (c.sessionId && c.prNumber != null) return "in-review";
  if (c.sessionId) return "running";
  return c.blockedBy.every((b) => closed.has(b)) ? "ready" : "blocked";
}

/** Dependency-gated spawn candidates (open, unclaimed, unspawned, all blockers closed),
 *  in epic order, shaped as drain's `Issue[]`. Pure: derives the closed set from `children`. */
export function selectEpicCandidates(children: EpicChild[]): Issue[] {
  const closed = new Set(children.filter((c) => c.issueClosed).map((c) => c.number));
  return children
    .filter((c) => !c.issueClosed && !c.claimed && c.sessionId == null && c.blockedBy.every((b) => closed.has(b)))
    .sort((a, b) => a.order - b.order || a.number - b.number)
    // carry the REAL body so the spawned session keeps full issue context (point 4)
    .map((c) => ({ number: c.number, title: c.title, body: c.body, url: c.url, labels: [], createdAt: 0 }));
}
```

- [ ] **Step 4: Run, verify pass** — `bun test test/epic-core.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/epic-core.ts test/epic-core.test.ts
git commit -m "feat(epic): core types, child-state derivation, dependency gating"
```

---

## Task 2: Markdown fallback parser

**Files:** Create `src/epic-parse.ts`; Test `test/epic-parse.test.ts`.

Convention: a fenced ` ```epic-dag ` block, one child per line, `#child <- #blocker, #blocker` for hard edges; order = line order. Membership also harvested from a `- [ ] #N` checklist when no fence (then every child is a root).

- [ ] **Step 1: Write the failing test** (`test/epic-parse.test.ts`)

```typescript
import { test, expect, describe } from "bun:test";
import { parseEpicBody } from "../src/epic-parse";

const FENCED = ["intro","```epic-dag","#320","#326","#321 <- #326","#322 <- #320",
  "#325 <- #320, #322","#323 <- #320, #321, #322","```","- [ ] #320 EFI"].join("\n");

describe("parseEpicBody", () => {
  test("fenced → members in order + edges", () => {
    const r = parseEpicBody(FENCED);
    expect(r.members).toEqual([320, 326, 321, 322, 325, 323]);
    expect(r.order).toEqual([320, 326, 321, 322, 325, 323]);
    expect(r.edges).toContainEqual({ dependent: 323, blocker: 320 });
    expect(r.edges.filter((e) => e.dependent === 325)).toEqual([
      { dependent: 325, blocker: 320 }, { dependent: 325, blocker: 322 }]);
  });
  test("checklist only → members, no edges", () => {
    const r = parseEpicBody("- [ ] #10 a\n- [x] #11 b\n");
    expect(r.members).toEqual([10, 11]); expect(r.edges).toEqual([]);
  });
  test("no structure → empty", () => expect(parseEpicBody("prose")).toEqual({ members: [], order: [], edges: [] }));
});
```

- [ ] **Step 2: Run, verify fail** — `bun test test/epic-parse.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/epic-parse.ts`**

```typescript
export interface EpicEdge { dependent: number; blocker: number; }
export interface ParsedEpic { members: number[]; order: number[]; edges: EpicEdge[]; }

const FENCE_RE = /```epic-dag\s*\n([\s\S]*?)```/;
const LINE_RE = /^#(\d+)\s*(?:<-\s*(.+))?$/;
const CHECK_RE = /^\s*-\s*\[[ xX]\]\s*#(\d+)\b/gm;

export function parseEpicBody(body: string): ParsedEpic {
  const fence = body.match(FENCE_RE);
  if (fence) {
    const order: number[] = [];
    const edges: EpicEdge[] = [];
    for (const raw of fence[1].split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(LINE_RE);
      if (!m) continue;
      const dependent = Number(m[1]);
      order.push(dependent);
      if (m[2]) for (const tok of m[2].split(",")) {
        const b = tok.trim().match(/#(\d+)/);
        if (b) edges.push({ dependent, blocker: Number(b[1]) });
      }
    }
    return { members: [...order], order, edges };
  }
  const members: number[] = [];
  for (const m of body.matchAll(CHECK_RE)) members.push(Number(m[1]));
  return { members, order: [...members], edges: [] };
}
```

- [ ] **Step 4: Run, verify pass** — `bun test test/epic-parse.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/epic-parse.ts test/epic-parse.test.ts
git commit -m "feat(epic): fenced epic-dag + checklist markdown parser"
```

---

## Task 3: Forge native reads/writes

**Files:** Modify `src/forge/types.ts`, `src/forge/github.ts`; Test `test/forge/github-epic.test.ts`.

- [ ] **Step 1: Add to `src/forge/types.ts`**

```typescript
// Per-child native state from the sub_issues REST payload — carries closed/labels/body so
// gating escapes listIssues()'s 200-open-issue cap (reviewer round 3, points 1 & 3).
export interface SubIssueRef {
  number: number; title: string; url: string;
  body: string; closed: boolean; labels: string[];
}
```

Inside `interface GitForge` (near `getIssue?`):

```typescript
  // Epic structure (GitHub only; absent → markdown fallback)
  listSubIssues?(parentNumber: number): Promise<SubIssueRef[]>;
  listBlockedBy?(issueNumber: number): Promise<number[]>;
  issueId?(issueNumber: number): Promise<number | null>;
  addSubIssue?(parentNumber: number, childNumber: number): Promise<void>;
  addBlockedBy?(issueNumber: number, blockerNumber: number): Promise<void>;
```

- [ ] **Step 2: Write the failing test** (`test/forge/github-epic.test.ts`) — mirror `test/forge/github.test.ts`'s `fakeRunner`:

```typescript
import { test, expect, describe } from "bun:test";
import { GithubForge } from "../../src/forge/github";

function fakeRunner(responses: Record<string, string>) {
  const run = async (args: string[]): Promise<string> => {
    const path = args.find((a) => a.startsWith("repos/")) ?? args.slice(0, 2).join(" ");
    if (responses[path] === undefined) throw new Error("gh: 404");
    return responses[path];
  };
  return { run };
}

describe("GithubForge epic reads", () => {
  test("listSubIssues → children in order with native state/labels/body", async () => {
    const { run } = fakeRunner({ "repos/o/r/issues/327/sub_issues": JSON.stringify([
      { number: 320, title: "EFI", html_url: "u320", body: "b320", state: "closed", labels: [{ name: "shepherd:active" }] },
      { number: 326, title: "Ont", html_url: "u326", body: "", state: "open", labels: [] }]) });
    expect(await new GithubForge("o/r", {} as never, run).listSubIssues!(327)).toEqual([
      { number: 320, title: "EFI", url: "u320", body: "b320", closed: true, labels: ["shepherd:active"] },
      { number: 326, title: "Ont", url: "u326", body: "", closed: false, labels: [] }]);
  });
  test("listBlockedBy → numbers", async () => {
    const { run } = fakeRunner({ "repos/o/r/issues/323/dependencies/blocked_by": JSON.stringify([{ number: 320 }, { number: 322 }]) });
    expect(await new GithubForge("o/r", {} as never, run).listBlockedBy!(323)).toEqual([320, 322]);
  });
  test("404 → [] (no native links)", async () => {
    expect(await new GithubForge("o/r", {} as never, fakeRunner({}).run).listSubIssues!(1)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run, verify fail** — `bun test test/forge/github-epic.test.ts` → FAIL.

- [ ] **Step 4: Implement the 5 methods in `src/forge/github.ts`** (inside `class GithubForge`, using `this.run`)

```typescript
  private readonly apiVersion = ["-H", "X-GitHub-Api-Version: 2026-03-10"];

  async listSubIssues(parentNumber: number): Promise<SubIssueRef[]> {
    try {
      const out = await this.run(["api", ...this.apiVersion, `repos/${this.slug}/issues/${parentNumber}/sub_issues`, "--paginate"]);
      return (JSON.parse(out || "[]") as Array<{ number: number; title: string; html_url: string; body?: string; state: string; labels?: Array<{ name: string }> }>)
        .map((i) => ({ number: i.number, title: i.title, url: i.html_url, body: i.body ?? "", closed: i.state === "closed", labels: (i.labels ?? []).map((l) => l.name) }));
    } catch { return []; }
  }
  async listBlockedBy(issueNumber: number): Promise<number[]> {
    try {
      const out = await this.run(["api", ...this.apiVersion, `repos/${this.slug}/issues/${issueNumber}/dependencies/blocked_by`, "--paginate"]);
      return (JSON.parse(out || "[]") as Array<{ number: number }>).map((i) => i.number);
    } catch { return []; }
  }
  async issueId(issueNumber: number): Promise<number | null> {
    try {
      const out = await this.run(["api", `repos/${this.slug}/issues/${issueNumber}`, "--jq", ".id"]);
      const id = Number(out.trim()); return Number.isFinite(id) ? id : null;
    } catch { return null; }
  }
  async addSubIssue(parentNumber: number, childNumber: number): Promise<void> {
    const id = await this.issueId(childNumber);
    if (id == null) throw new Error(`cannot resolve id for #${childNumber}`);
    await this.run(["api", "-X", "POST", ...this.apiVersion, `repos/${this.slug}/issues/${parentNumber}/sub_issues`, "-F", `sub_issue_id=${id}`]);
  }
  async addBlockedBy(issueNumber: number, blockerNumber: number): Promise<void> {
    const id = await this.issueId(blockerNumber);
    if (id == null) throw new Error(`cannot resolve id for #${blockerNumber}`);
    await this.run(["api", "-X", "POST", ...this.apiVersion, `repos/${this.slug}/issues/${issueNumber}/dependencies/blocked_by`, "-F", `issue_id=${id}`]);
  }
```

Add `SubIssueRef` to the `./types` import.

- [ ] **Step 5: Run, verify pass** — `bun test test/forge/github-epic.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/forge/types.ts src/forge/github.ts test/forge/github-epic.test.ts
git commit -m "feat(forge): native sub-issue + issue-dependency reads/writes via gh api"
```

---

## Task 4: Epic assembler

**Files:** Create `src/epic-model.ts`; Test `test/epic-model.test.ts`.

Assembles `Epic` from forge reads + repo `auto` sessions. **Native path:** each child's
`closed`/`claimed`/`body`/`title`/`url` come from the per-child `SubIssueRef` (escapes the
200-cap). **Markdown path only:** those come from the 200-capped `listIssues()` (`openIssues`);
`openIssuesTruncated` arms a warning. Drain calls `selectEpicCandidates(epic.children)` on the result.

- [ ] **Step 1: Write the failing test** (`test/epic-model.test.ts`)

```typescript
import { test, expect, describe } from "bun:test";
import { assembleEpic, type AssembleInput } from "../src/epic-model";

const BASE: AssembleInput = {
  repoPath: "/repo",
  run: { repoPath: "/repo", parentIssueNumber: 327, mode: "auto", status: "running" },
  parent: { number: 327, title: "EFI cluster", body: "" },
  // native per-child state: 320 closed; 322 open + claimed + body — NO listIssues needed
  subIssues: [
    { number: 320, title: "EFI", url: "u320", body: "b320", closed: true, labels: [] },
    { number: 322, title: "effort", url: "u322", body: "effort body", closed: false, labels: ["shepherd:active"] },
  ],
  blockedBy: new Map([[322, [320]]]),
  openIssues: [],            // markdown-only input; ignored on the native path
  openIssuesTruncated: false,
  sessions: [],
};

describe("assembleEpic", () => {
  test("native: order/state/claimed/body from sub-issue payload (no listIssues)", () => {
    const e = assembleEpic(BASE);
    expect(e.source).toBe("native");
    expect(e.children.map((c) => c.number)).toEqual([320, 322]);
    expect(e.children.find((c) => c.number === 320)!.state).toBe("merged");   // closed via native state
    expect(e.children.find((c) => c.number === 322)!.state).toBe("ready");    // blocker 320 closed
    expect(e.children.find((c) => c.number === 322)!.claimed).toBe(true);     // native labels
    expect(e.children.find((c) => c.number === 322)!.body).toBe("effort body");
  });
  test("native gating is correct even when openIssues is empty/over-cap", () => {
    // 320 NOT in openIssues at all — old code would misread it; native state keeps it closed.
    expect(assembleEpic(BASE).children.find((c) => c.number === 322)!.state).toBe("ready");
  });
  test("markdown fallback derives state from openIssues + warns on truncation", () => {
    const e = assembleEpic({ ...BASE, subIssues: [], blockedBy: new Map(),
      parent: { number: 1, title: "p", body: "```epic-dag\n#2\n#3 <- #2\n```" },
      openIssues: [{ number: 2, body: "", labels: [] }, { number: 3, body: "", labels: [] }],
      openIssuesTruncated: true });
    expect(e.source).toBe("markdown");
    expect(e.children.find((c) => c.number === 3)!.state).toBe("blocked");    // #2 open → not closed
    expect(e.warnings.some((w) => w.includes("truncated"))).toBe(true);
  });
  test("non-member + self edges dropped + warned", () => {
    const e = assembleEpic({ ...BASE, blockedBy: new Map([[322, [999, 322]]]) });
    expect(e.children.find((c) => c.number === 322)!.blockedBy).toEqual([]);
    expect(e.warnings.filter((w) => w.includes("blocked_by")).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `bun test test/epic-model.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/epic-model.ts`**

```typescript
import { parseEpicBody } from "./epic-parse";
import { deriveChildState, type Epic, type EpicChild, type EpicRun } from "./epic-core";
import type { SubIssueRef } from "./forge/types";

const ACTIVE_LABEL = "shepherd:active"; // mirror src/drain-core.ts

export interface AssembleSession { id: string; issueNumber: number | null; prNumber: number | null; }
/** Per-member resolved facts, sourced natively (sub-issues) or from capped listIssues (markdown). */
interface Resolved { title: string; url: string; body: string; closed: boolean; claimed: boolean; }
export interface AssembleInput {
  repoPath: string;
  run: EpicRun;
  parent: { number: number; title: string; body: string };
  subIssues: SubIssueRef[];                              // native: carries closed/labels/body per child
  blockedBy: Map<number, number[]>;
  openIssues: { number: number; body: string; labels: string[] }[]; // markdown fallback only (200-capped)
  openIssuesTruncated: boolean;                          // listIssues() hit the 200 cap
  sessions: AssembleSession[];
}

export function assembleEpic(input: AssembleInput): Epic {
  const native = input.subIssues.length > 0;
  const warnings: string[] = [];
  const resolved = new Map<number, Resolved>();
  const edges = new Map<number, number[]>();
  let order: number[];

  if (native) {
    order = input.subIssues.map((s) => s.number);
    for (const s of input.subIssues) {
      resolved.set(s.number, { title: s.title, url: s.url, body: s.body, closed: s.closed, claimed: s.labels.includes(ACTIVE_LABEL) });
    }
    for (const [c, b] of input.blockedBy) edges.set(c, b);
  } else {
    const parsed = parseEpicBody(input.parent.body);
    order = parsed.order;
    const openByNum = new Map(input.openIssues.map((i) => [i.number, i]));
    for (const n of parsed.members) {
      const o = openByNum.get(n);
      // markdown: a member absent from the (capped) open list is treated closed
      resolved.set(n, { title: `#${n}`, url: "", body: o?.body ?? "", closed: !o, claimed: !!o?.labels.includes(ACTIVE_LABEL) });
    }
    for (const e of parsed.edges) edges.set(e.dependent, [...(edges.get(e.dependent) ?? []), e.blocker]);
    if (input.openIssuesTruncated) {
      warnings.push("markdown epic: open-issue list truncated at 200 — closed-state of children beyond the cap may be wrong (premature-spawn risk); add native sub-issue links to make gating safe");
    }
  }

  const members = new Set(order);
  const closed = new Set(order.filter((n) => resolved.get(n)!.closed));
  const sessByIssue = new Map<number, AssembleSession>();
  for (const s of input.sessions) if (s.issueNumber != null) sessByIssue.set(s.issueNumber, s);

  const children: EpicChild[] = order.map((number, idx) => {
    const blockedBy = (edges.get(number) ?? []).filter((b) => {
      if (b === number) { warnings.push(`#${number} blocked_by itself — ignored`); return false; }
      if (!members.has(b)) { warnings.push(`#${number} blocked_by #${b} is outside the epic — ignored`); return false; }
      return true;
    });
    const r = resolved.get(number)!;
    const sess = sessByIssue.get(number) ?? null;
    const child: EpicChild = {
      number, title: r.title, url: r.url, order: idx, body: r.body, blockedBy, state: "blocked",
      sessionId: sess?.id ?? null, prNumber: sess?.prNumber ?? null,
      issueClosed: r.closed, claimed: r.claimed,
    };
    child.state = deriveChildState(child, closed);
    return child;
  });

  return { repoPath: input.repoPath, parentIssueNumber: input.parent.number, parentTitle: input.parent.title,
           source: native ? "native" : "markdown", children, warnings, run: input.run };
}
```

- [ ] **Step 4: Run, verify pass** — `bun test test/epic-model.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/epic-model.ts test/epic-model.test.ts
git commit -m "feat(epic): assemble epic model (native-first, markdown fallback, edge hygiene)"
```

---

# PHASE 2 — Drain integration

## Task 5: `epic_run` store

**Files:** Modify `src/store.ts`; Test `test/epic-store.test.ts`.

- [ ] **Step 1: Write the failing test** (`test/epic-store.test.ts`)

```typescript
import { test, expect, describe } from "bun:test";
import { SessionStore } from "../src/store";

describe("epic_run", () => {
  test("absent until set", () => expect(new SessionStore(":memory:").getEpicRun("/repo")).toBeNull());
  test("set+get round-trips (one per repo)", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun({ repoPath: "/repo", parentIssueNumber: 327, mode: "attended", status: "running" });
    expect(s.getEpicRun("/repo")).toEqual({ repoPath: "/repo", parentIssueNumber: 327, mode: "attended", status: "running" });
    s.setEpicRun({ repoPath: "/repo", parentIssueNumber: 400, mode: "auto", status: "idle" }); // replaces
    expect(s.getEpicRun("/repo")!.parentIssueNumber).toBe(400);
  });
  test("listRunningEpics → running or paused", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun({ repoPath: "/a", parentIssueNumber: 1, mode: "auto", status: "running" });
    s.setEpicRun({ repoPath: "/b", parentIssueNumber: 2, mode: "auto", status: "idle" });
    expect(s.listRunningEpics().map((e) => e.repoPath)).toEqual(["/a"]);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `bun test test/epic-store.test.ts` → FAIL.

- [ ] **Step 3: Implement in `src/store.ts`.** In the constructor near the other `CREATE TABLE`s:

```typescript
this.db.run(`CREATE TABLE IF NOT EXISTS epic_run (
  repoPath TEXT PRIMARY KEY, parentIssueNumber INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'auto', status TEXT NOT NULL DEFAULT 'idle', updatedAt INTEGER NOT NULL)`);
```

Methods (import `EpicRun` from `./epic-core`):

```typescript
getEpicRun(repoPath: string): EpicRun | null {
  return (this.db.query(`SELECT repoPath, parentIssueNumber, mode, status FROM epic_run WHERE repoPath = ?`)
    .get(repoPath) as EpicRun | null) ?? null;
}
setEpicRun(r: EpicRun): void {
  this.db.run(`INSERT INTO epic_run (repoPath, parentIssueNumber, mode, status, updatedAt) VALUES (?,?,?,?,?)
    ON CONFLICT(repoPath) DO UPDATE SET parentIssueNumber=excluded.parentIssueNumber, mode=excluded.mode, status=excluded.status, updatedAt=excluded.updatedAt`,
    [r.repoPath, r.parentIssueNumber, r.mode, r.status, Date.now()]);
}
listRunningEpics(): EpicRun[] {
  return this.db.query(`SELECT repoPath, parentIssueNumber, mode, status FROM epic_run WHERE status IN ('running','paused')`).all() as EpicRun[];
}
```

- [ ] **Step 4: Run, verify pass** — `bun test test/epic-store.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/epic-store.test.ts
git commit -m "feat(epic): epic_run table (one active epic per repo)"
```

---

## Task 6: drain-core attended gate

**Files:** Modify `src/drain-core.ts`; Test extend `test/drain-core.test.ts`.

- [ ] **Step 1: Write the failing test** (append to `test/drain-core.test.ts`) — reuse its existing `state()`/`issue()` helpers; the new fields default false:

```typescript
import { computeNext } from "../src/drain-core";

describe("epic attended gate", () => {
  test("attended + not approved → awaiting_approval(detail=next#)", () => {
    const d = computeNext(state({ candidates: [issue(322)], epicAttended: true, epicApprovedNext: false }));
    expect(d).toEqual({ kind: "hold", reason: { code: "awaiting_approval", detail: "322" } });
  });
  test("attended + approved → spawn", () => {
    const d = computeNext(state({ candidates: [issue(322)], epicAttended: true, epicApprovedNext: true }));
    expect(d).toEqual({ kind: "spawn", issue: expect.objectContaining({ number: 322 }) });
  });
  test("label mode (epicAttended false) unaffected → spawn", () => {
    expect(computeNext(state({ candidates: [issue(322)] })).kind).toBe("spawn");
  });
});
```

> Update the local `state()` helper in this test file to include `epicAttended: false, epicApprovedNext: false` defaults so existing cases keep compiling.

- [ ] **Step 2: Run, verify fail** — `bun test test/drain-core.test.ts` → FAIL.

- [ ] **Step 3: Implement in `src/drain-core.ts`.** Add `"awaiting_approval"` to `HoldReason.code` (line ~27). Add to `DrainRepoState`:

```typescript
  /** Epic mode: when true, hold each spawn until the operator approves it. */
  epicAttended: boolean;
  /** Epic mode: operator approved the next spawn (consumed on spawn). */
  epicApprovedNext: boolean;
```

In `computeNext`, immediately before the existing spawn branch (after cap/trouble/usage holds, where it currently picks the next candidate), insert:

```typescript
  const epicNext = state.candidates.find((c) => !state.mappedIssueNumbers.has(c.number));
  if (epicNext && state.epicAttended && !state.epicApprovedNext) {
    return { kind: "hold", reason: { code: "awaiting_approval", detail: String(epicNext.number) } };
  }
```

> Read the real spawn branch first: it already computes the next unmapped candidate. Reuse that variable rather than duplicating the `.find` if the existing code exposes it; the snippet shows intent.

- [ ] **Step 4: Run, verify pass** — `bun test test/drain-core.test.ts` → PASS (epic + all prior cases).

- [ ] **Step 5: Commit**

```bash
git add src/drain-core.ts test/drain-core.test.ts
git commit -m "feat(epic): drain-core attended gate (awaiting_approval hold)"
```

---

## Task 7: drain `buildState` epic branch + approve + emit

**Files:** Modify `src/drain.ts`, `src/index.ts`; Test extend `test/drain.test.ts`.

- [ ] **Step 1: Write the failing test** (`test/drain.test.ts`, new `describe`) — a repo with a running auto epic spawns the dependency-free root once; a paused epic spawns nothing; attended-unapproved holds. Reuse the file's existing `DrainService` deps harness + `fakeForge`, extended with `listSubIssues`/`listBlockedBy` and a store seeded via `setEpicRun`.

```typescript
describe("drain epic mode", () => {
  test("running auto epic: roots are candidates, spawns one, carries body (no listIssues needed)", async () => {
    const store = new SessionStore(":memory:");
    store.setEpicRun({ repoPath: REPO, parentIssueNumber: 327, mode: "auto", status: "running" });
    const created: CreateSessionInput[] = [];
    const forge = fakeForge({
      issues: [], // deliberately empty: native path must NOT depend on listIssues (200-cap escape)
      subIssues: [{ number: 320, title: "EFI", url: "u320", body: "Notion-derived spec for #320", closed: false, labels: [] }],
      blockedBy: new Map(),
    });
    const drain = new DrainService(deps({ store, forge, onCreate: (i) => created.push(i) }));
    await drain.tick();
    expect(created.map((c) => c.issueRef?.number)).toEqual([320]);
    expect(created[0].auto).toBe(true);
    expect(created[0].issueRef?.body).toBe("Notion-derived spec for #320"); // point 4: context from sub-issue payload
  });
  test("gated child stays blocked until its native blocker is closed (point 1, >200-issue safety)", async () => {
    // #320 closed natively, #322 blocked_by #320, #322 open → #322 ready; #323 blocked_by #322 (open) → not spawned.
    // listIssues empty → proves gating uses native state, not open-list membership.
  });
  test("paused epic spawns nothing", async () => { /* status: 'paused' → created empty */ });
  test("attended epic without approve holds; approveEpicNext then spawns", async () => { /* … */ });
  test("running epic sets DrainStatus.epicParent (point 6)", async () => {
    const statuses: DrainStatus[] = [];
    /* seed running epic; deps emitStatus → statuses.push; after tick: */
    /* expect(statuses.at(-1)!.epicParent).toBe(327); */
  });
  test("emitEpic fires once per change, not per pump iteration (point 4)", async () => {
    const emitted: number[] = [];
    /* deps emitEpic → emitted.push(epic.parentIssueNumber); after one tick with a single ready root */
    /* and no further change, assert emitted.length === 1 (not ~100). */
  });
});
```

- [ ] **Step 2: Run, verify fail** — `bun test test/drain.test.ts` → FAIL.

- [ ] **Step 3: Add `assembleEpic` wiring + the `buildState` epic branch in `src/drain.ts`.** Add a private helper that reads forge structure + sessions and calls the model assembler:

**Point 5 — cache the O(children) `gh` structure reads.** `buildState` runs up to 100×/pump
(`drain.ts:202`); the epic structure (parent body, sub-issues, each child's `blocked_by`) is
invariant within a pump, so cache it with the same TTL as the label path's `issuesCache`
(`drain.ts:151-156`, default `issuesTtlMs = 10_000`). On the native path NO `listIssues()` call
happens at all — per-child `closed`/`labels`/`body` ride the cached `sub_issues` payload
(reviewer round 3); `listIssues()` is read (capped) only for the markdown fallback. Run
status/mode are NOT cached (read fresh from `getEpicRun` each `buildState`), so Start/Pause/mode
flips reflect immediately; newly-imported links appear within `issuesTtlMs`.

```typescript
import { assembleEpic } from "./epic-model";
import { selectEpicCandidates, type Epic, type EpicRun } from "./epic-core";
import type { Issue, SubIssueRef } from "./forge/types";

interface EpicStructure { parent: Issue | null; subIssues: SubIssueRef[]; blockedBy: Map<number, number[]>; }
private epicStructureCache = new Map<string, { reads: EpicStructure; ts: number }>();

/** Cached forge structure reads (parent + sub-issues + each child's blocked_by). */
private async epicStructure(repoPath: string, run: EpicRun): Promise<EpicStructure | null> {
  const cached = this.epicStructureCache.get(repoPath);
  if (cached && this.now() - cached.ts < this.issuesTtlMs) return cached.reads;
  const forge = this.deps.resolveForge(repoPath);
  if (!forge) return null;
  const parent = (await forge.getIssue?.(run.parentIssueNumber)) ?? null;
  const subIssues = (await forge.listSubIssues?.(run.parentIssueNumber)) ?? [];
  const blockedBy = new Map<number, number[]>();
  for (const s of subIssues) blockedBy.set(s.number, (await forge.listBlockedBy?.(s.number)) ?? []);
  const reads: EpicStructure = { parent, subIssues, blockedBy };
  this.epicStructureCache.set(repoPath, { reads, ts: this.now() });
  return reads;
}

private async buildEpic(repoPath: string, run: EpicRun): Promise<Epic | null> {
  const struct = await this.epicStructure(repoPath, run);
  if (!struct) return null;
  const native = struct.subIssues.length > 0;
  // Native path: per-child state comes from sub_issues — NO listIssues (escapes the 200 cap).
  // Markdown path only: read the (200-capped) open list and flag possible truncation.
  let openIssues: { number: number; body: string; labels: string[] }[] = [];
  let openIssuesTruncated = false;
  if (!native) {
    const open = await this.listIssues(repoPath); // existing 10s issuesCache; Issue carries body
    openIssues = open.map((i) => ({ number: i.number, body: i.body, labels: i.labels }));
    openIssuesTruncated = open.length >= 200; // listIssues hard cap, src/forge/github.ts:111-115
  }
  const prSnap = this.deps.prCache.snapshot();
  const sessions = this.deps.store.list(repoPath)
    .filter((x) => x.auto && x.issueNumber != null && x.status !== "archived")
    .map((x) => ({ id: x.id, issueNumber: x.issueNumber, prNumber: prSnap[x.id]?.prNumber ?? null }));
  return assembleEpic({
    repoPath, run,
    parent: { number: run.parentIssueNumber, title: struct.parent?.title ?? `#${run.parentIssueNumber}`, body: struct.parent?.body ?? "" },
    subIssues: struct.subIssues, blockedBy: struct.blockedBy,
    openIssues, openIssuesTruncated,
    sessions,
  });
}

/** Emit the epic only when the UI-relevant signature changes (not 100×/pump). */
private lastEpicSig = new Map<string, string>();
private emitEpicIfChanged(repoPath: string, epic: Epic): void {
  const sig = JSON.stringify({ st: epic.run.status, md: epic.run.mode,
    kids: epic.children.map((c) => [c.number, c.state, c.prNumber] as const), warn: epic.warnings.length });
  if (this.lastEpicSig.get(repoPath) === sig) return;
  this.lastEpicSig.set(repoPath, sig);
  this.deps.emitEpic?.(epic);
}
```

In `buildState`, replace the candidate/enabled computation (`drain.ts:130-134`) with:

```typescript
const epicRun = this.deps.store.getEpicRun(repoPath);
let candidates: Issue[] = [];
let epicAttended = false;
let epicParent: number | null = null; // point 6
if (epicRun && (epicRun.status === "running" || epicRun.status === "paused")) {
  const epic = await this.buildEpic(repoPath, epicRun);
  if (epic) {
    this.emitEpicIfChanged(repoPath, epic); // emit-on-change, not 100×/pump (point 4)
    epicParent = epicRun.parentIssueNumber;
    if (epicRun.status === "running") candidates = selectEpicCandidates(epic.children);
    epicAttended = epicRun.mode === "attended";
  }
} else if (cfg.autoDrainEnabled) {
  candidates = selectCandidates(await this.listIssues(repoPath), cfg.autoLabel);
}
const enabled = epicRun ? epicRun.status === "running" : cfg.autoDrainEnabled;
// include in the returned state object:
//   candidates, epicAttended, epicApprovedNext: this.approvedNext.has(repoPath)
// and add `epicParent` to the emitted DrainStatus (point 6): add `epicParent: number | null`
// to the DrainStatus interface (drain.ts:18-34) and set it where snapshot()/emitStatus builds it.
```

Add the approval set + method + spawn consumption:

```typescript
private approvedNext = new Set<string>();
approveEpicNext(repoPath: string): void { this.approvedNext.add(repoPath); }
// in doSpawn, after a successful epic spawn: this.approvedNext.delete(repoPath);
```

Update the three pump-trigger guards (`drain.ts:440,447,456`) from `autoDrainEnabled` to:

```typescript
const er = this.deps.store.getEpicRun(repoPath);
if (!(cfg.autoDrainEnabled || er?.status === "running")) return; // or `continue;` at :456
```

Add `emitEpic?: (epic: Epic) => void;` to `DrainDeps`.

- [ ] **Step 4: Wire `emitEpic` in `src/index.ts`** — in the `new DrainService({...})` deps: `emitEpic: (epic) => events.emit("epic:update", epic),`. No new service is constructed.

- [ ] **Step 5: Run, verify pass** — `bun test test/drain.test.ts` → PASS.

- [ ] **Step 6: Full root check** — `bun run lint && bun test ./test` → green.

- [ ] **Step 7: Commit**

```bash
git add src/drain.ts src/index.ts test/drain.test.ts
git commit -m "feat(epic): drain epic-mode candidate source + approveEpicNext + epic:update"
```

---

# PHASE 3 — Importer

## Task 8: Importer

**Files:** Create `src/epic-import.ts`; Test `test/epic-import.test.ts`.

- [ ] **Step 1: Write the failing test** (`test/epic-import.test.ts`)

```typescript
import { test, expect, describe } from "bun:test";
import { importEpicLinks } from "../src/epic-import";

function fakeForge(existingSubs: number[], existingBy: Map<number, number[]>) {
  const subAdds: Array<[number, number]> = [], depAdds: Array<[number, number]> = [];
  return { forge: {
    listSubIssues: async () => existingSubs.map((n) => ({ number: n, title: `#${n}`, url: "" })),
    listBlockedBy: async (n: number) => existingBy.get(n) ?? [],
    addSubIssue: async (p: number, c: number) => { subAdds.push([p, c]); },
    addBlockedBy: async (i: number, b: number) => { depAdds.push([i, b]); },
  } as never, subAdds, depAdds };
}
const BODY = "```epic-dag\n#320\n#326\n#322 <- #320\n```";

describe("importEpicLinks", () => {
  test("creates missing", async () => {
    const f = fakeForge([], new Map());
    const r = await importEpicLinks(f.forge, 327, BODY);
    expect(f.subAdds).toEqual([[327, 320], [327, 326], [327, 322]]);
    expect(f.depAdds).toEqual([[322, 320]]);
    expect(r).toEqual({ subIssuesAdded: 3, dependenciesAdded: 1, skipped: 0 });
  });
  test("idempotent", async () => {
    const f = fakeForge([320, 326, 322], new Map([[322, [320]]]));
    const r = await importEpicLinks(f.forge, 327, BODY);
    expect(f.subAdds).toEqual([]); expect(f.depAdds).toEqual([]); expect(r.skipped).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `bun test test/epic-import.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/epic-import.ts`**

```typescript
import { parseEpicBody } from "./epic-parse";
import type { GitForge } from "./forge/types";

export interface ImportResult { subIssuesAdded: number; dependenciesAdded: number; skipped: number; }

export async function importEpicLinks(forge: GitForge, parentNumber: number, body: string): Promise<ImportResult> {
  if (!forge.addSubIssue || !forge.addBlockedBy || !forge.listSubIssues || !forge.listBlockedBy)
    throw new Error("forge does not support native epic links");
  const parsed = parseEpicBody(body);
  const members = new Set(parsed.members);
  const result: ImportResult = { subIssuesAdded: 0, dependenciesAdded: 0, skipped: 0 };

  const existingSubs = new Set((await forge.listSubIssues(parentNumber)).map((s) => s.number));
  for (const n of parsed.order) {
    if (existingSubs.has(n)) { result.skipped++; continue; }
    await forge.addSubIssue(parentNumber, n); result.subIssuesAdded++;
  }
  const byChild = new Map<number, number[]>();
  for (const e of parsed.edges) {
    if (e.blocker === e.dependent || !members.has(e.blocker)) continue;
    byChild.set(e.dependent, [...(byChild.get(e.dependent) ?? []), e.blocker]);
  }
  for (const [child, blockers] of byChild) {
    const existing = new Set(await forge.listBlockedBy(child));
    for (const b of blockers) {
      if (existing.has(b)) { result.skipped++; continue; }
      await forge.addBlockedBy(child, b); result.dependenciesAdded++;
    }
  }
  return result;
}
```

- [ ] **Step 4: Run, verify pass** — `bun test test/epic-import.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/epic-import.ts test/epic-import.test.ts
git commit -m "feat(epic): idempotent markdown→native-links importer"
```

---

# PHASE 4 — Server

## Task 9: Epic API routes + events

**Files:** Modify `src/server.ts`, `src/validate.ts`; Test `test/epic-server.test.ts`.

Routes (all `repo` via `safeRepoDir`, mirroring `/api/drain`): `GET /api/epics`, `GET /api/epic`, `PUT /api/epic`, `POST /api/epic/approve-next`, `POST /api/epic/import`. The drain instance is reachable via `deps.drain` (already wired for `/api/drain`); add `assembleEpic`-backed assembly by calling a small `deps.drain.assembleEpic(repo, run)` exposed publicly, or re-assemble in the route from forge reads.

- [ ] **Step 1: Add `validateEpicRunPatch` to `src/validate.ts`** (mirror `validateBuildSteps`)

```typescript
export function validateEpicRunPatch(v: unknown): { mode?: "auto" | "attended"; status?: "idle" | "running" | "paused" } | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const out: { mode?: "auto" | "attended"; status?: "idle" | "running" | "paused" } = {};
  if ("mode" in o) { if (o.mode !== "auto" && o.mode !== "attended") return null; out.mode = o.mode; }
  if ("status" in o) { if (o.status !== "idle" && o.status !== "running" && o.status !== "paused") return null; out.status = o.status; }
  return out;
}
```

- [ ] **Step 2: Write the failing test** (`test/epic-server.test.ts`) — exercise `validateEpicRunPatch` (valid/invalid) and the PUT handler: invalid body → 400; valid `{status:"running"}` persists via `setEpicRun` and emits `epic:update`. Mirror the existing server route-test harness.

- [ ] **Step 3: Run, verify fail.**

- [ ] **Step 4: Add the route handlers in `src/server.ts`** following `/api/drain` + `putBuildQueue`. Expose `assembleEpic` publicly on `DrainService` (rename `buildEpic` → public `assembleEpic`) so `GET /api/epic` and the PUT response reuse it. PUT merges the patch onto `getEpicRun(repo) ?? { repoPath, parentIssueNumber: parent, mode: "auto", status: "idle" }`, persists, re-assembles, `events?.emit("epic:update", epic)`, returns the `Epic`. `import` reads the parent body via `forge.getIssue(parent)` then `importEpicLinks`. `approve-next` calls `deps.drain.approveEpicNext(dir)` then `deps.drain.tick()`.

- [ ] **Step 5: Run, verify pass** — `bun test test/epic-server.test.ts` → PASS.

- [ ] **Step 6: Whole suite + lint** — `bun run lint && bun test ./test` → green.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/validate.ts test/epic-server.test.ts
git commit -m "feat(epic): epic API routes (list/get/settings/approve-next/import) + epic:update"
```

---

# PHASE 5 — UI

## Task 10: UI types, api client, store

**Files:** Modify `ui/src/lib/types.ts`, `ui/src/lib/api.ts`, `ui/src/lib/store.svelte.ts`, `ui/src/routes/+layout.svelte`.

- [ ] **Step 1: Mirror types in `ui/src/lib/types.ts`** — `EpicChildState`, `EpicChild`, `EpicMode`, `EpicRunStatus`, `EpicRun`, `Epic` (structurally identical to `src/epic-core.ts`) + `EpicSummary { parentIssueNumber; parentTitle; total; merged; status: EpicRunStatus }`. Add to `WsEvent`: `| { event: "epic:update"; data: Epic }`.

- [ ] **Step 2: Add api client calls in `ui/src/lib/api.ts`** (mirror `getDrainQueue`/`updateRepoConfig`)

```typescript
export async function getEpics(repoPath: string): Promise<EpicSummary[]> {
  return getJson(`/api/epics?repo=${encodeURIComponent(repoPath)}`, "get epics");
}
export async function getEpic(repoPath: string, parent: number): Promise<Epic> {
  return getJson(`/api/epic?repo=${encodeURIComponent(repoPath)}&parent=${parent}`, "get epic");
}
export async function updateEpic(repoPath: string, parent: number, patch: Partial<Pick<EpicRun, "mode" | "status">>): Promise<Epic> {
  const r = await fetch(`/api/epic?repo=${encodeURIComponent(repoPath)}&parent=${parent}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  if (!r.ok) throw await failed(r, "update epic"); return r.json();
}
export async function approveEpicNext(repoPath: string, parent: number): Promise<Epic> {
  const r = await fetch(`/api/epic/approve-next?repo=${encodeURIComponent(repoPath)}&parent=${parent}`, { method: "POST" });
  if (!r.ok) throw await failed(r, "approve next"); return r.json();
}
export async function importEpic(repoPath: string, parent: number): Promise<{ subIssuesAdded: number; dependenciesAdded: number; skipped: number }> {
  const r = await fetch(`/api/epic/import?repo=${encodeURIComponent(repoPath)}&parent=${parent}`, { method: "POST" });
  if (!r.ok) throw await failed(r, "import epic"); return r.json();
}
```

- [ ] **Step 3: Store + handler** — `ui/src/lib/store.svelte.ts`: `epics = $state<Record<string, Epic>>({})` keyed `${repoPath}#${parent}` + `setEpic(e: Epic)` (`this.epics = { ...this.epics, [`${e.repoPath}#${e.parentIssueNumber}`]: e }`). In `+layout.svelte` subscribe `epic:update` → `herd.setEpic(data)`.

- [ ] **Step 4: Verify** — `cd ui && bun run check` → no type errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/types.ts ui/src/lib/api.ts ui/src/lib/store.svelte.ts ui/src/routes/+layout.svelte
git commit -m "feat(ui): epic types, api client, store wiring"
```

---

## Task 11: EpicPanel + helpers

**Files:** Create `ui/src/lib/components/epic-panel.ts`, `ui/src/lib/components/EpicPanel.svelte`; Test `ui/src/lib/components/epic-panel.test.ts`.

- [ ] **Step 1: Write the failing helper test** (`epic-panel.test.ts`, vitest)

```typescript
import { describe, it, expect } from "vitest";
import { chipFor, progress } from "./epic-panel";
describe("epic-panel helpers", () => {
  it("chipFor maps state → tone", () => {
    expect(chipFor("merged").tone).toBe("done");
    expect(chipFor("ready").tone).toBe("ready");
    expect(chipFor("blocked").tone).toBe("muted");
    expect(chipFor("in-review").tone).toBe("review");
  });
  it("progress counts merged/total", () => {
    expect(progress([{ state: "merged" }, { state: "ready" }] as never)).toEqual({ merged: 1, total: 2 });
  });
});
```

- [ ] **Step 2: Run, verify fail** — `cd ui && bun run test epic-panel` → FAIL.

- [ ] **Step 3: Implement `ui/src/lib/components/epic-panel.ts`**

```typescript
import type { EpicChild, EpicChildState } from "$lib/types";
export type ChipTone = "done" | "review" | "running" | "ready" | "muted";
const TONES: Record<EpicChildState, ChipTone> = { merged: "done", "in-review": "review", running: "running", ready: "ready", blocked: "muted" };
export function chipFor(state: EpicChildState): { key: EpicChildState; tone: ChipTone } { return { key: state, tone: TONES[state] }; }
export function progress(children: Pick<EpicChild, "state">[]): { merged: number; total: number } {
  return { merged: children.filter((c) => c.state === "merged").length, total: children.length };
}
```

- [ ] **Step 4: Run, verify pass** — `cd ui && bun run test epic-panel` → PASS.

- [ ] **Step 5: Implement `EpicPanel.svelte`** — props `{ repoPath, parent, epic }`; render the ordered child list with state chips (tones → `--status-*`/`--color-*` tokens, **no literals**), the blocker list for blocked children, and controls (Start/Pause, mode toggle, Approve-next in attended, Import-structure when `source === "markdown"`). All strings via `m.*`. Use the `.gbtn`/`.badge` recipes from `/design-system`; replace any token guess with the real `--status-*` name after consulting that page.

```svelte
<script lang="ts">
  import type { Epic } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { updateEpic, approveEpicNext, importEpic } from "$lib/api";
  import { chipFor, progress } from "./epic-panel";
  let { repoPath, parent, epic }: { repoPath: string; parent: number; epic: Epic } = $props();
  const p = $derived(progress(epic.children));
  const running = $derived(epic.run.status === "running");
</script>
<div class="epic">
  <div class="epic-head">
    <span class="badge">{m.epic_progress({ merged: p.merged, total: p.total })}</span>
    {#if epic.source === "markdown"}<button class="gbtn" onclick={() => importEpic(repoPath, parent)}>{m.epic_import()}</button>{/if}
  </div>
  <ul class="epic-children">
    {#each epic.children as c (c.number)}
      {@const chip = chipFor(c.state)}
      <li class="epic-child">
        <a class="num" href={c.url} target="_blank" rel="noreferrer">#{c.number}</a>
        <span class="title">{c.title}</span>
        <span class="chip {chip.tone}">{m[`epic_state_${chip.key.replace("-", "_")}`]()}</span>
        {#if c.state === "blocked"}<span class="deps">{m.epic_blocked_on({ deps: c.blockedBy.map((n) => `#${n}`).join(", ") })}</span>{/if}
      </li>
    {/each}
  </ul>
  {#if epic.warnings.length}<p class="warn">{m.epic_warnings({ count: epic.warnings.length })}</p>{/if}
  <div class="epic-controls">
    {#if running}<button class="gbtn" onclick={() => updateEpic(repoPath, parent, { status: "paused" })}>{m.epic_pause()}</button>
    {:else}<button class="gbtn" onclick={() => updateEpic(repoPath, parent, { status: "running" })}>{m.epic_start()}</button>{/if}
    <button class="gbtn" onclick={() => updateEpic(repoPath, parent, { mode: epic.run.mode === "auto" ? "attended" : "auto" })}>{epic.run.mode === "auto" ? m.epic_mode_auto() : m.epic_mode_attended()}</button>
    {#if epic.run.mode === "attended" && running}<button class="gbtn primary" onclick={() => approveEpicNext(repoPath, parent)}>{m.epic_approve_next()}</button>{/if}
  </div>
</div>
<style>
  /* tokens only — see /design-system; replace --status-review with the real review token */
  .chip.done { color: var(--status-done); }
  .chip.ready { color: var(--color-green); }
  .chip.review { color: var(--color-accent); }
  .chip.muted { color: var(--color-text-muted); }
</style>
```

- [ ] **Step 6: Check + helper tests** — `cd ui && bun run check && bun run test epic-panel` → green.

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/components/EpicPanel.svelte ui/src/lib/components/epic-panel.ts ui/src/lib/components/epic-panel.test.ts
git commit -m "feat(ui): EpicPanel — ordered child list + run controls"
```

---

## Task 12: Backlog integration — badge + expansion

**Files:** Modify `ui/src/lib/components/IssuesPanel.svelte`; Test extend `ui/src/lib/components/issues-panel.test.ts`.

- [ ] **Step 1: Detect epics.** After `listIssues`, call `getEpics(repoPath)` → `Map<number, EpicSummary>`. An issue with an entry shows an `EPIC merged/total` badge + a disclosure toggle.

- [ ] **Step 2: Render.** In the issue row when `epicByNumber.has(issue.number)`:

```svelte
{#if epicByNumber.has(issue.number)}
  <button class="badge epic" aria-expanded={expanded.has(issue.number)} onclick={() => toggle(issue.number)}>
    {m.epic_badge({ merged: epicByNumber.get(issue.number)!.merged, total: epicByNumber.get(issue.number)!.total })}
  </button>
{/if}
...
{#if expanded.has(issue.number)}
  {@const live = herd.epics[`${repoPath}#${issue.number}`]}
  {#if live}
    <EpicPanel {repoPath} parent={issue.number} epic={live} />
  {:else}
    {#await getEpic(repoPath, issue.number) then epic}
      <EpicPanel {repoPath} parent={issue.number} {epic} />
    {/await}
  {/if}
{/if}
```

Prefer the live store value (`epic:update`) once present so the open panel re-renders on changes.

- [ ] **Step 3: Precedence indicator (point 6 — hard gate).** Mirror `epicParent: number | null`
  onto the UI `DrainStatus` type (`ui/src/lib/types.ts`). In `AutomationPanel.svelte` (and the
  `RepoSwitcher.svelte` chip), when the repo's `DrainStatus.epicParent` is non-null, render an
  unmistakable banner and show the label-drain toggle as overridden:

```svelte
{#if drain?.epicParent != null}
  <div class="epic-mode-banner" role="status">{m.epic_mode_active({ parent: `#${drain.epicParent}` })}</div>
{/if}
<!-- the existing label-drain toggle below is rendered disabled/dimmed when drain?.epicParent != null -->
```

  Write a browser/component test asserting the banner renders when `epicParent` is set and is
  absent when null, and that the label-drain toggle reads as suspended while it is set.

- [ ] **Step 4: Verify** — `cd ui && bun run check && bun run test` → green. Manual (vite proxy + agent-browser, per memory): on a fixture/native-linked parent, confirm `EPIC 0/n` badge → expands to ordered children with correct chips; with the epic started, the repo's automation panel shows "Epic mode · #N — label-drain suspended" and the label-drain toggle reads overridden.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/IssuesPanel.svelte ui/src/lib/components/AutomationPanel.svelte ui/src/lib/components/RepoSwitcher.svelte ui/src/lib/types.ts ui/src/lib/components/issues-panel.test.ts
git commit -m "feat(ui): backlog epic badge/expansion + epic-mode precedence indicator"
```

---

## Task 13: i18n, feature catalog, final verification

**Files:** Modify `ui/messages/en.json`, `ui/messages/de.json`, `ui/src/lib/feature-announcements.ts`.

- [ ] **Step 1: Add every new key to BOTH catalogs** (parity-gated). Keys: `epic_progress`, `epic_badge`, `epic_import`, `epic_start`, `epic_pause`, `epic_mode_auto`, `epic_mode_attended`, `epic_mode_active`, `epic_approve_next`, `epic_blocked_on`, `epic_warnings`, `epic_state_merged`, `epic_state_in_review`, `epic_state_running`, `epic_state_ready`, `epic_state_blocked`, plus `feat_epic_runner_title`/`feat_epic_runner_body`. EN example:

```json
"epic_progress": "Epic {merged}/{total}",
"epic_badge": "EPIC {merged}/{total}",
"epic_import": "Import structure",
"epic_start": "Start epic",
"epic_pause": "Pause",
"epic_mode_auto": "Auto-advance",
"epic_mode_attended": "Attended",
"epic_mode_active": "Epic mode · {parent} — label-drain suspended",
"epic_approve_next": "Approve next",
"epic_blocked_on": "blocked · {deps}",
"epic_warnings": "{count} edge warning(s)",
"epic_state_merged": "merged",
"epic_state_in_review": "in review",
"epic_state_running": "running",
"epic_state_ready": "ready",
"epic_state_blocked": "blocked"
```

DE counterparts (e.g. `"epic_start": "Epic starten"`, `"epic_state_in_review": "in Prüfung"`).

- [ ] **Step 2: Parity gate** — `cd ui && bun run check:i18n` → PASS.

- [ ] **Step 3: One feature-catalog entry** in `ui/src/lib/feature-announcements.ts` (NEXT unreleased version, not `package.json` — see memory):

```typescript
{ id: "epic-runner", sinceVersion: "<next-unreleased>", titleKey: "feat_epic_runner_title", bodyKey: "feat_epic_runner_body" },
```

- [ ] **Step 4: Full verification — both halves.**

```bash
bun run lint && bun test ./test
cd ui && bun install && bun run check && bun run check:i18n && bun run test
```

Then `bunx fallow audit --base origin/main --fail-on-issues` (per the fallow pre-push gate memory) — fix new dead code / cognitive-complexity > 15 by extracting helpers.

- [ ] **Step 5: Commit**

```bash
git add ui/messages/en.json ui/messages/de.json ui/src/lib/feature-announcements.ts
git commit -m "feat(epic): i18n parity + feature-catalog entry"
```

---

## Self-review (completed during planning)

- **Spec coverage:** native+markdown source (T2,T3,T4), dependency gating (T1,T7), one-task-PR-per-issue via drain spawn (T7), attended/auto autonomy (T6,T7,T9), importer (T8), Backlog-embedded UI (T11,T12), i18n+catalog+tokens (T11,T13), Gitea→markdown-only (optional forge methods, T3). All spec sections map to tasks.
- **Type consistency:** `Epic`/`EpicChild`/`EpicRun`/`EpicChildState`/`EpicMode`/`EpicRunStatus` defined once in `src/epic-core.ts`, mirrored in `ui/src/lib/types.ts`; `deriveChildState`/`selectEpicCandidates`/`assembleEpic`/`importEpicLinks`/`parseEpicBody`/`validateEpicRunPatch` signatures stable across consumers. `selectEpicCandidates` returns `Issue[]` to match `DrainRepoState.candidates`.
- **Collision review (reviewer points 1-3,6):** no sibling harness — epic children are drain's `s.auto` sessions; one pump/pool/cap/owner. Full-auto children advance off merge→recompute (retire gate skips them, `drain-core.ts:173`); non-full-auto retire normally. No second `service.archive` caller.
- **Flagged for implementer (not placeholders):** the exact spot to insert the attended gate in `computeNext` (reuse its existing next-candidate variable); the real `--status-*` review token (consult `/design-system`); confirm `Issue`/`GitState` field names from `src/forge/types.ts` when wiring `buildEpic`.

## Risks & success criteria

See `.shepherd-plan.md` (authoritative): Limitations, Risks, and the six Success criteria (fixture-based criteria 2 & 5, concrete dependency-gating language in criterion 3).
