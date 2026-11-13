import { expect, test } from "bun:test";
import { SessionStore } from "../src/store";
import { makeAgentIngressApp, type AppDeps } from "../src/server";
import { BrowserTokenSigner } from "../src/browser-token";
import { ASSISTANT_INGRESS_HEADER } from "../src/assistant-ingress";
import { collectProviderHandoff } from "../src/provider-handoff";

function fixture() {
  const store = new SessionStore(":memory:");
  const s = store.create({
    name: "test",
    prompt: "task",
    repoPath: "/r",
    worktreePath: "/wt",
    baseBranch: "main",
    branch: "b",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "old",
    model: null,
  });
  const packet = collectProviderHandoff({
    session: s,
    id: "h",
    targetProvider: "codex",
    now: 1,
    messages: {
      messages: [{ role: "user", text: "answer", ts: 1 }],
      awaitingInput: false,
      pendingQuestion: null,
      unavailable: null,
    },
    queue: store.getBuildQueue(s.id),
  });
  store.putProviderHandoff({
    id: "h",
    sessionId: s.id,
    requestId: "r",
    choice: "codex",
    phase: "sent",
    targetRun: "codex:new",
    updatedAt: 1,
    packet,
  });
  const signer = new BrowserTokenSigner(Buffer.alloc(32, 9));
  const app = makeAgentIngressApp({ store, assistantIngress: signer } as unknown as AppDeps);
  const get = (id: string, handoff = "h", cursor = "", keyId = s.id) =>
    app.fetch(
      new Request(
        `http://localhost/api/sessions/${id}/provider-handoffs/${handoff}${cursor ? `?cursor=${cursor}` : ""}`,
        { headers: { [ASSISTANT_INGRESS_HEADER]: signer.sign(keyId) } },
      ),
    );
  const putQueue = () =>
    app.fetch(
      new Request(`http://localhost/api/sessions/${s.id}/queue`, {
        method: "PUT",
        headers: {
          [ASSISTANT_INGRESS_HEADER]: signer.sign(s.id),
          "content-type": "application/json",
        },
        body: JSON.stringify({ steps: [] }),
      }),
    );
  return { s, get, putQueue };
}

test("handoff readback requires the owning session key and never accepts arbitrary paths", async () => {
  const { s, get } = fixture();
  const good = await get(s.id);
  expect(good.status).toBe(200);
  expect((await good.json()).text).toContain("answer");
  expect((await get(s.id, "h", "-1")).status).toBe(400);
  expect((await get(s.id, "other")).status).toBe(404);
  expect((await get("11111111-2222-3333-4444-555555555555")).status).not.toBe(200);
  expect((await get(s.id, "h", "", "other")).status).not.toBe(200);
  expect((await get(s.id, "h/extra")).status).toBe(404);
});

test("handoff mutation guard still holds with only a persisted session adapter", async () => {
  const { putQueue } = fixture();
  const response = await putQueue();
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe("handoff_in_progress");
});
