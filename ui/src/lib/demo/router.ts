// State-backed demo API router. Maps every intercepted `/api/**` request to a
// Response drawn from the in-memory `demoState`. The POLISHED set — every bootstrap
// GET, every showcased-lens GET, and the demo-flow mutations — has an exact handler
// returning the precise shape its `api.ts` caller consumes. Everything off-screen
// falls through to a permissive, never-throwing stub. `handleApi` never throws.
//
// GET routes are exact-path lookups grouped into small tables by resource family
// (bootstrap / lenses / epics), plus one regex-matched group for session-detail
// tabs. Mutations are grouped the same way (sessions / held / manual-steps).
// This keeps each dispatcher a flat lookup or a handful of same-shape checks
// instead of one long branchy switch.

import { demoState } from "./state";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Body may be a parsed object (readBody JSON) or absent; read a field defensively. */
function field<T>(body: unknown, key: string): T | undefined {
  if (body && typeof body === "object" && key in body) {
    return (body as Record<string, T>)[key];
  }
  return undefined;
}

/** Extract the `:id` from `/api/sessions/:id/<tail>` (or `/api/held/:id/<tail>`). */
function seg(path: string, index: number): string {
  return decodeURIComponent(path.split("/")[index] ?? "");
}

/** Read the `repo` query param shared by most repo-scoped GET routes. */
function repoParam(url: URL): string {
  return url.searchParams.get("repo") ?? "";
}

type GetHandler = (url: URL) => Response;

// ── bootstrap ──────────────────────────────────────────────────────────────
const bootstrapGetRoutes: Record<string, GetHandler> = {
  "/api/me": () => json({ authenticated: true }),
  "/api/sessions": () => json(demoState.sessions()),
  // Admin "clear merged": derives the merged, non-archived session ids from live
  // state (currently `deps`) — shape matches getMergedClearable() in api.ts exactly.
  "/api/sessions/clear-merged": () => json(demoState.mergedClearable()),
  // Done lens (#Task 8): archived sessions, distinct from the live `sessions` list.
  "/api/sessions/done": () => json(demoState.doneSessions()),
  "/api/repo-config": (url) => json(demoState.repoConfig(repoParam(url))),
  "/api/commands": (url) => json(demoState.commands(repoParam(url))),
  "/api/todo": (url) => json(demoState.todo(repoParam(url))),
  // Owed lens (#Task 8): durable post-merge step records — outstanding only. Svelte's
  // `{#each}` silently no-ops on the old `{}` fallback, so this gap never threw; it
  // just left the lens empty even though `deps` seeds one genuinely-owed step.
  "/api/manual-steps/outstanding": () => json(demoState.outstandingManualSteps()),
  "/api/held": () => json(demoState.held()),
  "/api/usage/limits": () => json(demoState.usageLimits()),
  "/api/update": () => json(demoState.update()),
  "/api/update/log": () => json({ phase: "idle", exitCode: null, log: "" }),
  "/api/herdr-update": () => json(demoState.herdrUpdate()),
  "/api/codex-update": () => json(demoState.codexUpdate()),
  "/api/star-prompt": () => json(demoState.starPrompt()),
  "/api/git": () => json(demoState.gitStates()),
  "/api/activity": () => json(demoState.activityStates()),
  "/api/claude-alive": () => json(demoState.claudeAliveStates()),
  "/api/working-blocked": () => json(demoState.workingBlockedStates()),
  "/api/holds": () => json(demoState.holdStates()),
  "/api/subagents": () => json(demoState.subagentStates()),
  "/api/preview": () => json(demoState.previewStates()),
  "/api/drain": () => json(demoState.drain()),
  "/api/automerge": () => json(demoState.autoMerge()),
  "/api/epics/completed": () => json(demoState.completedEpics()),
};

// ── lenses / drawers ─────────────────────────────────────────────────────
const lensGetRoutes: Record<string, GetHandler> = {
  "/api/settings": () => json(demoState.settings()),
  "/api/plugins": () => json({ plugins: demoState.plugins() }),
  "/api/diagnostics": () => json(demoState.diagnostics()),
  "/api/backlog": () => json(demoState.backlog()),
  "/api/queues": () => json(demoState.buildQueues()),
  "/api/reviews": () => json(demoState.reviews()),
  "/api/reviews/inflight": () => json([]),
  "/api/plan-gates": () => json(demoState.planGates()),
  "/api/plan-gates/inflight": () => json([]),
  "/api/recaps": () => json(demoState.recaps()),
  "/api/herd/digest": () => json(demoState.herdDigest()),
  "/api/up-next": () => json(demoState.upNext()),
  "/api/steers": () => json(demoState.steers()),
  "/api/project-icons": () => json(demoState.projectIcons()),
  "/api/learnings/pending": () => json(demoState.pendingLearnings()),
  "/api/learnings/injectable": () => json([]),
  "/api/learnings/merge-suggestions": () => json([]),
  "/api/learnings/health": () => json({ ok: true, consecutiveFailures: 0, lastFailure: null }),
};

