# Stream S12 — Settings, tokens and command surface Implementation Plan

**Goal:** finish the SwiftUI Settings scene, safe token administration, workspace and diagnostic controls, local appearance and the shared command surface.

**Architecture:** contract-first generated payloads, one `ShepherdClient+Settings.swift`
extension, activation-scoped observable models and SwiftUI views. Stream registration is split
between the model-free `installScene()` pass and `install(app)` after the store exists.

**Tech stack:** Swift 6, complete strict concurrency, SwiftUI, Observation, Swift Testing,
Bun contract tests and the repository's existing OpenAPI generator.

## Global Constraints

<!-- prettier-ignore-start -->


- **Swift 6 strict concurrency** (`SWIFT_STRICT_CONCURRENCY: complete`, `swiftLanguageModes: [.v6]`).
  No `@preconcurrency`, no `@unchecked Sendable`, no `nonisolated(unsafe)`.
- **No hand-written `Codable` for server payloads.** The contract is the only type source: a route
  or event this stream needs is added to `contracts/openapi.yaml` first, then
  `bun run gen:contract-swift` + `./native/scripts/sync-contract.sh` regenerate and copy the derived
  file. Never hand-edit `contracts/openapi.swift.yaml` or `native/Sources/ShepherdKit/openapi.yaml`.
- **ShepherdKit has no UI dependency.** Nothing under `native/Sources/` imports SwiftUI or AppKit.
- **Every new view is AppKit-free.** No `NSEvent`, no `NSColor`, no `NSWindow`.
- **Strings only via `L.t()`**, with every key present in **both** `ui/messages/en.json` and
  `ui/messages/de.json` and listed in `KEYS_HERD` in `native/scripts/gen-strings.ts`. Never add a
  string only in Swift. German copy matches the web UI verbatim — reuse the web's key rather than
  writing a second translation.
- **No Keychain prompts.** Build and test through `./native/scripts/build-app.sh` and
  `./native/scripts/test-app.sh` (which export `SHEPHERD_ISOLATED=1`). `SHEPHERD_KEYCHAIN_TESTS` is
  **never** set locally — it is CI's switch for the real-keychain suite.
- **`bun run test`, never bare `bun test`** (repo `CLAUDE.md`).
- **`bun run typecheck` is a gate**, alongside `bun run lint` and `bun run test:contract`.
- **Live tests read `SHEPHERD_LIVE_BASE_URL` / `SHEPHERD_LIVE_PASSWORD` from the environment only**
  — or `SHEPHERD_LIVE_TOKEN` for the read-only suite. Never from a file, never in CI. The
  `TEST_RUNNER_` prefix is how `xcodebuild` forwards them; set
  `TEST_RUNNER_SHEPHERD_REVOKE_ON_EXIT=1` for any live run. A base URL always goes through
  `RemoteServerForm.normalize` before it reaches a `ServerProfile`.
- **XCUITest runs serialised** — one worktree at a time; parallel `xcodebuild` runs fight over
  `testmanagerd`.
- **`git checkout -- native/Package.resolved` after `swift test --package-path native`.**
- **No `.toolbar` inside a `DetailTab`** — the `TabView` keeps every visited child alive and AppKit
  eventually throws out of `-[NSToolbar _insertNewItemWithItemIdentifier:…]`. This stream registers
  no tab at all, so the rule bites only if somebody adds one.
- **A cancelled event tap still hands you its buffered frames**, so stamp work with a generation
  rather than trusting cancellation, and **finish** every `AsyncStream` watcher in `teardown()` —
  never park one on a bare `withCheckedContinuation`.
- **Commits:** conventional, lowercase subject; body lines ≤ 100 chars; a **blank line** before the
  trailer, and the body ends with
  `Co-Authored-By: <executing model name> <noreply@anthropic.com>`.
- **Push with `git push --no-verify`.**
- **Never edit `native/Apps/ShepherdMac/Sources/App/StreamRegistrations.swift`** inside this
  stream. It ships `HerdStream.install(app)` and the integration lane (S0-int) adds the one line.
- **Logging:** `run.shepherd.mac` (app), `run.shepherd.kit` (kit).
- **Branch:** `feat/native-herd`, cut from `origin/main` **after S0-prep-2 merges**. Rebase to
  update; never `git merge main`.

| Command (repo root) | What it proves |
| --- | --- |
| `bun run test:contract` | the contract matches the real server |
| `bun run gen:contract-swift` | regenerates `contracts/openapi.swift.yaml` |
| `./native/scripts/sync-contract.sh` | copies the derived file into the kit target |
| `bun run typecheck` | the fixtures typecheck |
| `swift test --package-path native` | kit compiles, kit tests pass |
| `./native/scripts/test-app.sh -only-testing:ShepherdTests` | app unit tests pass |
| `./native/scripts/build-app.sh` | `Shepherd.app` builds |
| `bun run check:strings` | `Localizable.xcstrings` is current |
| `bun run lint` · `bun run test` | repo gates |

<!-- prettier-ignore-end -->

### Stream-specific bindings to the verbatim baseline

The preceding S7 block is reproduced verbatim. In this stream its three S7-specific bindings are
`KEYS_SETTINGS`, `SettingsFeature.install(app)`, and
`feat/native-settings`. All other rules apply literally. This stream **does** install views, so the
no-`.toolbar` rule applies to every detail tab. Every `AppModel` test supplies both
`InMemoryCredentialStore` and a UUID-named throwaway `UserDefaults` suite, removed in `defer`.
No test opens the Keychain. Use `SHEPHERD_LIVE_TOKEN` for these read-only checks; the supplied
operator token is never revoked. `REVOKE_ON_EXIT` applies only to credentials a harness itself
mints, never to an environment-provided token.

### Ownership, prerequisites and verified decisions

Own `Sources/Settings/**`, `ShepherdClient+Settings.swift`, `ShepherdClientSettingsTests.swift`,
`Tests/Settings*Tests.swift`, `test/contract/settings.test.ts` and `settings-fixtures.ts`, the three `settings` contract
blocks, generated contract copies, `KEYS_SETTINGS`, append-only EN/DE keys and generated strings.
App paths are relative to `native/Apps/ShepherdMac/`; kit paths use `native/Sources/ShepherdKit/Client/`
and `native/Tests/ShepherdKitTests/`. Run alone in Phase E after S0-prep-2 and S7–S11. S9's tested
`x-shepherd-explicit-null` generator prerequisite must already be in S0: this stream uses it for
`RepoRolesPatch` so clearing a role sends null rather than omitting the field.

The only core contract edits are **adding `patch:` to the existing `/api/settings` path** and
expanding **`Settings`**. Keep existing GET and PUT `putRepoRoot` intact. Never duplicate the core
access-token paths, login, repo listing, usage limits, or S11's `/api/repos/init-empty-commit`.
Never edit `StreamRegistrations.swift`, `ShepherdApp.swift`, `AppModel.swift`, `MainWindow.swift`,
`SessionSignals.swift`, `SessionStore`,
`EventName`, shared harness files, or S6's files inside this stream. Task 9 gives S0 exact integration
changes, including retirement of S6's AppKit window and notification delivery hooks.

- **PATCH is not implemented today.** `handleSettings` accepts GET/PUT, and PUT dispatches only the
  first recognized setting. S0 must land Task 1's small server alias before S12's contract passes.
  The new PATCH deliberately accepts exactly one known non-root setting, so a native form cannot
  silently lose a batch. PATCH responses are partial; refresh GET after each success. The existing
  repo-root PUT remains the folder-picker operation. This is a prerequisite, not an authorization
  for S12 to edit `src/server.ts` or silently relabel PUT as PATCH.
- The appendix status rows are claims, not authority. Repo roles PUT can return **502 with
  `RepoRolesResult`**, not `Error`. Pull's 409/502 return **`RepoPullResult`**, not `Error`.
  Diagnostics fix adds 409/502/503. Verify-key is 200/401/409/503, with no 400. Directory traversal
  is clamped and returns 200, not 400. Fork succeeds with 201 and can return 409/422/504.
- Access-token GET/mint require a signed **operator cookie**; a full bearer still gets 403.
  Use a short-lived `ShepherdClient` with empty in-memory credentials and an ephemeral cookie jar,
  after password reauthentication. Do not build another generated `Client` or repurpose the
  active bearer. Token plaintext lives only in view/model memory and disappears on close/switch.
- Repo role saves commit and push `.shepherd/roles.json`; fork, sync, pull, diagnostics fixes and
  key verification also do real work. Every such action requires an explicit operator click,
  and fix/role/repository mutation controls show a confirmation. Live checks in Task 11 are GET-only.
- Appearance is device-local (`UserDefaults`); `reducedPushMode` is server-wide plus the native
  delivery filter/evaluator in Task 8. A toggle that changes only the server is incomplete.
- The three usage gaps are covered by rendering `observed`, `perModelWeek`, and `subscriptionOnly`,
  together with credits, calibration and stale state. Use S3's existing usage contract.

| Task | Deliverable                                                             |
| ---- | ----------------------------------------------------------------------- |
| 1    | Verified settings contract, PATCH prerequisite and real-server coverage |
| 2    | Generated wrappers, cookie token administration and transport tests     |
| 3    | Activation-safe settings snapshots and state teardown                   |
| 4    | General settings and CLI/role defaults                                  |
| 5    | Repository config, roles, directory picker and repo operations          |
| 6    | Access-token pane and ephemeral secret lifetime                         |
| 7    | Diagnostics and complete usage detail                                   |
| 8    | Appearance and native reduced-push rules                                |
| 9    | Settings scene panes, command palette, menu commands and S6 retirement  |
| 10   | `KEYS_SETTINGS`, localized dynamic diagnostics and string tests         |
| 11   | Full gates, read-only live smoke and PR                                 |

Contract snippets below are mapping members. When inserting them, indent schema members by four
spaces, path/event members by two, the core PATCH by four, and core Settings properties by eight.
Preserve the existing marked blocks and never insert a second top-level path or schema key.

### Task 1: Declare and verify the settings surface

**Files:** `contracts/openapi.yaml`, generated copies, `test/contract/settings-fixtures.ts`, `settings.test.ts`.

**Interfaces:** consumes S0 markers/stubs, actual handlers and existing core token schemas; produces 12 operations on ten new templates, one core PATCH, one event.

| Operation                       | Declared statuses            |
| ------------------------------- | ---------------------------- |
| `GET /api/repo-config`          | 200, 400, 401                |
| `PUT /api/repo-config`          | 200, 400, 401                |
| `GET /api/repo-roles`           | 200, 400, 401                |
| `PUT /api/repo-roles`           | 200, 400, 401, 502           |
| `GET /api/repo-collaborators`   | 200, 400, 401                |
| `GET /api/diagnostics`          | 200, 401                     |
| `POST /api/diagnostics/fix`     | 200, 400, 401, 409, 502, 503 |
| `POST /api/settings/verify-key` | 200, 401, 409, 503           |
| `GET /api/fs/dirs`              | 200, 401                     |
| `POST /api/repos/pull`          | 200, 400, 401, 409, 502      |
| `POST /api/repos/fork`          | 201, 400, 401, 409, 422, 504 |
| `POST /api/repos/sync-fork`     | 200, 400, 401, 409, 502      |
| `PATCH /api/settings`           | 200, 400, 401                |

- [ ] **Step 1: Write fixtures and real-server assertions first**

```ts
// test/contract/settings-fixtures.ts
import type { DiagnosticsSnapshot } from "../../src/types";
export const diagnostic: DiagnosticsSnapshot = {
  generatedAt: 123,
  overall: "warning",
  checks: [
    {
      id: "bun",
      state: "warning",
      hintKey: "diagnostics_hint_bun_missing",
      remediation: "fixture-only-command",
    },
  ],
};
```

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
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
import { operationsForStream, eventsForStream } from "./stream-blocks";
import { config } from "../../src/config";
import { firstRun } from "../../src/first-run";
import { diagnostic } from "./settings-fixtures";
let s: ContractServer, token: string, cookie: string;
const OPS = operationsForStream("settings"),
  EVENTS = eventsForStream("settings");
