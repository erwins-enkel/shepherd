import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import { serve } from "../../src/server";
import { config } from "../../src/config";
import { hashPassword, SESSION_COOKIE } from "../../src/operator-auth";
import { makeContractDeps, type ContractDeps } from "./deps";

export interface Contract {
  paths: Record<string, PathItem>;
  components: { schemas: Record<string, unknown> };
  /** Event name → declaration, plus two non-event keys: `description` (a plain string documenting
   *  the socket) and `envelope` (a `$ref` to the EventEnvelope schema every frame matches).
   *  `declaredEvents()`/`validateEvent()` skip both. */
  "x-shepherd-events": Record<string, EventDecl | string | { $ref: string }>;
  "x-shepherd-pty": {
    /** Prose documenting the socket: the pre-upgrade 404, the scrollback replay on attach and the
     *  "the loser of a 4000 must not reconnect" rule. Prose, but pinned by
     *  `terminal.test.ts` — a rewrite that drops one of those is a contract change. */
    description: string;
    path: string;
    query: string[];
    resizePrefix: string;
    closeCodes: { superseded: number; gone: number };
  };
}
interface EventDecl {
  description?: string;
  schema: unknown;
}
/** The keys inside `x-shepherd-events` that document the socket rather than name a frame:
 *  `description` (prose) and `envelope` (the `$ref` to EventEnvelope, which is the shape of EVERY
 *  frame and therefore not an event of its own). */
const NON_EVENT_KEYS: ReadonlySet<string> = new Set(["description", "envelope"]);
export interface ResponseDecl {
  content?: { "application/json": { schema: unknown } };
  /** Response headers the client may rely on; `required: true` ones are asserted present. */
  headers?: Record<string, { required?: boolean }>;
}
export interface Operation {
  operationId: string;
  security?: unknown[];
  responses: Record<string, ResponseDecl | { $ref: string }>;
}

interface PathItem extends Record<string, unknown> {
  parameters?: unknown[];
}

const CONTRACT_PATH = join(import.meta.dir, "..", "..", "contracts", "openapi.yaml");
const CONTRACT_ID = "https://shepherd.run/contracts/openapi.yaml";

let cached: Contract | null = null;
export function loadContract(): Contract {
  if (!cached) cached = Bun.YAML.parse(readFileSync(CONTRACT_PATH, "utf8")) as Contract;
  return cached;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  ajv.addSchema(loadContract() as unknown as object, CONTRACT_ID);
  registered = true;
}
const compiled = new Map<string, ValidateFunction>();
function compileRef(pointer: string): ValidateFunction {
  ensureRegistered();
  let fn = compiled.get(pointer);
  if (!fn) {
    fn = ajv.compile({ $ref: `${CONTRACT_ID}${pointer}` });
    compiled.set(pointer, fn);
  }
  return fn;
}

const coveredOperations = new Set<string>();
const coveredEvents = new Set<string>();
export function coverage() {
  return { operations: coveredOperations, events: coveredEvents };
}

function fail(msg: string, errors: unknown): never {
  throw new Error(`${msg}\n${JSON.stringify(errors, null, 2)}`);
}

