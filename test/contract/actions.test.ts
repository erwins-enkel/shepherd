import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fx from "./actions-fixtures";
import {
  bearer,
  collectEvents,
  coverage,
  login,
  mintToken,
  restoreAuth,
  startContractServer,
  validateEvent,
  validateResponse,
  withAuth,
  type ContractServer,
} from "./harness";
import { eventsForStream, operationsForStream } from "./stream-blocks";

/** This block's own coverage gate, so the stream proves its surface whichever file Bun runs
 *  first; the gate in openapi.test.ts covers the core block and subtracts this one.
 *
 *  Derived from the contract, never hand-kept. A literal list drifts silently in one direction
 *  only — a status declared in `paths:` but forgotten here is declared-but-unexercised, and
 *  nothing anywhere catches it, which is the exact hole the per-stream split exists to close.
 *  `operationsForStream` reads the same marked block this task writes, so the gate fails the
 *  moment the two disagree. */
const OPERATIONS = operationsForStream("actions");
const EVENTS = eventsForStream("actions");

let s: ContractServer;
let token: string;

/** JSON POST with the bearer. Every route in this block takes a JSON body or none; the ones
 *  that gate on the content-type (reply/rename/amendments/ready) get one unconditionally. */
async function post(path: string, body?: unknown, auth = true): Promise<Response> {
  return fetch(`${s.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? bearer(token) : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
}

async function createSession(prompt: string): Promise<string> {
  const res = await fetch(`${s.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ repoPath: s.validRepo, baseBranch: "main", prompt }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

beforeAll(async () => {
  await withAuth();
  s = startContractServer();
  ({ token } = await mintToken(s, await login(s), "actions contract test"));
});
afterAll(() => {
  try {
    s?.stop();
  } finally {
    restoreAuth();
  }
});

describe("resume", () => {
  test("adopts a session that has a conversation, refuses one that has none", async () => {
    const id = await createSession("resume me");
    // resumeTarget() needs hasConversation(): a claude session id. The stub spawns a pane but
    // never records one, so this is the one piece of state the route cannot reach on its own.
    s.deps.store.update(id, { claudeSessionId: "claude-fixture" });
    const ok = await post(`/api/sessions/${id}/resume`, { force: false });
    expect(ok.status).toBe(200);
    const body = (await validateResponse("POST", "/api/sessions/{id}/resume", ok)) as {
      id: string;
    };
    expect(body.id).toBe(id);

    const gone = await post("/api/sessions/nope/resume", {});
    expect(gone.status).toBe(409);
    await validateResponse("POST", "/api/sessions/{id}/resume", gone);

    const anon = await post(`/api/sessions/${id}/resume`, {}, false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/sessions/{id}/resume", anon);
  });
});

describe("rename", () => {
  // The stub session is isolated with a branch and no prCache, so resolveRenameBranch always
  // says "move the branch" — and test/contract/deps.ts's worktree stub has no renameBranch, whose
  // TypeError the handler would map to 409. Supply the one missing method for this file's server
  // (torn down in afterAll) so the happy path is the server's, not a swallowed throw.
  beforeAll(() => {
    s.stubs.worktree.renameBranch = () => {};
  });

  test("renames, rejects an empty name and an unknown id", async () => {
    const id = await createSession("rename me");
    const ok = await post(`/api/sessions/${id}/rename`, { name: "fresh name" });
    expect(ok.status).toBe(200);
    const body = (await validateResponse("POST", "/api/sessions/{id}/rename", ok)) as {
      session: { name: string };
      branchRenamed: boolean;
    };
    expect(body.session.name).toBe("fresh-name");
    expect(body.branchRenamed).toBe(true);

    const bad = await post(`/api/sessions/${id}/rename`, { name: "   " });
    expect(bad.status).toBe(400);
    await validateResponse("POST", "/api/sessions/{id}/rename", bad);

    const gone = await post("/api/sessions/nope/rename", { name: "x" });
    expect(gone.status).toBe(404);
    await validateResponse("POST", "/api/sessions/{id}/rename", gone);

    const anon = await post(`/api/sessions/${id}/rename`, { name: "x" }, false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/sessions/{id}/rename", anon);
  });

  // 409 name_taken is the pre-check in handleSessionRename: a branch-moving rename whose target
  // `shepherd/<slug>` already exists. test/contract/deps.ts hardcodes worktree.branchExists to
  // false (nothing is ever taken), so the stub is swapped for the one request that must collide.
  test("refuses a rename onto a branch name that is already taken", async () => {
    const id = await createSession("collide me");
    const saved = s.stubs.worktree.branchExists;
    s.stubs.worktree.branchExists = () => true;
    try {
      const taken = await post(`/api/sessions/${id}/rename`, { name: "already taken" });
      expect(taken.status).toBe(409);
      await validateResponse("POST", "/api/sessions/{id}/rename", taken);
    } finally {
      s.stubs.worktree.branchExists = saved;
    }
  });
});

describe("amendments", () => {
  test("records an amendment, rejects an empty one and an unknown id", async () => {
    const id = await createSession("amend me");
    const ok = await post(`/api/sessions/${id}/amendments`, {
      text: "Also cover the admin route.",
      steer: false,
    });
    expect(ok.status).toBe(201);
    const body = (await validateResponse("POST", "/api/sessions/{id}/amendments", ok)) as {
      amendment: { sessionId: string; retractedAt: number | null };
      steered: boolean;
    };
    expect(body.amendment.sessionId).toBe(id);
    expect(body.amendment.retractedAt).toBeNull();
    expect(body.steered).toBe(false);

    const bad = await post(`/api/sessions/${id}/amendments`, { text: "   " });
    expect(bad.status).toBe(400);
    await validateResponse("POST", "/api/sessions/{id}/amendments", bad);

    const gone = await post("/api/sessions/nope/amendments", { text: "x" });
    expect(gone.status).toBe(404);
    await validateResponse("POST", "/api/sessions/{id}/amendments", gone);

    const anon = await post(`/api/sessions/${id}/amendments`, { text: "x" }, false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/sessions/{id}/amendments", anon);
  });
});

describe("ready to merge", () => {
  test("toggles the flag, rejects a non-boolean and an unknown id", async () => {
    const id = await createSession("ready me");
    const ok = await post(`/api/sessions/${id}/ready`, { ready: true });
    expect(ok.status).toBe(200);
    await validateResponse("POST", "/api/sessions/{id}/ready", ok);
    expect(s.deps.store.get(id)?.readyToMerge).toBe(true);

    const bad = await post(`/api/sessions/${id}/ready`, { ready: "yes" });
    expect(bad.status).toBe(400);
    await validateResponse("POST", "/api/sessions/{id}/ready", bad);

    const gone = await post("/api/sessions/nope/ready", { ready: true });
    expect(gone.status).toBe(404);
    await validateResponse("POST", "/api/sessions/{id}/ready", gone);

    const anon = await post(`/api/sessions/${id}/ready`, { ready: true }, false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/sessions/{id}/ready", anon);
  });
});

describe("relaunch", () => {
  test("spawns a replacement and archives the original", async () => {
    const id = await createSession("relaunch me");
    const ok = await post(`/api/sessions/${id}/relaunch`);
    expect(ok.status).toBe(201);
    const body = (await validateResponse("POST", "/api/sessions/{id}/relaunch", ok)) as {
      session: { id: string };
      archived: boolean;
    };
    expect(body.session.id).not.toBe(id);
    expect(typeof body.archived).toBe("boolean");
  });

  test("rejects an unknown override key, an unknown id and an archived session", async () => {
    const bad = await post(`/api/sessions/${await createSession("bad override")}/relaunch`, {
      notAnOverride: 1,
    });
    expect(bad.status).toBe(400);
    await validateResponse("POST", "/api/sessions/{id}/relaunch", bad);

    const gone = await post("/api/sessions/nope/relaunch");
    expect(gone.status).toBe(404);
    await validateResponse("POST", "/api/sessions/{id}/relaunch", gone);

    const archived = await createSession("archived first");
    const del = await fetch(`${s.baseUrl}/api/sessions/${archived}`, {
      method: "DELETE",
      headers: bearer(token),
    });
    expect(del.status).toBe(200);
    const conflict = await post(`/api/sessions/${archived}/relaunch`);
    expect(conflict.status).toBe(409);
    await validateResponse("POST", "/api/sessions/{id}/relaunch", conflict);

    const anon = await post("/api/sessions/nope/relaunch", {}, false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/sessions/{id}/relaunch", anon);
  });

  // A relaunch whose spawn throws is a downstream failure: 502, the original left intact.
  // Same lever openapi.test.ts uses for the create-session 502.
  test("is 502 when the replacement's spawn fails", async () => {
    const id = await createSession("relaunch fails");
    const saved = s.stubs.herdr.start;
    s.stubs.herdr.start = async () => {
      throw new Error("boom");
    };
    try {
      const res = await post(`/api/sessions/${id}/relaunch`);
      expect(res.status).toBe(502);
      await validateResponse("POST", "/api/sessions/{id}/relaunch", res);
    } finally {
      s.stubs.herdr.start = saved;
    }
    expect(s.deps.store.get(id)?.status).not.toBe("archived");
  });
});

describe("recaps", () => {
  test("GET /api/recaps answers a map", async () => {
    const ok = await fetch(`${s.baseUrl}/api/recaps`, { headers: bearer(token) });
    expect(ok.status).toBe(200);
    expect(await validateResponse("GET", "/api/recaps", ok)).toEqual({});

    const anon = await fetch(`${s.baseUrl}/api/recaps`);
    expect(anon.status).toBe(401);
    await validateResponse("GET", "/api/recaps", anon);
  });

  test("regenerate answers 202 with a status, 404 for an unknown id", async () => {
    const id = await createSession("recap me");
    const ok = await post(`/api/sessions/${id}/recap/regenerate`);
    expect(ok.status).toBe(202);
    const body = (await validateResponse("POST", "/api/sessions/{id}/recap/regenerate", ok)) as {
      ok: boolean;
      status: string;
    };
    expect(body.ok).toBe(true);
    // deps.recap is unwired in test/contract/deps.ts, so the handler's `?? "error"` answers.
    expect(body.status).toBe("error");

    const gone = await post("/api/sessions/nope/recap/regenerate");
    expect(gone.status).toBe(404);
    await validateResponse("POST", "/api/sessions/{id}/recap/regenerate", gone);

    const anon = await post(`/api/sessions/${id}/recap/regenerate`, {}, false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/sessions/{id}/recap/regenerate", anon);
  });
});

describe("actions events", () => {
  test("session:amendments rides a real POST; session:recap comes from the fixture", async () => {
    const id = await createSession("event source");
    const frames = await collectEvents(s, token, async () => {
      await post(`/api/sessions/${id}/amendments`, { text: "Event-driving amendment." });
      s.deps.events.emit("session:recap", { id, recap: fx.recap });
    });
    const seen = new Set<string>();
    for (const frame of frames) {
      if (!EVENTS.includes(frame.event)) continue;
      validateEvent(frame.event, frame.data);
      seen.add(frame.event);
    }
    expect([...seen].sort()).toEqual([...EVENTS].sort());
  });
});

// Stays LAST in this file.
describe("actions coverage gate", () => {
  test("every actions operation and event was exercised", () => {
    const { operations, events } = coverage();
    expect(OPERATIONS.filter((o) => !operations.has(o))).toEqual([]);
    expect(EVENTS.filter((e) => !events.has(e))).toEqual([]);
  });
});
