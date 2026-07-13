import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { Session, DiffResult } from "../src/types";
import { parseUnifiedDiff, toSessionDiff } from "../src/diff";
import { stripPatchForRecap } from "../src/recap";

const SESSION: Session = {
  id: "s1",
  desig: "TASK-01",
  name: "Add feature",
  prompt: "Add the feature",
  repoPath: "/repo",
  baseBranch: "main",
  branch: null, // null branch → empty result, no git shell-out needed
  worktreePath: "/wt",
  isolated: false,
  herdrSession: "default",
  herdrAgentId: "a1",
  claudeSessionId: "c1",
  model: null,
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
  issueNumber: null,
  sandboxApplied: null,
  sandboxDegraded: false,
  egressApplied: false,
  egressDegraded: false,
  research: false,
  epicAuthoring: false,
  landingRepair: false,
  status: "running",
  lastState: "working",
  createdAt: 0,
  updatedAt: 0,
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

function makeDeps(session: Session | null, prCache?: AppDeps["prCache"]): AppDeps {
  const store: Partial<SessionStore> = {
    get: (id) => (session && id === session.id ? session : null),
  };
  return {
    store: store as SessionStore,
    service: {} as SessionService,
    events: { emit: () => {} } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    prCache,
  };
}

test("GET /api/sessions/:id/diff → empty result for a non-isolated session", async () => {
  const app = makeApp(makeDeps(SESSION));
  const res = await app.fetch(new Request("http://localhost/api/sessions/s1/diff"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.head).toBeNull();
  expect(body.files).toEqual([]);
  expect(body.base).toBe("main");
});

test("GET /api/sessions/:id/diff → prefers the PR's cached base over session.baseBranch", async () => {
  // Session stored baseBranch="main" but its PR actually targets "release-1.2" (the TASK-852 shape:
  // base diverges from the stored default). The diff must reflect the PR's base. Using a null-branch
  // session keeps computeDiff side-effect-free while still threading the resolved base into the result.
  const prCache = {
    snapshot: () => ({}),
    get: () =>
      ({ kind: "github", state: "open", checks: "none", baseRefName: "release-1.2" }) as never,
    set: () => {},
    drop: () => {},
  };
  const app = makeApp(makeDeps(SESSION, prCache));
  const res = await app.fetch(new Request("http://localhost/api/sessions/s1/diff"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.base).toBe("release-1.2"); // PR base, NOT the stored "main"
});

test("GET /api/sessions/:id/diff → 404 when session unknown", async () => {
  const app = makeApp(makeDeps(null));
  const res = await app.fetch(new Request("http://localhost/api/sessions/nope/diff"));
  expect(res.status).toBe(404);
});

// ── DiffFile.patch: lossless raw-block capture ──────────────────────────────

const MODIFIED_DIFF = `diff --git a/src/server.ts b/src/server.ts
index 1111111..2222222 100644
--- a/src/server.ts
+++ b/src/server.ts
@@ -40,3 +40,4 @@ function makeApp() {
   const url = new URL(req.url);
-  // old handler
+  if (parts[3] === "diff") {
+    return json(computeDiff());
+  }
`;

const ADDED_DIFF = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
`;

const DELETED_DIFF = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 4444444..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const gone = true;
`;

// Rename WITH a content change — a pure rename has no body lines, so it never gets a
// `patch` (see the "pure rename" test below); this fixture exercises the lossless-block
// requirement for the renamed case.
const RENAMED_WITH_CHANGE_DIFF = `diff --git a/old/name.ts b/new/name.ts
similarity index 90%
rename from old/name.ts
rename to new/name.ts
index 5555555..6666666 100644
--- a/old/name.ts
+++ b/new/name.ts
@@ -1,1 +1,1 @@
-export const old = true;
+export const renamed = true;
`;

const BINARY_DIFF = `diff --git a/logo.png b/logo.png
index 5555555..6666666 100644
Binary files a/logo.png and b/logo.png differ
`;

test.each([
  ["modified", MODIFIED_DIFF],
  ["added", ADDED_DIFF],
  ["deleted", DELETED_DIFF],
  ["renamed", RENAMED_WITH_CHANGE_DIFF],
])("parseUnifiedDiff: captures a lossless raw patch block for a %s file", (_status, text) => {
  const f = parseUnifiedDiff(text)[0]!;
  expect(f.patch).toBeDefined();
  expect(f.patch!.startsWith("diff --git")).toBe(true);
  expect(f.patch).toContain("@@");
  // every non-blank source line must survive verbatim in the captured block
  for (const line of text.split("\n")) {
    if (line === "") continue;
    expect(f.patch).toContain(line);
  }
});

test("parseUnifiedDiff: a pure rename (no body lines) gets no patch", () => {
  const RENAMED = `diff --git a/old/name.ts b/new/name.ts
similarity index 100%
rename from old/name.ts
rename to new/name.ts
`;
  const f = parseUnifiedDiff(RENAMED)[0]!;
  expect(f.patch).toBeUndefined();
});

test("parseUnifiedDiff: patch is omitted for a binary file", () => {
  const f = parseUnifiedDiff(BINARY_DIFF)[0]!;
  expect(f.binary).toBe(true);
  expect(f.patch).toBeUndefined();
});

test("parseUnifiedDiff: patch is omitted for a file truncated by the per-file line cap", () => {
  const big = Array.from({ length: 2100 }, (_, i) => `+line ${i}`).join("\n");
  const text = `diff --git a/big.ts b/big.ts
--- /dev/null
+++ b/big.ts
@@ -0,0 +1,2100 @@
${big}
`;
  const f = parseUnifiedDiff(text)[0]!;
  expect(f.truncated).toBe(true);
  expect(f.patch).toBeUndefined();
});

// ── toSessionDiff: strips `hunks`, keeps `patch` ────────────────────────────

test("toSessionDiff: strips hunks from every file, keeps patch, leaves the rest of DiffResult untouched", () => {
  const files = parseUnifiedDiff(MODIFIED_DIFF + ADDED_DIFF + BINARY_DIFF);
  const result: DiffResult = {
    base: "main",
    baseRef: "origin/main",
    head: "feature",
    fetchFailed: false,
    truncated: false,
    files,
  };
  const wire = toSessionDiff(result);
  expect(wire.base).toBe("main");
  expect(wire.baseRef).toBe("origin/main");
  expect(wire.head).toBe("feature");
  expect(wire.fetchFailed).toBe(false);
  expect(wire.truncated).toBe(false);
  expect(wire.files).toHaveLength(3);
  for (const f of wire.files) {
    expect((f as { hunks?: unknown }).hunks).toBeUndefined();
  }
  // patch survives for the files that had one; still absent for the binary file.
  const modified = wire.files.find((f) => f.path === "src/server.ts")!;
  const added = wire.files.find((f) => f.path === "new.ts")!;
  const binary = wire.files.find((f) => f.path === "logo.png")!;
  expect(modified.patch).toBeDefined();
  expect(added.patch).toBeDefined();
  expect(binary.patch).toBeUndefined();
});

// ── stripPatchForRecap: recap keeps hunks, drops patch ──────────────────────

test("stripPatchForRecap: keeps hunks, drops patch", () => {
  const files = parseUnifiedDiff(MODIFIED_DIFF + ADDED_DIFF);
  // sanity: parseUnifiedDiff really did populate patch, so this test isn't vacuous
  expect(files.every((f) => f.patch)).toBe(true);

  const recapFiles = stripPatchForRecap(files);
  expect(recapFiles).toHaveLength(2);
  for (const f of recapFiles) {
    expect(f.patch).toBeUndefined();
    expect(f.hunks).toBeDefined();
    expect(f.hunks.length).toBeGreaterThan(0);
  }
});
