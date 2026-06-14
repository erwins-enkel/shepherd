import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import { config, clampCap, PR_REVIEW_CYCLES_MIN, PR_REVIEW_CYCLES_MAX } from "../src/config";
import type { AuthMode } from "../src/auth-mode";

let tmp: string;
let savedRoot: string;
let savedCeiling: string;
let savedRc: boolean;
let savedHk: boolean;
let savedPrCap: number;
let savedPlanCap: number;
let savedDefaultModel: string;
let savedExtraCredits: number;
let savedAuthMode: AuthMode;
let savedAuthApiKeyHelperPath: string | null;
let savedHome: string | undefined;

beforeEach(() => {
  // realpath so comparisons hold where tmpdir() is a symlink (macOS)
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-settings-test-")));
  mkdirSync(join(tmp, "child"));
  savedRoot = config.repoRoot; // PUT mutates the shared config; restore after
  savedCeiling = config.rootCeiling;
  savedRc = config.remoteControlAtStartup;
  savedHk = config.sessionHousekeepingEnabled;
  savedPrCap = config.prReviewCyclesCap;
  savedPlanCap = config.planReviewCyclesCap;
  savedDefaultModel = config.defaultModel;
  savedExtraCredits = config.extraCreditsDrainCeiling;
  savedAuthMode = config.authMode;
  savedAuthApiKeyHelperPath = config.authApiKeyHelperPath;
  savedHome = process.env.HOME;
  // the ceiling is the immutable boundary; point it at our temp dir for the test so
  // dirs inside tmp validate and the dir browser is confined to tmp.
  config.rootCeiling = tmp;
  // redirect HOME so putAnthropicApiKey writes into our temp dir, not ~/.shepherd
  process.env.HOME = tmp;
});

afterEach(() => {
  config.repoRoot = savedRoot;
  config.rootCeiling = savedCeiling;
  config.remoteControlAtStartup = savedRc;
  config.sessionHousekeepingEnabled = savedHk;
  config.prReviewCyclesCap = savedPrCap;
  config.planReviewCyclesCap = savedPlanCap;
  config.defaultModel = savedDefaultModel;
  config.extraCreditsDrainCeiling = savedExtraCredits;
  config.authMode = savedAuthMode;
  config.authApiKeyHelperPath = savedAuthApiKeyHelperPath;
  if (savedHome !== undefined) process.env.HOME = savedHome;
  else delete process.env.HOME;
  rmSync(tmp, { recursive: true, force: true });
});

function harness(): { app: ReturnType<typeof makeApp>; store: SessionStore } {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    events: new EventHub(),
    service: {} as any,
    usageLimits: { limits: () => ({}) } as any,
  };
  return { app: makeApp(deps), store };
}

