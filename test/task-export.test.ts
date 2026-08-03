/** Whole-session export keyed on the Task-ID (issue #1268): GET /api/tasks/:key/{export,transcript}. */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config } from "../src/config";
import { makeApp, makeAgentIngressApp, type AppDeps } from "../src/server";
import { capRaw, RAW_CAP_BYTES } from "../src/task-export";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { Session } from "../src/types";
import { jsonlPathFor } from "../src/usage";

const SESSION: Session = {
  id: "11111111-2222-3333-4444-555555555555",
  desig: "TASK-42",
  name: "Export the world",
  prompt: "export everything",
  repoPath: "/repo",
  baseBranch: "main",
  // null branch → the diff short-circuits to "no-branch" with no git shell-out. Cases that
  // exercise the other diff outcomes override it.
  branch: null,
  worktreePath: "/wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "a1",
  claudeSessionId: "c0ffee00-0000-0000-0000-000000000000",
  model: "opus",
  effort: null,
  readyToMerge: false,
  mergingSince: null,
  mergingTrainId: null,
  mergeTrainPrs: null,
  mergingPrNumber: null,
  autopilotEnabled: null,
  autopilotStepCount: 0,
  autopilotPaused: false,
  autopilotComplete: false,
  autopilotQuestion: null,
  completionRepromptCount: 0,
  planGateEnabled: null,
  planPhase: null,
  autoMergeEnabled: null,
  autoMergeRebaseCount: 0,
  autoMergeRebaseHead: null,
  auto: false,
  issueNumber: 1268,
  sandboxApplied: null,
  sandboxDegraded: false,
  egressApplied: false,
  egressDegraded: false,
  research: false,
  epicAuthoring: false,
  landingRepair: false,
  status: "running",
  lastState: "working",
  createdAt: 10,
  updatedAt: 20,
  archivedAt: null,
  haltReason: null,
  haltedAt: null,
  manualSteps: [],
  manualStepsAckedAt: null,
  experimentId: null,
  experimentRole: null,
  spawnTerminalId: null,
  spawnAccountDir: null,
};

/** Stub store: `get` is the UUID path, `getByDesig` the designation path — exactly the two lookups
 *  the handler chains, so a test can prove which one resolved. */
function makeDeps(session: Session | null): AppDeps {
  const store: Partial<SessionStore> = {
    get: (id) => (session && id === session.id ? session : null),
    getByDesig: (key) => {
      if (!session) return null;
      const k = key.trim().toUpperCase();
      const num = session.desig.slice("TASK-".length);
      return k === session.desig.toUpperCase() || (/^\d+$/.test(k) && Number(k) === Number(num))
        ? session
        : null;
    },
    getSessionUsage: () => null,
  };
  return {
    store: store as SessionStore,
    service: {} as SessionService,
    events: { emit: () => {} } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
  };
}

function writeTranscript(s: Session, text: string): string {
  const p = jsonlPathFor(s.worktreePath, s.claudeSessionId, s.spawnAccountDir);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
}

/** One assistant record with a tool_use — what parseActivity turns into an entry. */
function toolUseLine(name: string, ts: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: {
      role: "assistant",
      model: "claude-opus-5",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [
        { type: "tool_use", id: `tu-${name}-${ts}`, name, input: { file_path: "/a/b.ts" } },
      ],
    },
  });
}

let tmpDir: string;
let origProjectsDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `task-export-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  origProjectsDir = config.claudeProjectsDir;
  config.claudeProjectsDir = tmpDir;
});

afterEach(() => {
  config.claudeProjectsDir = origProjectsDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── key resolution ────────────────────────────────────────────────────────────

test("export resolves the key as desig, bare number, or session UUID", async () => {
  writeTranscript(SESSION, toolUseLine("Edit", "2026-08-01T10:00:00.000Z") + "\n");
  const app = makeApp(makeDeps(SESSION));

  for (const key of ["TASK-42", "task-42", "42", SESSION.id]) {
    const res = await app.fetch(new Request(`http://localhost/api/tasks/${key}/export`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.desig).toBe("TASK-42");
    expect(body.meta.id).toBe(SESSION.id);
  }
});

test("export 404s an unknown key", async () => {
  const app = makeApp(makeDeps(SESSION));
  const res = await app.fetch(new Request("http://localhost/api/tasks/TASK-99/export"));
  expect(res.status).toBe(404);
});

// ── bundle contents ───────────────────────────────────────────────────────────

