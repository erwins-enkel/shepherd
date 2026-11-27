import { afterEach, beforeEach, expect, test } from "bun:test";
import { makeAgentIngressApp, makeApp, type AppDeps } from "../src/server";
import { config } from "../src/config";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { Session } from "../src/types";

// GET|POST /api/sessions/:id/artifact (#4293): whether the built-in tool trim denies Artifact to a
// session, and the operator's "Enable Artifact for this session".

const ID = "11111111-2222-3333-4444-555555555555";
const SESSION = {
  id: ID,
  prompt: "Build the settings page",
  repoPath: "/repo",
  worktreePath: "/wt",
  status: "done",
} as Session;

let prevTrim: boolean;
beforeEach(() => {
  prevTrim = config.trimBuiltinTools;
  config.trimBuiltinTools = true;
});
afterEach(() => {
  config.trimBuiltinTools = prevTrim;
});

function setup(
  session: Session | null,
  enable: SessionService["enableArtifact"] = async () => {
    throw new Error("enableArtifact not expected");
  },
) {
  const emitted: { event: string; data: unknown }[] = [];
  const calls: string[] = [];
  const deps = {
    store: {
      get: (id: string) => (session && id === session.id ? session : null),
      getRepoConfig: () => ({}) as any,
    } as Partial<SessionStore> as SessionStore,
    service: {
      enableArtifact: async (id: string) => {
        calls.push(id);
        return enable(id);
      },
    } as Partial<SessionService> as SessionService,
    events: {
      emit: (event: string, data: unknown) => emitted.push({ event, data }),
    } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    resolveForge: () => null,
  } as unknown as AppDeps;
  return { app: makeApp(deps), deps, emitted, calls };
}

const req = (method: string, id = ID) =>
  new Request(`http://localhost/api/sessions/${id}/artifact`, {
    method,
    headers: { "content-type": "application/json", Origin: "http://localhost" },
  });

test("GET answers whether the trim denies Artifact to the session", async () => {
  const res = await setup(SESSION).app.fetch(req("GET"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ trimmed: true });

  const design = { ...SESSION, prompt: "/design a hero" } as Session;
  expect(await (await setup(design).app.fetch(req("GET"))).json()).toEqual({ trimmed: false });
  const enabled = { ...SESSION, artifactEnabled: true } as Session;
  expect(await (await setup(enabled).app.fetch(req("GET"))).json()).toEqual({ trimmed: false });
  const archived = { ...SESSION, status: "archived" } as Session;
  expect(await (await setup(archived).app.fetch(req("GET"))).json()).toEqual({ trimmed: false });

  expect((await setup(null).app.fetch(req("GET"))).status).toBe(404);
});

test("POST enables Artifact and nudges clients to the resumed agent", async () => {
  const resumed = { ...SESSION, status: "running", artifactEnabled: true } as Session;
  const { app, emitted, calls } = setup(SESSION, async () => ({
    ok: true,
    session: resumed,
    restarted: true,
  }));
  const res = await app.fetch(req("POST"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ session: resumed, restarted: true });
  expect(calls).toEqual([ID]);
  expect(emitted).toEqual([{ event: "session:status", data: { id: ID, status: "running" } }]);
});

test("POST maps a refusal to 404/409 with its code", async () => {
  const refused = setup(SESSION, async () => ({ ok: false, code: "resume-refused" }));
  const res = await refused.app.fetch(req("POST"));
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "resume-refused", code: "resume-refused" });
  expect(refused.emitted).toEqual([]);

  const gone = setup(SESSION, async () => ({ ok: false, code: "not-found" }));
  expect((await gone.app.fetch(req("POST"))).status).toBe(404);
});

test("the agent ingress never reaches it: an agent cannot enable its own Artifact tool", async () => {
  const { deps, calls } = setup(SESSION);
  const ingress = makeAgentIngressApp(deps);
  for (const method of ["GET", "POST"]) {
    const res = await ingress.fetch(req(method));
    expect(res.status).toBe(404);
  }
  expect(calls).toEqual([]);
});