const put = (app: ReturnType<typeof makeApp>, body: unknown) =>
  app.fetch(
    new Request("http://x/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

test("GET /api/settings returns the current repo root and remote-control flag", async () => {
  config.repoRoot = tmp;
  config.remoteControlAtStartup = false;
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/settings"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.repoRoot).toBe(tmp);
  expect(typeof body.repoRootDisplay).toBe("string");
  expect(body.remoteControlAtStartup).toBe(false);
  // housekeeping flag + display-only retention thresholds
  expect(typeof body.sessionHousekeepingEnabled).toBe("boolean");
  expect(body.sessionRetentionDays).toBeGreaterThan(0);
  expect(body.sessionRetentionKeep).toBeGreaterThan(0);
  // PR + plan review caps, each with its display-only bounds
  expect(typeof body.prReviewCyclesCap).toBe("number");
  expect(body.prReviewCyclesMin).toBeGreaterThan(0);
  expect(body.prReviewCyclesMax).toBeGreaterThanOrEqual(body.prReviewCyclesMin);
  expect(typeof body.planReviewCyclesCap).toBe("number");
  expect(body.planReviewCyclesMin).toBeGreaterThan(0);
  expect(body.planReviewCyclesMax).toBeGreaterThanOrEqual(body.planReviewCyclesMin);
});

test("PUT /api/settings sets prReviewCyclesCap in range, persists, leaves repoRoot intact", async () => {
  config.repoRoot = tmp;
  config.prReviewCyclesCap = 3;
  const { app, store } = harness();
  const res = await put(app, { prReviewCyclesCap: 5 });
  expect(res.status).toBe(200);
  expect((await res.json()).prReviewCyclesCap).toBe(5);
  expect(config.prReviewCyclesCap).toBe(5); // live
  expect(store.getSetting("prReviewCyclesCap")).toBe("5"); // persisted as a string
  expect(config.repoRoot).toBe(tmp); // a cap patch must not touch the repo root
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.prReviewCyclesCap).toBe(5);
});

test("PUT /api/settings clamps an out-of-range prReviewCyclesCap into the valid bounds", async () => {
  const { app, store } = harness();
  const high = await put(app, { prReviewCyclesCap: 99 });
  expect(high.status).toBe(200);
  const hi = (await high.json()).prReviewCyclesCap;
  expect(hi).toBe(8); // snapped to its MAX, not rejected
  expect(store.getSetting("prReviewCyclesCap")).toBe(String(hi));
  const low = await put(app, { prReviewCyclesCap: 0 });
  expect(low.status).toBe(200);
  expect((await low.json()).prReviewCyclesCap).toBe(1); // snapped to its MIN
});

test("PUT /api/settings rounds a fractional prReviewCyclesCap to an integer", async () => {
  const { app } = harness();
  const res = await put(app, { prReviewCyclesCap: 4.7 });
  expect(res.status).toBe(200);
  expect((await res.json()).prReviewCyclesCap).toBe(5);
});

test("PUT /api/settings rejects a non-number prReviewCyclesCap", async () => {
  const { app } = harness();
  config.prReviewCyclesCap = 3;
  for (const bad of ["4", true, null, NaN]) {
    const res = await put(app, { prReviewCyclesCap: bad });
    expect(res.status).toBe(400);
  }
  expect(config.prReviewCyclesCap).toBe(3); // unchanged on failure
});

test("PUT /api/settings sets planReviewCyclesCap in range, persists, leaves repoRoot intact", async () => {
  config.repoRoot = tmp;
  config.planReviewCyclesCap = 5;
  const { app, store } = harness();
  const res = await put(app, { planReviewCyclesCap: 7 });
  expect(res.status).toBe(200);
  expect((await res.json()).planReviewCyclesCap).toBe(7);
  expect(config.planReviewCyclesCap).toBe(7); // live
  expect(store.getSetting("planReviewCyclesCap")).toBe("7"); // persisted as a string
  expect(config.repoRoot).toBe(tmp); // a cap patch must not touch the repo root
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.planReviewCyclesCap).toBe(7);
});

test("PUT /api/settings clamps an out-of-range planReviewCyclesCap into ITS bounds (1–12)", async () => {
  const { app, store } = harness();
  const high = await put(app, { planReviewCyclesCap: 99 });
  expect(high.status).toBe(200);
  expect((await high.json()).planReviewCyclesCap).toBe(12); // snapped to its MAX (12, not 8)
  expect(store.getSetting("planReviewCyclesCap")).toBe("12");
  const low = await put(app, { planReviewCyclesCap: 0 });
  expect(low.status).toBe(200);
  expect((await low.json()).planReviewCyclesCap).toBe(1); // snapped to its MIN
});

test("PUT /api/settings rounds a fractional planReviewCyclesCap to an integer", async () => {
  const { app } = harness();
  const res = await put(app, { planReviewCyclesCap: 8.4 });
  expect(res.status).toBe(200);
  expect((await res.json()).planReviewCyclesCap).toBe(8);
});

test("PUT /api/settings rejects a non-number planReviewCyclesCap", async () => {
  const { app } = harness();
  config.planReviewCyclesCap = 5;
  for (const bad of ["4", true, null, NaN]) {
    const res = await put(app, { planReviewCyclesCap: bad });
    expect(res.status).toBe(400);
  }
  expect(config.planReviewCyclesCap).toBe(5); // unchanged on failure
});

// Migration read-fallback: an install predating the cap split persisted only the legacy
// `reviewCyclesCap` key. The boot-override in src/index.ts seeds the PR cap from
// `getSetting("prReviewCyclesCap") ?? getSetting("reviewCyclesCap")`. That override is
// top-level module code that runs the whole server bootstrap on import, so rather than
// import it we assert the equivalent expression directly against a real store + clampCap.
test("legacy reviewCyclesCap seeds the PR cap when no prReviewCyclesCap key exists", () => {
  const store = new SessionStore(":memory:");
  store.setSetting("reviewCyclesCap", "6"); // legacy single-cap value, no new key
  const savedPr = store.getSetting("prReviewCyclesCap") ?? store.getSetting("reviewCyclesCap");
  expect(savedPr).toBe("6"); // fallback resolves to the legacy value
  expect(clampCap(Number(savedPr), PR_REVIEW_CYCLES_MIN, PR_REVIEW_CYCLES_MAX, 3)).toBe(6);
  // a fresh store with neither key → no persisted value → boot keeps the env/default seed
  const fresh = new SessionStore(":memory:");
  expect(fresh.getSetting("prReviewCyclesCap") ?? fresh.getSetting("reviewCyclesCap")).toBeNull();
});