async function request(
  method: string,
  template: string,
  status: number,
  body?: unknown,
  path = template,
  headers: Record<string, string> = bearer(token),
) {
  const res = await fetch(s.baseUrl + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(res.status, `${method} ${path}`).toBe(status);
  return await validateResponse(method, template, res);
}
beforeAll(async () => {
  await withAuth();
  s = startContractServer();
  cookie = await login(s);
  ({ token } = await mintToken(s, cookie, "settings contract"));
});
afterAll(() => {
  try {
    s?.stop();
  } finally {
    restoreAuth();
  }
});
test("repo config, role no-op, push refusal and collaborator fallback", async () => {
  const query = `?repo=${encodeURIComponent(s.validRepo)}`;
  for (const path of ["/api/repo-config", "/api/repo-roles", "/api/repo-collaborators"]) {
    await request("GET", path, 200, undefined, path + query);
    await request("GET", path, 400, undefined, path + "?repo=/outside");
  }
  const cfg = (await request(
    "PUT",
    "/api/repo-config",
    200,
    { hidden: true },
    "/api/repo-config" + query,
  )) as { hidden: boolean };
  expect(cfg.hidden).toBe(true);
  await request("PUT", "/api/repo-config", 400, { maxAuto: "many" }, "/api/repo-config" + query);
  await request(
    "PUT",
    "/api/repo-roles",
    200,
    { reviewer: null, merger: null },
    "/api/repo-roles" + query,
  );
  await request("PUT", "/api/repo-roles", 400, null, "/api/repo-roles" + query);
  const saved = s.stubs.resolveForge.forge;
  try {
    s.stubs.resolveForge.forge = null;
    const failed = (await request(
      "PUT",
      "/api/repo-roles",
      502,
      { reviewer: "operator", merger: null },
      "/api/repo-roles" + query,
    )) as { pushError: string };
    expect(failed.pushError).toBe("push rejected");
  } finally {
    s.stubs.resolveForge.forge = saved;
  }
});
test("diagnostics current, refresh, fix and all refusal statuses", async () => {
  const saved = s.deps.diagnostics;
  let currentCalls = 0,
    checkCalls = 0;
  try {
    s.deps.diagnostics = {
      current: async () => {
        currentCalls++;
        return diagnostic;
      },
      check: async () => {
        checkCalls++;
        return diagnostic;
      },
      fix: async (id: string) => {
        if (id === "unknown") throw new Error("unknown check unknown");
        if (id === "broken") throw new Error("fixture failure");
        return diagnostic;
      },
    } as never;
    expect(await request("GET", "/api/diagnostics", 200)).toEqual(diagnostic);
    await request("GET", "/api/diagnostics", 200, undefined, "/api/diagnostics?refresh=1");
    expect(currentCalls).toBe(1);
    expect(checkCalls).toBe(1);
    const frames = await collectEvents(s, token, async () => {
      await request("POST", "/api/diagnostics/fix", 200, { checkId: "bun" });
    });
    const frame = frames.find((f) => f.event === "diagnostics:status");
    expect(frame).toBeDefined();
    validateEvent("diagnostics:status", frame!.data);
    expect(frame!.data).toEqual(diagnostic);
    await request("POST", "/api/diagnostics/fix", 400, {});
    await request("POST", "/api/diagnostics/fix", 409, { checkId: "unknown" });
    await request("POST", "/api/diagnostics/fix", 502, { checkId: "broken" });
    s.deps.diagnostics = undefined;
    await request("POST", "/api/diagnostics/fix", 503, { checkId: "bun" });
  } finally {
    s.deps.diagnostics = saved;
  }
});
test("verify-key is transient work and has no 400 branch", async () => {
  const saved = s.deps.verifyKey,
    pending = firstRun.pending;
  try {
    firstRun.pending = false;
    s.deps.verifyKey = async () => ({ ok: true });
    expect(await request("POST", "/api/settings/verify-key", 200)).toEqual({ ok: true });
    s.deps.verifyKey = undefined;
    await request("POST", "/api/settings/verify-key", 503);
    firstRun.pending = true;
    await request("POST", "/api/settings/verify-key", 409);
  } finally {
    s.deps.verifyKey = saved;
    firstRun.pending = pending;
  }
});
test("directory traversal is clamped rather than 400", async () => {
  const dirs = (await request(
    "GET",
    "/api/fs/dirs",
    200,
    undefined,
    "/api/fs/dirs?path=/outside",
  )) as { path: string; parent: string | null };
  expect(dirs.path).toBe(s.tmpRoot);
  expect(dirs.parent).toBeNull();
});
test("pull uses a temporary local bare remote, never the operator checkout", async () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  const remote = join(s.tmpRoot, "remote.git");
  git(s.tmpRoot, "init", "--bare", remote);
  git(s.validRepo, "init", "-b", "main");
  git(
    s.validRepo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "seed",
  );
  git(s.validRepo, "remote", "add", "origin", remote);
  git(s.validRepo, "push", "-u", "origin", "main");
  const p = "/api/repos/pull";
  const body = { repo: s.validRepo, branch: "main" };
  const ok = (await request("POST", p, 200, body)) as { ok: boolean; updated: boolean };
  expect(ok.ok).toBe(true);
  expect(ok.updated).toBe(false);
  git(s.validRepo, "checkout", "-b", "feature");
  const refused = (await request("POST", p, 409, body)) as { reason: string };
  expect(refused.reason).toBe("wrong_branch");
  git(s.validRepo, "checkout", "main");
  git(s.validRepo, "remote", "set-url", "origin", join(s.tmpRoot, "missing.git"));
  const failed = (await request("POST", p, 502, body)) as { ok: boolean };
  expect(failed.ok).toBe(false);
  await request("POST", p, 400, { repo: "/outside" });
});
test("fork reports 201, rejects targets, existing directories and runner failures", async () => {
  const saved = s.deps.newProjectGhRunner,
    pending = firstRun.pending;
  try {
    firstRun.pending = false;
    const calls: string[][] = [];
    s.deps.newProjectGhRunner = async (args) => {
      calls.push(args);
    };
    const r = (await request("POST", "/api/repos/fork", 201, { target: "fixture/new-repo" })) as {
      name: string;
    };
    expect(r.name).toBe("new-repo");
    expect(calls[1]?.slice(0, 2)).toEqual(["repo", "fork"]);
    await request("POST", "/api/repos/fork", 400, { target: "invalid" });
    await request("POST", "/api/repos/fork", 409, { target: "fixture/repo" });
    s.deps.newProjectGhRunner = async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    await request("POST", "/api/repos/fork", 422, { target: "fixture/new-repo" });
    s.deps.newProjectGhRunner = async (args) => {
      if (args[0] === "repo") throw Object.assign(new Error("timeout"), { code: "_timeout" });
    };
    await request("POST", "/api/repos/fork", 504, { target: "fixture/new-repo" });
    firstRun.pending = true;
    await request("POST", "/api/repos/fork", 409, { target: "fixture/new-repo" });
  } finally {
    s.deps.newProjectGhRunner = saved;
    firstRun.pending = pending;
  }
});
test("sync-fork errors differ from best-effort local pull", async () => {
  const saved = s.stubs.resolveForge.forge;
  const p = "/api/repos/sync-fork",
    body = { repo: s.validRepo };
  try {
    s.stubs.resolveForge.forge = null;
    await request("POST", p, 400, body);
    s.stubs.resolveForge.forge = {
      isFork: true,
      syncFork: async () => {},
      defaultBranch: async () => "main",
    };
    expect(await request("POST", p, 200, body)).toEqual({ ok: true, branch: "main" });
    s.stubs.resolveForge.forge = {
      isFork: true,
      syncFork: async () => {
        throw new Error("diverged");
      },
    };
    await request("POST", p, 409, body);
    s.stubs.resolveForge.forge = {
      isFork: true,
      syncFork: async () => {
        throw new Error("authentication");
      },
    };
    await request("POST", p, 502, body);
  } finally {
    s.stubs.resolveForge.forge = saved;
  }
});
test("approved core PATCH exception writes one field, preserves GET and refuses batches", async () => {
  const saved = config.reducedPushMode;
  try {
    const result = await request("PATCH", "/api/settings", 200, { reducedPushMode: !saved });
    expect(result).toEqual({ reducedPushMode: !saved });
    const settings = (await request("GET", "/api/settings", 200)) as {
      reducedPushMode: boolean;
      hasApiKey: boolean;
    };
    expect(settings.reducedPushMode).toBe(!saved);
    expect(typeof settings.hasApiKey).toBe("boolean");
    expect(settings).not.toHaveProperty("anthropicApiKey");
    await request("PATCH", "/api/settings", 400, { reducedPushMode: "yes" });
    await request("PATCH", "/api/settings", 400, {
      reducedPushMode: true,
      autoReviveEnabled: true,
    });
    await request("PATCH", "/api/settings", 400, { repoRoot: s.tmpRoot });
    await request("PATCH", "/api/settings", 401, { reducedPushMode: true }, undefined, {});
  } finally {
    config.reducedPushMode = saved;
  }
});
test("existing token contract is cookie-admin only", async () => {
  const admin = { cookie };
  await request("GET", "/api/access-tokens", 200, undefined, undefined, admin);
  await request("GET", "/api/access-tokens", 403);
  await request("GET", "/api/access-tokens", 401, undefined, undefined, {});
  await request("POST", "/api/access-tokens", 400, { name: "" }, undefined, admin);
  await request("POST", "/api/access-tokens", 403, { name: "forbidden" });
  await request("POST", "/api/access-tokens", 401, { name: "missing" }, undefined, {});
  const minted = (await request(
    "POST",
    "/api/access-tokens",
    201,
    { name: "fixture", scope: "read", expiresInDays: 30 },
    undefined,
    admin,
  )) as { token: string; entry: { id: string; scope: string } };
  expect(minted.token.startsWith("shp_")).toBe(true);
  expect(minted.entry.scope).toBe("read");
  const path = `/api/access-tokens/${minted.entry.id}`;
  await request("DELETE", "/api/access-tokens/{id}", 403, undefined, path);
  await request("DELETE", "/api/access-tokens/{id}", 401, undefined, path, {});
  await request("DELETE", "/api/access-tokens/{id}", 200, undefined, path, admin);
  await request("DELETE", "/api/access-tokens/{id}", 404, undefined, path, admin);
});
test("settings owns a full unauthenticated sweep and its exception coverage", async () => {
  for (const op of OPS.filter((o) => o.endsWith(" 401"))) {
    const [method, path] = op.split(" ") as [string, string];
    await request(method, path, 401, method === "GET" ? undefined : {}, undefined, {});
  }
  expect(OPS.length).toBeGreaterThan(35);
  expect(EVENTS).toEqual(["diagnostics:status"]);
  const seen = coverage();
  expect(OPS.filter((o) => !seen.operations.has(o))).toEqual([]);
  expect(EVENTS.filter((e) => !seen.events.has(e))).toEqual([]);
  for (const status of [200, 400, 401])
    expect(seen.operations.has(`PATCH /api/settings ${status}`)).toBe(true);
});
```

```bash
bun run test:contract
```

Expected red includes undeclared operations and PATCH returning 404. All write fixtures use the
in-memory store, injected runners/forge or a temporary bare git remote. API-key file writes are
not exercised against the operator's home; wrapper serialization covers that field instead.

- [ ] **Step 2: Have S0 land the exact server prerequisite in its own commit**

Replace the `if (req.method === "PUT")` dispatch opening **inside `handleSettings` only** with:

```ts
if (req.method === "PATCH") {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).length !== 1) {
      return json({ error: "exactly one setting is required" }, 400);
    }
    const field = Object.keys(body)[0]!;
    const handler = SETTING_PATCHES.find(([key]) => key === field)?.[1];
    if (!handler) return json({ error: "unknown setting" }, 400);
    return handler(body[field], deps);
  }
  if (req.method === "PUT") {
```

S0 also updates the **core** coverage predicate in `test/contract/openapi.test.ts` in its own
integration commit. Replace the `missingOps` declaration in the core coverage test with:

```ts
const missingOps = declaredOperations().filter(
  (o) =>
    !owned.has(operationTemplate(o)) && !o.startsWith("PATCH /api/settings ") && !operations.has(o),
);
```

This exempts only the new operation, whose 200/400/401 coverage is asserted in `settings.test.ts`.
GET and PUT remain core-gated; `/api/settings` stays outside the settings block. File execution
order must not make the core gate depend on S12's test having run first. No shared harness change
is made on S12's branch.

The remainder of the existing PUT body stays unchanged. The closing brace above belongs to the
new PATCH branch; the final line opens the existing PUT block. Run `test/contract/settings.test.ts`
after S12's contract is present, plus `test/server-settings.test.ts` on S0's branch. Do not advertise
PATCH until the actual handler has merged. Its 400 behavior is stronger than legacy PUT's
first-match dispatch and intentionally excludes `repoRoot`.

- [ ] **Step 3: Insert complete schemas, paths and event into their marked settings blocks**

```yaml
SettingsPatch:
  type: object
  additionalProperties: false
  properties:
    remoteControlAtStartup:
      type: boolean
    reducedPushMode:
      type: boolean
    sessionHousekeepingEnabled:
      type: boolean
    autoReviveEnabled:
      type: boolean
    upnextSkipCliPicker:
      type: boolean
    usageHoldEnabled:
      type: boolean
    usageHoldAutoRelease:
      type: boolean
    usageDowngradeEnabled:
      type: boolean
    fableAvailable:
      type: boolean
    judgeEnabled:
      type: boolean
    tuiFullscreen:
      type: boolean
    tuiDisableMouse:
      type: boolean
    prReviewCyclesCap:
      type: number
    planReviewCyclesCap:
      type: number
    distillerIntervalDays:
      type: number
    extraCreditsDrainCeiling:
      type: number
    usageHoldPct:
      type: number
    usageDowngradePct:
      type: number
    judgeDailyUsd:
      type: number
    defaultModel:
      type: string
    defaultCodexModel:
      type: string
    defaultEffort:
      type: string
    defaultAgentProvider:
      type: string
    authMode:
      type: string
    operatorLanguage:
      type: string
    usageDowngradeModel:
      type: string
    blockJudgeMode:
      type: string
    houseRuleRelevance:
      type: string
    telemetryConsent:
      type: string
    criticCli:
      type: string
    criticModel:
      type: string
    criticEffort:
      type: string
    plannerCli:
      type: string
    plannerModel:
      type: string
    plannerEffort:
      type: string
    recapCli:
      type: string
    recapModel:
      type: string
    recapEffort:
      type: string
    docAgentCli:
      type: string
    docAgentModel:
      type: string
    docAgentEffort:
      type: string
    distillerCli:
      type: string
    distillerModel:
      type: string
    distillerEffort:
      type: string
    optimizerCli:
      type: string
    optimizerModel:
      type: string
    optimizerEffort:
      type: string
    mergeSuggestCli:
      type: string
    mergeSuggestModel:
      type: string
    mergeSuggestEffort:
      type: string
    namerCli:
      type: string
    namerModel:
      type: string
    namerEffort:
      type: string
    autopilotCli:
      type: string
    autopilotModel:
      type: string
    autopilotEffort:
      type: string
    anthropicApiKey:
      type: string
  minProperties: 1
  maxProperties: 1
SettingsPatchResult:
  type: object
  additionalProperties: true
  properties:
    remoteControlAtStartup:
      type: boolean
    reducedPushMode:
      type: boolean
    sessionHousekeepingEnabled:
      type: boolean
    autoReviveEnabled:
      type: boolean
    upnextSkipCliPicker:
      type: boolean
    usageHoldEnabled:
      type: boolean
    usageHoldAutoRelease:
      type: boolean
    usageDowngradeEnabled:
      type: boolean
    fableAvailable:
      type: boolean
    judgeEnabled:
      type: boolean
    tuiFullscreen:
      type: boolean
    tuiDisableMouse:
      type: boolean
    prReviewCyclesCap:
      type: number
    planReviewCyclesCap:
      type: number
    distillerIntervalDays:
      type: number
    extraCreditsDrainCeiling:
      type: number
    usageHoldPct:
      type: number
    usageDowngradePct:
      type: number
    judgeDailyUsd:
      type: number
    defaultModel:
      type: string
    defaultCodexModel:
      type: string
    defaultEffort:
      type: string
    defaultAgentProvider:
      type: string
    authMode:
      type: string
    operatorLanguage:
      type: string
    usageDowngradeModel:
      type: string
    blockJudgeMode:
      type: string
    houseRuleRelevance:
      type: string
    telemetryConsent:
      type: string
    criticCli:
      type: string
    criticModel:
      type: string
    criticEffort:
      type: string
    plannerCli:
      type: string
    plannerModel:
      type: string
    plannerEffort:
      type: string
    recapCli:
      type: string
    recapModel:
      type: string
    recapEffort:
      type: string
    docAgentCli:
      type: string
    docAgentModel:
      type: string
    docAgentEffort:
      type: string
    distillerCli:
      type: string
    distillerModel:
      type: string
    distillerEffort:
      type: string
    optimizerCli:
      type: string
    optimizerModel:
      type: string
    optimizerEffort:
      type: string
    mergeSuggestCli:
      type: string
    mergeSuggestModel:
      type: string
    mergeSuggestEffort:
      type: string
    namerCli:
      type: string
    namerModel:
      type: string
    namerEffort:
      type: string
    autopilotCli:
      type: string
    autopilotModel:
      type: string
    autopilotEffort:
      type: string
    hasApiKey:
      type: boolean
RepoConfig:
  type: object
  additionalProperties: true
  required:
    - criticEnabled
    - criticAllPrs
    - criticSmellLensEnabled
    - autoAddressEnabled
    - learningsEnabled
    - autopilotEnabled
    - planGateEnabled
    - autoDrainEnabled
    - autoMergeEnabled
    - buildQueueEnabled
    - draftMode
    - autoOptimizeFlagged
    - manualStepsIssueEnabled
    - preWarmEpicLandingCi
    - epicStacksEnabled
    - hidden
    - signoffAuthority
    - maxAuto
    - autoLabel
    - usageCeilingPct
    - sandboxProfile
    - defaultModel
    - defaultEffort
    - egressExtraHosts
    - repoMode
    - previewOpenMode
  properties:
    criticEnabled:
      type: boolean
    criticAllPrs:
      type: boolean
    criticSmellLensEnabled:
      type: boolean
    autoAddressEnabled:
      type: boolean
    learningsEnabled:
      type: boolean
    autopilotEnabled:
      type: boolean
    planGateEnabled:
      type: boolean
    autoDrainEnabled:
      type: boolean
    autoMergeEnabled:
      type: boolean
    buildQueueEnabled:
      type: boolean
    draftMode:
      type: boolean
    autoOptimizeFlagged:
      type: boolean
    manualStepsIssueEnabled:
      type: boolean
    preWarmEpicLandingCi:
      type: boolean
    epicStacksEnabled:
      type: boolean
    hidden:
      type: boolean
    signoffAuthority:
      type: string
    maxAuto:
      type: integer
    autoLabel:
      type: string
    usageCeilingPct:
      type: number
    sandboxProfile:
      type: string
    defaultModel:
      type: string
    defaultEffort:
      type: string
    egressExtraHosts:
      type: array
      items:
        type: string
    repoMode:
      type: string
    previewStartScript:
      type:
        - string
        - "null"
    previewStartCommand:
      type:
        - string
        - "null"
    previewOpenMode:
      type: string
RepoConfigPatch:
  type: object
  additionalProperties: false
  properties:
    criticEnabled:
      type: boolean
    criticAllPrs:
      type: boolean
    criticSmellLensEnabled:
      type: boolean
    autoAddressEnabled:
      type: boolean
    learningsEnabled:
      type: boolean
    autopilotEnabled:
      type: boolean
    planGateEnabled:
      type: boolean
    autoDrainEnabled:
      type: boolean
    autoMergeEnabled:
      type: boolean
    buildQueueEnabled:
      type: boolean
    draftMode:
      type: boolean
    autoOptimizeFlagged:
      type: boolean
    manualStepsIssueEnabled:
      type: boolean
    preWarmEpicLandingCi:
      type: boolean
    epicStacksEnabled:
      type: boolean
    hidden:
      type: boolean
    signoffAuthority:
      type: string
    maxAuto:
      type: integer
    autoLabel:
      type: string
    usageCeilingPct:
      type: number
    sandboxProfile:
      type: string
    defaultModel:
      type: string
    defaultEffort:
      type: string
    egressExtraHosts:
      type: array
      items:
        type: string
    repoMode:
      type: string
    previewStartScript:
      type:
        - string
        - "null"
    previewStartCommand:
      type:
        - string
        - "null"
    previewOpenMode:
      type: string
    automationConfirmed:
      type: boolean
RepoRoles:
  type: object
  additionalProperties: true
  required:
    - reviewer
    - merger
  properties:
    reviewer:
      type:
        - string
        - "null"
    merger:
      type:
        - string
        - "null"
RepoRolesResult:
  type: object
  additionalProperties: true
  required:
    - roles
    - me
  properties:
    roles:
      $ref: "#/components/schemas/RepoRoles"
    me:
      type:
        - string
        - "null"
    pushError:
      type: string
RepoRolesPatch:
  type: object
  additionalProperties: false
  required:
    - reviewer
    - merger
  properties:
    reviewer:
      type:
        - string
        - "null"
      x-shepherd-explicit-null: true
    merger:
      type:
        - string
        - "null"
      x-shepherd-explicit-null: true
RepoCollaborators:
  type: object
  additionalProperties: true
  required:
    - logins
    - me
    - collaboratorsUnavailable
    - repoSlug
    - isFork
  properties:
    logins:
      type: array
      items:
        type: string
    source:
      type: string
    me:
      type:
        - string
        - "null"
    collaboratorsUnavailable:
      type: boolean
    repoSlug:
      type:
        - string
        - "null"
    isFork:
      type: boolean
DiagnosticState:
  type: string
  enum:
    - ok
    - optional
    - warning
    - error
  x-shepherd-open-enum: true
DiagnosticCheck:
  type: object
  additionalProperties: true
  required:
    - id
    - state
    - hintKey
  properties:
    id:
      type: string
    state:
      $ref: "#/components/schemas/DiagnosticState"
    hintKey:
      type: string
    remediation:
      type: string
    fixActionKey:
      type: string
    fixActionParams:
      type: object
      additionalProperties:
        type: string
    hintParams:
      type: object
      additionalProperties:
        type: string
DiagnosticsSnapshot:
  type: object
  additionalProperties: true
  required:
    - checks
    - generatedAt
    - overall
  properties:
    checks:
      type: array
      items:
        $ref: "#/components/schemas/DiagnosticCheck"
    generatedAt:
      type: integer
    overall:
      $ref: "#/components/schemas/DiagnosticState"
DiagnosticsFix:
  type: object
  additionalProperties: false
  required:
    - checkId
  properties:
    checkId:
      type: string
KeyVerification:
  type: object
  additionalProperties: true
  required:
    - ok
  properties:
    ok:
      type: boolean
    reason:
      type: string
    detail:
      type: string
DirectoryEntry:
  type: object
  additionalProperties: true
  required:
    - name
    - path
  properties:
    name:
      type: string
    path:
      type: string
DirectoryListing:
  type: object
  additionalProperties: true
  required:
    - path
    - display
    - parent
    - entries
  properties:
    path:
      type: string
    display:
      type: string
    parent:
      type:
        - string
        - "null"
    entries:
      type: array
      items:
        $ref: "#/components/schemas/DirectoryEntry"
RepoPullRequest:
  type: object
  additionalProperties: false
  required:
    - repo
  properties:
    repo:
      type: string
    branch:
      type: string
RepoPullResult:
  type: object
  additionalProperties: true
  required:
    - ok
  properties:
    ok:
      type: boolean
    branch:
      type: string
    updated:
      type: boolean
    sha:
      type: string
    reason:
      type: string
RepoForkRequest:
  type: object
  additionalProperties: false
  required:
    - target
  properties:
    target:
      type: string
ForkedRepo:
  type: object
  additionalProperties: true
  required:
    - name
    - path
    - display
    - realPath
  properties:
    name:
      type: string
    path:
      type: string
    display:
      type: string
    realPath:
      type: string
RepoSyncForkRequest:
  type: object
  additionalProperties: false
  required:
    - repo
  properties:
    repo:
      type: string
RepoSyncForkResult:
  type: object
  additionalProperties: true
  required:
    - ok
  properties:
    ok:
      type: boolean
    branch:
      type: string
```

```yaml
/api/repo-config:
  get:
    operationId: getRepoConfig
    parameters:
      - name: repo
        in: query
        required: true
        schema:
          type: string
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/RepoConfig"
      "400":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "401":
        $ref: "#/components/responses/Unauthorized"
  put:
    operationId: putRepoConfig
    parameters:
      - name: repo
        in: query
        required: true
        schema:
          type: string
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/RepoConfigPatch"
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/RepoConfig"
      "400":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "401":
        $ref: "#/components/responses/Unauthorized"
/api/repo-roles:
  get:
    operationId: getRepoRoles
    parameters:
      - name: repo
        in: query
        required: true
        schema:
          type: string
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/RepoRolesResult"
      "400":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "401":
        $ref: "#/components/responses/Unauthorized"
  put:
    operationId: putRepoRoles
    parameters:
      - name: repo
        in: query
        required: true
        schema:
          type: string
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/RepoRolesPatch"
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/RepoRolesResult"
      "400":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "401":
        $ref: "#/components/responses/Unauthorized"
      "502":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/RepoRolesResult"
/api/repo-collaborators:
  get:
    operationId: getRepoCollaborators
    parameters:
      - name: repo
        in: query
        required: true
        schema:
          type: string
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/RepoCollaborators"
      "400":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "401":
        $ref: "#/components/responses/Unauthorized"
/api/diagnostics:
  get:
    operationId: getDiagnostics
    parameters:
      - name: refresh
        in: query
        required: false
        schema:
          type: string
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/DiagnosticsSnapshot"
      "401":
        $ref: "#/components/responses/Unauthorized"
/api/diagnostics/fix:
  post:
    operationId: fixDiagnostics
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/DiagnosticsFix"
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/DiagnosticsSnapshot"
      "400":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "401":
        $ref: "#/components/responses/Unauthorized"
      "409":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "502":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "503":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
/api/settings/verify-key:
  post:
    operationId: verifySettingsKey
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/KeyVerification"
      "401":
        $ref: "#/components/responses/Unauthorized"
      "409":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "503":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
/api/fs/dirs:
  get:
    operationId: listDirectories
    parameters:
      - name: path
        in: query
        required: false
        schema:
          type: string
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/DirectoryListing"
      "401":
        $ref: "#/components/responses/Unauthorized"
/api/repos/pull:
  post:
    operationId: pullRepo
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/RepoPullRequest"
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/RepoPullResult"
      "400":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "401":
        $ref: "#/components/responses/Unauthorized"
      "409":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/RepoPullResult"
      "502":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/RepoPullResult"
/api/repos/fork:
  post:
    operationId: forkRepo
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/RepoForkRequest"
    responses:
      "201":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/ForkedRepo"
      "400":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "401":
        $ref: "#/components/responses/Unauthorized"
      "409":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "422":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "504":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
/api/repos/sync-fork:
  post:
    operationId: syncFork
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/RepoSyncForkRequest"
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/RepoSyncForkResult"
      "400":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "401":
        $ref: "#/components/responses/Unauthorized"
      "409":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "502":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
```

```yaml
diagnostics:status:
  schema:
    $ref: "#/components/schemas/DiagnosticsSnapshot"
```

Under the **existing** `/api/settings` path, alongside its existing `get:` and `put:`, add this
operation (do not add a second path key):

```yaml
patch:
  operationId: patchSettings
  requestBody:
    required: true
    content:
      application/json:
        schema:
          $ref: "#/components/schemas/SettingsPatch"
  responses:
    "200":
      description: Success.
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/SettingsPatchResult"
    "400":
      description: Handler refusal; see the verified status matrix.
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/Error"
    "401":
      $ref: "#/components/responses/Unauthorized"
```

Append these properties to the **existing** core `Settings.properties`, keeping every existing
property/type and the current required list. New properties are optional for older servers. Skip
keys already present; this is a merge of properties, not a second `Settings` declaration:

```yaml
remoteControlAtStartup:
  type: boolean
reducedPushMode:
  type: boolean
sessionHousekeepingEnabled:
  type: boolean
autoReviveEnabled:
  type: boolean
upnextSkipCliPicker:
  type: boolean
usageHoldEnabled:
  type: boolean
usageHoldAutoRelease:
  type: boolean
usageDowngradeEnabled:
  type: boolean
fableAvailable:
  type: boolean
judgeEnabled:
  type: boolean
tuiFullscreen:
  type: boolean
tuiDisableMouse:
  type: boolean
prReviewCyclesCap:
  type: number
planReviewCyclesCap:
  type: number
distillerIntervalDays:
  type: number
extraCreditsDrainCeiling:
  type: number
usageHoldPct:
  type: number
usageDowngradePct:
  type: number
judgeDailyUsd:
  type: number
usageDowngradeModel:
  type: string
blockJudgeMode:
  type: string
houseRuleRelevance:
  type: string
telemetryConsent:
  type: string
criticCli:
  type: string
criticModel:
  type: string
criticEffort:
  type: string
plannerCli:
  type: string
plannerModel:
  type: string
plannerEffort:
  type: string
recapCli:
  type: string
recapModel:
  type: string
recapEffort:
  type: string
docAgentCli:
  type: string
docAgentModel:
  type: string
docAgentEffort:
  type: string
distillerCli:
  type: string
distillerModel:
  type: string
distillerEffort:
  type: string
optimizerCli:
  type: string
optimizerModel:
  type: string
optimizerEffort:
  type: string
mergeSuggestCli:
  type: string
mergeSuggestModel:
  type: string
mergeSuggestEffort:
  type: string
namerCli:
  type: string
namerModel:
  type: string
namerEffort:
  type: string
autopilotCli:
  type: string
autopilotModel:
  type: string
autopilotEffort:
  type: string
docAgentEnabled:
  type: boolean
docAgentAct:
  type: boolean
judgeHasKey:
  type: boolean
telemetryAvailable:
  type: boolean
prReviewCyclesMin:
  type: integer
prReviewCyclesMax:
  type: integer
planReviewCyclesMin:
  type: integer
planReviewCyclesMax:
  type: integer
distillerIntervalDaysMin:
  type: integer
distillerIntervalDaysMax:
  type: integer
sessionRetentionDays:
  type: integer
sessionRetentionKeep:
  type: integer
previewHost:
  type:
    - string
    - "null"
```

`SettingsPatch.anthropicApiKey` uses a string; empty string clears it (the real handler also
accepts null). This avoids an optional-null encoding ambiguity without changing the endpoint.
Never add the key or helper path to a response. Generated role defaults use strings to tolerate
new model names; validation remains server-owned. The server's additional read-only telemetry
and failover metadata can remain in `additionalProperties`; no view assumes they are writable.

- [ ] **Step 4: Regenerate, run green and commit**

```bash
bun run test:contract
bun run typecheck
bun run gen:contract-swift && bun run check:contract-swift
./native/scripts/sync-contract.sh && ./native/scripts/sync-contract.sh --check
git add contracts native/Sources/ShepherdKit/openapi.yaml test/contract/settings.test.ts test/contract/settings-fixtures.ts
git commit -m "feat(contract): settings diagnostics and repository management"
```

### Task 2: Wrap generated operations and existing token APIs

**Files:** `ShepherdClient+Settings.swift`, `ShepherdClientSettingsTests.swift`.

**Interfaces:** consumes generated contract operations and S0-safe ephemeral auth; produces typed async wrappers with accurate status/body mapping.

- [ ] **Step 1: Write transport and cookie-isolation tests**

```swift
import Foundation
import Testing
@testable import ShepherdKit
struct ShepherdClientSettingsTests {
    func client(_ server: FakeShepherdServer, session: URLSession? = nil) throws -> ShepherdClient {
        try ShepherdClient(profile: .init(name: "fixture", baseURL: server.baseURL, mode: .local),
            credentials: InMemoryCredentialStore(), urlSession: session ?? server.urlSession())
    }
    @Test func patchSendsOnlyOneSetting() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("PATCH", "/api/settings") { request in
            let data = try #require(request.body)
            let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(body.count == 1); #expect(body["reducedPushMode"] as? Bool == true)
            return FakeResponse(body: Data(#"{"reducedPushMode":true}"#.utf8))
        }
        #expect(try await client(server).patchSettings(body: .init(reducedPushMode:true)).reducedPushMode == true)
    }
    @Test func adminUsesCookieWithoutBearerAndAnotherJarCannotSeeIt() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("POST", "/api/login") { request in
            #expect(request.headers["Authorization"] == nil)
            return FakeResponse(headers: ["Content-Type":"application/json", "Set-Cookie":"shepherd_session=fixture; Path=/; HttpOnly"], body: Data(#"{"ok":true}"#.utf8))
        }
        server.on("GET", "/api/access-tokens") { request in
            #expect(request.headers["Authorization"] == nil)
            let cookie = request.headers["Cookie"]
            return cookie?.contains("shepherd_session=fixture") == true
                ? FakeResponse(body: Data(#"{"tokens":[]}"#.utf8))
                : FakeResponse(statusCode: 401, body: Data(#"{"error":"unauthorized"}"#.utf8))
        }
        let admin = try client(server)
        try await admin.loginForTokenAdministration(password: "fixture")
        #expect(try await admin.listAccessTokens().tokens.isEmpty)
        let other = try client(server)
        await #expect(throws: ShepherdError.unauthenticated) { _ = try await other.listAccessTokens() }
    }
    @Test func roles502IsNotDecodedAsGenericError() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("PUT", "/api/repo-roles") { _ in FakeResponse(statusCode:502,
            body:Data(#"{"roles":{"reviewer":null,"merger":null},"me":null,"pushError":"push rejected"}"#.utf8)) }
        await #expect(throws: ShepherdError.upstreamFailure(code:nil,message:"push rejected")) {
            _ = try await client(server).putRepoRoles(repo:"/fixture", body:.values(reviewer:nil,merger:nil))
        }
    }
}
```

```bash
swift test --package-path native --filter ShepherdClientSettings
```

- [ ] **Step 2: Implement the complete kit extension**

```swift
import Foundation
import OpenAPIRuntime

public typealias SettingsPatch = Components.Schemas.SettingsPatch
public typealias SettingsPatchResult = Components.Schemas.SettingsPatchResult
public typealias RepoConfig = Components.Schemas.RepoConfig
public typealias RepoConfigPatch = Components.Schemas.RepoConfigPatch
public typealias RepoRoles = Components.Schemas.RepoRoles
public typealias RepoRolesResult = Components.Schemas.RepoRolesResult
public typealias RepoRolesPatch = Components.Schemas.RepoRolesPatch
public typealias RepoCollaborators = Components.Schemas.RepoCollaborators
public typealias DiagnosticState = Components.Schemas.DiagnosticState
public typealias DiagnosticCheck = Components.Schemas.DiagnosticCheck
public typealias DiagnosticsSnapshot = Components.Schemas.DiagnosticsSnapshot
public typealias DiagnosticsFix = Components.Schemas.DiagnosticsFix
public typealias KeyVerification = Components.Schemas.KeyVerification
public typealias DirectoryEntry = Components.Schemas.DirectoryEntry
public typealias DirectoryListing = Components.Schemas.DirectoryListing
public typealias RepoPullRequest = Components.Schemas.RepoPullRequest
public typealias RepoPullResult = Components.Schemas.RepoPullResult
public typealias RepoForkRequest = Components.Schemas.RepoForkRequest
public typealias ForkedRepo = Components.Schemas.ForkedRepo
public typealias RepoSyncForkRequest = Components.Schemas.RepoSyncForkRequest
public typealias RepoSyncForkResult = Components.Schemas.RepoSyncForkResult
extension Components.Schemas.DiagnosticState: OpenEnum {}
extension Components.Schemas.RepoRolesPatch {
    public static func values(reviewer: String?, merger: String?) throws -> Self {
        .init(reviewer: try OpenAPIValueContainer(unvalidatedValue: reviewer),
            merger: try OpenAPIValueContainer(unvalidatedValue: merger))
    }
}

extension ShepherdClient {
    public func getRepoConfig(repo: String) async throws -> Components.Schemas.RepoConfig {
        do {
            switch try await generated.getRepoConfig(.init(query: .init(repo: repo))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "getRepoConfig")
            }
        } catch { throw ShepherdError.from(error, route: "getRepoConfig") }
    }
    public func putRepoConfig(repo: String, body: RepoConfigPatch) async throws -> Components.Schemas.RepoConfig {
        do {
            switch try await generated.putRepoConfig(.init(query: .init(repo: repo), body: .json(body))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "putRepoConfig")
            }
        } catch { throw ShepherdError.from(error, route: "putRepoConfig") }
    }
    public func getRepoRoles(repo: String) async throws -> Components.Schemas.RepoRolesResult {
        do {
            switch try await generated.getRepoRoles(.init(query: .init(repo: repo))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "getRepoRoles")
            }
        } catch { throw ShepherdError.from(error, route: "getRepoRoles") }
    }
    public func putRepoRoles(repo: String, body: RepoRolesPatch) async throws -> Components.Schemas.RepoRolesResult {
        do {
            switch try await generated.putRepoRoles(.init(query: .init(repo: repo), body: .json(body))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .badGateway(let value): throw ShepherdError.upstreamFailure(code: nil, message: try value.body.json.pushError ?? "push rejected")
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "putRepoRoles")
            }
        } catch { throw ShepherdError.from(error, route: "putRepoRoles") }
    }
    public func getRepoCollaborators(repo: String) async throws -> Components.Schemas.RepoCollaborators {
        do {
            switch try await generated.getRepoCollaborators(.init(query: .init(repo: repo))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "getRepoCollaborators")
            }
        } catch { throw ShepherdError.from(error, route: "getRepoCollaborators") }
    }
    public func getDiagnostics(refresh: String? = nil) async throws -> Components.Schemas.DiagnosticsSnapshot {
        do {
            switch try await generated.getDiagnostics(.init(query: .init(refresh: refresh))) {
            case .ok(let value): return try value.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "getDiagnostics")
            }
        } catch { throw ShepherdError.from(error, route: "getDiagnostics") }
    }
    public func fixDiagnostics(body: DiagnosticsFix) async throws -> Components.Schemas.DiagnosticsSnapshot {
        do {
            switch try await generated.fixDiagnostics(.init(body: .json(body))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .conflict(let value): throw ShepherdError.fromConflict(try value.body.json)
            case .badGateway(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .serviceUnavailable(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "fixDiagnostics")
            }
        } catch { throw ShepherdError.from(error, route: "fixDiagnostics") }
    }
    public func verifySettingsKey() async throws -> Components.Schemas.KeyVerification {
        do {
            switch try await generated.verifySettingsKey(.init()) {
            case .ok(let value): return try value.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .conflict(let value): throw ShepherdError.fromConflict(try value.body.json)
            case .serviceUnavailable(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "verifySettingsKey")
            }
        } catch { throw ShepherdError.from(error, route: "verifySettingsKey") }
    }
    public func listDirectories(path: String? = nil) async throws -> Components.Schemas.DirectoryListing {
        do {
            switch try await generated.listDirectories(.init(query: .init(path: path))) {
            case .ok(let value): return try value.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "listDirectories")
            }
        } catch { throw ShepherdError.from(error, route: "listDirectories") }
    }
    public func pullRepo(body: RepoPullRequest) async throws -> Components.Schemas.RepoPullResult {
        do {
            switch try await generated.pullRepo(.init(body: .json(body))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .conflict(let value):
                let result = try value.body.json
                throw ShepherdError.conflict(code: result.reason, message: result.reason ?? "pull failed")
            case .badGateway(let value):
                let result = try value.body.json
                throw ShepherdError.upstreamFailure(code: result.reason, message: result.reason ?? "pull failed")
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "pullRepo")
            }
        } catch { throw ShepherdError.from(error, route: "pullRepo") }
    }
    public func forkRepo(body: RepoForkRequest) async throws -> Components.Schemas.ForkedRepo {
        do {
            switch try await generated.forkRepo(.init(body: .json(body))) {
            case .created(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .conflict(let value): throw ShepherdError.fromConflict(try value.body.json)
            case .unprocessableContent(let value): throw ShepherdError.unprocessable(try value.body.json.error)
            case .gatewayTimeout(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "forkRepo")
            }
        } catch { throw ShepherdError.from(error, route: "forkRepo") }
    }
    public func syncFork(body: RepoSyncForkRequest) async throws -> Components.Schemas.RepoSyncForkResult {
        do {
            switch try await generated.syncFork(.init(body: .json(body))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .conflict(let value): throw ShepherdError.fromConflict(try value.body.json)
            case .badGateway(let value): throw ShepherdError.fromUpstream(try value.body.json)
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "syncFork")
            }
        } catch { throw ShepherdError.from(error, route: "syncFork") }
    }
    public func patchSettings(body: SettingsPatch) async throws -> Components.Schemas.SettingsPatchResult {
        do {
            switch try await generated.patchSettings(.init(body: .json(body))) {
            case .ok(let value): return try value.body.json
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "patchSettings")
            }
        } catch { throw ShepherdError.from(error, route: "patchSettings") }
    }
    public func loginForTokenAdministration(password: String) async throws {
        do {
            switch try await generated.login(.init(body: .json(.init(password: password)))) {
            case .ok: return
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "login")
            }
        } catch { throw ShepherdError.from(error, route: "login") }
    }
    public func listAccessTokens() async throws -> Components.Schemas.AccessTokenList {
        do {
            switch try await generated.listAccessTokens(.init()) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .forbidden: throw ShepherdError.forbidden
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "listAccessTokens")
            }
        } catch { throw ShepherdError.from(error, route: "listAccessTokens") }
    }
    public func mintAccessToken(body: Components.Schemas.AccessTokenMintRequest) async throws -> Components.Schemas.AccessTokenMinted {
        do {
            switch try await generated.mintAccessToken(.init(body: .json(body))) {
            case .created(let created): return try created.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .forbidden: throw ShepherdError.forbidden
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "mintAccessToken")
            }
        } catch { throw ShepherdError.from(error, route: "mintAccessToken") }
    }
    public func revokeAccessToken(id: String) async throws {
        do {
            switch try await generated.revokeAccessToken(.init(path: .init(id: id))) {
            case .ok: return
            case .unauthorized: throw ShepherdError.unauthenticated
            case .forbidden: throw ShepherdError.forbidden
            case .notFound: throw ShepherdError.notFound
            case .undocumented(let status, _): throw ShepherdError.fromUndocumented(statusCode: status, route: "revokeAccessToken")
            }
        } catch { throw ShepherdError.from(error, route: "revokeAccessToken") }
    }
}
```

- [ ] **Step 3: Run green and commit**

```bash
swift test --package-path native --filter ShepherdClientSettings
git checkout -- native/Package.resolved
git add native/Sources/ShepherdKit/Client/ShepherdClient+Settings.swift native/Tests/ShepherdKitTests/ShepherdClientSettingsTests.swift
git commit -m "feat(kit): settings repository and cookie token APIs"
```

### Task 3: Build the activation-scoped settings model

**Files:** `Sources/Settings/SettingsModel.swift`, `SettingsTokensModel.swift`, `Tests/SettingsModelTests.swift`.

**Interfaces:** consumes store event tap, authoritative GETs and activation generation; produces reconnect refresh, finite observation watcher and guarded writes.

- [ ] **Step 1: Write a suspended-read teardown regression**

```swift
import Foundation
import Testing
import ShepherdKit
@testable import Shepherd
actor SettingsReadLatch {
    var waiting = false
    var continuation: CheckedContinuation<SettingsSnapshot, Error>?
    func read() async throws -> SettingsSnapshot {
        try await withCheckedThrowingContinuation { continuation = $0; waiting = true }
    }
    func fail() { continuation?.resume(throwing:ShepherdError.notFound); continuation = nil }
}
@Suite(.serialized) @MainActor struct SettingsModelTests {
    @Test func failureAfterTeardownCannotReopenErrorState() async {
        let latch = SettingsReadLatch()
        let model = SettingsModel(reads:.init(snapshot:{try await latch.read()}))
        let load = Task {await model.load()}
        while !(await latch.waiting) {await Task.yield()}
        model.teardown(); await latch.fail(); await load.value
        #expect(model.error == nil); #expect(model.snapshot == nil); #expect(!model.busy)
    }
    @Test func failedReadIsVisibleBeforeTeardown() async {
        let model = SettingsModel(reads:.init(snapshot:{throw ShepherdError.notFound}))
        await model.load()
        #expect(model.error != nil)
        model.teardown()
    }
    @Test func successfulWriteReconcilesSharedStoreBeforePublishing() async {
        var reconciled = false
        var committed = false
        let model = SettingsModel(reads: .init(snapshot: { throw ShepherdError.notFound },
            reconcile: { reconciled = true }))
        defer { model.teardown() }
        model.run({ true }, commit: { value in
            #expect(reconciled)
            committed = value
        })
        while model.busy { await Task.yield() }
        #expect(reconciled); #expect(committed)
    }
    @Test func registrationUsesIsolatedPersistence() {
        let suite = "SettingsModel-" + UUID().uuidString
        let defaults = UserDefaults(suiteName:suite)!
        defer {defaults.removePersistentDomain(forName:suite)}
        let app = AppModel(defaults:defaults,credentials:InMemoryCredentialStore())
        app.register(SettingsModel.self); app.register(SettingsModel.self)
        #expect(app.extensionFactories.count == 1)
        #expect(app.extension(SettingsModel.self) == nil)
        app.teardown()
    }
}
```

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/SettingsModelTests
```

