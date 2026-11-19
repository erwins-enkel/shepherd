import { expect, test } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import { EventHub } from "../src/events";
import type { SessionArtifact } from "../src/session-artifacts";
import { SessionStore } from "../src/store";

// PUT /api/sessions/:id/artifacts/hidden (#3877): the artifact row's "hide for this session" and
// the undo of one hide, kept on the session's artifact list and pushed as `session:artifacts`.

const A: SessionArtifact = {
  url: "https://claude.ai/artifact/AAAAAAAAAAAAAAAAAAAAA1",
  title: "Canvas",
  versions: 2,
  firstSeenAt: 10,
  updatedAt: 20,
  toolUseId: "toolu_2",
  toolUseIds: ["toolu_1", "toolu_2"],
};
const C_URL = "https://claude.ai/artifact/CCCCCCCCCCCCCCCCCCCCC3";

function harness() {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const pushed: { event: string; data: { id: string; artifacts: SessionArtifact[] } }[] = [];
  events.subscribe((event, data) => pushed.push({ event, data: data as never }));
  const deps: AppDeps = {
    store,
    service: {} as never,
    events,
    usageLimits: { limits: () => ({}) } as never,
  };
  const session = store.create({
    name: "t",
    prompt: "p",
    repoPath: "/wt",
    baseBranch: "main",
    branch: "shepherd/t",
    worktreePath: "/wt",
    isolated: false,
    herdrSession: "sess-x",
    herdrAgentId: "agent-x",
    model: null,
  });
  store.setSessionArtifacts(session.id, [A]);
  const app = makeApp(deps);
  const put = (body: unknown, id = session.id, type = "application/json") =>
    app.fetch(
      new Request(`http://x/api/sessions/${id}/artifacts/hidden`, {
        method: "PUT",
        headers: { "content-type": type },
        body: JSON.stringify(body),
      }),
    );
  const artifacts = () => store.get(session.id)?.artifacts ?? [];
  const artifactEvents = () => pushed.filter((p) => p.event === "session:artifacts");
  return { store, session, put, artifacts, artifactEvents };
}

test("a hide stamps the list, persists it and pushes it; its undo clears it", async () => {
  const { session, put, artifacts, artifactEvents } = harness();
  const hidden = await put({ hidden: true });
  expect(hidden.status).toBe(200);
  const body = (await hidden.json()) as {
    id: string;
    artifacts: SessionArtifact[];
    hiddenAt: number;
  };
  expect(body.id).toBe(session.id);
  expect(typeof body.hiddenAt).toBe("number");
  expect(artifacts()).toEqual([{ ...A, hiddenAt: body.hiddenAt }]);
  expect(body.artifacts).toEqual(artifacts());
  expect(artifactEvents().at(-1)?.data).toEqual({ id: session.id, artifacts: artifacts() });

  const undone = await put({ hidden: false, hiddenAt: body.hiddenAt });
  expect(undone.status).toBe(200);
  expect(await undone.json()).toEqual({ id: session.id, artifacts: [A], hiddenAt: null });
  expect(artifacts()).toEqual([A]);
  expect(artifactEvents()).toHaveLength(2);
});

test("hide → new url → a later hide elsewhere → the first hide's undo is refused with 409", async () => {
  const { store, session, put, artifacts, artifactEvents } = harness();
  const first = (await (await put({ hidden: true })).json()) as { hiddenAt: number };
  const fresh: SessionArtifact = {
    url: C_URL,
    title: "C",
    versions: 1,
    firstSeenAt: 30,
    updatedAt: 30,
    toolUseId: "toolu_3",
    toolUseIds: ["toolu_3"],
  };
  store.setSessionArtifacts(session.id, [...artifacts(), fresh]);
  const second = (await (await put({ hidden: true })).json()) as { hiddenAt: number };
  expect(second.hiddenAt).toBeGreaterThan(first.hiddenAt);
  const before = artifacts();
  const events = artifactEvents().length;

  const stale = await put({ hidden: false, hiddenAt: first.hiddenAt });
  expect(stale.status).toBe(409);
  expect(((await stale.json()) as { code: string }).code).toBe("hide_superseded");
  expect(artifacts()).toEqual(before);
  expect(artifacts().every((a) => a.hiddenAt === second.hiddenAt)).toBe(true);
  expect(artifactEvents()).toHaveLength(events);
});

test("a bad body is 400, an unknown session 404, a non-JSON request 415", async () => {
  const { put, artifacts } = harness();
  for (const body of [{}, { hidden: "yes" }, { hidden: false }, { hidden: false, hiddenAt: 1.5 }])
    expect((await put(body)).status).toBe(400);
  expect((await put({ hidden: true }, "missing")).status).toBe(404);
  expect((await put({ hidden: true }, undefined, "text/plain")).status).toBe(415);
  expect(artifacts()).toEqual([A]);
});