test("PUT /api/settings toggles remoteControlAtStartup, persists, leaves repoRoot intact", async () => {
  config.repoRoot = tmp;
  config.remoteControlAtStartup = false;
  const { app, store } = harness();
  const res = await put(app, { remoteControlAtStartup: true });
  expect(res.status).toBe(200);
  expect((await res.json()).remoteControlAtStartup).toBe(true);
  expect(config.remoteControlAtStartup).toBe(true); // live
  expect(store.getSetting("remoteControlAtStartup")).toBe("1"); // persisted as "1"/"0"
  expect(config.repoRoot).toBe(tmp); // a RC patch must not touch the repo root
  // reflected by GET, and toggling back persists "0"
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.remoteControlAtStartup).toBe(true);
  await put(app, { remoteControlAtStartup: false });
  expect(store.getSetting("remoteControlAtStartup")).toBe("0");
});

test("PUT /api/settings rejects a non-boolean remoteControlAtStartup", async () => {
  const { app } = harness();
  const res = await put(app, { remoteControlAtStartup: "yes" });
  expect(res.status).toBe(400);
});

test("PUT /api/settings toggles sessionHousekeepingEnabled, persists, leaves repoRoot intact", async () => {
  config.repoRoot = tmp;
  config.sessionHousekeepingEnabled = true;
  const { app, store } = harness();
  const res = await put(app, { sessionHousekeepingEnabled: false });
  expect(res.status).toBe(200);
  expect((await res.json()).sessionHousekeepingEnabled).toBe(false);
  expect(config.sessionHousekeepingEnabled).toBe(false); // live
  expect(store.getSetting("sessionHousekeepingEnabled")).toBe("0"); // persisted as "1"/"0"
  expect(config.repoRoot).toBe(tmp); // a housekeeping patch must not touch the repo root
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.sessionHousekeepingEnabled).toBe(false);
  await put(app, { sessionHousekeepingEnabled: true });
  expect(store.getSetting("sessionHousekeepingEnabled")).toBe("1");
});

test("PUT /api/settings rejects a non-boolean sessionHousekeepingEnabled", async () => {
  const { app } = harness();
  const before = config.sessionHousekeepingEnabled;
  const res = await put(app, { sessionHousekeepingEnabled: "yes" });
  expect(res.status).toBe(400);
  expect(config.sessionHousekeepingEnabled).toBe(before); // unchanged on failure
});

test("PUT /api/settings updates config, persists, and is reflected by GET", async () => {
  const { app, store } = harness();
  const child = join(tmp, "child");
  const res = await put(app, { repoRoot: child });
  expect(res.status).toBe(200);
  expect((await res.json()).repoRoot).toBe(child);
  // runtime config updated
  expect(config.repoRoot).toBe(child);
  // persisted
  expect(store.getSetting("repoRoot")).toBe(child);
  // reflected by a subsequent GET
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.repoRoot).toBe(child);
});

test("PUT /api/settings with a dir inside the ceiling → 200", async () => {
  const { app } = harness();
  const res = await put(app, { repoRoot: join(tmp, "child") });
  expect(res.status).toBe(200);
});

test("PUT /api/settings with a dir OUTSIDE the ceiling → 400", async () => {
  const { app } = harness();
  const before = config.repoRoot;
  for (const outside of ["/etc", "/tmp", "/"]) {
    const res = await put(app, { repoRoot: outside });
    expect(res.status).toBe(400);
  }
  expect(config.repoRoot).toBe(before); // unchanged on failure
});

test("PUT /api/settings rejects a non-existent directory", async () => {
  const { app } = harness();
  const before = config.repoRoot;
  const res = await put(app, { repoRoot: join(tmp, "does-not-exist") });
  expect(res.status).toBe(400);
  expect(config.repoRoot).toBe(before); // unchanged on failure
});

test("GET /api/fs/dirs lists sub-directories within the ceiling", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request(`http://x/api/fs/dirs?path=${encodeURIComponent(tmp)}`));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path).toBe(tmp);
  expect(body.entries.map((e: { name: string }) => e.name)).toEqual(["child"]);
  expect(body.parent).toBeNull(); // at the ceiling → no parent
});

test("GET /api/fs/dirs?path=/ stays clamped to the ceiling (never escapes to '/')", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/fs/dirs?path=/"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path).toBe(tmp);
  expect(body.parent).toBeNull();
});

test("GET /api/settings includes defaultModel (raw, unresolved)", async () => {
  config.defaultModel = "opus";
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/settings"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.defaultModel).toBe("opus");
});