test("export returns metadata + raw AND parsed transcript in one call", async () => {
  const lines = [
    toolUseLine("Edit", "2026-08-01T10:00:00.000Z"),
    toolUseLine("Bash", "2026-08-01T10:00:01.000Z"),
  ];
  const text = lines.join("\n") + "\n";
  const path = writeTranscript(SESSION, text);

  const app = makeApp(makeDeps(SESSION));
  const res = await app.fetch(new Request("http://localhost/api/tasks/TASK-42/export"));
  expect(res.status).toBe(200);
  const body = await res.json();

  expect(body.meta).toMatchObject({
    desig: "TASK-42",
    id: SESSION.id,
    prompt: "export everything",
    agentProvider: "claude",
    agentSessionId: SESSION.claudeSessionId,
    model: "opus",
    repoPath: "/repo",
    baseBranch: "main",
    issueNumber: 1268,
  });
  expect(body.meta.usage).toBeDefined();

  expect(body.transcript.format).toBe("jsonl");
  expect(body.transcript.path).toBe(path);
  expect(body.transcript.raw).toBe(text); // byte-identical passthrough for re-ingestion
  expect(body.transcript.rawBytes).toBe(Buffer.byteLength(text));
  expect(body.transcript.truncated).toBe(false);
  expect(body.transcript.unavailable).toBeNull();
  expect(body.transcript.entries.map((e: { tool: string }) => e.tool)).toEqual(["Edit", "Bash"]);
});

test("export serves the FULL parsed activity, not the live view's 30-entry tail", async () => {
  const lines = Array.from({ length: 45 }, (_, i) =>
    toolUseLine("Edit", `2026-08-01T10:00:${String(i).padStart(2, "0")}.000Z`),
  );
  writeTranscript(SESSION, lines.join("\n") + "\n");

  const app = makeApp(makeDeps(SESSION));
  const body = await (
    await app.fetch(new Request("http://localhost/api/tasks/TASK-42/export"))
  ).json();
  expect(body.transcript.entries.length).toBe(45);
});

test("export marks a missing transcript file rather than serving an empty one", async () => {
  const app = makeApp(makeDeps(SESSION)); // nothing written to disk
  const body = await (
    await app.fetch(new Request("http://localhost/api/tasks/TASK-42/export"))
  ).json();
  expect(body.transcript.unavailable).toBe("file-missing");
  expect(body.transcript.raw).toBeNull();
  expect(body.transcript.entries).toEqual([]);
});

// ── degradation ───────────────────────────────────────────────────────────────

test("archived session with a torn-down worktree: transcript survives, diff is marked", async () => {
  const archived: Session = {
    ...SESSION,
    status: "archived",
    archivedAt: 999,
    branch: "shepherd/task-42",
    worktreePath: join(tmpDir, "gone-worktree"), // never created
  };
  const text = toolUseLine("Edit", "2026-08-01T10:00:00.000Z") + "\n";
  writeTranscript(archived, text);

  const app = makeApp(makeDeps(archived));
  const body = await (
    await app.fetch(new Request("http://localhost/api/tasks/TASK-42/export"))
  ).json();

  expect(body.meta.archivedAt).toBe(999);
  expect(body.transcript.raw).toBe(text); // the whole point: analysis happens after archive
  expect(body.diff).toBeNull();
  expect(body.diffUnavailable).toBe("worktree-removed");
});

test("a session without a branch reports no-branch rather than an empty diff", async () => {
  writeTranscript(SESSION, toolUseLine("Edit", "2026-08-01T10:00:00.000Z") + "\n");
  const app = makeApp(makeDeps(SESSION));
  const body = await (
    await app.fetch(new Request("http://localhost/api/tasks/TASK-42/export"))
  ).json();
  expect(body.diff).toBeNull();
  expect(body.diffUnavailable).toBe("no-branch");
});

test("codex session: metadata still ships, transcript gap is explicit (pending #1267)", async () => {
  const codex: Session = {
    ...SESSION,
    agentProvider: "codex",
    providerSessionId: "rollout-uuid-1",
  };
  const app = makeApp(makeDeps(codex));
  const res = await app.fetch(new Request("http://localhost/api/tasks/TASK-42/export"));
  expect(res.status).toBe(200); // never a 500
  const body = await res.json();

  expect(body.meta.agentProvider).toBe("codex");
  expect(body.meta.agentSessionId).toBe("rollout-uuid-1"); // provider-agnostic field
  expect(body.transcript.unavailable).toBe("codex-pending-1267");
  expect(body.transcript.raw).toBeNull();
  expect(body.transcript.path).toBeNull();
  expect(body.diffUnavailable).toBe("no-branch"); // diff still attempted, not skipped
});

test("a session with no pinned agent session id reports no-transcript-id", async () => {
  const app = makeApp(makeDeps({ ...SESSION, claudeSessionId: "" }));
  const body = await (
    await app.fetch(new Request("http://localhost/api/tasks/TASK-42/export"))
  ).json();
  expect(body.transcript.unavailable).toBe("no-transcript-id");
  expect(body.meta.agentSessionId).toBeNull();
});

// ── raw cap ───────────────────────────────────────────────────────────────────

