import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { RESIZE_PREFIX } from "../../src/operator-activity";
import { PTY_GONE_CODE, PTY_SUPERSEDED_CODE } from "../../src/server";
import {
  bearer,
  coverage,
  loadContract,
  login,
  mintToken,
  restoreAuth,
  startContractServer,
  validateResponse,
  withAuth,
  type ContractServer,
} from "./harness";
import { operationsForStream } from "./stream-blocks";

let s: ContractServer;
let token: string;

beforeAll(async () => {
  await withAuth();
  s = startContractServer();
  const cookie = await login(s);
  ({ token } = await mintToken(s, cookie));
});
afterAll(() => {
  try {
    s?.stop();
  } finally {
    restoreAuth();
  }
});

const reply = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${s.baseUrl}/api/sessions/${id}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token), ...headers },
    body: JSON.stringify(body),
  });

describe("POST /api/sessions/{id}/reply", () => {
  test("a live session takes the text (200)", async () => {
    const create = await fetch(`${s.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify({ repoPath: s.validRepo, baseBranch: "main", prompt: "terminal" }),
    });
    const created = (await validateResponse("POST", "/api/sessions", create)) as { id: string };
    expect(create.status).toBe(201);

    const res = await reply(created.id, { text: "keep going" });
    expect(res.status).toBe(200);
    await validateResponse("POST", "/api/sessions/{id}/reply", res);
  });

  test("an unknown id is a contract-shaped 404", async () => {
    const res = await reply("no-such-session", { text: "hello" });
    expect(res.status).toBe(404);
    await validateResponse("POST", "/api/sessions/{id}/reply", res);
  });

  test("a body without text is a contract-shaped 400", async () => {
    const res = await reply("no-such-session", { nope: 1 });
    expect(res.status).toBe(400);
    await validateResponse("POST", "/api/sessions/{id}/reply", res);
  });

  test("a non-JSON content type is a contract-shaped 415", async () => {
    const res = await reply("no-such-session", { text: "hi" }, { "content-type": "text/plain" });
    expect(res.status).toBe(415);
    await validateResponse("POST", "/api/sessions/{id}/reply", res);
  });

  test("no credential is a contract-shaped 401", async () => {
    const res = await fetch(`${s.baseUrl}/api/sessions/x/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(401);
    await validateResponse("POST", "/api/sessions/{id}/reply", res);
  });

  test("the declared request schema is the one the server accepts", () => {
    const schema = loadContract().components.schemas.ReplyRequest as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["text"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(["text"]);
  });
});

describe("x-shepherd-pty documents what the native client relies on", () => {
  test("the constants still match the server", () => {
    const pty = loadContract()["x-shepherd-pty"];
    expect(pty.path).toBe("/pty/{id}");
    expect(pty.query).toEqual(["cols", "rows"]);
    expect(pty.resizePrefix).toBe(RESIZE_PREFIX);
    expect(pty.closeCodes.superseded).toBe(PTY_SUPERSEDED_CODE);
    expect(pty.closeCodes.gone).toBe(PTY_GONE_CODE);
  });

  test("an unknown session id is refused before the upgrade", async () => {
    const res = await fetch(`${s.baseUrl}/pty/no-such-session`, { headers: bearer(token) });
    expect(res.status).toBe(404);
  });

  test("the prose names the pre-upgrade 404 and the scrollback replay", () => {
    const { description } = loadContract()["x-shepherd-pty"];
    expect(description).toContain("404");
    expect(description).toContain("scrollback");
  });
});

// This stream's own coverage gate, the counterpart to the block-aware gate in
// `openapi.test.ts`: that one deliberately skips every path inside a `# ── stream: … ──`
// block, so nothing else polices what this block declares. Stays the LAST describe here.
describe("terminal stream coverage gate", () => {
  test("every operation declared in the terminal block was exercised", () => {
    const { operations } = coverage();
    expect(operationsForStream("terminal").filter((o) => !operations.has(o))).toEqual([]);
  });
});