- [ ] **Step 2: Implement model and guarded state transitions**

```swift
import Foundation
import Observation
import ShepherdKit

struct SettingsSnapshot: Sendable {
    var settings: Components.Schemas.Settings
    var diagnostics: DiagnosticsSnapshot
    var usage: UsageLimits?
    var repos: [Components.Schemas.Repo]
}
struct SettingsReads: Sendable {
    var snapshot: @Sendable () async throws -> SettingsSnapshot
    var reconcile: @MainActor @Sendable () async throws -> Void = {}
    @MainActor static func live(_ store: SessionStore) -> Self {
        let client = store.client
        return .init(snapshot: {
            async let settings = client.settings()
            async let diagnostics = client.getDiagnostics()
            async let usage = client.usage()
            async let repos = client.repos()
            return try await .init(settings: settings, diagnostics: diagnostics,
                usage: usage.limits, repos: repos.repos)
        }, reconcile: { try await store.refresh() })
    }
}
@Observable @MainActor final class SettingsModel: AppExtension {
    private(set) var snapshot: SettingsSnapshot?
    private(set) var error: String?
    private(set) var busy = false
    var repo = ""
    var repoConfig: RepoConfig?
    var roles: RepoRolesResult?
    var collaborators: RepoCollaborators?
    var directories: DirectoryListing?
    var verification: KeyVerification?
    let tokens = SettingsTokensModel()
    @ObservationIgnored private let reads: SettingsReads
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var stopped = false
    @ObservationIgnored private var tap: Task<Void,Never>?
    @ObservationIgnored private var loadTask: Task<Void,Never>?
    @ObservationIgnored private var writeTask: Task<Void,Never>?
    @ObservationIgnored private var watcher: Task<Void,Never>?
    @ObservationIgnored private var wake: AsyncStream<Void>.Continuation?
    init(reads: SettingsReads) { self.reads = reads }
    init(store: SessionStore, app: AppModel) {
        self.app = app; reads = .live(store)
        let activation = app.activationGeneration
        tap = Task { [weak self, weak store] in
            guard let store else { return }
            for await event in store.events() {
                guard let self, !self.stopped, self.app?.activationGeneration == activation,
                    !Task.isCancelled else { return }
                if case .unknown(let name, _) = event, name == "diagnostics:status" { self.reload() }
                if case .usageLimits = event { self.reload() }
            }
        }
        let (stream, continuation) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        wake = continuation
        watcher = Task { [weak self, weak store] in
            guard let store else { return }
            var iterator = stream.makeAsyncIterator(), live = false
            while let self, !self.stopped, self.app?.activationGeneration == activation, !Task.isCancelled {
                let connection = withObservationTracking { store.connection }
                    onChange: { continuation.yield(()) }
                if connection == .live && !live { self.reload() }
                live = connection == .live
                guard await iterator.next() != nil else { return }
            }
        }
        reload()
    }
    func reload() {
        guard !stopped else { return }
        generation &+= 1; loadTask?.cancel()
        loadTask = Task { [weak self] in await self?.load() }
    }
    func load() async {
        let mine = generation, activation = app?.activationGeneration
        do {
            let value = try await reads.snapshot()
            guard valid(mine, activation), !Task.isCancelled else { return }
            snapshot = value; error = nil
            if !value.repos.contains(where: { $0.path == repo }) {
                repo = ""; repoConfig = nil; roles = nil; collaborators = nil
            }
        } catch {
            guard valid(mine, activation), !Task.isCancelled else { return }
            self.error = L.t("native_settings_load_failed")
        }
    }
    private func valid(_ mine: Int, _ activation: Int?) -> Bool {
        !stopped && mine == generation && activation == app?.activationGeneration
    }
    func run<Value: Sendable>(
        _ operation: @escaping @Sendable () async throws -> Value,
        commit: @escaping @MainActor (Value) -> Void = { _ in }
    ) {
        guard !stopped, !busy else { return }
        busy = true; error = nil
        // Reconnects may invalidate reads but must not strand the write's busy flag.
        let activation = app?.activationGeneration
        writeTask = Task { [weak self] in
            do {
                let value = try await operation()
                guard let self, !self.stopped, self.app?.activationGeneration == activation,
                    !Task.isCancelled else { return }
                // Other streams read SessionStore.settings/repos (composer defaults and root).
                // A SettingsModel-only GET would leave those consumers stale until reconnect.
                try await self.reads.reconcile()
                guard !self.stopped, self.app?.activationGeneration == activation,
                    !Task.isCancelled else { return }
                commit(value); self.busy = false; self.reload()
            } catch {
                guard let self, !self.stopped, self.app?.activationGeneration == activation,
                    !Task.isCancelled else { return }
                self.busy = false; self.error = L.t("native_settings_action_failed")
            }
        }
    }
    func replaceDiagnostics(_ value: DiagnosticsSnapshot) { snapshot?.diagnostics = value }
    func patch(_ body: SettingsPatch, client: ShepherdClient) {
        run { try await client.patchSettings(body: body) }
    }
    func selectRepo(_ path: String, client: ShepherdClient) {
        guard !busy else { return }
        repo = path; repoConfig = nil; roles = nil; collaborators = nil
        run({
            async let config = client.getRepoConfig(repo: path)
            async let roles = client.getRepoRoles(repo: path)
            async let people = client.getRepoCollaborators(repo: path)
            return try await (config, roles, people)
        }, commit: { [weak self] value in
            guard let self, self.repo == path else { return }
            self.repoConfig = value.0; self.roles = value.1; self.collaborators = value.2
        })
    }
    func teardown() {
        stopped = true; generation &+= 1
        wake?.finish(); wake = nil
        tap?.cancel(); loadTask?.cancel(); writeTask?.cancel(); watcher?.cancel()
        tap = nil; loadTask = nil; writeTask = nil; watcher = nil
        tokens.close(); snapshot = nil; repoConfig = nil; roles = nil; collaborators = nil
        directories = nil; verification = nil; repo = ""; busy = false; app = nil
    }
}
```