test("capRaw keeps whole lines and reports the full on-disk size", () => {
  const line = JSON.stringify({ a: "x".repeat(50) });
  const text = Array.from({ length: 100 }, () => line).join("\n") + "\n";

  const under = capRaw(text, Buffer.byteLength(text));
  expect(under.truncated).toBe(false);
  expect(under.raw).toBe(text);
  expect(under.rawBytes).toBe(Buffer.byteLength(text));

  const over = capRaw(text, 200);
  expect(over.truncated).toBe(true);
  expect(over.rawBytes).toBe(Buffer.byteLength(text)); // FULL size, not the capped length
  expect(Buffer.byteLength(over.raw)).toBeLessThanOrEqual(200);
  expect(over.raw.endsWith("\n")).toBe(true);
  // every retained line is still parseable — a truncated bundle is valid JSONL, not a half record
  for (const l of over.raw.split("\n").filter(Boolean)) expect(() => JSON.parse(l)).not.toThrow();
});

test("capRaw yields an empty prefix when a single record exceeds the cap", () => {
  const huge = JSON.stringify({ a: "x".repeat(500) }) + "\n";
  const r = capRaw(huge, 100);
  expect(r.truncated).toBe(true);
  expect(r.raw).toBe(""); // no complete line fits; rawBytes points the caller at /transcript
  expect(r.rawBytes).toBe(Buffer.byteLength(huge));
});

test("the inline cap is a real budget, not unbounded", () => {
  expect(RAW_CAP_BYTES).toBe(8 * 1024 * 1024);
});

// ── raw transcript stream ─────────────────────────────────────────────────────

test("GET /api/tasks/:key/transcript streams the untruncated JSONL", async () => {
  const text = [
    toolUseLine("Edit", "2026-08-01T10:00:00.000Z"),
    toolUseLine("Bash", "2026-08-01T10:00:01.000Z"),
  ].join("\n");
  writeTranscript(SESSION, text);

  const app = makeApp(makeDeps(SESSION));
  const res = await app.fetch(new Request("http://localhost/api/tasks/42/transcript"));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/x-ndjson");
  expect(res.headers.get("content-disposition")).toContain("TASK-42.jsonl");
  expect(await res.text()).toBe(text);
});

test("transcript route 404s with the same reason code the bundle carries", async () => {
  const app = makeApp(makeDeps({ ...SESSION, agentProvider: "codex" }));
  const res = await app.fetch(new Request("http://localhost/api/tasks/TASK-42/transcript"));
  expect(res.status).toBe(404);
  expect((await res.json()).reason).toBe("codex-pending-1267");

  const missing = makeApp(makeDeps(SESSION)); // claude, but nothing on disk
  const res2 = await missing.fetch(new Request("http://localhost/api/tasks/TASK-42/transcript"));
  expect(res2.status).toBe(404);
  expect((await res2.json()).reason).toBe("file-missing");
});

// ── surface boundaries ────────────────────────────────────────────────────────

test("the auth-exempt agent ingress does NOT expose the export", async () => {
  writeTranscript(SESSION, toolUseLine("Edit", "2026-08-01T10:00:00.000Z") + "\n");
  const ingress = makeAgentIngressApp(makeDeps(SESSION));
  for (const p of ["export", "transcript"]) {
    const res = await ingress.fetch(new Request(`http://localhost/api/tasks/TASK-42/${p}`));
    expect(res.status).toBe(404);
  }
});

test("export sits behind the same operator gate as /api/sessions/:id/* (401 without credentials)", async () => {
  const prevSecret = config.cookieSecret;
  const prevToken = config.token;
  config.cookieSecret = "task-export-test-secret";
  config.token = "task-export-test-token";
  try {
    writeTranscript(SESSION, toolUseLine("Edit", "2026-08-01T10:00:00.000Z") + "\n");
    const app = makeApp(makeDeps(SESSION));
    for (const p of ["export", "transcript"]) {
      const url = `http://localhost/api/tasks/TASK-42/${p}`;
      expect((await app.fetch(new Request(url))).status).toBe(401);
      const ok = await app.fetch(
        new Request(url, { headers: { Authorization: `Bearer ${config.token}` } }),
      );
      expect(ok.status).toBe(200);
    }
  } finally {
    config.cookieSecret = prevSecret;
    config.token = prevToken;
  }
});

test("unrecognised /api/tasks sub-paths fall through to the generic 404", async () => {
  const app = makeApp(makeDeps(SESSION));
  for (const path of [
    "/api/tasks",
    "/api/tasks/TASK-42",
    "/api/tasks/TASK-42/bogus",
    "/api/tasks/TASK-42/export/extra",
  ]) {
    const res = await app.fetch(new Request(`http://localhost${path}`));
    expect(res.status).toBe(404);
  }
});

test("export is GET-only", async () => {
  const app = makeApp(makeDeps(SESSION));
  const res = await app.fetch(
    new Request("http://localhost/api/tasks/TASK-42/export", { method: "POST" }),
  );
  expect(res.status).toBe(404);
});
