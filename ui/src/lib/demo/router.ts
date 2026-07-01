// State-backed demo API router. Maps every intercepted `/api/**` request to a
// Response drawn from the in-memory `demoState`. The POLISHED set — every bootstrap
// GET, every showcased-lens GET, and the demo-flow mutations — has an exact handler
// returning the precise shape its `api.ts` caller consumes. Everything off-screen
// falls through to a permissive, never-throwing stub. `handleApi` never throws.

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

function handleGet(path: string, url: URL): Response | null {
  switch (path) {
    case "/api/me":
      return json({ authenticated: true });

    // ── bootstrap ──────────────────────────────────────────────────────────
    case "/api/sessions":
      return json(demoState.sessions());
    case "/api/held":
      return json(demoState.held());
    case "/api/usage/limits":
      return json(demoState.usageLimits());
    case "/api/update":
      return json(demoState.update());
    case "/api/update/log":
      return json({ phase: "idle", exitCode: null, log: "" });
    case "/api/herdr-update":
      return json(demoState.herdrUpdate());
    case "/api/codex-update":
      return json(demoState.codexUpdate());
    case "/api/star-prompt":
      return json(demoState.starPrompt());
    case "/api/git":
      return json(demoState.gitStates());
    case "/api/activity":
      return json(demoState.activityStates());
    case "/api/claude-alive":
      return json(demoState.claudeAliveStates());
    case "/api/working-blocked":
      return json(demoState.workingBlockedStates());
    case "/api/holds":
      return json(demoState.holdStates());
    case "/api/subagents":
      return json(demoState.subagentStates());
    case "/api/preview":
      return json(demoState.previewStates());
    case "/api/drain":
      return json(demoState.drain());
    case "/api/automerge":
      return json(demoState.autoMerge());
    case "/api/epics/completed":
      return json(demoState.completedEpics());

    // ── lenses / drawers ─────────────────────────────────────────────────────
    case "/api/settings":
      return json(demoState.settings());
    case "/api/plugins":
      return json({ plugins: demoState.plugins() });
    case "/api/diagnostics":
      return json(demoState.diagnostics());
    case "/api/backlog":
      return json(demoState.backlog());
    case "/api/queues":
      return json(demoState.buildQueues());
    case "/api/reviews":
      return json(demoState.reviews());
    case "/api/reviews/inflight":
      return json([]);
    case "/api/plan-gates":
      return json(demoState.planGates());
    case "/api/plan-gates/inflight":
      return json([]);
    case "/api/recaps":
      return json(demoState.recaps());
    case "/api/herd/digest":
      return json(demoState.herdDigest());
    case "/api/up-next":
      return json(demoState.upNext());
    case "/api/steers":
      return json(demoState.steers());
    case "/api/project-icons":
      return json(demoState.projectIcons());
    case "/api/learnings/pending":
      return json(demoState.pendingLearnings());
    case "/api/learnings/injectable":
      return json([]);
    case "/api/learnings/merge-suggestions":
      return json([]);
    case "/api/learnings/health":
      return json({ ok: true, consecutiveFailures: 0, lastFailure: null });
    case "/api/epics": {
      const repo = url.searchParams.get("repo") ?? "";
      return json(demoState.epicSummaries(repo));
    }
    case "/api/epic": {
      const repo = url.searchParams.get("repo") ?? "";
      const parent = Number(url.searchParams.get("parent") ?? "0");
      const epic = demoState.epic(repo, parent);
      return epic ? json(epic) : new Response(null, { status: 404 });
    }
  }

  // `/api/sessions/:id/git` — single-session PR state (404 → api returns null).
  if (/^\/api\/sessions\/[^/]+\/git$/.test(path)) {
    const git = demoState.gitState(seg(path, 3));
    return git ? json(git) : new Response(null, { status: 404 });
  }

  return null;
}

function handleMutation(method: string, path: string, body: unknown): Response | null {
  // POST /api/sessions/:id/reply
  if (method === "POST" && /^\/api\/sessions\/[^/]+\/reply$/.test(path)) {
    demoState.reply(seg(path, 3), field<string>(body, "text") ?? "");
    return json({});
  }
  // PUT /api/sessions/:id/autopilot
  if (method === "PUT" && /^\/api\/sessions\/[^/]+\/autopilot$/.test(path)) {
    demoState.setAutopilot(seg(path, 3), field<boolean | null>(body, "enabled") ?? null);
    return json({});
  }
  // POST /api/sessions/:id/review-plan
  if (method === "POST" && /^\/api\/sessions\/[^/]+\/review-plan$/.test(path)) {
    demoState.reviewPlan(seg(path, 3));
    return json({ status: "started" });
  }
  // POST /api/sessions/:id/go  (release plan gate)
  if (method === "POST" && /^\/api\/sessions\/[^/]+\/go$/.test(path)) {
    const ok = demoState.releasePlanGate(seg(path, 3));
    return json({ ok }, ok ? 200 : 409);
  }
  // POST /api/sessions/:id/answer-plan-questions
  if (method === "POST" && /^\/api\/sessions\/[^/]+\/answer-plan-questions$/.test(path)) {
    return json(demoState.answerPlanQuestions(seg(path, 3)));
  }
  // POST /api/sessions/:id/git/merge
  if (method === "POST" && /^\/api\/sessions\/[^/]+\/git\/merge$/.test(path)) {
    return json(demoState.mergePr(seg(path, 3)));
  }
  // POST /api/sessions/:id/ready
  if (method === "POST" && /^\/api\/sessions\/[^/]+\/ready$/.test(path)) {
    demoState.setReadyToMerge(seg(path, 3), field<boolean>(body, "ready") ?? true);
    return json({});
  }
  // DELETE /api/sessions/:id  (archive)
  if (method === "DELETE" && /^\/api\/sessions\/[^/]+$/.test(path)) {
    demoState.archiveSession(seg(path, 3));
    return json({});
  }
  // POST /api/held/:id/spawn
  if (method === "POST" && /^\/api\/held\/[^/]+\/spawn$/.test(path)) {
    const s = demoState.spawnHeld(seg(path, 3));
    return s ? json(s) : new Response(null, { status: 404 });
  }
  return null;
}

/** Map an intercepted `/api/**` request to a Response. Always resolves; never throws. */
export async function handleApi(method: string, url: URL, body: unknown): Promise<Response> {
  try {
    const path = url.pathname;
    const m = method.toUpperCase();

    if (m === "GET") {
      const res = handleGet(path, url);
      if (res) return res;
    } else {
      // POST /api/epic/approve-next needs the URL query, so handle it here.
      if (m === "POST" && path === "/api/epic/approve-next") {
        const repo = url.searchParams.get("repo") ?? "";
        const parent = Number(url.searchParams.get("parent") ?? "0");
        const epic = demoState.approveEpicNext(repo, parent);
        return epic ? json(epic) : new Response(null, { status: 404 });
      }
      const res = handleMutation(m, path, body);
      if (res) return res;
    }

    // Permissive fallback for off-screen endpoints: unmatched read → benign empty
    // object; unmatched mutation → a generic success. Keeps the demo UI from
    // erroring on endpoints no showcased screen touches.
    if (m === "GET") return json({});
    return json({ ok: true });
  } catch {
    // Never throw out of the transport — a malformed request degrades to a stub.
    return json(method.toUpperCase() === "GET" ? {} : { ok: true });
  }
}