test("PUT /api/settings sets defaultModel, persists, leaves repoRoot intact", async () => {
  config.repoRoot = tmp;
  config.defaultModel = "auto";
  const { app, store } = harness();
  const res = await put(app, { defaultModel: "fable" });
  expect(res.status).toBe(200);
  expect((await res.json()).defaultModel).toBe("fable");
  expect(config.defaultModel).toBe("fable"); // live
  expect(store.getSetting("defaultModel")).toBe("fable"); // persisted
  expect(config.repoRoot).toBe(tmp); // a defaultModel patch must not touch the repo root
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.defaultModel).toBe("fable");
});

test("PUT /api/settings accepts defaultModel 'auto' and 'default'", async () => {
  const { app } = harness();
  const r1 = await put(app, { defaultModel: "auto" });
  expect(r1.status).toBe(200);
  expect((await r1.json()).defaultModel).toBe("auto");
  const r2 = await put(app, { defaultModel: "default" });
  expect(r2.status).toBe(200);
  expect((await r2.json()).defaultModel).toBe("default");
});

test("PUT /api/settings rejects an unknown defaultModel value", async () => {
  const { app } = harness();
  config.defaultModel = "auto";
  const res = await put(app, { defaultModel: "gpt9" });
  expect(res.status).toBe(400);
  expect(config.defaultModel).toBe("auto"); // unchanged on failure
});

test("PUT /api/settings rejects a non-string defaultModel", async () => {
  const { app } = harness();
  config.defaultModel = "auto";
  const res = await put(app, { defaultModel: 42 });
  expect(res.status).toBe(400);
  expect(config.defaultModel).toBe("auto"); // unchanged on failure
});

test("GET /api/settings includes extraCreditsDrainCeiling", async () => {
  config.extraCreditsDrainCeiling = 25;
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/settings"));
  const body = await res.json();
  expect(body.extraCreditsDrainCeiling).toBe(25);
});

test("PUT /api/settings sets extraCreditsDrainCeiling, persists, leaves repoRoot intact", async () => {
  config.repoRoot = tmp;
  config.extraCreditsDrainCeiling = 0;
  const { app, store } = harness();
  const res = await put(app, { extraCreditsDrainCeiling: 50 });
  expect(res.status).toBe(200);
  expect((await res.json()).extraCreditsDrainCeiling).toBe(50);
  expect(config.extraCreditsDrainCeiling).toBe(50); // live
  expect(store.getSetting("extra_credits_drain_ceiling")).toBe("50"); // persisted
  expect(config.repoRoot).toBe(tmp); // patch must not touch the repo root
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.extraCreditsDrainCeiling).toBe(50);
});

test("PUT /api/settings accepts a fractional extraCreditsDrainCeiling (currency amount)", async () => {
  const { app, store } = harness();
  const res = await put(app, { extraCreditsDrainCeiling: 0.5 });
  expect(res.status).toBe(200);
  expect((await res.json()).extraCreditsDrainCeiling).toBe(0.5);
  expect(store.getSetting("extra_credits_drain_ceiling")).toBe("0.5");
});

test("PUT /api/settings rejects a negative extraCreditsDrainCeiling", async () => {
  const { app } = harness();
  config.extraCreditsDrainCeiling = 0;
  const res = await put(app, { extraCreditsDrainCeiling: -5 });
  expect(res.status).toBe(400);
  expect(config.extraCreditsDrainCeiling).toBe(0); // unchanged on failure
});

test("PUT /api/settings rejects a non-number extraCreditsDrainCeiling", async () => {
  const { app } = harness();
  config.extraCreditsDrainCeiling = 0;
  const res = await put(app, { extraCreditsDrainCeiling: "lots" });
  expect(res.status).toBe(400);
  expect(config.extraCreditsDrainCeiling).toBe(0); // unchanged on failure
});

// ── authMode ──────────────────────────────────────────────────────────────────

test("GET /api/settings includes authMode and hasApiKey, never key/path", async () => {
  config.authMode = "subscription";
  config.authApiKeyHelperPath = null;
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/settings"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.authMode).toBe("subscription");
  expect(body.hasApiKey).toBe(false);
  // must NOT expose the raw key or helper path
  expect("authApiKeyHelperPath" in body).toBe(false);
  expect("anthropicApiKey" in body).toBe(false);
});

test("GET /api/settings hasApiKey is true when helper path is set", async () => {
  config.authMode = "api-key";
  config.authApiKeyHelperPath = "/some/path/helper.sh";
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/settings"));
  const body = await res.json();
  expect(body.authMode).toBe("api-key");
  expect(body.hasApiKey).toBe(true);
  expect("authApiKeyHelperPath" in body).toBe(false);
});

