/** Repository grants are an additional, deny-by-default boundary on machine tokens. */
import { isRepositoryPaths } from "./access-tokens";
import { listRepos } from "./repos";
import { safeRepoDir } from "./validate";

export function normalizeRepositoryPaths(
  raw: unknown,
  root: string,
  previous: readonly string[] = [],
): { repoPaths: string[] | null } | { error: string } {
  if (!isRepositoryPaths(raw)) return { error: "repoPaths must be null or an array of paths" };
  if (raw === null) return { repoPaths: null };
  const available = new Set(
    listRepos(root)
      .map((r) => safeRepoDir(r.path, root))
      .filter(Boolean),
  );
  const paths = new Set<string>();
  for (const path of raw) {
    const canonical = safeRepoDir(path, root);
    if (canonical && available.has(canonical)) paths.add(canonical);
    else if (!canonical && previous.includes(path)) paths.add(path);
    else return { error: "repository is not available" };
  }
  return { repoPaths: [...paths] };
}

/** Exact canonical roots, never prefix matching. Missing paths grant nothing. */
export function repositoryAllows(
  repoPaths: readonly string[] | null,
  path: string,
  root: string,
): boolean {
  if (repoPaths === null) return true;
  const canonical = safeRepoDir(path, root);
  return canonical !== null && repoPaths.includes(canonical);
}

export type RepositoryRoute =
  | { kind: "collection" | "body" | "bootstrap" | "upload" }
  | { kind: "session" | "held" | "task"; id: string }
  | { kind: "repo"; path: string };

const COLLECTION_READS = new Set([
  "/api/repos",
  "/api/sessions",
  "/api/git",
  "/api/holds",
  "/api/login-requests",
  "/api/held",
  "/api/reviews/inflight",
  "/api/plan-gates/inflight",
  "/api/queues",
  "/api/reviews",
  "/api/plan-gates",
  "/api/amendments",
]);
const SESSION_READS = new Set([
  "usage",
  "activity",
  "steer-log",
  "diff",
  "diff/annotations",
  "prompt-budget",
  "leftovers",
  "scratchpad",
  "scratchpad/download",
  "worktree",
  "worktree/download",
  "queue",
  "git",
  "git/reviewers",
]);
const SESSION_POSTS = new Set([
  "reply",
  "interrupt",
  "resume",
  "relaunch",
  "replace",
  "variant",
  "restore",
  "ready",
  "rename",
  "go",
  "answer-plan-questions",
  "review-plan",
  "review-pr",
  "amendments",
  "queue/approve",
  "scratchpad/upload",
  "git/pr",
  "git/merge",
  "git/close",
  "git/redeploy",
  "git/ready",
  "git/draft",
  "git/request-review",
  "login-request",
]);

function collectionRoutePolicy(
  method: string,
  path: string,
  params: URLSearchParams,
): RepositoryRoute | null {
  const key = `${method} ${path}`;
  if (
    ["GET /api/me", "GET /events", "POST /api/ping"].includes(key) ||
    (method === "DELETE" && /^\/api\/access-tokens\/[^/]+$/.test(path))
  )
    return { kind: "bootstrap" };
  if (method === "GET" && COLLECTION_READS.has(path)) return { kind: "collection" };
  if (key === "GET /api/branches") return { kind: "repo", path: params.get("repo") ?? "" };
  if (["POST /api/sessions", "POST /api/issues"].includes(key)) return { kind: "body" };
  if (key === "POST /api/uploads") {
    const id = params.get("session");
    return id ? { kind: "session", id } : { kind: "upload" };
  }
  return null;
}

function sessionRoutePolicy(method: string, id: string, leaf: string): RepositoryRoute | null {
  if (["clear-merged", "done", "archived"].includes(id)) return null;
  // Bare session reads also accept TASK designations; other session routes use UUIDs.
  if (method === "GET" && leaf === "") return { kind: "task", id };
  if (
    (method === "GET" && SESSION_READS.has(leaf)) ||
    (method === "POST" && SESSION_POSTS.has(leaf)) ||
    (method === "PUT" && leaf === "queue") ||
    (method === "POST" && /^queue\/steps\/[^/]+$/.test(leaf)) ||
    (method === "DELETE" && (leaf === "" || /^amendments\/[^/]+$/.test(leaf)))
  )
    return { kind: "session", id };
  return null;
}

function resourceRoutePolicy(method: string, parts: string[]): RepositoryRoute | null {
  if (method === "GET" && (parts[0] === "pty" || parts[0] === "browser-view") && parts.length === 2)
    return { kind: "session", id: parts[1]! };
  if (parts[0] !== "api" || !parts[2]) return null;
  const id = parts[2],
    leaf = parts.slice(3).join("/");
  switch (parts[1]) {
    case "tasks":
      return method === "GET" && ["export", "transcript"].includes(leaf)
        ? { kind: "task", id }
        : null;
    case "held":
      return ["PATCH ", "DELETE ", "POST spawn"].includes(`${method} ${leaf}`)
        ? { kind: "held", id }
        : null;
    case "sessions":
      return sessionRoutePolicy(method, id, leaf);
    default:
      return null;
  }
}

/** Same segment normalization as the dispatcher; matching still requires an exact leaf. */
export function repositoryRoutePolicy(method: string, url: URL): RepositoryRoute | null {
  const parts = url.pathname.split("/").filter(Boolean);
  return (
    collectionRoutePolicy(method, "/" + parts.join("/"), url.searchParams) ??
    resourceRoutePolicy(method, parts)
  );
}

const SESSION_EVENTS = new Set([
  "session:new",
  "session:status",
  "session:archived",
  "session:renamed",
  "session:block",
  "session:ready",
  "session:activity",
  "session:claude-alive",
  "session:working-blocked",
  "session:background-busy",
  "session:halt",
  "session:git",
  "session:hold",
  "session:login-request",
  "session:review",
  "session:reviewing",
  "session:plangate",
  "session:plangate-reviewing",
  "session:critic-activity",
  "session:plangate-activity",
  "session:spawn-notices",
  "session:amendments",
  "session:subagents",
  "session:preview",
  "session:preview-serve",
  "session:recap",
  "session:manual-steps",
  "session:experiment",
  "session:autopilot",
]);

/** Unknown events never inherit access merely because their payload contains an id. */
export function filterRepositoryEvent(
  event: string,
  data: unknown,
  sessionAllowed: (id: string) => boolean,
): boolean {
  if (!data || typeof data !== "object") return false;
  const row = data as Record<string, unknown>;
  const id =
    event === "queue:update" ? row.sessionId : SESSION_EVENTS.has(event) ? row.id : undefined;
  return typeof id === "string" && sessionAllowed(id);
}