/** Resolve a `#/…` JSON pointer (RFC 6901) against the contract document. */
function resolveRef(contract: Contract, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref (must be a local pointer): ${ref}`);
  let node: unknown = contract;
  for (const raw of ref.slice(2).split("/")) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof node !== "object" || node === null) throw new Error(`cannot resolve ${ref}`);
    node = (node as Record<string, unknown>)[key];
  }
  if (node === undefined) throw new Error(`$ref not found: ${ref}`);
  return node;
}

/** Asserts `res.status` is declared for `method template` in the contract, validates the JSON
 *  body against the declared schema (if any), records coverage, returns the parsed body. */
export async function validateResponse(
  method: string,
  template: string,
  res: Response,
): Promise<unknown> {
  const contract = loadContract();
  const op = contract.paths[template]?.[method.toLowerCase()] as Operation | undefined;
  if (!op) throw new Error(`contract has no operation ${method} ${template}`);
  const status = String(res.status);
  const rawDeclared = op.responses[status];
  if (!rawDeclared) {
    throw new Error(
      `${method} ${template} returned ${status}, contract declares ${Object.keys(op.responses).join(", ")}`,
    );
  }
  let pointer = `#/paths/${pointerSegment(template)}/${method.toLowerCase()}/responses/${status}`;
  let declared: ResponseDecl;
  if ("$ref" in rawDeclared) {
    pointer = rawDeclared.$ref;
    declared = resolveRef(contract, rawDeclared.$ref) as ResponseDecl;
  } else {
    declared = rawDeclared;
  }
  coveredOperations.add(`${method.toUpperCase()} ${template} ${status}`);
  // A header the contract marks `required` is part of the promise (the native client's whole login
  // flow hangs off Set-Cookie), so a missing one fails the same way a bad body does.
  for (const [name, decl] of Object.entries(declared.headers ?? {})) {
    if (decl?.required === true && res.headers.get(name) === null) {
      throw new Error(`${method} ${template} ${status}: missing required header ${name}`);
    }
  }
  const schema = declared.content?.["application/json"]?.schema;
  if (schema === undefined) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    throw new Error(`${method} ${template} ${status}: body is not JSON (${String(e)})`, {
      cause: e,
    });
  }
  const fn = compileRef(`${pointer}/content/application~1json/schema`);
  if (!fn(body)) fail(`${method} ${template} ${status} body violates contract`, fn.errors);
  return body;
}

export function validateEvent(name: string, data: unknown): void {
  const contract = loadContract();
  const decl = contract["x-shepherd-events"][name];
  if (NON_EVENT_KEYS.has(name) || typeof decl !== "object" || !decl || !("schema" in decl)) {
    throw new Error(`contract has no event ${name}`);
  }
  const fn = compileRef(`#/x-shepherd-events/${pointerSegment(name)}/schema`);
  if (!fn(data)) fail(`event ${name} payload violates contract`, fn.errors);
  coveredEvents.add(name);
}

/** One JSON-pointer segment: `~0`/`~1` escapes first (RFC 6901), then percent-encoding for the
 *  URI fragment (`/api/sessions/{id}` → `~1api~1sessions~1%7Bid%7D`). */
function pointerSegment(key: string): string {
  return encodeURIComponent(key.replace(/~/g, "~0").replace(/\//g, "~1"));
}

export interface ContractServer extends ContractDeps {
  baseUrl: string;
  wsUrl: string;
  stop(): void;
}

export function startContractServer(): ContractServer {
  const cd = makeContractDeps();
  const server = serve(cd.deps, 0);
  return {
    ...cd,
    baseUrl: `http://127.0.0.1:${server.port}`,
    wsUrl: `ws://127.0.0.1:${server.port}`,
    stop() {
      server.stop(true);
      cd.cleanup();
    },
  };
}

export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
] as const;

/** Every "METHOD /template status" combination the contract declares. */
export function declaredOperations(): string[] {
  const out: string[] = [];
  for (const [template, methods] of Object.entries(loadContract().paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!HTTP_METHODS.includes(method as never)) continue;
      for (const status of Object.keys((op as Operation).responses)) {
        out.push(`${method.toUpperCase()} ${template} ${status}`);
      }
    }
  }
  return out;
}

export function declaredEvents(): string[] {
  return Object.keys(loadContract()["x-shepherd-events"]).filter((k) => !NON_EVENT_KEYS.has(k));
}

/** Secured operations: everything without an explicit `security: []`. */
export function securedOperations(): { method: string; template: string }[] {
  const out: { method: string; template: string }[] = [];
  for (const [template, methods] of Object.entries(loadContract().paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!HTTP_METHODS.includes(method as never)) continue;
      const security = (op as Operation).security;
      const isPublic = Array.isArray(security) && security.length === 0;
      if (!isPublic) out.push({ method, template });
    }
  }
  return out;
}

// ── auth bootstrap (issue #1079 / #2082) ───────────────────────────────────
// The gate is open when NO auth is configured (checkAuth's un-bootstrapped escape hatch), so a
// contract run that wants to prove the gate has to turn it on the way bootstrapAuth() does at
// boot — and put config back afterwards, because config is a process-wide singleton the rest of
// the suite shares.

export const PASSWORD = "operator-password";
const SECRET = "contract-cookie-signing-secret";
let saved: { secret: string | null; hash: string | null; token: string | null } | null = null;