// ── epics ────────────────────────────────────────────────────────────────
const epicsGetRoutes: Record<string, GetHandler> = {
  "/api/epics": (url) => json(demoState.epicSummaries(repoParam(url))),
  "/api/epic": (url) => {
    const parent = Number(url.searchParams.get("parent") ?? "0");
    const epic = demoState.epic(repoParam(url), parent);
    return epic ? json(epic) : new Response(null, { status: 404 });
  },
};

const exactGetRoutes: Record<string, GetHandler> = {
  ...bootstrapGetRoutes,
  ...lensGetRoutes,
  ...epicsGetRoutes,
};

// ── session-detail tabs (Task 8 sibling audit) ─────────────────────────────
// Every GET a Viewport tab (or its always-on chrome) fires when a session is opened,
// plus the single-session PR-state GET. Each returns a correctly-shaped, never-`{}`
// response — see the matching demoState getter in state.ts for the exact fallback
// shape per endpoint. Must run after the exact-match table above — "done" (etc.)
// isn't a session id, so the exact routes take priority.
function handleSessionDetailGet(path: string, url: URL): Response | null {
  if (/^\/api\/sessions\/[^/]+\/git$/.test(path)) {
    const git = demoState.gitState(seg(path, 3));
    return git ? json(git) : new Response(null, { status: 404 });
  }
  if (/^\/api\/sessions\/[^/]+\/activity$/.test(path)) {
    return json(demoState.activityEntries(seg(path, 3)));
  }
  if (/^\/api\/sessions\/[^/]+\/diff$/.test(path)) {
    return json(demoState.diff(seg(path, 3)));
  }
  if (/^\/api\/sessions\/[^/]+\/scratchpad$/.test(path)) {
    // Root listing only (matches the demo's flat, non-nested scratchpad seeds); a
    // non-root `path` query still returns a valid empty listing at that path, never {}.
    const reqPath = url.searchParams.get("path") ?? "";
    const root = demoState.scratchpadRoot(seg(path, 3));
    return json(reqPath ? { path: reqPath, parent: "", entries: [] } : root);
  }
  if (/^\/api\/sessions\/[^/]+\/worktree$/.test(path)) {
    // Demo has no seeded worktree tree; return a valid (empty) listing so the Files-tab
    // Worktree view renders its empty state instead of crashing on a shapeless {} body.
    const reqPath = url.searchParams.get("path") ?? "";
    return json({ path: reqPath, parent: reqPath ? "" : null, entries: [] });
  }
  if (/^\/api\/sessions\/[^/]+\/usage$/.test(path)) {
    return json(demoState.sessionUsage(seg(path, 3)));
  }
  if (/^\/api\/sessions\/[^/]+\/leftovers$/.test(path)) {
    return json(demoState.leftovers());
  }
  if (/^\/api\/sessions\/[^/]+\/queue$/.test(path)) {
    return json(demoState.sessionBuildQueue(seg(path, 3)));
  }
  return null;
}

function handleGet(path: string, url: URL): Response | null {
  const exact = exactGetRoutes[path];
  if (exact) return exact(url);
  return handleSessionDetailGet(path, url);
}

// ── session mutations ───────────────────────────────────────────────────────
// The `/api/sessions/:id/<tail>` (+ `DELETE /api/sessions/:id`) family is
// data-driven: one row per (method, tail pattern) rather than a chain of
// `if (method === … && regex.test(path))` branches, so adding a route doesn't
// grow this function's branching — only the table.
type SessionMutationHandler = (path: string, body: unknown) => Response;

