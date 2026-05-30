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
} from "./validate";
import { listRepos, readTodo, writeTodo } from "./repos";
import { listBranches } from "./branches";
import { listIssues } from "./github";
import { sessionTokens, jsonlPathFor } from "./usage";
import type { UsageLimitsService } from "./usage-limits";
import type { Session } from "./types";
import { join, normalize } from "node:path";

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
  if (await file.exists()) return new Response(file);
  return new Response(Bun.file(join(UI_DIR, "index.html")), {
    headers: { "content-type": "text/html" },
  });
}

export interface AppDeps {
  store: SessionStore;
  service: SessionService;
  events: EventHub;
  usageLimits: Pick<UsageLimitsService, "limits">;
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

      if (parts[0] === "api" && parts[1] === "sessions") {
        if (req.method === "POST" && !parts[2]) {
          if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
            return json({ error: "Content-Type must be application/json" }, 415);
          }
          const body = await req.json().catch(() => null);
          const result = validateCreate(body, config.repoRoot);
          if (!result.ok) return json({ error: result.error }, 400);
          const s = await deps.service.create(result.value);
          deps.events.emit("session:new", s);
          return json(s, 201);
        }
        if (req.method === "GET" && !parts[2]) return json(deps.store.list({ activeOnly: true }));
        if (req.method === "GET" && parts[2] && parts[3] === "usage") {
          const s = deps.store.get(parts[2]);
          return s ? json(await sessionUsage(s)) : json({ error: "not found" }, 404);
        }
        if (req.method === "GET" && parts[2]) {
          const s = deps.store.get(parts[2]);
          return s ? json(s) : json({ error: "not found" }, 404);
        }
        if (req.method === "DELETE" && parts[2]) {
          deps.service.archive(parts[2]);
          deps.events.emit("session:archived", { id: parts[2] });
          return json({ ok: true });
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

      if (req.method === "GET" && parts[0] === "api" && parts[1] === "branches" && !parts[2]) {
        const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
        if (!dir) return json({ error: "invalid repo" }, 400);
        return json(listBranches(dir));
      }

      if (req.method === "GET" && parts[0] === "api" && parts[1] === "issues" && !parts[2]) {
        const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
        if (!dir) return json({ error: "invalid repo" }, 400);
        return json(listIssues(dir));
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
  | { kind: "pty"; terminalId: string; cols: number; rows: number; bridge?: PtyBridge };

export function serve(deps: AppDeps, port: number) {
  const app = makeApp(deps);
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
          data: { kind: "pty", terminalId: s.herdrAgentId, cols, rows },
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
          const bridge = new PtyBridge(ws.data.terminalId, {
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
        else ws.data.bridge?.close();
      },
    },
  });
}