test("PUT /api/settings sets authMode to 'api-key', persists, returns shape", async () => {
  config.authMode = "subscription";
  config.authApiKeyHelperPath = null;
  const { app, store } = harness();
  const res = await put(app, { authMode: "api-key" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.authMode).toBe("api-key");
  expect(typeof body.hasApiKey).toBe("boolean");
  expect(config.authMode as string).toBe("api-key"); // live
  expect(store.getSetting("authMode")).toBe("api-key"); // persisted
});

test("PUT /api/settings sets authMode to 'subscription', persists", async () => {
  config.authMode = "api-key";
  const { app, store } = harness();
  const res = await put(app, { authMode: "subscription" });
  expect(res.status).toBe(200);
  expect((await res.json()).authMode).toBe("subscription");
  expect(config.authMode as string).toBe("subscription");
  expect(store.getSetting("authMode")).toBe("subscription");
});

test("PUT /api/settings allows switching to api-key with no key configured", async () => {
  config.authMode = "subscription";
  config.authApiKeyHelperPath = null;
  const { app } = harness();
  const res = await put(app, { authMode: "api-key" });
  expect(res.status).toBe(200);
  // hasApiKey reflects no key is set yet
  expect((await res.json()).hasApiKey).toBe(false);
});

test("PUT /api/settings rejects an unknown authMode value → 400", async () => {
  config.authMode = "subscription";
  const { app } = harness();
  for (const bad of ["oauth", "api_key", "", 42, null, true]) {
    const res = await put(app, { authMode: bad });
    expect(res.status).toBe(400);
  }
  expect(config.authMode).toBe("subscription"); // unchanged on failure
});

// ── anthropicApiKey ───────────────────────────────────────────────────────────

test("PUT anthropicApiKey writes helper, sets config path, returns {hasApiKey:true} — no key/path in response", async () => {
  config.authApiKeyHelperPath = null;
  const { app, store } = harness();
  const res = await put(app, { anthropicApiKey: "sk-ant-api03-testkey" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.hasApiKey).toBe(true);
  // NEVER expose raw key or path
  expect("authApiKeyHelperPath" in body).toBe(false);
  expect("anthropicApiKey" in body).toBe(false);
  // config updated
  expect(config.authApiKeyHelperPath).not.toBeNull();
  // persisted (we store the path; path must NOT contain the key text)
  const persisted = store.getSetting("authApiKeyHelperPath");
  expect(persisted).not.toBeNull();
  expect(persisted).not.toContain("sk-ant-api03-testkey");
  // helper file must exist
  expect(existsSync(config.authApiKeyHelperPath!)).toBe(true);
});

test("PUT anthropicApiKey trims whitespace from the key", async () => {
  config.authApiKeyHelperPath = null;
  const { app } = harness();
  const res = await put(app, { anthropicApiKey: "  sk-ant-api03-trimmed  " });
  expect(res.status).toBe(200);
  expect(config.authApiKeyHelperPath).not.toBeNull();
});

test("PUT anthropicApiKey with null clears helper, returns {hasApiKey:false}", async () => {
  // first set a key
  config.authApiKeyHelperPath = null;
  const { app, store } = harness();
  await put(app, { anthropicApiKey: "sk-ant-api03-somekey" });
  const pathAfterSet = config.authApiKeyHelperPath;
  expect(pathAfterSet).not.toBeNull();

  // now clear it
  const res = await put(app, { anthropicApiKey: null });
  expect(res.status).toBe(200);
  expect((await res.json()).hasApiKey).toBe(false);
  expect(config.authApiKeyHelperPath).toBeNull();
  expect(store.getSetting("authApiKeyHelperPath")).toBe(""); // marked cleared
  // file should be gone
  expect(existsSync(pathAfterSet!)).toBe(false);
});

test("PUT anthropicApiKey with empty string clears helper", async () => {
  config.authApiKeyHelperPath = null;
  const { app } = harness();
  await put(app, { anthropicApiKey: "sk-ant-api03-somekey" });
  const res = await put(app, { anthropicApiKey: "" });
  expect(res.status).toBe(200);
  expect((await res.json()).hasApiKey).toBe(false);
  expect(config.authApiKeyHelperPath).toBeNull();
});

test("PUT anthropicApiKey with non-string/non-null value → 400", async () => {
  const { app } = harness();
  for (const bad of [42, true, {}, []]) {
    const res = await put(app, { anthropicApiKey: bad });
    expect(res.status).toBe(400);
  }
});
