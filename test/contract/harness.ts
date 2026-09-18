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
  "x-shepherd-events": Record<string, { description?: string; schema: unknown }>;
  "x-shepherd-pty": {
    path: string;
    query: string[];
    resizeFrame: string;
    closeCodes: { superseded: number; gone: number };
  };
}
interface Operation {
  operationId: string;
  responses: Record<string, { content?: { "application/json": { schema: unknown } } }>;
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
  const declared = op.responses[status];
  if (!declared) {
    throw new Error(
      `${method} ${template} returned ${status}, contract declares ${Object.keys(op.responses).join(", ")}`,
    );
  }
  coveredOperations.add(`${method.toUpperCase()} ${template} ${status}`);
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
  const fn = compileRef(
    `#/paths/${pointerSegment(template)}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`,
  );
  if (!fn(body)) fail(`${method} ${template} ${status} body violates contract`, fn.errors);
  return body;
}

export function validateEvent(name: string, data: unknown): void {
  const contract = loadContract();
  if (!contract["x-shepherd-events"][name]) throw new Error(`contract has no event ${name}`);
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

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;

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
  return Object.keys(loadContract()["x-shepherd-events"]);
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