The same task creates `Sources/Settings/SettingsTokensModel.swift` with the complete
authentication lifetime owner below.

```swift
import Foundation
import Observation
import ShepherdKit
import SwiftUI

@Observable @MainActor final class SettingsTokensModel {
    private(set) var entries: [Components.Schemas.AccessTokenSummary] = []
    private(set) var revealed: String?
    private(set) var authenticated = false
    private(set) var busy = false
    private(set) var error: String?
    @ObservationIgnored private var client: ShepherdClient?
    @ObservationIgnored private var session: URLSession?
    @ObservationIgnored private var work: Task<Void,Never>?
    @ObservationIgnored private var generation = 0
    func authenticate(profile: ServerProfile, password: String, session: URLSession? = nil) {
        close()
        let transport = session ?? URLSession(configuration: .ephemeral)
        self.session = transport
        do {
            // Empty credentials: a bearer header would make this a forbidden machine request.
            client = try ShepherdClient(profile: profile, credentials: InMemoryCredentialStore(), urlSession: transport)
        } catch { self.error = L.t("native_settings_login_failed"); return }
        guard let client else { return }
        execute {
            try await client.loginForTokenAdministration(password: password)
            return try await client.listAccessTokens()
        } commit: { [weak self] in self?.entries = $0.tokens; self?.authenticated = true }
    }
    func mint(name: String, days: Components.Schemas.AccessTokenMintRequest.ExpiresInDaysPayload?, scope: Components.Schemas.TokenScope) {
        guard let client, authenticated else { return }
        revealed = nil
        execute { try await client.mintAccessToken(body: .init(name: name, expiresInDays: days, scope: scope)) }
            commit: { [weak self] value in self?.revealed = value.token; self?.entries.insert(value.entry, at: 0) }
    }
    func revoke(id: String) {
        guard let client, authenticated else { return }
        execute { try await client.revokeAccessToken(id: id) }
            commit: { [weak self] _ in self?.entries.removeAll { $0.id == id }; self?.revealed = nil }
    }
    private func execute<Value: Sendable>(
        _ operation: @escaping @Sendable () async throws -> Value,
        commit: @escaping @MainActor (Value) -> Void
    ) {
        guard !busy else { return }
        busy = true; error = nil
        let mine = generation
        work = Task { [weak self] in
            do {
                let result = try await operation()
                guard let self, mine == self.generation, !Task.isCancelled else { return }
                commit(result); self.busy = false
            } catch {
                guard let self, mine == self.generation, !Task.isCancelled else { return }
                self.busy = false; self.error = L.t("native_settings_token_failed")
            }
        }
    }
    func close() {
        generation &+= 1; work?.cancel(); work = nil
        session?.configuration.httpCookieStorage?.removeCookies(since: .distantPast)
        session?.invalidateAndCancel(); session = nil; client = nil
        revealed = nil; entries = []; authenticated = false; busy = false; error = nil
    }
}
```

`load` tests suspend injected reads without sleeps. Stream tasks subscribe to
`store.events()`; no second WebSocket is opened. Reconnect snapshots prune a selected repository
that disappeared, and teardown clears all repo/token state. `run` owns the post-await commit:
views must not mutate their state inside the network closure. Every event and write completion
checks activation; load revisions also reject an older GET completing after a newer one.

- [ ] **Step 3: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/SettingsModelTests
```

```bash
git add native/Apps/ShepherdMac/Sources/Settings/SettingsModel.swift native/Apps/ShepherdMac/Sources/Settings/SettingsTokensModel.swift native/Apps/ShepherdMac/Tests/SettingsModelTests.swift
git commit -m "feat(mac): activation-scoped settings model"
```

### Task 4: Implement general settings and CLI defaults

**Files:** `Sources/Settings/SettingsFields.swift`, `Tests/SettingsFieldsTests.swift`.

**Interfaces:** consumes expanded Settings, single-property PATCH and server bounds; produces editable operator settings, all nine role defaults, secret input without persistence.

- [ ] **Step 1: Assert every descriptor produces one-field JSON**

```swift
import Foundation
import Testing
import ShepherdKit
@testable import Shepherd
@MainActor struct SettingsFieldsTests {
    @Test func descriptorsHaveUniqueKeysAndNeverBatch() throws {
        let fields = SettingsFields.all
        #expect(Set(fields.map(\.id)).count == fields.count)
        for field in fields {
            let input = field.kind == .number ? "2" : field.kind == .toggle ? "true" : "fixture"
            let patch = try #require(field.patch(input))
            let body = try #require(JSONSerialization.jsonObject(with:JSONEncoder().encode(patch)) as? [String:Any])
            #expect(body.count == 1); #expect(body[field.id] != nil)
        }
        #expect(fields.filter {$0.id.hasSuffix("Cli")}.count == 9)
        #expect(fields.contains {$0.id == "reducedPushMode"})
        #expect(fields.first {$0.id == "prReviewCyclesCap"}?.patch("not a number") == nil)
    }
}
```

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/SettingsFieldsTests
```

- [ ] **Step 2: Implement the descriptor list and editable form**

```swift
import SwiftUI
import ShepherdKit

struct SettingsField: Identifiable {
    enum Kind { case toggle, text, number }
    let id: String
    let title: StaticString
    let kind: Kind
    let value: (Components.Schemas.Settings) -> String
    let patch: (String) -> SettingsPatch?
    let cli: Bool
}
@MainActor enum SettingsFields {
    static let all: [SettingsField] = [
        .init(id:"remoteControlAtStartup", title:"native_settings_field_remotecontrolatstartup", kind:.toggle, value:{ String($0.remoteControlAtStartup ?? false) }, patch:{ .init(remoteControlAtStartup: $0 == "true") }, cli:false),
        .init(id:"reducedPushMode", title:"native_settings_field_reducedpushmode", kind:.toggle, value:{ String($0.reducedPushMode ?? false) }, patch:{ .init(reducedPushMode: $0 == "true") }, cli:false),
        .init(id:"sessionHousekeepingEnabled", title:"native_settings_field_sessionhousekeepingenabled", kind:.toggle, value:{ String($0.sessionHousekeepingEnabled ?? false) }, patch:{ .init(sessionHousekeepingEnabled: $0 == "true") }, cli:false),
        .init(id:"autoReviveEnabled", title:"native_settings_field_autoreviveenabled", kind:.toggle, value:{ String($0.autoReviveEnabled ?? false) }, patch:{ .init(autoReviveEnabled: $0 == "true") }, cli:false),
        .init(id:"upnextSkipCliPicker", title:"native_settings_field_upnextskipclipicker", kind:.toggle, value:{ String($0.upnextSkipCliPicker ?? false) }, patch:{ .init(upnextSkipCliPicker: $0 == "true") }, cli:false),
        .init(id:"usageHoldEnabled", title:"native_settings_field_usageholdenabled", kind:.toggle, value:{ String($0.usageHoldEnabled ?? false) }, patch:{ .init(usageHoldEnabled: $0 == "true") }, cli:false),
        .init(id:"usageHoldAutoRelease", title:"native_settings_field_usageholdautorelease", kind:.toggle, value:{ String($0.usageHoldAutoRelease ?? false) }, patch:{ .init(usageHoldAutoRelease: $0 == "true") }, cli:false),
        .init(id:"usageDowngradeEnabled", title:"native_settings_field_usagedowngradeenabled", kind:.toggle, value:{ String($0.usageDowngradeEnabled ?? false) }, patch:{ .init(usageDowngradeEnabled: $0 == "true") }, cli:false),
        .init(id:"fableAvailable", title:"native_settings_field_fableavailable", kind:.toggle, value:{ String($0.fableAvailable ?? false) }, patch:{ .init(fableAvailable: $0 == "true") }, cli:false),
        .init(id:"judgeEnabled", title:"native_settings_field_judgeenabled", kind:.toggle, value:{ String($0.judgeEnabled ?? false) }, patch:{ .init(judgeEnabled: $0 == "true") }, cli:false),
        .init(id:"tuiFullscreen", title:"native_settings_field_tuifullscreen", kind:.toggle, value:{ String($0.tuiFullscreen ?? false) }, patch:{ .init(tuiFullscreen: $0 == "true") }, cli:false),
        .init(id:"tuiDisableMouse", title:"native_settings_field_tuidisablemouse", kind:.toggle, value:{ String($0.tuiDisableMouse ?? false) }, patch:{ .init(tuiDisableMouse: $0 == "true") }, cli:false),
        .init(id:"prReviewCyclesCap", title:"native_settings_field_prreviewcyclescap", kind:.number, value:{ String($0.prReviewCyclesCap ?? 0) }, patch:{ value in guard let n = Double(value), n.isFinite else { return nil }; return .init(prReviewCyclesCap: n) }, cli:false),
        .init(id:"planReviewCyclesCap", title:"native_settings_field_planreviewcyclescap", kind:.number, value:{ String($0.planReviewCyclesCap ?? 0) }, patch:{ value in guard let n = Double(value), n.isFinite else { return nil }; return .init(planReviewCyclesCap: n) }, cli:false),
        .init(id:"distillerIntervalDays", title:"native_settings_field_distillerintervaldays", kind:.number, value:{ String($0.distillerIntervalDays ?? 0) }, patch:{ value in guard let n = Double(value), n.isFinite else { return nil }; return .init(distillerIntervalDays: n) }, cli:true),
        .init(id:"extraCreditsDrainCeiling", title:"native_settings_field_extracreditsdrainceiling", kind:.number, value:{ String($0.extraCreditsDrainCeiling ?? 0) }, patch:{ value in guard let n = Double(value), n.isFinite else { return nil }; return .init(extraCreditsDrainCeiling: n) }, cli:false),
        .init(id:"usageHoldPct", title:"native_settings_field_usageholdpct", kind:.number, value:{ String($0.usageHoldPct ?? 0) }, patch:{ value in guard let n = Double(value), n.isFinite else { return nil }; return .init(usageHoldPct: n) }, cli:false),
        .init(id:"usageDowngradePct", title:"native_settings_field_usagedowngradepct", kind:.number, value:{ String($0.usageDowngradePct ?? 0) }, patch:{ value in guard let n = Double(value), n.isFinite else { return nil }; return .init(usageDowngradePct: n) }, cli:false),
        .init(id:"judgeDailyUsd", title:"native_settings_field_judgedailyusd", kind:.number, value:{ String($0.judgeDailyUsd ?? 0) }, patch:{ value in guard let n = Double(value), n.isFinite else { return nil }; return .init(judgeDailyUsd: n) }, cli:false),
        .init(id:"defaultModel", title:"native_settings_field_defaultmodel", kind:.text, value:{ $0.defaultModel }, patch:{ .init(defaultModel: $0) }, cli:true),
        .init(id:"defaultCodexModel", title:"native_settings_field_defaultcodexmodel", kind:.text, value:{ $0.defaultCodexModel ?? "" }, patch:{ .init(defaultCodexModel: $0) }, cli:true),
        .init(id:"defaultEffort", title:"native_settings_field_defaulteffort", kind:.text, value:{ $0.defaultEffort }, patch:{ .init(defaultEffort: $0) }, cli:true),
        .init(id:"defaultAgentProvider", title:"native_settings_field_defaultagentprovider", kind:.text, value:{ $0.defaultAgentProvider.rawValue }, patch:{ .init(defaultAgentProvider: $0) }, cli:true),
        .init(id:"authMode", title:"native_settings_field_authmode", kind:.text, value:{ $0.authMode.rawValue }, patch:{ .init(authMode: $0) }, cli:true),
        .init(id:"operatorLanguage", title:"native_settings_field_operatorlanguage", kind:.text, value:{ $0.operatorLanguage.rawValue }, patch:{ .init(operatorLanguage: $0) }, cli:false),
        .init(id:"usageDowngradeModel", title:"native_settings_field_usagedowngrademodel", kind:.text, value:{ $0.usageDowngradeModel ?? "" }, patch:{ .init(usageDowngradeModel: $0) }, cli:true),
        .init(id:"blockJudgeMode", title:"native_settings_field_blockjudgemode", kind:.text, value:{ $0.blockJudgeMode ?? "" }, patch:{ .init(blockJudgeMode: $0) }, cli:false),
        .init(id:"houseRuleRelevance", title:"native_settings_field_houserulerelevance", kind:.text, value:{ $0.houseRuleRelevance ?? "" }, patch:{ .init(houseRuleRelevance: $0) }, cli:false),
        .init(id:"telemetryConsent", title:"native_settings_field_telemetryconsent", kind:.text, value:{ $0.telemetryConsent ?? "" }, patch:{ .init(telemetryConsent: $0) }, cli:false),
        .init(id:"criticCli", title:"native_settings_field_criticcli", kind:.text, value:{ $0.criticCli ?? "" }, patch:{ .init(criticCli: $0) }, cli:true),
        .init(id:"criticModel", title:"native_settings_field_criticmodel", kind:.text, value:{ $0.criticModel ?? "" }, patch:{ .init(criticModel: $0) }, cli:true),
        .init(id:"criticEffort", title:"native_settings_field_criticeffort", kind:.text, value:{ $0.criticEffort ?? "" }, patch:{ .init(criticEffort: $0) }, cli:true),
        .init(id:"plannerCli", title:"native_settings_field_plannercli", kind:.text, value:{ $0.plannerCli ?? "" }, patch:{ .init(plannerCli: $0) }, cli:true),
        .init(id:"plannerModel", title:"native_settings_field_plannermodel", kind:.text, value:{ $0.plannerModel ?? "" }, patch:{ .init(plannerModel: $0) }, cli:true),
        .init(id:"plannerEffort", title:"native_settings_field_plannereffort", kind:.text, value:{ $0.plannerEffort ?? "" }, patch:{ .init(plannerEffort: $0) }, cli:true),
        .init(id:"recapCli", title:"native_settings_field_recapcli", kind:.text, value:{ $0.recapCli ?? "" }, patch:{ .init(recapCli: $0) }, cli:true),
        .init(id:"recapModel", title:"native_settings_field_recapmodel", kind:.text, value:{ $0.recapModel ?? "" }, patch:{ .init(recapModel: $0) }, cli:true),
        .init(id:"recapEffort", title:"native_settings_field_recapeffort", kind:.text, value:{ $0.recapEffort ?? "" }, patch:{ .init(recapEffort: $0) }, cli:true),
        .init(id:"docAgentCli", title:"native_settings_field_docagentcli", kind:.text, value:{ $0.docAgentCli ?? "" }, patch:{ .init(docAgentCli: $0) }, cli:true),
        .init(id:"docAgentModel", title:"native_settings_field_docagentmodel", kind:.text, value:{ $0.docAgentModel ?? "" }, patch:{ .init(docAgentModel: $0) }, cli:true),
        .init(id:"docAgentEffort", title:"native_settings_field_docagenteffort", kind:.text, value:{ $0.docAgentEffort ?? "" }, patch:{ .init(docAgentEffort: $0) }, cli:true),
        .init(id:"distillerCli", title:"native_settings_field_distillercli", kind:.text, value:{ $0.distillerCli ?? "" }, patch:{ .init(distillerCli: $0) }, cli:true),
        .init(id:"distillerModel", title:"native_settings_field_distillermodel", kind:.text, value:{ $0.distillerModel ?? "" }, patch:{ .init(distillerModel: $0) }, cli:true),
        .init(id:"distillerEffort", title:"native_settings_field_distillereffort", kind:.text, value:{ $0.distillerEffort ?? "" }, patch:{ .init(distillerEffort: $0) }, cli:true),
        .init(id:"optimizerCli", title:"native_settings_field_optimizercli", kind:.text, value:{ $0.optimizerCli ?? "" }, patch:{ .init(optimizerCli: $0) }, cli:true),
        .init(id:"optimizerModel", title:"native_settings_field_optimizermodel", kind:.text, value:{ $0.optimizerModel ?? "" }, patch:{ .init(optimizerModel: $0) }, cli:true),
        .init(id:"optimizerEffort", title:"native_settings_field_optimizereffort", kind:.text, value:{ $0.optimizerEffort ?? "" }, patch:{ .init(optimizerEffort: $0) }, cli:true),
        .init(id:"mergeSuggestCli", title:"native_settings_field_mergesuggestcli", kind:.text, value:{ $0.mergeSuggestCli ?? "" }, patch:{ .init(mergeSuggestCli: $0) }, cli:true),
        .init(id:"mergeSuggestModel", title:"native_settings_field_mergesuggestmodel", kind:.text, value:{ $0.mergeSuggestModel ?? "" }, patch:{ .init(mergeSuggestModel: $0) }, cli:true),
        .init(id:"mergeSuggestEffort", title:"native_settings_field_mergesuggesteffort", kind:.text, value:{ $0.mergeSuggestEffort ?? "" }, patch:{ .init(mergeSuggestEffort: $0) }, cli:true),
        .init(id:"namerCli", title:"native_settings_field_namercli", kind:.text, value:{ $0.namerCli ?? "" }, patch:{ .init(namerCli: $0) }, cli:true),
        .init(id:"namerModel", title:"native_settings_field_namermodel", kind:.text, value:{ $0.namerModel ?? "" }, patch:{ .init(namerModel: $0) }, cli:true),
        .init(id:"namerEffort", title:"native_settings_field_namereffort", kind:.text, value:{ $0.namerEffort ?? "" }, patch:{ .init(namerEffort: $0) }, cli:true),
        .init(id:"autopilotCli", title:"native_settings_field_autopilotcli", kind:.text, value:{ $0.autopilotCli ?? "" }, patch:{ .init(autopilotCli: $0) }, cli:true),
        .init(id:"autopilotModel", title:"native_settings_field_autopilotmodel", kind:.text, value:{ $0.autopilotModel ?? "" }, patch:{ .init(autopilotModel: $0) }, cli:true),
        .init(id:"autopilotEffort", title:"native_settings_field_autopiloteffort", kind:.text, value:{ $0.autopilotEffort ?? "" }, patch:{ .init(autopilotEffort: $0) }, cli:true),
    ]
}
struct SettingsFieldRow: View {
    let field: SettingsField
    let payload: Components.Schemas.Settings
    let save: (SettingsPatch) -> Void
    @State private var draft = ""
    var body: some View {
        HStack {
            if field.kind == .toggle {
                Toggle(L.t(field.title), isOn: Binding(get: { field.value(payload) == "true" }, set: {
                    if let patch = field.patch($0 ? "true" : "false") { save(patch) }
                }))
            } else {
                TextField(L.t(field.title), text: $draft)
                    .onAppear { draft = field.value(payload) }
                    .onChange(of: field.value(payload)) { draft = field.value(payload) }
                Button(L.t("common_save")) { if let patch = field.patch(draft) { save(patch) } }
                    .disabled(draft == field.value(payload) || field.patch(draft) == nil)
            }
        }.accessibilityIdentifier("settings-" + field.id)
    }
}
struct SettingsGeneralView: View {
    let model: SettingsModel
    let client: ShepherdClient
    var cli = false
    @State private var apiKey = ""
    @State private var confirmKey = false
    var body: some View {
        Form {
            if let error = model.error { Text(verbatim:error).foregroundStyle(.red) }
            if let payload = model.snapshot?.settings {
                ForEach(SettingsFields.all.filter { $0.cli == cli }) { field in
                    SettingsFieldRow(field:field,payload:payload) { model.patch($0,client:client) }
                }
                if cli {
                    Text(payload.hasApiKey == true ? L.t("native_settings_key_present") : L.t("native_settings_key_absent"))
                    SecureField(L.t("native_settings_api_key"),text:$apiKey)
                    Button(L.t("native_settings_key_save")) { confirmKey = true }
                } else {
                    Text(verbatim:payload.repoRootDisplay)
                    if let days = payload.sessionRetentionDays, let keep = payload.sessionRetentionKeep {
                        Text(L.t("native_settings_retention", String(days), String(keep)))
                    }
                    if let low = payload.prReviewCyclesMin, let high = payload.prReviewCyclesMax {
                        Text(L.t("native_settings_pr_bounds", String(low), String(high)))
                    }
                    if let low = payload.planReviewCyclesMin, let high = payload.planReviewCyclesMax {
                        Text(L.t("native_settings_plan_bounds", String(low), String(high)))
                    }
                }
            } else { ProgressView() }
        }.padding().disabled(model.busy)
        .confirmationDialog(L.t("native_settings_key_confirm"),isPresented:$confirmKey) {
            Button(L.t("common_save")) {
                let value = apiKey; apiKey = ""
                model.patch(.init(anthropicApiKey:value),client:client)
            }
        }.onDisappear { apiKey = "" }
    }
}
```

