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
  const hide = (id = session.id) =>
    app.fetch(new Request(`http://x/api/sessions/${id}/artifacts/hidden`, { method: "PUT" }));
  const undo = (hiddenAt: unknown, id = session.id) =>
    app.fetch(
      new Request(
        `http://x/api/sessions/${id}/artifacts/hidden${hiddenAt === undefined ? "" : `?hiddenAt=${String(hiddenAt)}`}`,
        { method: "DELETE" },
      ),
    );
  const artifacts = () => store.get(session.id)?.artifacts ?? [];
  const artifactEvents = () => pushed.filter((p) => p.event === "session:artifacts");
  return { store, session, hide, undo, artifacts, artifactEvents };
}

test("a hide stamps the list, persists it and pushes it; its undo clears it", async () => {
  const { session, hide, undo, artifacts, artifactEvents } = harness();
  const hidden = await hide();
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

  const undone = await undo(body.hiddenAt);
  expect(undone.status).toBe(200);
  expect(await undone.json()).toEqual({ id: session.id, artifacts: [A], hiddenAt: null });
  expect(artifacts()).toEqual([A]);
  expect(artifactEvents()).toHaveLength(2);
});

test("hide → new url → a later hide elsewhere → the first hide's undo is refused with 409", async () => {
  const { store, session, hide, undo, artifacts, artifactEvents } = harness();
  const first = (await (await hide()).json()) as { hiddenAt: number };
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
  const second = (await (await hide()).json()) as { hiddenAt: number };
  expect(second.hiddenAt).toBeGreaterThan(first.hiddenAt);
  const before = artifacts();
  const events = artifactEvents().length;

  const stale = await undo(first.hiddenAt);
  expect(stale.status).toBe(409);
  expect(((await stale.json()) as { code: string }).code).toBe("hide_superseded");
  expect(artifacts()).toEqual(before);
  expect(artifacts().every((a) => a.hiddenAt === second.hiddenAt)).toBe(true);
  expect(artifactEvents()).toHaveLength(events);
});

test("an undo without a valid stamp is 400, an unknown session 404", async () => {
  const { hide, undo, artifacts } = harness();
  for (const stamp of [undefined, "", "abc", "1.5", "-3", "9".repeat(17)])
    expect((await undo(stamp)).status).toBe(400);
  expect((await hide("missing")).status).toBe(404);
  expect((await undo(1, "missing")).status).toBe(404);
  expect(artifacts()).toEqual([A]);
});

test("an undo after hide → undo → hide is refused: stamps are never reused", async () => {
  const { hide, undo, artifacts } = harness();
  const first = (await (await hide()).json()) as { hiddenAt: number };
  expect((await undo(first.hiddenAt)).status).toBe(200);
  const second = (await (await hide()).json()) as { hiddenAt: number };
  expect(second.hiddenAt).toBeGreaterThan(first.hiddenAt);
  expect((await undo(first.hiddenAt)).status).toBe(409);
  expect(artifacts().every((a) => a.hiddenAt === second.hiddenAt)).toBe(true);
});