/** Turn the auth gate on the way bootstrapAuth() does at boot. */
export async function withAuth(): Promise<void> {
  saved = { secret: config.cookieSecret, hash: config.passwordHash, token: config.token };
  config.cookieSecret = SECRET;
  config.passwordHash = await hashPassword(PASSWORD);
  config.token = null;
}

export function restoreAuth(): void {
  if (!saved) return;
  config.cookieSecret = saved.secret;
  config.passwordHash = saved.hash;
  config.token = saved.token;
  saved = null;
}

/** Log in and return the raw `name=value` cookie pair, ready for a `cookie:` request header. */
export async function login(s: ContractServer, password = PASSWORD): Promise<string> {
  const res = await fetch(`${s.baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  await validateResponse("POST", "/api/login", res);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const pair = setCookie.split(";")[0] ?? "";
  if (!pair.startsWith(`${SESSION_COOKIE}=`)) {
    throw new Error(`no ${SESSION_COOKIE} cookie in ${setCookie}`);
  }
  return pair;
}

/** Mint a `full`-scope access token through the real route; returns the plaintext and its id. */
export async function mintToken(
  s: ContractServer,
  cookie: string,
  name = "contract test",
): Promise<{ token: string; id: string }> {
  const res = await fetch(`${s.baseUrl}/api/access-tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name, expiresInDays: null, scope: "full" }),
  });
  const body = (await validateResponse("POST", "/api/access-tokens", res)) as {
    token: string;
    entry: { id: string };
  };
  return { token: body.token, id: body.entry.id };
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Opens /events with a bearer token, runs `drive`, resolves with every frame received until
 *  `settleMs` of silence after the LAST received frame (re-armed on every message), bounded by
 *  `deadlineMs` overall. The socket is always closed exactly once, so a failing assertion
 *  downstream can't leave a dangling subscription behind. An error or a premature close (before
 *  collection has settled) rejects instead of returning partial frames, and the whole thing times
 *  out instead of hanging forever if the server never talks. */
export async function collectEvents(
  s: ContractServer,
  token: string,
  drive: () => Promise<void>,
  settleMs = 150,
  deadlineMs = 5000,
): Promise<{ event: string; data: unknown }[]> {
  const frames: { event: string; data: unknown }[] = [];
  // Bun's WebSocket constructor takes `{ headers }` as its second argument; the DOM lib typing
  // this repo compiles against does not know about it.
  const ws = new WebSocket(`${s.wsUrl}/events`, { headers: bearer(token) } as never);
  let closed = false;
  const closeOnce = (): void => {
    if (closed) return;
    closed = true;
    ws.close();
  };
  try {
    let settled = false;
    let driveDone = false;
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(
          new Error(
            `events collection timed out after ${deadlineMs}ms (received ${frames.length} frames)`,
          ),
        );
      }, deadlineMs);
      let settleTimer: ReturnType<typeof setTimeout> | null = null;
      // Only meaningful once `drive()` has resolved: (re-)starts the silence window, so the
      // settle clock always measures time since the LAST frame, not since drive() returned.
      const armSettle = (): void => {
        if (!driveDone) return;
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settled = true;
          clearTimeout(deadline);
          resolve();
        }, settleMs);
      };
      const finish = (): void => {
        clearTimeout(deadline);
        if (settleTimer) clearTimeout(settleTimer);
      };
      // Install every handler BEFORE the open handshake resolves, so a frame that arrives in the
      // gap between `open` and a later `onmessage` assignment is never silently dropped.
      ws.onmessage = (m) => {
        frames.push(JSON.parse(String(m.data)));
        armSettle();
      };
      ws.onerror = (e) => {
        finish();
        reject(new Error(`events ws error: ${String(e)}`));
      };
      ws.onclose = (e) => {
        if (settled) return; // expected: our own close() after settling
        finish();
        reject(new Error(`events ws closed early: code=${e.code} reason=${e.reason}`));
      };
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "presence", active: true }));
        void drive()
          .then(() => {
            driveDone = true;
            armSettle();
          })
          .catch((err: unknown) => {
            finish();
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      };
    });
  } finally {
    closeOnce();
  }
  return frames;
}