This form saves each field explicitly and re-reads normalized server values; the server clamps
caps using the bounds returned by GET. CLI/model/effort fields accept server aliases, including
`inherit`/`default`, rather than freezing a second model catalog. Invalid values leave the edit in
place and show the model's failure. The read-only retention and cap-bound values explain the
server's behavior. The API-key field uses `SecureField`, clears immediately on submit/disappear,
and is never logged or written to defaults. Empty string requests deletion, with confirmation.

- [ ] **Step 3: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/SettingsFieldsTests
```

```bash
git add native/Apps/ShepherdMac/Sources/Settings/SettingsFields.swift native/Apps/ShepherdMac/Tests/SettingsFieldsTests.swift
git commit -m "feat(mac): general and role CLI settings"
```

### Task 5: Add workspace, repo config and roles

**Files:** `Sources/Settings/SettingsWorkspaceView.swift`, `SettingsRepoFields.swift`, `Tests/SettingsRepoTests.swift`.

**Interfaces:** consumes directory listing, S0 putRepoRoot, generated repo config/roles/pull/fork/sync wrappers; produces server-side directory picker and confirmed repository edits.

- [ ] **Step 1: Test explicit-null role clearing and repo metadata**

```swift
import Foundation
import Testing
import ShepherdKit
@testable import Shepherd
struct SettingsRepoTests {
    @Test func roleClearingSendsNullAndConfigCarriesConfirmation() throws {
        let clear = try RepoRolesPatch.values(reviewer:nil,merger:nil)
        let roles = try #require(JSONSerialization.jsonObject(with:JSONEncoder().encode(clear)) as? [String:Any])
        #expect(roles["reviewer"] is NSNull); #expect(roles["merger"] is NSNull)
        let config = RepoConfigPatch(autoDrainEnabled:true,automationConfirmed:true)
        let body = try #require(JSONSerialization.jsonObject(with:JSONEncoder().encode(config)) as? [String:Any])
        #expect(body["autoDrainEnabled"] as? Bool == true)
        #expect(body["automationConfirmed"] as? Bool == true)
        #expect(body.count == 2)
    }
}
```

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/SettingsRepoTests
```

- [ ] **Step 2: Implement workspace controls and every repository setting**

```swift
import SwiftUI
import ShepherdKit

struct SettingsWorkspaceView: View {
    let model: SettingsModel
    let client: ShepherdClient
    @State private var reviewer = ""
    @State private var merger = ""
    @State private var forkTarget = ""
    @State private var confirmation: String?
    @State private var pendingConfig: RepoConfigPatch?
    var body: some View {
        Form {
            if let error = model.error { Text(verbatim:error).foregroundStyle(.red) }
            Picker(L.t("native_settings_repo"), selection:Binding(get:{model.repo},set:{model.selectRepo($0,client:client)})) {
                Text(L.t("native_settings_select_repo")).tag("")
                ForEach(model.snapshot?.repos ?? [],id:\.path) { Text(verbatim:$0.display).tag($0.path) }
            }
            if let config = model.repoConfig {
                SettingsRepoFields(config:config) { pendingConfig = $0; confirmation = "config" }
            }
            if let roles = model.roles {
                TextField(L.t("native_settings_reviewer"),text:$reviewer)
                TextField(L.t("native_settings_merger"),text:$merger)
                Text(verbatim:(model.collaborators?.logins ?? []).joined(separator:", "))
                if model.collaborators?.collaboratorsUnavailable == true { Text(L.t("native_settings_people_unavailable")) }
                Button(L.t("native_settings_roles_save")) { confirmation = "roles" }
                .onAppear { reviewer = roles.roles.reviewer ?? ""; merger = roles.roles.merger ?? "" }
                .onChange(of:model.repo) { reviewer = model.roles?.roles.reviewer ?? ""; merger = model.roles?.roles.merger ?? "" }
            }
            Button(L.t("native_settings_pull")) { confirmation = "pull" }.disabled(model.repo.isEmpty)
            if model.collaborators?.isFork == true {
                Button(L.t("native_settings_sync")) { confirmation = "sync" }
            }
            TextField(L.t("native_settings_fork_target"),text:$forkTarget)
            Button(L.t("native_settings_fork")) { confirmation = "fork" }.disabled(forkTarget.isEmpty)
            Button(L.t("native_settings_browse_root")) { browse(model.snapshot?.settings.repoRoot) }
            if let listing = model.directories {
                Text(verbatim:listing.display)
                if let parent = listing.parent { Button(L.t("native_settings_parent")) { browse(parent) } }
                ForEach(listing.entries,id:\.path) { row in Button(row.name) { browse(row.path) } }
                Button(L.t("native_settings_use_folder")) { confirmation = "root" }
            }
        }.padding().disabled(model.busy)
        .confirmationDialog(L.t("native_settings_repo_confirm"),isPresented:Binding(
            get:{confirmation != nil},set:{if !$0 {confirmation = nil}})) {
            Button(L.t("common_save")) { apply() }
        } message: {
            Text(verbatim:confirmation == "fork" ? forkTarget : model.repo)
            if confirmation == "roles" { Text(L.t("native_settings_roles_push_notice")) }
            if confirmation == "config" { Text(L.t("native_settings_automation_notice")) }
        }
    }
    private func browse(_ path: String?) {
        model.run({ try await client.listDirectories(path:path) },commit:{ model.directories = $0 })
    }
    private func apply() {
        let action = confirmation; confirmation = nil
        let repo = model.repo
        switch action {
        case "config":
            guard var patch = pendingConfig else {return}; pendingConfig = nil
            patch.automationConfirmed = true
            let confirmed = patch
            model.run({try await client.putRepoConfig(repo:repo,body:confirmed)},commit:{model.repoConfig = $0})
        case "roles":
            let reviewer = reviewer.isEmpty ? nil : reviewer
            let merger = merger.isEmpty ? nil : merger
            model.run({try await client.putRepoRoles(repo:repo,body:.values(reviewer:reviewer,merger:merger))},commit:{model.roles = $0})
        case "pull": model.run {try await client.pullRepo(body:.init(repo:repo))}
        case "sync": model.run {try await client.syncFork(body:.init(repo:repo))}
        case "fork": let target = forkTarget; model.run {try await client.forkRepo(body:.init(target:target))}
        case "root":
            guard let path = model.directories?.path else {return}
            model.run {try await client.putRepoRoot(path)}
        default: break
        }
    }
}
```

```swift
import SwiftUI
import ShepherdKit

struct SettingsRepoFields: View {
    let config: RepoConfig
    let save: (RepoConfigPatch) -> Void
    var body: some View {
        Group {
            Toggle(L.t("native_settings_repo_criticenabled"),isOn:Binding(get:{config.criticEnabled},set:{save(.init(criticEnabled:$0))}))
            Toggle(L.t("native_settings_repo_criticallprs"),isOn:Binding(get:{config.criticAllPrs},set:{save(.init(criticAllPrs:$0))}))
            Toggle(L.t("native_settings_repo_criticsmelllensenabled"),isOn:Binding(get:{config.criticSmellLensEnabled},set:{save(.init(criticSmellLensEnabled:$0))}))
            Toggle(L.t("native_settings_repo_autoaddressenabled"),isOn:Binding(get:{config.autoAddressEnabled},set:{save(.init(autoAddressEnabled:$0))}))
            Toggle(L.t("native_settings_repo_learningsenabled"),isOn:Binding(get:{config.learningsEnabled},set:{save(.init(learningsEnabled:$0))}))
            Toggle(L.t("native_settings_repo_autopilotenabled"),isOn:Binding(get:{config.autopilotEnabled},set:{save(.init(autopilotEnabled:$0))}))
            Toggle(L.t("native_settings_repo_plangateenabled"),isOn:Binding(get:{config.planGateEnabled},set:{save(.init(planGateEnabled:$0))}))
            Toggle(L.t("native_settings_repo_autodrainenabled"),isOn:Binding(get:{config.autoDrainEnabled},set:{save(.init(autoDrainEnabled:$0))}))
            Toggle(L.t("native_settings_repo_automergeenabled"),isOn:Binding(get:{config.autoMergeEnabled},set:{save(.init(autoMergeEnabled:$0))}))
            Toggle(L.t("native_settings_repo_buildqueueenabled"),isOn:Binding(get:{config.buildQueueEnabled},set:{save(.init(buildQueueEnabled:$0))}))
            Toggle(L.t("native_settings_repo_draftmode"),isOn:Binding(get:{config.draftMode},set:{save(.init(draftMode:$0))}))
            Toggle(L.t("native_settings_repo_autooptimizeflagged"),isOn:Binding(get:{config.autoOptimizeFlagged},set:{save(.init(autoOptimizeFlagged:$0))}))
            Toggle(L.t("native_settings_repo_manualstepsissueenabled"),isOn:Binding(get:{config.manualStepsIssueEnabled},set:{save(.init(manualStepsIssueEnabled:$0))}))
            Toggle(L.t("native_settings_repo_prewarmepiclandingci"),isOn:Binding(get:{config.preWarmEpicLandingCi},set:{save(.init(preWarmEpicLandingCi:$0))}))
            Toggle(L.t("native_settings_repo_epicstacksenabled"),isOn:Binding(get:{config.epicStacksEnabled},set:{save(.init(epicStacksEnabled:$0))}))
            Toggle(L.t("native_settings_repo_hidden"),isOn:Binding(get:{config.hidden},set:{save(.init(hidden:$0))}))
            SettingsRepoTextRow(title:"native_settings_repo_maxauto",value:String(config.maxAuto)) { value in
                guard let parsed = Int(value) else {return}; save(.init(maxAuto:parsed))
            }
            SettingsRepoTextRow(title:"native_settings_repo_usageceilingpct",value:String(config.usageCeilingPct)) { value in
                guard let parsed = Double(value) else {return}; save(.init(usageCeilingPct:parsed))
            }
            SettingsRepoTextRow(title:"native_settings_repo_signoffauthority",value:config.signoffAuthority) {save(.init(signoffAuthority:$0))}
            SettingsRepoTextRow(title:"native_settings_repo_autolabel",value:config.autoLabel) {save(.init(autoLabel:$0))}
            SettingsRepoTextRow(title:"native_settings_repo_sandboxprofile",value:config.sandboxProfile) {save(.init(sandboxProfile:$0))}
            SettingsRepoTextRow(title:"native_settings_repo_defaultmodel",value:config.defaultModel) {save(.init(defaultModel:$0))}
            SettingsRepoTextRow(title:"native_settings_repo_defaulteffort",value:config.defaultEffort) {save(.init(defaultEffort:$0))}
            SettingsRepoTextRow(title:"native_settings_repo_repomode",value:config.repoMode) {save(.init(repoMode:$0))}
            SettingsRepoTextRow(title:"native_settings_repo_previewopenmode",value:config.previewOpenMode) {save(.init(previewOpenMode:$0))}
            SettingsRepoTextRow(title:"native_settings_repo_previewstartscript",value:config.previewStartScript ?? "") {save(.init(previewStartScript:$0))}
            SettingsRepoTextRow(title:"native_settings_repo_previewstartcommand",value:config.previewStartCommand ?? "") {save(.init(previewStartCommand:$0))}
            SettingsRepoTextRow(title:"native_settings_repo_egressextrahosts",value:config.egressExtraHosts.joined(separator:",")) {
                save(.init(egressExtraHosts:$0.split(separator:",").map { $0.trimmingCharacters(in:.whitespaces) }))
            }
        }
    }
}
struct SettingsRepoTextRow: View {
    let title: StaticString
    let value: String
    let save: (String) -> Void
    @State private var draft = ""
    var body: some View {
        HStack {
            TextField(L.t(title),text:$draft)
            Button(L.t("common_save")) {save(draft)}.disabled(draft == value)
        }.onAppear {draft = value}.onChange(of:value) {draft = value}
    }
}
```

Role changes display the committed-push warning before sending. A 502 is a failed operation even
if a local roles file exists; refresh before retrying. Re-selecting a repo clears prior roles and
collaborators immediately. Directory navigation is remote-server data, never a local `NSOpenPanel`.
The server clamps traversal to its ceiling; choosing the displayed directory calls the existing
core PUT wrapper. `init-empty-commit` remains S11-owned and is not redeclared or reimplemented.
Repo automation confirmation is metadata, never a stored RepoConfig property.

- [ ] **Step 3: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/SettingsRepoTests
```

```bash
git add native/Apps/ShepherdMac/Sources/Settings/SettingsWorkspaceView.swift native/Apps/ShepherdMac/Sources/Settings/SettingsRepoFields.swift native/Apps/ShepherdMac/Tests/SettingsRepoTests.swift
git commit -m "feat(mac): repository settings and operator actions"
```

### Task 6: Build cookie-authenticated token administration

**Files:** `Sources/Settings/SettingsAccessView.swift`, `Tests/SettingsTokensTests.swift`.

**Interfaces:** consumes Task 2 core token wrappers and a fresh password login; produces scoped tokens, one-time reveal, revoke confirmation and secret teardown.

- [ ] **Step 1: Test secret lifetime independently from Keychain**

```swift
import Foundation
import Testing
import ShepherdKit
@testable import Shepherd
@MainActor struct SettingsTokensTests {
    @Test func closeClearsAllObservableAccessState() {
        let tokens = SettingsTokensModel()
        tokens.close(); tokens.close()
        #expect(tokens.revealed == nil); #expect(tokens.entries.isEmpty)
        #expect(!tokens.authenticated); #expect(!tokens.busy); #expect(tokens.error == nil)
    }
    @Test func lateFailedAuthenticationAfterCloseIsDiscarded() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 0.01
        let transport = URLSession(configuration:config)
        let tokens = SettingsTokensModel()
        tokens.authenticate(profile:.init(name:"offline",baseURL:URL(string:"http://127.0.0.1:1")!,mode:.local),
            password:"fixture",session:transport)
        tokens.close()
        for _ in 0..<10 {await Task.yield()}
        #expect(!tokens.authenticated); #expect(tokens.revealed == nil); #expect(tokens.error == nil)
    }
}
```

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/SettingsTokensTests
```

- [ ] **Step 2: Implement the token model and access pane**

```swift
import SwiftUI
import ShepherdKit

struct SettingsAccessView: View {
    let app: AppModel
    let settings: SettingsModel
    @State private var password = ""
    @State private var name = ""
    @State private var days = 0
    @State private var scope: Components.Schemas.TokenScope = .read
    @State private var revokeID: String?
    var body: some View {
        let model = settings.tokens
        Form {
            if settings.snapshot?.settings.envTokenActive == true { Text(L.t("native_settings_env_token")) }
            if let error = model.error { Text(verbatim: error).foregroundStyle(.red) }
            if !model.authenticated {
                SecureField(L.t("login_password_label"), text: $password)
                Button(L.t("native_settings_token_login")) {
                    guard let profile = app.activeProfile else { return }
                    let secret = password; password = ""
                    model.authenticate(profile: profile, password: secret)
                }.disabled(password.isEmpty || model.busy)
            } else {
                TextField(L.t("native_settings_token_name"), text: $name)
                Picker(L.t("native_settings_token_expiry"), selection: $days) {
                    Text(L.t("native_settings_never")).tag(0)
                    ForEach([30,90,365], id: \.self) { Text(L.t("native_settings_days", String($0))).tag($0) }
                }
                Picker(L.t("native_settings_token_scope"), selection: $scope) {
                    Text(L.t("native_settings_scope_read")).tag(Components.Schemas.TokenScope.read)
                    Text(L.t("native_settings_scope_submit")).tag(Components.Schemas.TokenScope.submit)
                    Text(L.t("native_settings_scope_full")).tag(Components.Schemas.TokenScope.full)
                }
                Button(L.t("native_settings_token_create")) {
                    model.mint(name: name.trimmingCharacters(in: .whitespacesAndNewlines), days: days == 0 ? nil : .init(rawValue:days), scope: scope)
                    name = ""
                }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 64 || model.busy)
                if let revealed = model.revealed {
                    Text(L.t("native_settings_token_once"))
                    Text(verbatim: revealed).textSelection(.enabled).privacySensitive()
                }
                ForEach(model.entries, id: \.id) { token in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(verbatim: token.name)
                            Text(verbatim: "\(token.hint) · \(token.scope.rawValue)")
                            if let expiry = token.expiresAt { Text(Date(timeIntervalSince1970: Double(expiry)/1000), style: .date) }
                        }
                        Button(L.t("native_settings_revoke"), role: .destructive) { revokeID = token.id }
                    }
                }
                Button(L.t("native_settings_lock_access")) { model.close() }
            }
        }.padding().disabled(model.busy)
        .confirmationDialog(L.t("native_settings_revoke_confirm"), isPresented: Binding(
            get: { revokeID != nil }, set: { if !$0 { revokeID = nil } })) {
            Button(L.t("native_settings_revoke"), role: .destructive) {
                guard let id = revokeID else { return }; revokeID = nil; model.revoke(id: id)
            }
        }
        .onDisappear { password = ""; model.close() }
        .onChange(of: app.activationGeneration) { password = ""; model.close() }
    }
}
```

The model is created in Task 3; this task creates the view. Name is trimmed and bounded to 64; scopes are read/submit/full with **read** as
default; expiry is never/30/90/365 days. The access pane reports an env-provisioned token without
claiming it can list or revoke that secret. The one-time value is selectable for native Copy;
no AppKit clipboard bridge or automatic clipboard write is needed. Selecting another pane closes
the ephemeral cookie session. A profile change tears down its owner even if the Settings window
stays open. No token/password is persisted by this feature.