const sessionIdMutationRoutes: ReadonlyArray<{
  method: string;
  pattern: RegExp;
  handle: SessionMutationHandler;
}> = [
  {
    // POST /api/sessions/:id/reply
    method: "POST",
    pattern: /^\/api\/sessions\/[^/]+\/reply$/,
    handle: (path, body) => {
      demoState.reply(seg(path, 3), field<string>(body, "text") ?? "");
      return json({});
    },
  },
  {
    // PUT /api/sessions/:id/autopilot
    method: "PUT",
    pattern: /^\/api\/sessions\/[^/]+\/autopilot$/,
    handle: (path, body) => {
      demoState.setAutopilot(seg(path, 3), field<boolean | null>(body, "enabled") ?? null);
      return json({});
    },
  },
  {
    // POST /api/sessions/:id/review-plan
    method: "POST",
    pattern: /^\/api\/sessions\/[^/]+\/review-plan$/,
    handle: (path) => {
      const status = demoState.reviewPlan(seg(path, 3));
      return json({ status });
    },
  },
  {
    // POST /api/sessions/:id/go  (release plan gate)
    method: "POST",
    pattern: /^\/api\/sessions\/[^/]+\/go$/,
    handle: (path) => {
      const ok = demoState.releasePlanGate(seg(path, 3));
      return json({ ok }, ok ? 200 : 409);
    },
  },
  {
    // POST /api/sessions/:id/answer-plan-questions
    method: "POST",
    pattern: /^\/api\/sessions\/[^/]+\/answer-plan-questions$/,
    handle: (path) => json(demoState.answerPlanQuestions(seg(path, 3))),
  },
  {
    // POST /api/sessions/:id/git/merge
    method: "POST",
    pattern: /^\/api\/sessions\/[^/]+\/git\/merge$/,
    handle: (path) => json(demoState.mergePr(seg(path, 3))),
  },
  {
    // POST /api/sessions/:id/ready
    method: "POST",
    pattern: /^\/api\/sessions\/[^/]+\/ready$/,
    handle: (path, body) => {
      demoState.setReadyToMerge(seg(path, 3), field<boolean>(body, "ready") ?? true);
      return json({});
    },
  },
  {
    // POST /api/sessions/:id/ack-manual-steps
    method: "POST",
    pattern: /^\/api\/sessions\/[^/]+\/ack-manual-steps$/,
    handle: (path) => {
      demoState.ackManualSteps(seg(path, 3));
      return json({ ok: true });
    },
  },
  {
    // DELETE /api/sessions/:id  (archive)
    method: "DELETE",
    pattern: /^\/api\/sessions\/[^/]+$/,
    handle: (path) => {
      demoState.archiveSession(seg(path, 3));
      return json({});
    },
  },
];

function handleSessionMutation(
  method: string,
  path: string,
  url: URL,
  body: unknown,
): Response | null {
  // POST /api/sessions/clear-merged — archives the given merged ids in demoState.
  // Shape matches clearMerged() in api.ts. Handled before the /:id/<tail> table
  // below — "clear-merged" isn't a session id.
  if (method === "POST" && path === "/api/sessions/clear-merged") {
    return json(demoState.clearMerged(field<string[]>(body, "ids") ?? []));
  }
  // POST /api/epic/approve-next needs the URL query, so it's handled here alongside
  // the other epic-shaped mutations rather than inline in handleApi.
  if (method === "POST" && path === "/api/epic/approve-next") {
    const parent = Number(url.searchParams.get("parent") ?? "0");
    const epic = demoState.approveEpicNext(repoParam(url), parent);
    return epic ? json(epic) : new Response(null, { status: 404 });
  }
  const route = sessionIdMutationRoutes.find((r) => r.method === method && r.pattern.test(path));
  return route ? route.handle(path, body) : null;
}

// ── held-session mutations ───────────────────────────────────────────────────
function handleHeldMutation(method: string, path: string): Response | null {
  // POST /api/held/:id/spawn
  if (method === "POST" && /^\/api\/held\/[^/]+\/spawn$/.test(path)) {
    const s = demoState.spawnHeld(seg(path, 3));
    return s ? json(s) : new Response(null, { status: 404 });
  }
  return null;
}

// ── manual-steps (Owed lens) mutations ───────────────────────────────────────
function handleManualStepsMutation(method: string, path: string, body: unknown): Response | null {
  // POST /api/manual-steps/:sessionId/steps/:stepId — tick/un-tick one owed step.
  if (method === "POST" && /^\/api\/manual-steps\/[^/]+\/steps\/[^/]+$/.test(path)) {
    const updated = demoState.setManualStepDone(
      seg(path, 3),
      seg(path, 5),
      field<boolean>(body, "done") ?? true,
    );
    return updated ? json(updated) : new Response(null, { status: 404 });
  }
  // POST /api/manual-steps/:sessionId/dismiss — clear a whole owed record.
  if (method === "POST" && /^\/api\/manual-steps\/[^/]+\/dismiss$/.test(path)) {
    const updated = demoState.dismissManualSteps(seg(path, 3));
    return updated ? json(updated) : new Response(null, { status: 404 });
  }
  return null;
}

function handleMutation(method: string, path: string, url: URL, body: unknown): Response | null {
  return (
    handleSessionMutation(method, path, url, body) ??
    handleHeldMutation(method, path) ??
    handleManualStepsMutation(method, path, body)
  );
}

/** Map an intercepted `/api/**` request to a Response. Always resolves; never throws. */
export async function handleApi(method: string, url: URL, body: unknown): Promise<Response> {
  try {
    const path = url.pathname;
    const m = method.toUpperCase();
    const res = m === "GET" ? handleGet(path, url) : handleMutation(m, path, url, body);
    if (res) return res;

    // Permissive fallback for off-screen endpoints: unmatched read → benign empty
    // object; unmatched mutation → a generic success. Keeps the demo UI from
    // erroring on endpoints no showcased screen touches.
    return json(m === "GET" ? {} : { ok: true });
  } catch {
    // Never throw out of the transport — a malformed request degrades to a stub.
    return json(method.toUpperCase() === "GET" ? {} : { ok: true });
  }
}
