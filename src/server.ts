import type { SessionStore } from "./store";
import type { SessionService } from "./service";
import type { EventHub } from "./events";
import { PtyBridge } from "./pty-bridge";
import { config } from "./config";
import {
  validateCreate,
  isAuthorized,
  originAllowed,
  safeRepoDir,
  parseTermDims,
  validateSteers,
  validateBroadcast,
  validateIconPatch,
} from "./validate";
import { listRepos, readTodo, writeTodo } from "./repos";
import { listDirs, validateRoot, collapseHome } from "./dirs";
import { loadSteers, saveSteers } from "./steers";
import { loadIcons, setIcon } from "./project-icons";
import { listBranches } from "./branches";
import { computeDiff } from "./diff";
import { sessionTokens, jsonlPathFor } from "./usage";
import { sessionActivity } from "./activity";
import { handleUpload } from "./uploads";
import type { UsageLimitsService } from "./usage-limits";
import type { UpdateService } from "./update";
import type { HerdrUpdateService } from "./herdr-update";
import type { Session } from "./types";
import type { HerdrDriver } from "./herdr";
import type { GitForge, GitState, MergeMethod } from "./forge/types";
import type { PrCache } from "./pr-poller";
import type { PushService } from "./push";
import type { StatusPoller } from "./poller";
import { join, normalize } from "node:path";
import type { ServerWebSocket } from "bun";

const UI_DIR = join(import.meta.dir, "..", "ui", "build");

async function serveStatic(pathname: string): Promise<Response> {
  // strip leading traversal, normalize
  const rel = normalize(pathname)
    .replace(/^(\.\.(\/|\\|$))+/, "")
    .replace(/^\/+/, "");
  const target = rel === "" ? "index.html" : rel;
  const resolved = join(UI_DIR, target);
  // extra traversal guard: resolved path must stay within UI_DIR
  if (!resolved.startsWith(UI_DIR + "/") && resolved !== UI_DIR) {
    return new Response(Bun.file(join(UI_DIR, "index.html")), {
      headers: { "content-type": "text/html" },
    });
  }
  const file = Bun.file(resolved);
  const headers: Record<string, string> = {};
  if (target.endsWith(".webmanifest")) headers["content-type"] = "application/manifest+json";
  if (await file.exists()) return new Response(file, { headers });
  return new Response(Bun.file(join(UI_DIR, "index.html")), {
    headers: { "content-type": "text/html" },
  });
}

export interface AppDeps {
  store: SessionStore;
  service: SessionService;
  events: EventHub;
  usageLimits: Pick<UsageLimitsService, "limits">;
  /** Resolve the git forge for a repo dir; null when none is configured. */
  resolveForge?: (repoDir: string) => GitForge | null;
  /** Self-update tracker; absent in environments where it isn't wired. */
  updates?: Pick<UpdateService, "current" | "apply">;
  /** herdr-version tracker + applier; absent in environments where it isn't wired. */
  herdrUpdates?: Pick<HerdrUpdateService, "current" | "apply">;
  /** Herdr driver (for liveness checks). Absent in some tests; gate fails open. */
  herdr?: Pick<HerdrDriver, "list">;
  /** In-memory PR-status cache surfaced in the list overview; absent in tests
   *  that don't exercise it. */
  prCache?: PrCache;
  /** Web Push delivery; absent in tests that don't exercise notifications. */
  push?: Pick<PushService, "publicKey" | "subscribe" | "unsubscribe">;
  /** Status poller; used to manually dismiss a stall flag. Absent in tests. */
  poller?: Pick<StatusPoller, "acknowledgeStall">;
}