- [ ] **Step 3: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/SettingsTokensTests
```

```bash
git add native/Apps/ShepherdMac/Sources/Settings/SettingsTokensModel.swift native/Apps/ShepherdMac/Sources/Settings/SettingsAccessView.swift native/Apps/ShepherdMac/Tests/SettingsTokensTests.swift
git commit -m "feat(mac): ephemeral access token administration"
```

### Task 7: Expose diagnostics and all usage details

**Files:** `Sources/Settings/SettingsDiagnoseView.swift`, `Tests/SettingsDiagnosticsTests.swift`.

**Interfaces:** consumes diagnostic snapshot/event, existing usage limits and S0 observed windows; produces refresh/fix confirmation, key verification and missing usage fields.

- [ ] **Step 1: Test future diagnostic states and observed usage decoding**

```swift
import Foundation
import Testing
import ShepherdKit
@testable import Shepherd
struct SettingsDiagnosticsTests {
    @Test func unknownStateDoesNotBreakTheWholeSnapshot() throws {
        let data = Data(#"{"checks":[{"id":"future","state":"new_state","hintKey":"future_hint"}],"generatedAt":1,"overall":"new_state"}"#.utf8)
        let snapshot = try JSONDecoder().decode(DiagnosticsSnapshot.self,from:data)
        #expect(snapshot.overall.known == nil)
        #expect(snapshot.checks.first?.state.rawValue == "new_state")
    }
    @Test func observedAndModelWindowsRemainDistinct() throws {
        let data = Data(#"{"session5h":null,"week":null,"perModelWeek":[{"model":"opus","pct":40,"resetAt":null,"scrapedAt":1,"stale":false}],"credits":null,"stale":false,"calibratedAt":null,"subscriptionOnly":true,"observed":{"session5h":{"pct":70,"resetAt":100,"scrapedAt":1},"week":null}}"#.utf8)
        let usage = try JSONDecoder().decode(UsageLimits.self,from:data)
        #expect(usage.subscriptionOnly)
        #expect(usage.perModelWeek.first?.pct == 40)
        #expect(usage.observed?.session5h?.pct == 70)
        #expect(usage.observed?.week == nil)
    }
}
```

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/SettingsDiagnosticsTests
```

- [ ] **Step 2: Generate literal diagnostic dispatch, then implement the pane**

```python
from pathlib import Path
import json,re
root = Path.cwd()
en = json.loads((root / "ui/messages/en.json").read_text())
lines = ["import Foundation", "enum SettingsDiagnosticCopy {",
    "    static func text(_ key: String, params: [String:String]) -> String {", "        switch key {"]
for key in sorted(key for key in en if key.startswith("diagnostics_")):
    names = list(dict.fromkeys(re.findall(r"\{([a-zA-Z0-9_]+)\}",en[key])))
    args = "".join(', params[' + json.dumps(name) + '] ?? "—"' for name in names)
    lines.append('        case ' + json.dumps(key) + ': return L.t(' + json.dumps(key) + args + ')')
lines += ['        default: return L.t("native_settings_diagnostic_unknown")', '        }', '    }', '}']
(root / "native/Apps/ShepherdMac/Sources/Settings/SettingsDiagnosticCopy.swift").write_text("\n".join(lines) + "\n")
```

```swift
import SwiftUI
import ShepherdKit

struct SettingsDiagnoseView: View {
    let model: SettingsModel
    let client: ShepherdClient
    @State private var fix: DiagnosticCheck?
    @State private var verify = false
    var body: some View {
        ScrollView {
            VStack(alignment:.leading,spacing:12) {
                if let error = model.error { Text(verbatim:error).foregroundStyle(.red) }
                Button(L.t("native_settings_refresh_diagnostics")) {
                    model.run({ try await client.getDiagnostics(refresh:"1") },commit:{ model.replaceDiagnostics($0) })
                }
                ForEach(model.snapshot?.diagnostics.checks ?? [],id:\.id) { check in
                    GroupBox {
                        VStack(alignment:.leading) {
                            Text(verbatim:check.id + " · " + check.state.rawValue)
                            Text(SettingsDiagnosticCopy.text(check.hintKey,params:check.hintParams?.additionalProperties ?? [:]))
                            if check.remediation != nil || check.fixActionKey != nil {
                                Button(L.t("native_settings_fix")) { fix = check }
                            }
                        }
                    }
                }
                Button(L.t("native_settings_verify_key")) { verify = true }
                if let result = model.verification {
                    Text(result.ok ? L.t("native_settings_verify_ok") : L.t("native_settings_verify_failed"))
                    if let reason = result.reason { Text(verbatim:reason) }
                }
                if let usage = model.snapshot?.usage { SettingsUsageView(usage:usage) }
            }.padding().disabled(model.busy)
        }
        .sheet(isPresented:Binding(get:{fix != nil},set:{if !$0 {fix = nil}})) {
            if let check = fix {
                VStack(alignment:.leading,spacing:12) {
                    Text(L.t("native_settings_fix_confirm"))
                    if let command = check.remediation { Text(verbatim:command).font(.system(.body,design:.monospaced)) }
                    if let key = check.fixActionKey {
                        Text(SettingsDiagnosticCopy.text(key,params:check.fixActionParams?.additionalProperties ?? [:]))
                    }
                    Button(L.t("common_cancel")) { fix = nil }.keyboardShortcut(.cancelAction)
                    Button(L.t("native_settings_fix")) {
                        let id = check.id; fix = nil
                        model.run({try await client.fixDiagnostics(body:.init(checkId:id))},commit:{model.replaceDiagnostics($0)})
                    }
                }.padding()
            }
        }
        .confirmationDialog(L.t("native_settings_verify_confirm"),isPresented:$verify) {
            Button(L.t("native_settings_verify_key")) {
                model.run({try await client.verifySettingsKey()},commit:{model.verification = $0})
            }
        }
    }
}
struct SettingsUsageView: View {
    let usage: UsageLimits
    var body: some View {
        GroupBox(L.t("native_settings_usage")) {
            VStack(alignment:.leading) {
                Text(usage.subscriptionOnly ? L.t("native_settings_subscription_only") : L.t("native_settings_usage_all"))
                if usage.stale { Text(L.t("native_settings_stale")) }
                if let at = usage.calibratedAt { Text(Date(timeIntervalSince1970:Double(at)/1000),style:.date) }
                ForEach(usage.perModelWeek,id:\.model) { window in
                    Text(L.t("native_settings_model_usage",window.model,String(window.pct)))
                    if window.stale { Text(L.t("native_settings_stale")) }
                }
                if let observed = usage.observed {
                    if let window = observed.session5h {
                        Text(L.t("native_settings_observed_session",String(window.pct)))
                        Text(Date(timeIntervalSince1970:Double(window.resetAt)/1000),style:.relative)
                    }
                    if let window = observed.week {
                        Text(L.t("native_settings_observed_week",String(window.pct)))
                        Text(Date(timeIntervalSince1970:Double(window.resetAt)/1000),style:.relative)
                    }
                } else { Text(L.t("native_settings_observed_absent")) }
                if let credits = usage.credits {
                    Text(L.t("native_settings_credits",String(credits.spent),String(credits.cap),credits.currency))
                    if credits.stale { Text(L.t("native_settings_stale")) }
                }
            }
        }
    }
}
```

Task 10 generates `SettingsDiagnosticCopy` from the real diagnostic message keys. Never pass a
server string to `StaticString` or display an unresolved translation key as a sentence. Unknown
checks retain their stable ID/state and get the localized generic fallback. A fix confirmation
shows the exact public remediation or code-fix label/parameters that the snapshot supplied; only
`checkId` is sent. Verification spawns work server-side, so it is never automatic or in live smoke.

- [ ] **Step 3: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/SettingsDiagnosticsTests
```

```bash
git add native/Apps/ShepherdMac/Sources/Settings/SettingsDiagnoseView.swift native/Apps/ShepherdMac/Sources/Settings/SettingsDiagnosticCopy.swift native/Apps/ShepherdMac/Tests/SettingsDiagnosticsTests.swift
git commit -m "feat(mac): diagnostic controls and complete usage detail"
```

### Task 8: Apply device appearance and native reduced-push semantics

**Files:** `Sources/Settings/SettingsAppearance.swift`, `SettingsReadyModel.swift`, `Tests/SettingsReadyTests.swift`.

**Interfaces:** consumes web theme controller, `src/ready-stage.ts`, `src/ready-notify.ts`, S6 delivery via S0; produces system/light/dark, contrast/shapes/motion and seed/dwell/warm-up/send-gated ready notifications.

- [ ] **Step 1: Write rule-by-rule tests with an injected clock value**

```swift
import Foundation
import Testing
import ShepherdKit
@testable import Shepherd
struct SettingsReadyTests {
    @Test func seedWarmupDwellRetryAndPrune() {
        var state = SettingsReadyState()
        #expect(state.candidates(enabled:true,ids:["old"],ready:["old"],now:0).isEmpty)
        #expect(state.candidates(enabled:true,ids:["old","new"],ready:["old","new"],now:1_000).isEmpty)
        #expect(state.candidates(enabled:true,ids:["old","new"],ready:["old","new"],now:15_999).isEmpty)
        #expect(state.candidates(enabled:true,ids:["old","new"],ready:["old","new"],now:16_000) == ["new"])
        // No sent() call: a focused/denied/cooldown delivery must retry.
        #expect(state.candidates(enabled:true,ids:["new"],ready:["new"],now:17_000) == ["new"])
        state.sent("new")
        #expect(state.candidates(enabled:true,ids:["new"],ready:["new"],now:18_000).isEmpty)
        #expect(state.seen["old"] == nil)
        #expect(state.candidates(enabled:false,ids:["new"],ready:["new"],now:19_000).isEmpty)
        #expect(!state.armed); #expect(state.seen.isEmpty)
        #expect(state.candidates(enabled:true,ids:["new"],ready:["new"],now:20_000).isEmpty)
    }
    @Test func leavingReadyRestartsDwell() {
        var state = SettingsReadyState()
        _ = state.candidates(enabled:true,ids:["a"],ready:[],now:0)
        _ = state.candidates(enabled:true,ids:["a"],ready:["a"],now:20_000)
        _ = state.candidates(enabled:true,ids:["a"],ready:[],now:24_999)
        #expect(state.candidates(enabled:true,ids:["a"],ready:["a"],now:25_000).isEmpty)
        #expect(state.candidates(enabled:true,ids:["a"],ready:["a"],now:30_000) == ["a"])
    }
    @Test func reducedPolicyFiltersRawReadyAndAllowsOnlyTheWebAllowlist() {
        for kind in ["done","blocked","merge_error","ready"] {
            #expect(!SettingsReadyRules.allows(kind:kind,reduced:true,evaluatedReady:false))
        }
        for kind in ["usage_limit","extra_credits","backup_stale","onboarding_stale"] {
            #expect(SettingsReadyRules.allows(kind:kind,reduced:true,evaluatedReady:false))
        }
        #expect(SettingsReadyRules.allows(kind:"ready",reduced:true,evaluatedReady:true))
        #expect(SettingsReadyRules.allows(kind:"done",reduced:false,evaluatedReady:false))
    }
    @Test(arguments: [
        (#"{"state":"merged","checks":"success","deployConfigured":false}"#, false),
        (#"{"state":"open","checks":"pending","deployConfigured":false}"#, false),
        (#"{"state":"open","checks":"failure","deployConfigured":false}"#, true),
        (#"{"state":"open","checks":"success","deployConfigured":false,"handoff":"reviewer"}"#, false),
        (#"{"state":"open","checks":"success","deployConfigured":false,"handoff":"merger"}"#, false),
        (#"{"state":"open","checks":"success","deployConfigured":false,"handoff":"reviewer","isDraft":true}"#, true),
        (#"{"state":"open","checks":"none","deployConfigured":false,"noCi":true,"handoff":"reviewer"}"#, false),
        (#"{"state":"open","checks":"none","deployConfigured":false,"noCi":false,"handoff":"reviewer"}"#, true),
    ] as [(String,Bool)])
    func gitReadyPrecedence(_ fixture: (String,Bool)) throws {
        let git = try JSONDecoder().decode(GitState.self,from:Data(fixture.0.utf8))
        let session = PreviewData.session(status:.init(known:.idle))
        #expect(SettingsReadyRules.ready(session,git:git,reviewing:false,working:false,now:0) == fixture.1)
    }
    @Test func readyFlagAndMergeBackstopPrecedence() {
        var session = PreviewData.session(status:.init(known:.idle))
        session.readyToMerge = true; session.mergingSince = 1
        #expect(!SettingsReadyRules.ready(session,git:nil,reviewing:false,working:false,now:10))
        #expect(SettingsReadyRules.ready(session,git:nil,reviewing:false,working:false,now:86_400_001))
    }
    @Test func readyPredicateExcludesRunningReviewAndWorkingBlocked() {
        var session = PreviewData.session(status:.init(known:.idle))
        #expect(SettingsReadyRules.ready(session,git:nil,reviewing:false,working:false,now:0))
        #expect(!SettingsReadyRules.ready(session,git:nil,reviewing:true,working:false,now:0))
        session.status = .init(known:.blocked)
        #expect(!SettingsReadyRules.ready(session,git:nil,reviewing:false,working:true,now:0))
        session.status = .init(known:.running)
        #expect(!SettingsReadyRules.ready(session,git:nil,reviewing:false,working:false,now:0))
    }
}
```

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/SettingsReadyTests
```

- [ ] **Step 2: Implement appearance and the finite ready evaluator**

```swift
import SwiftUI
import Observation
import ShepherdKit

private struct SettingsMotionKey: EnvironmentKey { static let defaultValue = false }
private struct SettingsShapesKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var shepherdReduceMotion: Bool {
        get {self[SettingsMotionKey.self]}
        set {self[SettingsMotionKey.self] = newValue}
    }
    var shepherdDifferentiateWithoutColor: Bool {
        get {self[SettingsShapesKey.self]}
        set {self[SettingsShapesKey.self] = newValue}
    }
}
struct SettingsStatusShape: ViewModifier {
    let status: SessionStatus
    @Environment(\.shepherdDifferentiateWithoutColor) private var shapes
    private var symbol: String {
        switch status.known {
        case .done: "checkmark.circle"
        case .blocked: "exclamationmark.triangle"
        case .running: "arrow.triangle.2.circlepath"
        case .archived: "archivebox"
        default: "circle"
        }
    }
    func body(content: Content) -> some View {
        HStack {content; if shapes {Image(systemName:symbol).accessibilityHidden(true)}}
    }
}
@Observable @MainActor final class SettingsPresentation {
    static let shared = SettingsPresentation()
    var palette = false
    var openSettingsRequest = 0
}
struct SettingsAppearanceView: View {
    @AppStorage("native.appearance.theme") private var theme = "system"
    @AppStorage("native.appearance.motion") private var motion = "system"
    @AppStorage("native.appearance.contrast") private var contrast = false
    @AppStorage("native.appearance.colorblind") private var colorblind = false
    var body: some View {
        Form {
            Picker(L.t("native_settings_theme"),selection:$theme) {
                Text(L.t("native_settings_system")).tag("system")
                Text(L.t("native_settings_light")).tag("light")
                Text(L.t("native_settings_dark")).tag("dark")
            }
            Picker(L.t("native_settings_motion"),selection:$motion) {
                Text(L.t("native_settings_system")).tag("system")
                Text(L.t("native_settings_full_motion")).tag("full")
                Text(L.t("native_settings_reduced_motion")).tag("reduced")
            }
            Toggle(L.t("native_settings_contrast"),isOn:$contrast)
            Toggle(L.t("native_settings_colorblind"),isOn:$colorblind)
        }
    }
}
struct SettingsRootModifier: ViewModifier {
    let app: AppModel
    var hostsPalette = true
    @Environment(\.openSettings) private var openSettings
    @Environment(\.accessibilityReduceMotion) private var systemMotion
    @Environment(\.accessibilityDifferentiateWithoutColor) private var systemShapes
    @AppStorage("native.appearance.theme") private var theme = "system"
    @AppStorage("native.appearance.motion") private var motion = "system"
    @AppStorage("native.appearance.contrast") private var contrast = false
    @AppStorage("native.appearance.colorblind") private var colorblind = false
    func body(content: Content) -> some View {
        @Bindable var presentation = SettingsPresentation.shared
        content
            .preferredColorScheme(theme == "dark" ? .dark : theme == "light" ? .light : nil)
            .contrast(contrast ? 1.15 : 1)
            .environment(\.shepherdReduceMotion, motion == "system" ? systemMotion : motion == "reduced")
            .transaction { transaction in
                if motion == "reduced" || (motion == "system" && systemMotion) {
                    transaction.disablesAnimations = true; transaction.animation = nil
                }
            }
            .environment(\.shepherdDifferentiateWithoutColor, colorblind || systemShapes)
            .sheet(isPresented: Binding(get:{hostsPalette && presentation.palette},set:{presentation.palette = $0})) {
                SettingsCommandPalette(app:app).frame(width:560,height:420)
            }
            .onChange(of:presentation.openSettingsRequest) { if hostsPalette { openSettings() } }
            .onChange(of:app.activationGeneration) { presentation.palette = false }
    }
}
```

```swift
import Foundation
import Observation
import ShepherdKit

struct SettingsReadyState {
    private(set) var armed = false
    private(set) var seen: [String:Int] = [:]
    private var dwell: [String:(since:Int,notified:Bool)] = [:]
    mutating func candidates(enabled: Bool, ids: Set<String>, ready: Set<String>, now: Int) -> [String] {
        guard enabled else { self = .init(); return [] }
        seen = seen.filter { ids.contains($0.key) }; dwell = dwell.filter { ids.contains($0.key) }
        for id in ids where seen[id] == nil { seen[id] = now }
        if !armed {
            armed = true
            for id in ready.intersection(ids) { dwell[id] = (now,true) }
            return []
        }
        var result: [String] = []
        for id in ids.sorted() {
            guard ready.contains(id) else { dwell[id] = nil; continue }
            if dwell[id] == nil { dwell[id] = (now,false) }
            guard let entry = dwell[id], !entry.notified,
                  now - entry.since >= 5_000, now - (seen[id] ?? now) >= 15_000 else { continue }
            result.append(id)
        }
        return result
    }
    mutating func sent(_ id: String) { if dwell[id] != nil { dwell[id]?.notified = true } }
}
enum SettingsReadyRules {
    // Mirrors src/ready-stage.ts, whose merged exclusion intentionally differs from the UI lens.
    static func ready(_ session: Session, git: GitState?, reviewing: Bool, working: Bool, now: Int) -> Bool {
        if session.status.known == .running || (session.status.known == .blocked && working) || reviewing {return false}
        if git?.state.known == .merged {return false}
        if let since = session.mergingSince, now - since < 86_400_000 {return false}
        if session.readyToMerge {return true}
        if git?.state.known == .open && git?.checks.known == .pending {return false}
        if git?.state.known == .open && git?.checks.known == .failure {return true}
        if let git, git.state.known == .open,
            git.checks.known == .success || (git.checks.known == .some(.none) && git.noCi == true),
            session.status.known != .running, session.status.known != .blocked {
            if git.isDraft == true {return true}
            return git.handoff?.known != .reviewer && git.handoff?.known != .merger
        }
        return true
    }
    static func allows(kind: String, reduced: Bool, evaluatedReady: Bool) -> Bool {
        guard reduced else {return true}
        if kind == "ready" {return evaluatedReady}
        return ["usage_limit","extra_credits","backup_stale","onboarding_stale"].contains(kind)
    }
}
@MainActor enum SettingsNotificationBridge {
    static var git: (AppModel) -> [String:GitState] = {_ in [:]}
    static var reviewing: (AppModel,String) -> Bool = {_,_ in false}
    static var sendReady: (AppModel,Session) async -> Bool = {_,_ in false}
}
@MainActor final class SettingsReadyModel: AppExtension {
    private var timer: Task<Void,Never>?
    private var state = SettingsReadyState()
    init(store: SessionStore, app: AppModel) {
        let activation = app.activationGeneration
        timer = Task { [weak self,weak app,weak store] in
            while let self, let app, let store, !Task.isCancelled, app.activationGeneration == activation {
                let now = Int(Date().timeIntervalSince1970 * 1000)
                let sessions = store.sessions.filter { $0.status.known != .archived }
                let git = SettingsNotificationBridge.git(app)
                let working = SessionSignals.workingBlocked()
                let ready = Set(sessions.filter { SettingsReadyRules.ready($0,git:git[$0.id],
                    reviewing:SettingsNotificationBridge.reviewing(app,$0.id),working:working[$0.id] == true,now:now) }.map(\.id))
                let enabled = app.extension(SettingsModel.self)?.snapshot?.settings.reducedPushMode == true
                for id in self.state.candidates(enabled:enabled,ids:Set(sessions.map(\.id)),ready:ready,now:now) {
                    guard let session = sessions.first(where:{$0.id == id}) else {continue}
                    let sent = await SettingsNotificationBridge.sendReady(app,session)
                    guard !Task.isCancelled, app.activationGeneration == activation else {return}
                    if sent {self.state.sent(id)}
                }
                do {try await Task.sleep(for:.seconds(1))} catch {return}
            }
        }
    }
    func teardown() {timer?.cancel();timer = nil;state = .init()}
}
```

Create `Sources/Settings/SettingsCommandPalette.swift` now; the root modifier references it.

```swift
import SwiftUI
import ShepherdKit

@MainActor enum SettingsCommandSearch {
    static func rows(query: String, app: AppModel) -> [MenuCommand] {
        let words = query.folding(options:[.caseInsensitive,.diacriticInsensitive],locale:.current)
            .split(whereSeparator: { $0.isWhitespace })
        return MenuCommand.Menu.allCases.flatMap { CommandRegistry.commands(in:$0) }
            .filter { command in
                let title = L.t(command.titleKey).folding(options:[.caseInsensitive,.diacriticInsensitive],locale:.current)
                return words.allSatisfy { title.contains($0) }
            }
    }
}
struct SettingsCommandPalette: View {
    let app: AppModel
    @State private var query = ""
    @State private var selection: String?
    @FocusState private var searchFocused: Bool
    private var rows: [MenuCommand] { SettingsCommandSearch.rows(query:query,app:app) }
    var body: some View {
        VStack {
            TextField(L.t("native_settings_command_search"),text:$query)
                .focused($searchFocused).onSubmit { invoke() }
            List(selection:$selection) {
                ForEach(rows) { command in
                    Button { invoke(command.id) } label: {
                        HStack {
                            Text(L.t(command.titleKey)); Spacer()
                            if let shortcut = command.shortcut {
                                Text(verbatim:"⌘" + (shortcut.option ? "⌥" : "") + (shortcut.shift ? "⇧" : "") + String(shortcut.key).uppercased())
                            }
                        }
                    }.disabled(!command.isEnabled(app)).tag(command.id)
                }
            }
            if rows.isEmpty { Text(L.t("native_settings_no_commands")) }
        }.padding().onAppear { searchFocused = true; selection = rows.first?.id }
        .onChange(of:query) { selection = rows.first?.id }
        .onExitCommand { SettingsPresentation.shared.palette = false }
        .onMoveCommand { direction in
            guard !rows.isEmpty else {return}
            let index = rows.firstIndex(where:{$0.id == selection}) ?? 0
            if direction == .down {selection = rows[min(rows.count-1,index+1)].id}
            if direction == .up {selection = rows[max(0,index-1)].id}
        }.accessibilityIdentifier("settings-command-palette")
    }
    private func invoke(_ id: String? = nil) {
        guard let command = rows.first(where:{$0.id == (id ?? selection)}), command.isEnabled(app) else {return}
        SettingsPresentation.shared.palette = false
        command.action(app)
    }
}
```

The native theme follows the OS by leaving preferredColorScheme nil in system mode. The contrast
layer composes with either scheme. SwiftUI accessibility environment values are read-only: read
them, then publish effective app preferences through the two writable app keys. Reduced motion
disables animation transactions; S0 adds the optional redundant status glyph to both sidebar row
hosts using the modifier below. Motion can
follow the OS or explicitly choose full/reduced. Apply the root modifier to **both** the main and
Settings scenes through S0 (Task 9). The ready evaluator intentionally mirrors the server notifier,
not all of S7's newer UI stage categories. It prunes IDs, seeds on arm, warms for 15 s, requires
5 s continuous readiness, retries rejected delivery and cancels on profile teardown.

- [ ] **Step 3: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/SettingsReadyTests
```

```bash
git add native/Apps/ShepherdMac/Sources/Settings/SettingsAppearance.swift native/Apps/ShepherdMac/Sources/Settings/SettingsCommandPalette.swift native/Apps/ShepherdMac/Sources/Settings/SettingsReadyModel.swift native/Apps/ShepherdMac/Tests/SettingsReadyTests.swift
git commit -m "feat(mac): appearance and reduced native notifications"
```

### Task 9: Install panes, commands and the palette; retire the old settings window

**Files:** `Sources/Settings/SettingsFeature.swift`, `Tests/SettingsRegistrationTests.swift`; S0-only integration handoff below.

**Interfaces:** consumes S0 Settings scene/registries and S6 notification model; produces six native panes, ⌘K palette, menu commands, one Settings window.

- [ ] **Step 1: Test scene registration before any activation**

```swift
import Foundation
import Testing
import ShepherdKit
@testable import Shepherd
@Suite(.serialized) @MainActor struct SettingsRegistrationTests {
    @Test func sceneRegistrationIsModelFreeAndIdempotent() {
        defer {SettingsPaneRegistry.reset();CommandRegistry.reset()}
        SettingsFeature.installScene(); SettingsFeature.installScene()
        #expect(SettingsPaneRegistry.panes.map(\.id) == ["general","notifications","workspace","clis","access","diagnose"])
        #expect(CommandRegistry.commands(in:.view).filter {$0.shortcut == .init("k")}.count == 1)
        let suite = "SettingsRegistry-" + UUID().uuidString
        let defaults = UserDefaults(suiteName:suite)!
        defer {defaults.removePersistentDomain(forName:suite)}
        let app = AppModel(defaults:defaults,credentials:InMemoryCredentialStore())
        SettingsFeature.install(app); SettingsFeature.install(app)
        #expect(app.extensionFactories.count == 2)
        let rows = SettingsCommandSearch.rows(query:"",app:app)
        #expect(rows.contains {$0.id == "settings.open"})
        #expect(rows.first {$0.id == "settings.refresh"}?.isEnabled(app) == false)
        #expect(SettingsCommandSearch.rows(query:"zzzz_unmatchable",app:app).isEmpty)
        app.teardown()
    }
}
```

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/SettingsRegistrationTests
```

- [ ] **Step 2: Implement registry entries and the shared-command palette**

```swift
import SwiftUI
import ShepherdKit

struct SettingsPaneEntry: SettingsPane {
    let id: String
    let titleKey: StaticString
    let systemImage: String
    let order: Int
    var title: String {L.t(titleKey)}
    @MainActor static func notifications(in app: AppModel) -> NotificationsModel? {
        app.extension(NotificationsModel.self)
    }
    @MainActor func makeView(app: AppModel) -> AnyView {
        AnyView(Group {
            if id == "general" {
                ScrollView {
                    SettingsAppearanceView()
                    if let model = app.extension(SettingsModel.self), let store = app.store {
                        SettingsGeneralView(model:model,client:store.client)
                    }
                }
            } else if id == "notifications", let model = Self.notifications(in: app) {
                VStack {
                    NotificationSettingsView(model:model,profileName:app.activeProfile?.name ?? "")
                    if let settings = app.extension(SettingsModel.self), let client = app.store?.client {
                        Toggle(L.t("native_settings_reduced_push"),isOn:Binding(
                            get:{settings.snapshot?.settings.reducedPushMode == true},
                            set:{settings.patch(.init(reducedPushMode:$0),client:client)}))
                            .disabled(settings.busy)
                    }
                }.padding()
            } else if let model = app.extension(SettingsModel.self), let store = app.store {
                switch id {
                case "workspace": SettingsWorkspaceView(model:model,client:store.client)
                case "clis": SettingsGeneralView(model:model,client:store.client,cli:true)
                case "access": SettingsAccessView(app:app,settings:model)
                case "diagnose": SettingsDiagnoseView(model:model,client:store.client)
                default: EmptyView()
                }
            } else { Text(L.t("native_settings_connect")) }
        }.id(app.activationGeneration))
    }
}
@MainActor enum SettingsFeature {
    static func installScene() {
        let panes: [(String,StaticString,String)] = [
            ("general","native_settings_general","gearshape"),
            ("notifications","native_settings_notifications","bell"),
            ("workspace","native_settings_workspace","folder"),
            ("clis","native_settings_clis","terminal"),
            ("access","native_settings_access","key"),
            ("diagnose","native_settings_diagnose","stethoscope")]
        for (index,pane) in panes.enumerated() {
            SettingsPaneRegistry.register(SettingsPaneEntry(id:pane.0,titleKey:pane.1,systemImage:pane.2,order:index*100))
        }
        CommandRegistry.register(.init(id:"settings.palette",menu:.view,order:0,
            titleKey:"native_settings_command_palette",shortcut:.init("k"),
            action:{_ in SettingsPresentation.shared.palette = true}))
        // ⌘, belongs to the SwiftUI Settings scene; do not install a second shortcut.
        CommandRegistry.register(.init(id:"settings.open",menu:.window,order:100,
            titleKey:"native_settings_open",action:{_ in SettingsPresentation.shared.openSettingsRequest += 1}))
        CommandRegistry.register(.init(id:"settings.refresh",menu:.help,order:100,
            titleKey:"native_settings_refresh_diagnostics",isEnabled:{$0.extension(SettingsModel.self) != nil},
            action:{$0.extension(SettingsModel.self)?.reload()}))
    }
    static func install(_ app: AppModel) {
        app.register(SettingsModel.self)
        app.register(SettingsReadyModel.self)
    }
}
```

The palette projects **all existing registry entries**, keeps the same enabled predicates and
invokes the same actions as the menu. It never duplicates a command implementation or captures an
outgoing store. Search is case/diacritic-insensitive across all typed words; arrows, Return and
Escape work. ⌘, is supplied by the SwiftUI Settings scene, so this stream adds no competing
shortcut. The web also mixes session/action search into its command bar; native limits this first
surface to registered commands, with session selection owned by S7's sidebar. Record that deliberate
scope choice in the PR.

- [ ] **Step 3: Deliver these concrete integration changes to S0, without changing its files**

```swift
// StreamRegistrations.installScene():
SettingsFeature.installScene()
// StreamRegistrations.installAll(into:), after all earlier streams:
SettingsFeature.install(app)
SettingsNotificationBridge.git = {$0.extension(HerdSignals.self)?.git ?? [:]}
SettingsNotificationBridge.reviewing = {app,id in app.extension(HerdSignals.self)?.isReviewing(id) ?? false}
SettingsNotificationBridge.sendReady = {app,session in
    guard let model = app.extension(NotificationsModel.self) else {return false}
    return await model.deliver(.init(kind:.ready,sessionID:session.id,subject:session.name),evaluatedReady:true)
}
// This is lazy per-activation lookup; never capture a NotificationsModel instance here.
// HerdGroupView: replace the SessionRow expression with:
SessionRow(session: display(session))
    .modifier(SettingsStatusShape(status: display(session).status))
// MainWindow fallback list: replace the SessionRow expression, preserving its tag:
SessionRow(session: session)
    .modifier(SettingsStatusShape(status: session.status)).tag(session.id)
// ShepherdApp main WindowGroup content, after .environment(model):
.modifier(SettingsRootModifier(app:model))
// ShepherdApp Settings scene content, after .environment(model):
.modifier(SettingsRootModifier(app:model,hostsPalette:false))
```

S0 replaces `NotificationsStream.install` with this entire method (the AppKit menu installer is
removed, while notification registration is preserved):

```swift
static func install(_ app: AppModel) {
    app.register(NotificationsModel.self)
    Log.app.info("notifications stream installed")
}
```

S0 deletes `NotificationSettingsWindow` (the enum starting at line 97 and all its methods) from
`NotificationSettingsView.swift`, and removes that file's `import AppKit`, `import Observation`,
and `import os` if unused after deletion. Keep the SwiftUI `NotificationSettingsView` itself,
which the new Notifications pane embeds. There must be no reference to `NotificationSettingsWindow`
or its old menu item after integration. No replacement `NSWindow` or `NSApp` usage is introduced.

**Retire the old tests in the same S0 commit.** At tip `895c439d`, the trailing
`NotificationWindowStateTests` suite in `Tests/NotificationsModelTests.swift` still calls
`NotificationSettingsWindow.reset/installMenuItem/show/isOpen/armedWatchers`. Deleting only the
production enum leaves the test target uncompilable. Replace that whole trailing suite with the
following; keep all earlier notification delivery, authorization, cooldown, badge and teardown
suites, plus `NotificationsBadgeRaceTests.swift`, unchanged. Remove obsolete menu/panel-only
helpers and imports if no longer used. These tests preserve registration and permission-copy
coverage, and replace window-close/watch assertions with the new scene's actual contract:
re-resolve the active notification model and retire the old model on profile switch.

```swift
@Suite(.serialized) @MainActor
struct NotificationWindowStateTests {
    @Test func notificationPaneAndModelRegisterOnce() {
        let suite = "notification-scene-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer {
            defaults.removePersistentDomain(forName: suite)
            SettingsPaneRegistry.reset(); CommandRegistry.reset()
        }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        defer { app.teardown() }
        NotificationsStream.install(app); NotificationsStream.install(app)
        SettingsFeature.installScene(); SettingsFeature.installScene()
        #expect(app.extensionFactories.count == 1)
        #expect(SettingsPaneEntry.notifications(in: app) == nil)
        #expect(SettingsPaneRegistry.panes.filter { $0.id == "notifications" }.count == 1)
    }
    @Test func permissionCopySurvivesPanelRetirement() {
        #expect(NotificationSettingsView.permissionNote(for: .denied)
            == L.t("native_notify_settings_permission_denied"))
        #expect(NotificationSettingsView.permissionNote(for: .granted) == nil)
        #expect(NotificationSettingsView.permissionNote(for: .notDetermined) == nil)
        #expect(NotificationSettingsView.showsAskButton(for: .notDetermined))
        #expect(!NotificationSettingsView.showsAskButton(for: .granted))
        #expect(!NotificationSettingsView.showsAskButton(for: .denied))
    }
    @Test func paneResolvesNewActivationAndCannotWriteThroughRetiredModel() async throws {
        let suite = "notification-scene-switch-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        defer { app.teardown() }
        NotificationsStream.install(app)
        let first = try app.addRemoteProfile(name: "first", address: "https://first.example.ts.net")
        await app.activate(first)
        let old = try #require(SettingsPaneEntry.notifications(in: app))
        let generation = app.activationGeneration
        let second = try app.addRemoteProfile(name: "second", address: "https://second.example.ts.net")
        await app.activate(second)
        let current = try #require(SettingsPaneEntry.notifications(in: app))
        #expect(current !== old)
        #expect(app.activationGeneration != generation)
        let oldSettings = old.settings
        let currentSettings = current.settings
        old.save(oldSettings.settingEnabled(!oldSettings.enabled))
        #expect(old.settings == oldSettings)
        #expect(current.settings == currentSettings)
        app.teardown() // Synchronous generation change, before any observer can arm.
        #expect(SettingsPaneEntry.notifications(in: app) == nil)
        #expect(!old.isSubscribed); #expect(!current.isSubscribed)
    }
}
```

The scene stays open across profile changes; `.id(app.activationGeneration)` recreates its pane
content. The removed AppKit watcher no longer exists, so retaining its watcher-count assertions
would test obsolete behavior. S0 also adds an isolated UI check for one Settings window under
repeated ⌘, and no legacy Notifications menu item. The stream's source-only build does not prove
this migration; the integrated full unit suite below is a required gate.

S0 adds this policy seam and delivery method **inside** `NotificationsModel`, then replaces its
existing `handle` method with the complete replacement shown next. This preserves permission,
focus, cooldown and real-send latching while letting S12 filter all native intents:

```swift
@ObservationIgnored var intentPolicy: @MainActor (NotificationIntent,Bool) -> Bool = {_,_ in true}
func deliver(_ intent: NotificationIntent, evaluatedReady: Bool = false) async -> Bool {
    guard !isTornDown, !Task.isCancelled, intentPolicy(intent,evaluatedReady) else {return false}
    let t = now()
    guard gate.allows(intent,at:t,settings:settings,windowFocused:windowFocused,
        authorized:authorization == .granted) else {return false}
    let sent = await center.post(NotificationRequest.make(title:NotificationCopy.title(intent),
        body:NotificationCopy.body(intent),threadIdentifier:intent.threadIdentifier,sessionID:intent.sessionID))
    guard !isTornDown, !Task.isCancelled else {return false}
    if sent {gate.posted(intent,at:t);trigger.usageWarningPosted(for:intent)}
    return sent
}
func handle(_ event: ServerEvent) async {
    guard !isTornDown, !Task.isCancelled else {return}
    for intent in trigger.intents(for:event) {
        _ = await deliver(intent)
        guard !isTornDown, !Task.isCancelled else {return}
    }
    await refreshBadge()
}
```

In S0's **live** `NotificationsModel.init(store:app:)`, after stored properties have been
initialized, assign this instance policy. Leave the existing offline/test initializer's default
allow policy intact; a process-global static policy would make S6's tests depend on whether the
host app had already installed S12.

```swift
intentPolicy = { [weak app] intent, evaluated in
    let reduced = app?.extension(SettingsModel.self)?.snapshot?.settings.reducedPushMode ?? true
    return SettingsReadyRules.allows(kind: intent.kind.id, reduced: reduced, evaluatedReady: evaluated)
}
```

S0 runs the full unit bundle, including the migrated suite and the existing notification
focus/cooldown/latch/teardown/badge-race tests, after this change:

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests
```

S6's raw `session:ready` intent is filtered while reduced mode is enabled; only the
new evaluator may pass `evaluatedReady:true`. Until settings have loaded, the conservative reduced
policy prevents a notification burst. Keep the web allowlist names even where S6 has no producer
for a kind yet; this feature does not invent notification sources.

- [ ] **Step 4: Run green, verify retirement on the integration branch and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/SettingsRegistrationTests
```

```bash
rg 'NotificationSettingsWindow' native/Apps/ShepherdMac/Sources native/Apps/ShepherdMac/Tests || true
rg 'import AppKit|NSWindow|\.toolbar' native/Apps/ShepherdMac/Sources/Settings || true
git add native/Apps/ShepherdMac/Sources/Settings/SettingsFeature.swift native/Apps/ShepherdMac/Tests/SettingsRegistrationTests.swift
git commit -m "feat(mac): settings panes menu commands and command palette"
```

### Task 10: Generate the owning strings and diagnostic lookup

**Files:** `native/scripts/gen-strings.ts` (`KEYS_SETTINGS` only), EN/DE catalogs, generated `.xcstrings`, `Sources/Settings/SettingsDiagnosticCopy.swift`, `Tests/SettingsStringsTests.swift`.

**Interfaces:** consumes all view literals and web diagnostic message keys; produces complete EN/DE coverage and safe dynamic-message dispatch.

- [ ] **Step 1: Write the red localization assertions**

```swift
import Testing
@testable import Shepherd
struct SettingsStringsTests {
    @Test func labelsAndUnknownDiagnosticsResolve() {
        #expect(L.t("native_settings_command_palette") != "native_settings_command_palette")
        #expect(SettingsDiagnosticCopy.text("not_a_known_key",params:[:]) == L.t("native_settings_diagnostic_unknown"))
        #expect(SettingsDiagnosticCopy.text("diagnostics_hint_bun_missing",params:[:]) != "diagnostics_hint_bun_missing")
    }
}
```

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/SettingsStringsTests
```

- [ ] **Step 2: Apply complete EN/DE additions, generate dynamic dispatch and update only KEYS_SETTINGS**

```python
from pathlib import Path
import json,re
root = Path.cwd()
additions = {'native_settings_load_failed': ('Could not load settings. Retry after reconnecting.',
                                 'Einstellungen konnten nicht geladen werden. Nach dem '
                                 'Verbinden erneut versuchen.'),
 'native_settings_action_failed': ('The operation failed. Refresh before retrying.',
                                   'Die Aktion ist fehlgeschlagen. Vor einem neuen Versuch '
                                   'aktualisieren.'),
 'native_settings_login_failed': ('Could not start operator login.',
                                  'Operator-Anmeldung konnte nicht gestartet werden.'),
 'native_settings_token_failed': ('Token operation failed. Unlock access again.',
                                  'Token-Aktion fehlgeschlagen. Zugriff erneut entsperren.'),
 'native_settings_env_token': ('An environment-provisioned token is active on this server.',
                               'Auf diesem Server ist ein über die Umgebung bereitgestelltes '
                               'Token aktiv.'),
 'native_settings_token_login': ('Unlock token administration', 'Token-Verwaltung entsperren'),
 'native_settings_token_name': ('Token name', 'Token-Name'),
 'native_settings_token_expiry': ('Expires after', 'Läuft ab nach'),
 'native_settings_never': ('Never', 'Nie'),
 'native_settings_days': ('{days} days', '{days} Tagen'),
 'native_settings_token_scope': ('Scope', 'Berechtigung'),
 'native_settings_scope_read': ('Read only', 'Nur lesen'),
 'native_settings_scope_submit': ('Submit tasks', 'Aufgaben einreichen'),
 'native_settings_scope_full': ('Full access', 'Vollzugriff'),
 'native_settings_token_create': ('Create token', 'Token erstellen'),
 'native_settings_token_once': ('Shown once. Copy now; closing this pane hides it permanently.',
                                'Nur einmal sichtbar. Jetzt kopieren; nach dem Schließen ist '
                                'es nicht erneut abrufbar.'),
 'native_settings_revoke': ('Revoke', 'Widerrufen'),
 'native_settings_lock_access': ('Lock access', 'Zugriff sperren'),
 'native_settings_revoke_confirm': ('Revoke this token? Clients using it will lose access.',
                                    'Dieses Token widerrufen? Clients verlieren damit ihren '
                                    'Zugriff.'),
 'native_settings_key_present': ('API key configured', 'API-Schlüssel eingerichtet'),
 'native_settings_key_absent': ('No API key configured', 'Kein API-Schlüssel eingerichtet'),
 'native_settings_api_key': ('API key (empty clears it)', 'API-Schlüssel (leer zum Löschen)'),
 'native_settings_key_save': ('Save API key', 'API-Schlüssel speichern'),
 'native_settings_key_confirm': ('Replace or clear the server API key?',
                                 'API-Schlüssel des Servers ersetzen oder löschen?'),
 'native_settings_retention': ('Retention: {days} days, keeping {keep} sessions',
                               'Aufbewahrung: {days} Tage, mindestens {keep} Sitzungen'),
 'native_settings_pr_bounds': ('PR review cap range: {min}–{max}',
                               'Bereich für PR-Review-Limit: {min}–{max}'),
 'native_settings_plan_bounds': ('Plan review cap range: {min}–{max}',
                                 'Bereich für Plan-Review-Limit: {min}–{max}'),
 'native_settings_repo': ('Repository', 'Repository'),
 'native_settings_select_repo': ('Select a repository', 'Repository wählen'),
 'native_settings_reviewer': ('Reviewer login', 'Reviewer-Login'),
 'native_settings_merger': ('Merger login', 'Merger-Login'),
 'native_settings_people_unavailable': ('Collaborator suggestions are unavailable.',
                                        'Mitarbeiter-Vorschläge sind nicht verfügbar.'),
 'native_settings_roles_save': ('Save and push roles', 'Rollen speichern und pushen'),
 'native_settings_pull': ('Pull default branch', 'Standardbranch aktualisieren'),
 'native_settings_sync': ('Sync fork', 'Fork synchronisieren'),
 'native_settings_fork_target': ('GitHub owner/repository', 'GitHub-Eigentümer/Repository'),
 'native_settings_fork': ('Fork and clone', 'Fork erstellen und klonen'),
 'native_settings_browse_root': ('Browse server folders', 'Server-Ordner durchsuchen'),
 'native_settings_parent': ('Parent folder', 'Übergeordneter Ordner'),
 'native_settings_use_folder': ('Use this folder', 'Diesen Ordner verwenden'),
 'native_settings_repo_confirm': ('Apply this change on the server?',
                                  'Diese Änderung auf dem Server anwenden?'),
 'native_settings_roles_push_notice': ('This commits and pushes the reviewer and merger roles '
                                       'to the default branch.',
                                       'Dies committet und pusht die Reviewer- und '
                                       'Merger-Rollen in den Standardbranch.'),
 'native_settings_automation_notice': ('Enabling automation can start agents and merge work '
                                       'without another prompt.',
                                       'Aktivierte Automatisierung kann Agenten starten und '
                                       'Änderungen ohne weitere Nachfrage mergen.'),
 'native_settings_refresh_diagnostics': ('Refresh diagnostics', 'Diagnose aktualisieren'),
 'native_settings_fix': ('Apply fix', 'Korrektur anwenden'),
 'native_settings_verify_key': ('Verify API key', 'API-Schlüssel prüfen'),
 'native_settings_verify_ok': ('Key verified', 'Schlüssel bestätigt'),
 'native_settings_verify_failed': ('Verification failed', 'Prüfung fehlgeschlagen'),
 'native_settings_fix_confirm': ('Run this remediation on the server?',
                                 'Diese Korrektur auf dem Server ausführen?'),
 'native_settings_verify_confirm': ('Start a temporary agent to verify authentication?',
                                    'Temporären Agenten zur Prüfung der Anmeldung starten?'),
 'native_settings_usage': ('Usage details', 'Nutzungsdetails'),
 'native_settings_subscription_only': ('Subscription usage only', 'Nur Abonnement-Nutzung'),
 'native_settings_usage_all': ('Usage including paid credits',
                               'Nutzung einschließlich Zusatzguthaben'),
 'native_settings_stale': ('Data is stale', 'Daten sind veraltet'),
 'native_settings_model_usage': ('{model}: {pct}% this week', '{model}: {pct}% diese Woche'),
 'native_settings_observed_session': ('Observed 5-hour window: {pct}%',
                                      'Beobachtetes 5-Stunden-Fenster: {pct}%'),
 'native_settings_observed_week': ('Observed week: {pct}%', 'Beobachtete Woche: {pct}%'),
 'native_settings_observed_absent': ('No observed usage windows available',
                                     'Keine beobachteten Nutzungsfenster verfügbar'),
 'native_settings_credits': ('Credits: {spent} of {cap} {currency}',
                             'Zusatzguthaben: {spent} von {cap} {currency}'),
 'native_settings_theme': ('Appearance', 'Darstellung'),
 'native_settings_system': ('System', 'System'),
 'native_settings_light': ('Light', 'Hell'),
 'native_settings_dark': ('Dark', 'Dunkel'),
 'native_settings_motion': ('Motion', 'Bewegung'),
 'native_settings_full_motion': ('Full motion', 'Volle Bewegung'),
 'native_settings_reduced_motion': ('Reduced motion', 'Reduzierte Bewegung'),
 'native_settings_contrast': ('Increase contrast', 'Kontrast erhöhen'),
 'native_settings_colorblind': ('Differentiate without color', 'Ohne Farbe unterscheiden'),
 'native_settings_command_search': ('Search commands', 'Befehle suchen'),
 'native_settings_no_commands': ('No matching commands', 'Keine passenden Befehle'),
 'native_settings_reduced_push': ('Reduced notifications', 'Reduzierte Benachrichtigungen'),
 'native_settings_connect': ('Connect to a server to edit these settings.',
                             'Zum Bearbeiten dieser Einstellungen mit einem Server verbinden.'),
 'native_settings_general': ('General', 'Allgemein'),
 'native_settings_notifications': ('Notifications', 'Benachrichtigungen'),
 'native_settings_workspace': ('Workspace', 'Arbeitsbereich'),
 'native_settings_clis': ('Coding CLIs', 'Coding-CLIs'),
 'native_settings_access': ('Access', 'Zugriff'),
 'native_settings_diagnose': ('Diagnose', 'Diagnose'),
 'native_settings_command_palette': ('Command palette', 'Befehlspalette'),
 'native_settings_open': ('Settings…', 'Einstellungen …'),
 'native_settings_diagnostic_unknown': ('This check needs attention. Consult the server '
                                        'diagnostics.',
                                        'Diese Prüfung erfordert Aufmerksamkeit. '
                                        'Server-Diagnose prüfen.'),
 'native_settings_field_remotecontrolatstartup': ('Remote control at startup',
                                                  'Fernsteuerung beim Start'),
 'native_settings_field_reducedpushmode': ('Reduced notifications',
                                           'Reduzierte Benachrichtigungen'),
 'native_settings_field_sessionhousekeepingenabled': ('Session housekeeping',
                                                      'Sitzungsbereinigung'),
 'native_settings_field_autoreviveenabled': ('Automatically revive sessions',
                                             'Sitzungen automatisch wiederbeleben'),
 'native_settings_field_upnextskipclipicker': ('Skip CLI picker for Up Next',
                                               'CLI-Auswahl für Als Nächstes überspringen'),
 'native_settings_field_usageholdenabled': ('Hold tasks at usage limit',
                                            'Aufgaben am Nutzungslimit halten'),
 'native_settings_field_usageholdautorelease': ('Automatically release held tasks',
                                                'Gehaltene Aufgaben automatisch freigeben'),
 'native_settings_field_usagedowngradeenabled': ('Downgrade model at usage limit',
                                                 'Modell am Nutzungslimit herabstufen'),
 'native_settings_field_fableavailable': ('Fable available', 'Fable verfügbar'),
 'native_settings_field_judgeenabled': ('Enable judge', 'Judge aktivieren'),
 'native_settings_field_tuifullscreen': ('Fullscreen TUI', 'Vollbild-TUI'),
 'native_settings_field_tuidisablemouse': ('Disable TUI mouse capture',
                                           'TUI-Mauserfassung deaktivieren'),
 'native_settings_field_prreviewcyclescap': ('PR review cycle cap',
                                             'Limit für PR-Review-Zyklen'),
 'native_settings_field_planreviewcyclescap': ('Plan review cycle cap',
                                               'Limit für Plan-Review-Zyklen'),
 'native_settings_field_distillerintervaldays': ('Distiller interval in days',
                                                 'Distiller-Intervall in Tagen'),
 'native_settings_field_extracreditsdrainceiling': ('Drain paid-credit ceiling',
                                                    'Zusatzguthaben-Limit für Drain'),
 'native_settings_field_usageholdpct': ('Usage hold percentage',
                                        'Nutzungsprozentsatz zum Halten'),
 'native_settings_field_usagedowngradepct': ('Model downgrade percentage',
                                             'Nutzungsprozentsatz zur Modell-Herabstufung'),
 'native_settings_field_judgedailyusd': ('Judge daily USD ceiling',
                                         'Tägliches USD-Limit für Judge'),
 'native_settings_field_defaultmodel': ('Default model', 'Standardmodell'),
 'native_settings_field_defaultcodexmodel': ('Default Codex model', 'Standardmodell für Codex'),
 'native_settings_field_defaulteffort': ('Default effort', 'Standardaufwand'),
 'native_settings_field_defaultagentprovider': ('Default coding CLI', 'Standard-Coding-CLI'),
 'native_settings_field_authmode': ('Agent authentication mode', 'Anmeldemodus für Agenten'),
 'native_settings_field_operatorlanguage': ('Operator language', 'Operator-Sprache'),
 'native_settings_field_usagedowngrademodel': ('Fallback model at usage limit',
                                               'Ersatzmodell am Nutzungslimit'),
 'native_settings_field_blockjudgemode': ('Blocked-session judge mode',
                                          'Judge-Modus für blockierte Sitzungen'),
 'native_settings_field_houserulerelevance': ('House-rule relevance mode',
                                              'Relevanzmodus für Hausregeln'),
 'native_settings_field_telemetryconsent': ('Telemetry consent', 'Telemetrie-Zustimmung'),
 'native_settings_field_criticcli': ('critic CLI', 'critic CLI'),
 'native_settings_field_criticmodel': ('critic model', 'critic Modell'),
 'native_settings_field_criticeffort': ('critic effort', 'critic Aufwand'),
 'native_settings_field_plannercli': ('planner CLI', 'planner CLI'),
 'native_settings_field_plannermodel': ('planner model', 'planner Modell'),
 'native_settings_field_plannereffort': ('planner effort', 'planner Aufwand'),
 'native_settings_field_recapcli': ('recap CLI', 'recap CLI'),
 'native_settings_field_recapmodel': ('recap model', 'recap Modell'),
 'native_settings_field_recapeffort': ('recap effort', 'recap Aufwand'),
 'native_settings_field_docagentcli': ('docAgent CLI', 'docAgent CLI'),
 'native_settings_field_docagentmodel': ('docAgent model', 'docAgent Modell'),
 'native_settings_field_docagenteffort': ('docAgent effort', 'docAgent Aufwand'),
 'native_settings_field_distillercli': ('distiller CLI', 'distiller CLI'),
 'native_settings_field_distillermodel': ('distiller model', 'distiller Modell'),
 'native_settings_field_distillereffort': ('distiller effort', 'distiller Aufwand'),
 'native_settings_field_optimizercli': ('optimizer CLI', 'optimizer CLI'),
 'native_settings_field_optimizermodel': ('optimizer model', 'optimizer Modell'),
 'native_settings_field_optimizereffort': ('optimizer effort', 'optimizer Aufwand'),
 'native_settings_field_mergesuggestcli': ('mergeSuggest CLI', 'mergeSuggest CLI'),
 'native_settings_field_mergesuggestmodel': ('mergeSuggest model', 'mergeSuggest Modell'),
 'native_settings_field_mergesuggesteffort': ('mergeSuggest effort', 'mergeSuggest Aufwand'),
 'native_settings_field_namercli': ('namer CLI', 'namer CLI'),
 'native_settings_field_namermodel': ('namer model', 'namer Modell'),
 'native_settings_field_namereffort': ('namer effort', 'namer Aufwand'),
 'native_settings_field_autopilotcli': ('autopilot CLI', 'autopilot CLI'),
 'native_settings_field_autopilotmodel': ('autopilot model', 'autopilot Modell'),
 'native_settings_field_autopiloteffort': ('autopilot effort', 'autopilot Aufwand'),
 'native_settings_repo_criticenabled': ('PR critic', 'PR-Kritiker'),
 'native_settings_repo_criticallprs': ('Critic on all PRs', 'Kritiker für alle PRs'),
 'native_settings_repo_criticsmelllensenabled': ('Critic smell checks',
                                                 'Kritiker-Smell-Prüfungen'),
 'native_settings_repo_autoaddressenabled': ('Automatically address review',
                                             'Review automatisch bearbeiten'),
 'native_settings_repo_learningsenabled': ('Learnings', 'Erkenntnisse'),
 'native_settings_repo_autopilotenabled': ('Autopilot', 'Autopilot'),
 'native_settings_repo_plangateenabled': ('Plan gate', 'Plan-Freigabe'),
 'native_settings_repo_autodrainenabled': ('Automatic drain', 'Automatischer Drain'),
 'native_settings_repo_automergeenabled': ('Automatic merge', 'Automatischer Merge'),
 'native_settings_repo_buildqueueenabled': ('Build queue', 'Build-Warteschlange'),
 'native_settings_repo_draftmode': ('Draft mode', 'Entwurfsmodus'),
 'native_settings_repo_autooptimizeflagged': ('Optimize flagged rules',
                                              'Markierte Regeln optimieren'),
 'native_settings_repo_manualstepsissueenabled': ('Manual-step tracking issue',
                                                  'Tracking-Issue für manuelle Schritte'),
 'native_settings_repo_prewarmepiclandingci': ('Pre-warm epic landing CI',
                                               'Epic-Landing-CI vorwärmen'),
 'native_settings_repo_epicstacksenabled': ('Epic stacks', 'Epic-Stacks'),
 'native_settings_repo_hidden': ('Hide repository', 'Repository ausblenden'),
 'native_settings_repo_maxauto': ('Maximum concurrent automatic agents',
                                  'Maximale gleichzeitige automatische Agenten'),
 'native_settings_repo_usageceilingpct': ('Usage ceiling percentage',
                                          'Nutzungslimit in Prozent'),
 'native_settings_repo_signoffauthority': ('Sign-off authority', 'Freigabeinstanz'),
 'native_settings_repo_autolabel': ('Drain issue label', 'Issue-Label für Drain'),
 'native_settings_repo_sandboxprofile': ('Sandbox profile', 'Sandbox-Profil'),
 'native_settings_repo_defaultmodel': ('Repository default model',
                                       'Standardmodell des Repositories'),
 'native_settings_repo_defaulteffort': ('Repository default effort',
                                        'Standardaufwand des Repositories'),
 'native_settings_repo_repomode': ('Repository mode', 'Repository-Modus'),
 'native_settings_repo_previewopenmode': ('Preview opening mode', 'Vorschau-Öffnungsmodus'),
 'native_settings_repo_previewstartscript': ('Canonical preview start script',
                                             'Kanonisches Vorschau-Startskript'),
 'native_settings_repo_previewstartcommand': ('Preview start command', 'Vorschau-Startbefehl'),
 'native_settings_repo_egressextrahosts': ('Extra allowed hosts, comma separated',
                                           'Zusätzlich erlaubte Hosts, kommagetrennt')}
for language,index in [("en",0),("de",1)]:
    path = root / "ui/messages" / (language + ".json")
    catalog = json.loads(path.read_text())
    for key,values in additions.items():
        if key in catalog: assert catalog[key] == values[index], key
        else: catalog[key] = values[index]
    path.write_text(json.dumps(catalog,ensure_ascii=False,indent=2) + "\n")
en = json.loads((root / "ui/messages/en.json").read_text())
de = json.loads((root / "ui/messages/de.json").read_text())
diagnostic_keys = sorted(key for key in en if key.startswith("diagnostics_"))
lines = ["import Foundation", "enum SettingsDiagnosticCopy {",
    "    static func text(_ key: String, params: [String:String]) -> String {", "        switch key {"]
for key in diagnostic_keys:
    assert key in de
    names = list(dict.fromkeys(re.findall(r"\{([a-zA-Z0-9_]+)\}",en[key])))
    args = "".join(', params[' + json.dumps(name) + '] ?? "—"' for name in names)
    lines.append('        case ' + json.dumps(key) + ': return L.t(' + json.dumps(key) + args + ')')
lines += ['        default: return L.t("native_settings_diagnostic_unknown")', '        }', '    }', '}']
(root / "native/Apps/ShepherdMac/Sources/Settings/SettingsDiagnosticCopy.swift").write_text("\n".join(lines) + "\n")
source_dir = root / "native/Apps/ShepherdMac/Sources/Settings"
used = set(additions) | set(diagnostic_keys)
for path in source_dir.glob("*.swift"):
    used |= set(re.findall(r'L\.t\("([a-z0-9_]+)"',path.read_text()))
path = root / "native/scripts/gen-strings.ts"
source = path.read_text()
pattern = r"export const KEYS_SETTINGS: readonly string\[\] = \[[\s\S]*?\];"
assert len(re.findall(pattern,source)) == 1
owned_elsewhere = set(re.findall(r'"([a-z0-9_]+)"',re.sub(pattern,"",source)))
for key in used: assert key in en and key in de, key
replacement = "export const KEYS_SETTINGS: readonly string[] = [\n" + "".join(
    "  " + json.dumps(key) + ",\n" for key in sorted(used-owned_elsewhere)) + "];"
path.write_text(re.sub(pattern,lambda _:replacement,source))
```

Run the Python block from the repository root after creating the view files. It produces only
S12-owned source and its own key array; existing stream keys are reused without claiming them.
The diagnostic dispatcher contains literal `StaticString` calls with parameters in the EN catalog's
placeholder order. DE reordering is handled by the existing string generator. Every native key
above includes both translations; no generated fallback duplicates an English key name.

- [ ] **Step 3: Regenerate strings, run green and commit**

```bash
bun native/scripts/gen-strings.ts
bun native/scripts/gen-strings.ts --check
./native/scripts/test-app.sh -only-testing:ShepherdTests/SettingsStringsTests
git add native/scripts/gen-strings.ts ui/messages native/Apps/ShepherdMac/Resources/Localizable.xcstrings native/Apps/ShepherdMac/Sources/Settings/SettingsDiagnosticCopy.swift native/Apps/ShepherdMac/Tests/SettingsStringsTests.swift
git commit -m "feat(mac): localize settings and diagnostic messages"
```

### Task 11: Run gates, read-only live checks and open the PR

**Files:** `Tests/SettingsLiveTests.swift`, stream branch and PR.

**Interfaces:** consumes completed stream and S0 integration evidence; produces validated settings feature and explicit remaining parity decisions.

- [ ] **Step 1: Add an opt-in GET-only live test**

```swift
import Foundation
import Testing
import ShepherdKit
@testable import Shepherd
struct SettingsLiveTests {
    @Test func readOnlyOperatorServer() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let raw = env["SHEPHERD_LIVE_BASE_URL"],
            let token = env["SHEPHERD_LIVE_TOKEN"],!token.isEmpty else {return}
        let url = try RemoteServerForm.normalize(raw)
        let credentials = InMemoryCredentialStore()
        try credentials.save(.init(token:token,tokenId:"external"),for:"live")
        let client = try ShepherdClient(profile:.init(name:"live",baseURL:url,mode:.remote,credentialKey:"live"),credentials:credentials)
        let settings = try await client.settings()
        let diagnostics = try await client.getDiagnostics()
        let directories = try await client.listDirectories()
        #expect(!settings.repoRoot.isEmpty)
        #expect(diagnostics.generatedAt >= 0)
        #expect(!directories.path.isEmpty)
        let repos = try await client.repos()
        if let repo = repos.repos.first {
            _ = try await client.getRepoConfig(repo:repo.path)
            _ = try await client.getRepoRoles(repo:repo.path)
            _ = try await client.getRepoCollaborators(repo:repo.path)
        }
    }
}
```

Never PATCH/PUT settings, fix diagnostics, verify the key, pull, fork, sync, create/revoke tokens,
or change roles on the operator server during live smoke. Token authorization is proved by the
local real-server fixtures, not by password prompts against production. With no environment
credentials, report “live checks not run”. Do not call refresh=1 in live diagnostics, and do not
revoke an environment-provided credential. All AppModel tests use in-memory credentials plus a
throwaway defaults suite; no Keychain access is permitted.

- [ ] **Step 2: Run the full gate and integration checks**

```bash
bun run lint
bun run typecheck
bun run test
bun run test:contract
bun run gen:contract-swift && bun run check:contract-swift
./native/scripts/sync-contract.sh --check
bun native/scripts/gen-strings.ts --check
swift test --package-path native
./native/scripts/test-app.sh -only-testing:ShepherdTests
./native/scripts/build-app.sh
git checkout -- native/Package.resolved
git diff --check
git diff --name-only origin/main
rg 'NotificationSettingsWindow' native/Apps/ShepherdMac/Sources native/Apps/ShepherdMac/Tests || true
rg 'import AppKit|NSWindow|\.toolbar' native/Apps/ShepherdMac/Sources/Settings || true
```

On S0's integration branch, verify ⌘, opens the SwiftUI Settings scene once, the six panes exist
before activation, ⌘K/Return/Escape work, disabled commands cannot execute, and no old notification
window/menu remains. Switch profiles during a delayed settings GET and token login, then close the
Settings pane: neither stale results nor a revealed token may survive. Test system/dark/light and
motion preferences in both windows using isolated launch defaults. Compare ready-notify tests
against seed/dwell/warm-up/retry/prune rules. The Settings stream cannot claim retirement or native
notification parity until S0's concrete changes have landed and those integration tests pass.

- [ ] **Step 3: Commit final tests and open the stream PR**

```bash
git add native/Apps/ShepherdMac/Tests/SettingsLiveTests.swift
git commit -m "test(mac): settings read-only smoke and final gates"
git push --no-verify -u origin feat/native-settings
cat > /tmp/native-settings-pr.md <<'BODY'
Adds the verified settings contract, generated wrappers, activation-scoped settings model,
six SwiftUI panes, repository controls, ephemeral cookie token administration, diagnostics,
complete usage detail, local appearance, reduced native notifications and the shared command palette.

Validation: contract status/event/auth coverage, transport/rule/lifecycle tests, lint, typecheck,
contract/string drift and app build. Record the actual GET-only live outcome before posting.

Integration: requires S0's PATCH alias, scene modifier, registry installs, S6 window retirement and
notification delivery seam. The palette searches registered commands; session search stays in S7.
BODY
gh pr create --base main --title "feat(native): settings tokens and command surface" --body-file /tmp/native-settings-pr.md
```
