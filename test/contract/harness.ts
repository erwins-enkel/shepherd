import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import { serve } from "../../src/server";
import { makeContractDeps, type ContractDeps } from "./deps";

export interface Contract {
  paths: Record<string, Record<string, Operation>>;
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
  const op = contract.paths[template]?.[method.toLowerCase()];
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
  if (!schema) return null;
  const body = await res.json();
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

/** Every "METHOD /template status" combination the contract declares. */
export function declaredOperations(): string[] {
  const out: string[] = [];
  for (const [template, methods] of Object.entries(loadContract().paths)) {
    for (const [method, op] of Object.entries(methods)) {
      for (const status of Object.keys(op.responses)) {
        out.push(`${method.toUpperCase()} ${template} ${status}`);
      }
    }
  }
  return out;
}

export function declaredEvents(): string[] {
  return Object.keys(loadContract()["x-shepherd-events"]);
}