const sessionUsage = (s: Session) =>
  s.claudeSessionId
    ? sessionTokens(jsonlPathFor(s.worktreePath, s.claudeSessionId))
    : sessionTokens("/nonexistent"); // pre-feature session → zeroed usage

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function checkAuth(req: Request): Response | null {
  if (!isAuthorized(req.headers.get("Authorization"), config.token)) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

function checkOrigin(req: Request): Response | null {
  const method = req.method;
  if (method !== "POST" && method !== "DELETE" && method !== "PUT") return null;
  if (!originAllowed(req.headers.get("Origin"), config.allowedOriginHosts)) {
    return json({ error: "forbidden: origin not allowed" }, 403);
  }
  return null;
}

/** Returns an object with a `fetch(Request)` method — unit-testable without a port. */
export function makeApp(deps: AppDeps) {
  return {
    async fetch(req: Request): Promise<Response> {
      const authErr = checkAuth(req);
      if (authErr) return authErr;

      const originErr = checkOrigin(req);
      if (originErr) return originErr;

      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean); // ["api","sessions",":id"]

      if (req.method === "GET" && parts[0] === "api" && parts[1] === "git" && !parts[2]) {
        return json(deps.prCache?.snapshot() ?? {});
      }

      if (parts[0] === "api" && parts[1] === "push") {
        if (req.method === "GET" && parts[2] === "vapid") {
          return json({ publicKey: deps.push?.publicKey() ?? null });
        }
        if (req.method === "POST" && parts[2] === "subscribe") {
          if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
            return json({ error: "Content-Type must be application/json" }, 415);
          }
          const body = (await req.json().catch(() => null)) as {
            endpoint?: unknown;
            keys?: { p256dh?: unknown; auth?: unknown };
            locale?: unknown;
          } | null;
          if (
            !body ||
            typeof body.endpoint !== "string" ||
            typeof body.keys?.p256dh !== "string" ||
            typeof body.keys?.auth !== "string"
          ) {
            return json({ error: "body must be a PushSubscription" }, 400);
          }
          deps.push?.subscribe(
            {
              endpoint: body.endpoint,
              keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
              locale: typeof body.locale === "string" ? body.locale : undefined,
            },
            req.headers.get("User-Agent") ?? "",
          );
          return json({ ok: true });
        }
        if (req.method === "POST" && parts[2] === "unsubscribe") {
          const body = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
          if (!body || typeof body.endpoint !== "string") {
            return json({ error: "body must be {endpoint: string}" }, 400);
          }
          deps.push?.unsubscribe(body.endpoint);
          return json({ ok: true });
        }
      }

      if (parts[0] === "api" && parts[1] === "sessions") {
        if (req.method === "POST" && !parts[2]) {
          if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
            return json({ error: "Content-Type must be application/json" }, 415);
          }
          const body = await req.json().catch(() => null);
          const result = validateCreate(body, config.repoRoot);
          if (!result.ok) return json({ error: result.error }, 400);
          let s;
          try {
            s = await deps.service.create(result.value);
          } catch (e) {
            // create shells out to herdr (and git); surface the real reason instead of a
            // bare 500 so the New Task dialog can show it. 409 ⇒ a name still collided
            // (a slip past uniqueName under a race), anything else ⇒ 502 (herdr/git failed).
            const msg = e instanceof Error ? e.message : "create failed";
            const taken = /agent_name_taken/.test(msg);
            return json(
              { error: taken ? "task name already in use, retry" : msg },
              taken ? 409 : 502,
            );
          }
          deps.events.emit("session:new", s);
          return json(s, 201);
        }
        if (req.method === "GET" && !parts[2]) return json(deps.store.list({ activeOnly: true }));
        if (req.method === "GET" && parts[2] && parts[3] === "usage") {
          const s = deps.store.get(parts[2]);
          return s ? json(await sessionUsage(s)) : json({ error: "not found" }, 404);
        }
        if (req.method === "GET" && parts[2] && parts[3] === "activity") {
          const s = deps.store.get(parts[2]);
          if (!s) return json({ error: "not found" }, 404);
          // pre-feature session (no pinned id) → no transcript to read
          const path = s.claudeSessionId ? jsonlPathFor(s.worktreePath, s.claudeSessionId) : "";
          return json(path ? await sessionActivity(path) : []);
        }
        if (req.method === "GET" && parts[2] && parts[3] === "diff") {
          const s = deps.store.get(parts[2]);
          if (!s) return json({ error: "not found" }, 404);
          try {
            return json(computeDiff(s.worktreePath, s.baseBranch, s.branch));
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : "diff failed" }, 500);
          }
        }
        if (req.method === "GET" && parts[2] && !parts[3]) {
          const s = deps.store.get(parts[2]);
          return s ? json(s) : json({ error: "not found" }, 404);
        }
        if (req.method === "DELETE" && parts[2]) {
          deps.service.archive(parts[2]);
          deps.prCache?.drop(parts[2]);
          deps.events.emit("session:archived", { id: parts[2] });
          return json({ ok: true });
        }
        if (req.method === "POST" && parts[2] && parts[3] === "reply") {
          if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
            return json({ error: "Content-Type must be application/json" }, 415);
          }
          const body = await req.json().catch(() => null);
          if (!body || typeof (body as { text?: unknown }).text !== "string") {
            return json({ error: "body must be {text: string}" }, 400);
          }
          const ok = deps.service.reply(parts[2], (body as { text: string }).text);
          return ok ? json({ ok: true }) : json({ error: "not found" }, 404);
        }
        if (req.method === "POST" && parts[2] && parts[3] === "dismiss-stall") {
          const ok = deps.poller?.acknowledgeStall(parts[2]) ?? false;
          return ok ? json({ ok: true }) : json({ error: "no stall to dismiss" }, 404);
        }
      }
      // ── git host (forge) actions: /api/sessions/:id/git[/pr|/merge|/redeploy] ──
      if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "git") {
        const session = deps.store.get(parts[2]);
        if (!session) return json({ error: "not found" }, 404);
        const forge = deps.resolveForge?.(session.repoPath) ?? null;
        if (!forge) return json({ error: "no forge for this repo" }, 404);
        const head = session.branch ?? "";
        try {
          if (req.method === "GET" && !parts[4]) {
            return json({ kind: forge.kind, ...(await forge.prStatus(head)) });
          }
          if (req.method === "POST" && parts[4] === "pr") {
            const body = (await req.json().catch(() => ({}))) as { title?: string; body?: string };
            const status = await forge.openPr({
              head,
              base: session.baseBranch,
              title: body.title?.trim() || session.name,
              body: body.body ?? session.prompt,
            });
            const git: GitState = { kind: forge.kind, ...status };
            deps.prCache?.set(session.id, git);
            deps.events.emit("session:git", { id: session.id, git });
            return json(status);
          }
          if (req.method === "POST" && parts[4] === "merge") {
            const body = (await req.json().catch(() => ({}))) as {
              method?: MergeMethod;
              deleteBranch?: boolean;
            };
            const cur = await forge.prStatus(head);
            if (cur.state !== "open" || !cur.number) {
              return json({ error: "no open PR to merge" }, 409);
            }
            await forge.merge(cur.number, {
              method: body.method ?? forge.mergeMethod,
              deleteBranch: body.deleteBranch ?? true,
            });
            const status = await forge.prStatus(head);
            const git: GitState = { kind: forge.kind, ...status };
            deps.prCache?.set(session.id, git);
            deps.events.emit("session:git", { id: session.id, git });
            return json(status);
          }
          if (req.method === "POST" && parts[4] === "redeploy") {
            if (!forge.deployWorkflow) {
              return json({ error: "no deploy workflow configured" }, 400);
            }
            await forge.redeploy({ workflow: forge.deployWorkflow, ref: session.baseBranch });
            return json({ ok: true });
          }
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "forge error" }, 502);
        }
      }

      if (
        req.method === "GET" &&
        parts[0] === "api" &&
        parts[1] === "usage" &&
        parts[2] === "limits"
      ) {
        return json(deps.usageLimits.limits(Date.now()));
      }

      // ── self-update: status + trigger ──────────────────────────────────────
      if (parts[0] === "api" && parts[1] === "update" && !parts[2]) {
        if (req.method === "GET") {
          return json(
            deps.updates?.current() ?? {
              behind: 0,
              current: null,
              latest: null,
              commits: [],
              checkedAt: Date.now(),
            },
          );
        }
        if (req.method === "POST") {
          if (!deps.updates) return json({ error: "updates not available" }, 503);
          const status = deps.updates.current();
          if (!status || status.behind <= 0) return json({ error: "no update available" }, 409);
          const r = deps.updates.apply();
          return json({ ok: r.started }, r.started ? 202 : 409);
        }
      }

      // ── herdr update: status + (destructive) apply ─────────────────────────
      if (parts[0] === "api" && parts[1] === "herdr-update" && !parts[2]) {
        if (req.method === "GET") {
          return json(
            deps.herdrUpdates?.current() ?? {
              current: null,
              latest: null,
              updateAvailable: false,
              notes: null,
              checkedAt: Date.now(),
            },
          );
        }
        if (req.method === "POST") {
          if (!deps.herdrUpdates) return json({ error: "herdr updates not available" }, 503);
          if (!deps.herdrUpdates.current()?.updateAvailable)
            return json({ error: "no update available" }, 409);
          const r = deps.herdrUpdates.apply();
          return json({ ok: r.started }, r.started ? 202 : 409);
        }
      }

      if (parts[0] === "api" && parts[1] === "uploads" && !parts[2]) {
        if (req.method === "POST") {
          return handleUpload(req, { store: deps.store, repoRoot: config.repoRoot });
        }
      }

      if (parts[0] === "api" && parts[1] === "repos" && !parts[2]) {
        if (req.method === "GET") {
          const lastUsed = deps.store.lastUsedByRepo();
          const repos = listRepos(config.repoRoot).map((r) => ({
            ...r,
            lastUsedAt: lastUsed[r.path],
          }));
          return json(repos);
        }
      }

      // ── settings: read/update the repo root (persisted, applied at runtime) ──
      if (parts[0] === "api" && parts[1] === "settings" && !parts[2]) {
        if (req.method === "GET") {
          return json({
            repoRoot: config.repoRoot,
            repoRootDisplay: collapseHome(config.repoRoot),
          });
        }
        if (req.method === "PUT") {
          const body = (await req.json().catch(() => null)) as { repoRoot?: unknown } | null;
          const root = validateRoot(body?.repoRoot, config.rootCeiling);
          if (!root) {
            return json({ error: "repoRoot must be an existing directory within the root" }, 400);
          }
          config.repoRoot = root; // live: every later read picks it up
          deps.store.setSetting("repoRoot", root); // persist across restarts
          return json({ repoRoot: root, repoRootDisplay: collapseHome(root) });
        }
      }

      // ── saved steers (canned prompts): list / replace ──
      if (parts[0] === "api" && parts[1] === "steers" && !parts[2]) {
        if (req.method === "GET") return json(loadSteers(deps.store));
        if (req.method === "PUT") {
          if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
            return json({ error: "Content-Type must be application/json" }, 415);
          }
          const body = await req.json().catch(() => null);
          const steers = validateSteers(body);
          if (!steers) return json({ error: "invalid steers payload" }, 400);
          saveSteers(deps.store, steers);
          return json(steers);
        }
      }

      // ── per-project icons: read full map / patch one entry ──
      if (parts[0] === "api" && parts[1] === "project-icons" && !parts[2]) {
        if (req.method === "GET") return json(loadIcons(deps.store));
        if (req.method === "PUT") {
          if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
            return json({ error: "Content-Type must be application/json" }, 415);
          }
          const body = await req.json().catch(() => null);
          const patch = validateIconPatch(body);
          if (!patch) return json({ error: "invalid project-icon payload" }, 400);
          const map = setIcon(deps.store, patch.path, patch.emoji);
          deps.events.emit("project-icons:update", map);
          return json(map);
        }
      }

      // ── broadcast a steer to many sessions ──
      if (parts[0] === "api" && parts[1] === "broadcast" && !parts[2]) {
        if (req.method === "POST") {
          if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
            return json({ error: "Content-Type must be application/json" }, 415);
          }
          const body = await req.json().catch(() => null);
          const parsed = validateBroadcast(body);
          if (!parsed) return json({ error: "body must be {text: string, ids: string[]}" }, 400);
          return json(deps.service.broadcast(parsed.ids, parsed.text));
        }
      }

      // ── filesystem browser: list sub-directories for the root picker ──
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "fs" && parts[2] === "dirs") {
        return json(listDirs(url.searchParams.get("path") ?? "", config.rootCeiling));
      }

      if (req.method === "GET" && parts[0] === "api" && parts[1] === "branches" && !parts[2]) {
        const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
        if (!dir) return json({ error: "invalid repo" }, 400);
        return json(listBranches(dir));
      }

      if (req.method === "GET" && parts[0] === "api" && parts[1] === "issues" && !parts[2]) {
        const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
        if (!dir) return json({ error: "invalid repo" }, 400);
        const forge = deps.resolveForge?.(dir) ?? null;
        if (!forge) return json({ slug: null, issues: [] });
        try {
          return json({ slug: forge.slug, issues: await forge.listIssues() });
        } catch {
          // missing/un-authed CLI or network error → graceful empty (matches prior behavior)
          return json({ slug: forge.slug, issues: [] });
        }
      }

      if (parts[0] === "api" && parts[1] === "todo" && !parts[2]) {
        const repoParam = url.searchParams.get("repo") ?? "";
        if (req.method === "GET") {
          const r = readTodo(repoParam, config.repoRoot);
          if (!r.ok) return json({ error: "invalid repo path" }, 400);
          return json(r);
        }
        if (req.method === "PUT") {
          const body = await req.json().catch(() => null);
          if (
            body === null ||
            typeof body !== "object" ||
            typeof (body as any).content !== "string"
          ) {
            return json({ error: "body must be {content: string}" }, 400);
          }
          const ok = writeTodo(repoParam, config.repoRoot, (body as any).content);
          if (!ok) return json({ error: "invalid repo path or content too large" }, 400);
          return json({ ok: true });
        }
      }

      if (url.pathname.startsWith("/api")) return json({ error: "not found" }, 404);
      if (req.method === "GET" || req.method === "HEAD") {
        const res = await serveStatic(url.pathname);
        // HEAD: same status/headers as GET, but no body
        return req.method === "HEAD"
          ? new Response(null, { status: res.status, headers: res.headers })
          : res;
      }
      return json({ error: "not found" }, 404);
    },
  };
}

type WsData =
  | { kind: "events" }
  | { kind: "pty"; id: string; terminalId: string; cols: number; rows: number; bridge?: PtyBridge };

// A pty WS closed with this code means "a newer client took over this terminal".
// The client parks (shows a take-over prompt) instead of reconnecting — without
// it, two devices on the same session ping-pong herdr's --takeover forever.
// Keep in sync with PTY_SUPERSEDED_CODE in ui/src/lib/pty.ts.
export const PTY_SUPERSEDED_CODE = 4000;

// A pty WS closed with this code means "this session has ended" — its herdr
// agent is gone (the user quit claude / ctrl-c'd). The client stops reconnecting
// and shows an ended state instead of looping on herdr's agent_not_found.
// Keep in sync with PTY_GONE_CODE in ui/src/lib/pty.ts.
export const PTY_GONE_CODE = 4001;

export function serve(deps: AppDeps, port: number) {
  const app = makeApp(deps);
  // current owning socket per terminal — a single owner avoids the takeover war
  const ptyOwners = new Map<string, ServerWebSocket<WsData>>();
  return Bun.serve<WsData>({
    port,
    hostname: config.host,
    fetch(req, server) {
      const authErr = checkAuth(req);
      if (authErr) return authErr;

      const originErr = checkOrigin(req);
      if (originErr) return originErr;

      const url = new URL(req.url);
      if (url.pathname === "/events") {
        const origin = req.headers.get("Origin");
        if (!originAllowed(origin, config.allowedOriginHosts)) {
          return new Response("forbidden: origin not allowed", { status: 403 });
        }
        return server.upgrade(req, { data: { kind: "events" } })
          ? undefined
          : new Response("upgrade failed", { status: 500 });
      }
      const m = url.pathname.match(/^\/pty\/([^/]+)$/);
      if (m) {
        const origin = req.headers.get("Origin");
        if (!originAllowed(origin, config.allowedOriginHosts)) {
          return new Response("forbidden: origin not allowed", { status: 403 });
        }
        const s = deps.store.get(m[1]!);
        if (!s) return new Response("no session", { status: 404 });
        // attach at the client's actual terminal size so the very first paint
        // matches; otherwise herdr renders the pane at the default 100×30 and the
        // view stays mis-sized until a follow-up resize forces a TUI repaint.
        const { cols, rows } = parseTermDims(
          url.searchParams.get("cols"),
          url.searchParams.get("rows"),
        );
        return server.upgrade(req, {
          data: { kind: "pty", id: s.id, terminalId: s.herdrAgentId, cols, rows },
        })
          ? undefined
          : new Response("upgrade failed", { status: 500 });
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === "events") {
          const unsub = deps.events.subscribe((event, data) =>
            ws.send(JSON.stringify({ event, data })),
          );
          (ws.data as any).unsub = unsub;
        } else {
          // Don't attach a terminal whose herdr agent is gone: attaching would make
          // herdr reply agent_not_found and the client would reconnect-loop on it.
          // A "done" status only means the agent finished its turn (idle at the
          // prompt) — its herdr pane may still be alive and attachable. So gate on
          // herdr LIVENESS, not on status: block only when the session is missing,
          // archived, or its herdr agent is no longer listed by `herdr agent list`.
          const cur = deps.store.get(ws.data.id);
          if (!cur || cur.status === "archived") {
            ws.close(PTY_GONE_CODE, "ended");
            return;
          }
          let agentLive: boolean;
          try {
            agentLive = deps.herdr?.list().some((a) => a.terminalId === cur.herdrAgentId) ?? true;
          } catch {
            agentLive = true; // a herdr CLI hiccup shouldn't strand a live session
          }
          if (!agentLive) {
            ws.close(PTY_GONE_CODE, "ended");
            return;
          }
          // single owner per terminal: claim it, then bump the previous owner
          // with a "superseded" close so it parks instead of fighting back.
          const tid = ws.data.terminalId;
          const prev = ptyOwners.get(tid);
          ptyOwners.set(tid, ws);
          if (prev && prev !== ws) prev.close(PTY_SUPERSEDED_CODE, "superseded");
          const bridge = new PtyBridge(tid, {
            send: (d) => ws.send(d),
            close: () => ws.close(),
          });
          ws.data.bridge = bridge;
          bridge.open(ws.data.cols, ws.data.rows);
        }
      },
      message(ws, msg) {
        if (ws.data.kind !== "pty") return;
        ws.data.bridge?.write(typeof msg === "string" ? msg : msg.toString());
      },
      close(ws) {
        if (ws.data.kind === "events") (ws.data as any).unsub?.();
        else {
          // only drop ownership if we're still the owner (a newer client may have
          // already claimed this terminal before our close fired)
          if (ptyOwners.get(ws.data.terminalId) === ws) ptyOwners.delete(ws.data.terminalId);
          ws.data.bridge?.close();
        }
      },
    },
  });
}
