import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import {
  config,
  clampCap,
  clampFraction,
  PR_REVIEW_CYCLES_MIN,
  PR_REVIEW_CYCLES_MAX,
} from "../src/config";
import type { AuthMode } from "../src/auth-mode";
import { EFFORTS } from "../src/types";
import { OPERATOR_LANGUAGES, normalizeOperatorLanguage } from "../src/operator-language";

let tmp: string;
let savedRoot: string;
let savedCeiling: string;
let savedRc: boolean;
let savedRpm: boolean;
let savedHk: boolean;
let savedPrCap: number;
let savedPlanCap: number;
let savedDefaultModel: string;
let savedDefaultCodexModel: string;
const ROLE_BASES = ["critic", "planner", "recap", "docAgent", "namer", "autopilot"] as const;
let savedRoleEnvs: Record<string, string>;
let savedDefaultAgentProvider: typeof config.defaultAgentProvider;
let savedExtraCredits: number;
let savedAuthMode: AuthMode;
let savedOperatorLanguage: typeof config.operatorLanguage;
let savedAuthApiKeyHelperPath: string | null;
let savedHome: string | undefined;
let savedTuiFullscreen: boolean;
let savedTuiDisableMouse: boolean;
let savedUsageDowngrade: {
  enabled: boolean;
  pct: number;
  model: string;
};

beforeEach(() => {
  // realpath so comparisons hold where tmpdir() is a symlink (macOS)
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-settings-test-")));
  mkdirSync(join(tmp, "child"));
  savedRoot = config.repoRoot; // PUT mutates the shared config; restore after
  savedCeiling = config.rootCeiling;
  savedRc = config.remoteControlAtStartup;
  savedRpm = config.reducedPushMode;
  savedHk = config.sessionHousekeepingEnabled;
  savedPrCap = config.prReviewCyclesCap;
  savedPlanCap = config.planReviewCyclesCap;
  savedDefaultModel = config.defaultModel;
  savedDefaultCodexModel = config.defaultCodexModel;
  savedRoleEnvs = {};
  const cfg = config as unknown as Record<string, string>;
  for (const role of ROLE_BASES) {
    savedRoleEnvs[`${role}Cli`] = cfg[`${role}Cli`]!;
    savedRoleEnvs[`${role}Model`] = cfg[`${role}Model`]!;
    savedRoleEnvs[`${role}Effort`] = cfg[`${role}Effort`]!;
  }
  savedDefaultAgentProvider = config.defaultAgentProvider;
  savedExtraCredits = config.extraCreditsDrainCeiling;
  savedAuthMode = config.authMode;
  savedOperatorLanguage = config.operatorLanguage;
  savedAuthApiKeyHelperPath = config.authApiKeyHelperPath;
  savedTuiFullscreen = config.tuiFullscreen;
  savedTuiDisableMouse = config.tuiDisableMouse;
  savedUsageDowngrade = {
    enabled: config.usageDowngradeEnabled,
    pct: config.usageDowngradePct,
    model: config.usageDowngradeModel,
  };
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
  config.reducedPushMode = savedRpm;
  config.sessionHousekeepingEnabled = savedHk;
  config.prReviewCyclesCap = savedPrCap;
  config.planReviewCyclesCap = savedPlanCap;
  config.defaultModel = savedDefaultModel;
  config.defaultCodexModel = savedDefaultCodexModel;
  const cfg = config as unknown as Record<string, string>;
  for (const role of ROLE_BASES) {
    cfg[`${role}Cli`] = savedRoleEnvs[`${role}Cli`]!;
    cfg[`${role}Model`] = savedRoleEnvs[`${role}Model`]!;
    cfg[`${role}Effort`] = savedRoleEnvs[`${role}Effort`]!;
  }
  config.defaultAgentProvider = savedDefaultAgentProvider;
  config.extraCreditsDrainCeiling = savedExtraCredits;
  config.authMode = savedAuthMode;
  config.operatorLanguage = savedOperatorLanguage;
  config.authApiKeyHelperPath = savedAuthApiKeyHelperPath;
  config.tuiFullscreen = savedTuiFullscreen;
  config.tuiDisableMouse = savedTuiDisableMouse;
  config.usageDowngradeEnabled = savedUsageDowngrade.enabled;
  config.usageDowngradePct = savedUsageDowngrade.pct;
  config.usageDowngradeModel = savedUsageDowngrade.model;
  if (savedHome !== undefined) process.env.HOME = savedHome;
  else delete process.env.HOME;
  rmSync(tmp, { recursive: true, force: true });
});

function harness(opts: { codexAuthMode?: "chatgpt" | "apikey" | "unknown" } = {}): {
  app: ReturnType<typeof makeApp>;
  store: SessionStore;
} {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    events: new EventHub(),
    service: {} as any,
    usageLimits: { limits: () => ({}) } as any,
    readCodexAuthMode: () => opts.codexAuthMode ?? "unknown",
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

test('PUT /api/settings toggles reducedPushMode, persists ("1"/"0"), leaves repoRoot intact', async () => {
  config.repoRoot = tmp;
  config.reducedPushMode = false;
  const { app, store } = harness();
  const res = await put(app, { reducedPushMode: true });
  expect(res.status).toBe(200);
  expect((await res.json()).reducedPushMode).toBe(true);
  expect(config.reducedPushMode).toBe(true); // live
  expect(store.getSetting("reducedPushMode")).toBe("1"); // persisted as "1"/"0"
  expect(config.repoRoot).toBe(tmp); // a reducedPushMode patch must not touch the repo root
  // reflected by GET, and toggling back persists "0"
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.reducedPushMode).toBe(true);
  await put(app, { reducedPushMode: false });
  expect(store.getSetting("reducedPushMode")).toBe("0");
});

test("PUT /api/settings rejects a non-boolean reducedPushMode", async () => {
  const { app } = harness();
  const res = await put(app, { reducedPushMode: "yes" });
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

test("GET /api/settings includes the provider-specific Codex default model", async () => {
  config.defaultCodexModel = "gpt-5.4";
  const { app } = harness();
  const body = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(body.defaultCodexModel).toBe("gpt-5.4");
});

test("GET /api/settings includes defaultAgentProvider", async () => {
  config.defaultAgentProvider = "codex";
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/settings"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.defaultAgentProvider).toBe("codex");
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

test("PUT /api/settings sets and persists defaultCodexModel", async () => {
  const { app, store } = harness();
  config.defaultCodexModel = "gpt-5.5";
  const res = await put(app, { defaultCodexModel: "gpt-5.4" });
  expect(res.status).toBe(200);
  expect((await res.json()).defaultCodexModel).toBe("gpt-5.4");
  expect(config.defaultCodexModel).toBe("gpt-5.4");
  expect(store.getSetting("defaultCodexModel")).toBe("gpt-5.4");
});

test("PUT /api/settings accepts provider default and rejects invalid Codex models", async () => {
  const { app } = harness();
  config.defaultCodexModel = "gpt-5.5";
  const accepted = await put(app, { defaultCodexModel: "default" });
  expect(accepted.status).toBe(200);
  expect(config.defaultCodexModel).toBe("default");
  const rejected = await put(app, { defaultCodexModel: "opus" });
  expect(rejected.status).toBe(400);
  expect(config.defaultCodexModel).toBe("default");
});

test("GET and PUT resolve a ChatGPT-incompatible Codex model to provider default", async () => {
  const { app, store } = harness({ codexAuthMode: "chatgpt" });
  config.defaultCodexModel = "gpt-5.3-codex";
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.defaultCodexModel).toBe("default");

  const res = await put(app, { defaultCodexModel: "gpt-5.3-codex" });
  expect(res.status).toBe(200);
  expect((await res.json()).defaultCodexModel).toBe("default");
  expect(config.defaultCodexModel).toBe("default");
  expect(store.getSetting("defaultCodexModel")).toBe("default");
});

// ── per-role environment settings (cli + model) for the six roles ──
test("GET /api/settings includes every per-role cli + model + effort setting (raw, unresolved)", async () => {
  config.criticCli = "codex";
  config.criticModel = "gpt-5.5";
  config.criticEffort = "high";
  config.plannerCli = "inherit";
  config.plannerModel = "default";
  config.plannerEffort = "default";
  config.recapCli = "claude";
  config.recapModel = "sonnet";
  config.recapEffort = "low";
  const { app } = harness();
  const body = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(body.criticCli).toBe("codex");
  expect(body.criticModel).toBe("gpt-5.5");
  expect(body.criticEffort).toBe("high");
  expect(body.plannerCli).toBe("inherit");
  expect(body.plannerModel).toBe("default");
  expect(body.plannerEffort).toBe("default");
  expect(body.recapCli).toBe("claude");
  expect(body.recapModel).toBe("sonnet");
  expect(body.recapEffort).toBe("low");
});

for (const role of ROLE_BASES) {
  const cliKey = `${role}Cli`;
  const modelKey = `${role}Model`;

  test(`PUT /api/settings sets ${cliKey} (codex), persists, leaves repoRoot intact`, async () => {
    config.repoRoot = tmp;
    const { app, store } = harness();
    const res = await put(app, { [cliKey]: "codex" });
    expect(res.status).toBe(200);
    expect((await res.json())[cliKey]).toBe("codex");
    expect((config as Record<string, unknown>)[cliKey]).toBe("codex"); // live
    expect(store.getSetting(cliKey)).toBe("codex"); // persisted
    expect(config.repoRoot).toBe(tmp); // a role patch must not touch the repo root
  });

  test(`PUT /api/settings accepts 'inherit' for ${cliKey}`, async () => {
    const { app } = harness();
    const res = await put(app, { [cliKey]: "inherit" });
    expect(res.status).toBe(200);
    expect((await res.json())[cliKey]).toBe("inherit");
  });

  test(`PUT /api/settings rejects an unknown ${cliKey} value`, async () => {
    const { app } = harness();
    (config as Record<string, unknown>)[cliKey] = "inherit";
    const res = await put(app, { [cliKey]: "gpt9" });
    expect(res.status).toBe(400);
    expect((config as Record<string, unknown>)[cliKey]).toBe("inherit"); // unchanged on failure
  });

  test(`PUT /api/settings sets ${modelKey} (alias + 'default'), persists`, async () => {
    const { app, store } = harness();
    const r1 = await put(app, { [modelKey]: "opus" });
    expect(r1.status).toBe(200);
    expect((await r1.json())[modelKey]).toBe("opus");
    expect(store.getSetting(modelKey)).toBe("opus"); // persisted
    const r2 = await put(app, { [modelKey]: "default" });
    expect(r2.status).toBe(200);
    expect((await r2.json())[modelKey]).toBe("default");
  });

  test(`PUT /api/settings rejects unknown / 'inherit' for ${modelKey}`, async () => {
    const { app } = harness();
    (config as Record<string, unknown>)[modelKey] = "default";
    expect((await put(app, { [modelKey]: "gpt9" })).status).toBe(400);
    // "inherit" is a cli value, not a model token → rejected on the model key.
    expect((await put(app, { [modelKey]: "inherit" })).status).toBe(400);
    expect((config as Record<string, unknown>)[modelKey]).toBe("default"); // unchanged on failure
  });

  const effortKey = `${role}Effort`;

  test(`PUT /api/settings accepts every effort tier + 'default' for ${effortKey}, persists`, async () => {
    const { app, store } = harness();
    for (const tier of [...EFFORTS, "default"]) {
      const res = await put(app, { [effortKey]: tier });
      expect(res.status).toBe(200);
      expect((await res.json())[effortKey]).toBe(tier);
      expect((config as Record<string, unknown>)[effortKey]).toBe(tier); // live
      expect(store.getSetting(effortKey)).toBe(tier); // persisted
    }
  });

  test(`PUT /api/settings rejects an unknown ${effortKey} value`, async () => {
    const { app } = harness();
    (config as Record<string, unknown>)[effortKey] = "default";
    const res = await put(app, { [effortKey]: "bogus" });
    expect(res.status).toBe(400);
    expect((config as Record<string, unknown>)[effortKey]).toBe("default"); // unchanged on failure
  });
}

test("PUT /api/settings rejects a non-string defaultModel", async () => {
  const { app } = harness();
  config.defaultModel = "auto";
  const res = await put(app, { defaultModel: 42 });
  expect(res.status).toBe(400);
  expect(config.defaultModel).toBe("auto"); // unchanged on failure
});

// ── usage-aware model downgrade (enabled / pct / model) ──
test("GET /api/settings includes the usage downgrade settings", async () => {
  config.usageDowngradeEnabled = true;
  config.usageDowngradePct = 75;
  config.usageDowngradeModel = "sonnet";
  const { app } = harness();
  const body = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(body.usageDowngradeEnabled).toBe(true);
  expect(body.usageDowngradePct).toBe(75);
  expect(body.usageDowngradeModel).toBe("sonnet");
});

test("PUT /api/settings toggles usageDowngradeEnabled and persists", async () => {
  config.usageDowngradeEnabled = false;
  const { app, store } = harness();
  const res = await put(app, { usageDowngradeEnabled: true });
  expect(res.status).toBe(200);
  expect((await res.json()).usageDowngradeEnabled).toBe(true);
  expect(config.usageDowngradeEnabled).toBe(true); // live
  expect(store.getSetting("usageDowngradeEnabled")).toBe("1"); // persisted
});

test("PUT /api/settings clamps usageDowngradePct to 0–100 and persists", async () => {
  const { app, store } = harness();
  const res = await put(app, { usageDowngradePct: 150 });
  expect(res.status).toBe(200);
  expect((await res.json()).usageDowngradePct).toBe(100);
  expect(config.usageDowngradePct).toBe(100);
  expect(store.getSetting("usageDowngradePct")).toBe("100");
});

test("PUT /api/settings sets usageDowngradeModel (accepts auto/default/alias), persists", async () => {
  const { app, store } = harness();
  const r1 = await put(app, { usageDowngradeModel: "haiku" });
  expect(r1.status).toBe(200);
  expect((await r1.json()).usageDowngradeModel).toBe("haiku");
  expect(store.getSetting("usageDowngradeModel")).toBe("haiku");
  const r2 = await put(app, { usageDowngradeModel: "auto" });
  expect(r2.status).toBe(200);
  expect((await r2.json()).usageDowngradeModel).toBe("auto");
});

test("PUT /api/settings rejects an unknown usageDowngradeModel (and 'inherit')", async () => {
  const { app } = harness();
  config.usageDowngradeModel = "haiku";
  expect((await put(app, { usageDowngradeModel: "gpt9" })).status).toBe(400);
  // "inherit" is invalid here — a downgrade target has nothing to inherit from.
  expect((await put(app, { usageDowngradeModel: "inherit" })).status).toBe(400);
  expect(config.usageDowngradeModel).toBe("haiku"); // unchanged on failure
});

test("PUT /api/settings sets defaultAgentProvider, persists, leaves repoRoot intact", async () => {
  config.repoRoot = tmp;
  config.defaultAgentProvider = "claude";
  const { app, store } = harness();
  const res = await put(app, { defaultAgentProvider: "codex" });
  expect(res.status).toBe(200);
  expect((await res.json()).defaultAgentProvider).toBe("codex");
  expect(String(config.defaultAgentProvider)).toBe("codex");
  expect(store.getSetting("defaultAgentProvider")).toBe("codex");
  expect(config.repoRoot).toBe(tmp);
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.defaultAgentProvider).toBe("codex");
});

test("PUT /api/settings rejects an unknown defaultAgentProvider value", async () => {
  const { app } = harness();
  config.defaultAgentProvider = "claude";
  const res = await put(app, { defaultAgentProvider: "other" });
  expect(res.status).toBe(400);
  expect(config.defaultAgentProvider).toBe("claude");
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

// ── POST /api/settings/verify-key ──────────────────────────────────────────
// Builds an app wiring a stubbed deps.verifyKey (or omitting it).
function verifyHarness(verifyKey?: AppDeps["verifyKey"]): ReturnType<typeof makeApp> {
  const deps: AppDeps = {
    store: new SessionStore(":memory:"),
    events: new EventHub(),
    service: {} as any,
    usageLimits: { limits: () => ({}) } as any,
    verifyKey,
  };
  return makeApp(deps);
}

const postVerify = (app: ReturnType<typeof makeApp>) =>
  app.fetch(new Request("http://x/api/settings/verify-key", { method: "POST" }));

test("POST /api/settings/verify-key → 200 {ok:true} when the verify succeeds", async () => {
  const app = verifyHarness(async () => ({ ok: true }));
  const res = await postVerify(app);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("POST /api/settings/verify-key echoes reason+detail and leaks no key/path", async () => {
  const app = verifyHarness(async () => ({
    ok: false,
    reason: "not-authenticated",
    detail: "invalid x-api-key",
  }));
  const res = await postVerify(app);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.reason).toBe("not-authenticated");
  expect(body.detail).toBe("invalid x-api-key");
  // Body must carry ONLY {ok,reason,detail} — never a key or its helper path.
  const allowed = new Set(["ok", "reason", "detail"]);
  expect(Object.keys(body).every((k) => allowed.has(k))).toBe(true);
});

test("POST /api/settings/verify-key → 503 when deps.verifyKey is absent", async () => {
  const app = verifyHarness(undefined);
  const res = await postVerify(app);
  expect(res.status).toBe(503);
});

test("GET /api/settings is unaffected by the verify-key route", async () => {
  config.repoRoot = tmp;
  const app = verifyHarness(async () => ({ ok: true }));
  const res = await app.fetch(new Request("http://x/api/settings"));
  expect(res.status).toBe(200);
  expect((await res.json()).repoRoot).toBe(tmp);
});

// ── tuiFullscreen ─────────────────────────────────────────────────────────────

test("GET /api/settings includes tuiFullscreen (default false)", async () => {
  config.tuiFullscreen = false;
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/settings"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.tuiFullscreen).toBe(false);
});

test('PUT /api/settings toggles tuiFullscreen, persists ("1"/"0"), leaves repoRoot intact', async () => {
  config.repoRoot = tmp;
  config.tuiFullscreen = false;
  const { app, store } = harness();
  const res = await put(app, { tuiFullscreen: true });
  expect(res.status).toBe(200);
  expect((await res.json()).tuiFullscreen).toBe(true);
  expect(config.tuiFullscreen).toBe(true); // live
  expect(store.getSetting("tuiFullscreen")).toBe("1"); // persisted as "1"/"0"
  expect(config.repoRoot).toBe(tmp); // a tuiFullscreen patch must not touch the repo root
  // reflected by GET, and toggling back persists "0"
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.tuiFullscreen).toBe(true);
  await put(app, { tuiFullscreen: false });
  expect(store.getSetting("tuiFullscreen")).toBe("0");
});

test("PUT /api/settings rejects a non-boolean tuiFullscreen", async () => {
  const { app } = harness();
  const res = await put(app, { tuiFullscreen: "yes" });
  expect(res.status).toBe(400);
});

// ── tuiDisableMouse ───────────────────────────────────────────────────────────

test("GET /api/settings includes tuiDisableMouse (default false)", async () => {
  config.tuiDisableMouse = false;
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/settings"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.tuiDisableMouse).toBe(false);
});

test('PUT /api/settings toggles tuiDisableMouse, persists ("1"/"0"), leaves repoRoot intact', async () => {
  config.repoRoot = tmp;
  config.tuiDisableMouse = false;
  const { app, store } = harness();
  const res = await put(app, { tuiDisableMouse: true });
  expect(res.status).toBe(200);
  expect((await res.json()).tuiDisableMouse).toBe(true);
  expect(config.tuiDisableMouse).toBe(true); // live
  expect(store.getSetting("tuiDisableMouse")).toBe("1"); // persisted as "1"/"0"
  expect(config.repoRoot).toBe(tmp); // a tuiDisableMouse patch must not touch the repo root
  // reflected by GET, and toggling back persists "0"
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.tuiDisableMouse).toBe(true);
  await put(app, { tuiDisableMouse: false });
  expect(store.getSetting("tuiDisableMouse")).toBe("0");
});

test("PUT /api/settings rejects a non-boolean tuiDisableMouse", async () => {
  const { app } = harness();
  const res = await put(app, { tuiDisableMouse: "yes" });
  expect(res.status).toBe(400);
});

// ── operatorLanguage ─────────────────────────────────────────────────────────

test("GET /api/settings includes operatorLanguage", async () => {
  config.operatorLanguage = "en";
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/settings"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.operatorLanguage).toBe("en");
});

test("PUT /api/settings sets operatorLanguage to 'de', persists, live-updates, reflected by GET", async () => {
  config.operatorLanguage = "en";
  const { app, store } = harness();
  const res = await put(app, { operatorLanguage: "de" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.operatorLanguage).toBe("de");
  expect(config.operatorLanguage as string).toBe("de"); // live
  expect(store.getSetting("operatorLanguage")).toBe("de"); // persisted
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.operatorLanguage).toBe("de"); // reflected by a subsequent GET
});

test("PUT /api/settings rejects an unrecognised operatorLanguage value → 400", async () => {
  config.operatorLanguage = "en";
  const { app } = harness();
  for (const bad of ["fr", "", 42, null, true]) {
    const res = await put(app, { operatorLanguage: bad });
    expect(res.status).toBe(400);
  }
  expect(config.operatorLanguage).toBe("en"); // unchanged on failure
});

test("a persisted operatorLanguage row overrides the env seed at boot hydration", () => {
  // Mirrors the hydration snippet in src/index.ts: a UI-set row wins over whatever
  // the env seed produced.
  const store = new SessionStore(":memory:");
  store.setSetting("operatorLanguage", "de");
  config.operatorLanguage = "en"; // simulate the env-seeded default having booted first
  const savedOl = store.getSetting("operatorLanguage");
  expect(savedOl).not.toBeNull();
  if (savedOl !== null) {
    const v = normalizeOperatorLanguage(savedOl);
    if (v !== null) config.operatorLanguage = v;
  }
  expect(config.operatorLanguage).toBe("de"); // the persisted row won
});

test("OPERATOR_LANGUAGES is set-equal to the UI's Paraglide locales", () => {
  const settingsPath = join(import.meta.dir, "..", "ui", "project.inlang", "settings.json");
  const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { locales: string[] };
  const locales = new Set(parsed.locales);
  const opLangs = new Set(OPERATOR_LANGUAGES as readonly string[]);
  expect(locales.size).toBe(opLangs.size);
  for (const l of locales) expect(opLangs.has(l)).toBe(true);
  for (const l of opLangs) expect(locales.has(l)).toBe(true);
});

// ── #1144: runaway-reaper knob clamping ──────────────────────────────────────

/** Exactly how config.ts reads these knobs: `Number(process.env.X ?? <default>)`. */
const asEnv = (raw: string | undefined, def: number) => Number(raw ?? def);

test("#1144: an empty SHEPHERD_REAP_RUNAWAY_MIN_AGE_S cannot disarm the age floor", () => {
  // `Number("")` is 0 — a SET-BUT-EMPTY env var slips past `??`, which only catches undefined. A 0
  // age floor would open the benign restore() race (restore SPAWNS the agent before store.unarchive
  // flips the row off `archived`), letting the sweep reap a freshly-respawned agent's own children.
  // The clamp, not a comment, is what prevents it.
  expect(asEnv("", 300)).toBe(0); // the trap itself
  expect(clampCap(asEnv("", 300), 60, 24 * 60 * 60, 300)).toBe(60); // …snapped to the floor
  expect(clampCap(asEnv(undefined, 300), 60, 24 * 60 * 60, 300)).toBe(300);
  expect(clampCap(asEnv("nonsense", 300), 60, 24 * 60 * 60, 300)).toBe(300); // NaN ⇒ fallback
  expect(clampCap(asEnv("99999999", 300), 60, 24 * 60 * 60, 300)).toBe(24 * 60 * 60);
});

test("#1144: the CPU fraction clamps WITHOUT rounding (clampCap would round 0.8 → 1)", () => {
  expect(clampFraction(asEnv("", 0.8), 0.05, 1, 0.8)).toBe(0.05); // empty ⇒ floor, not 0
  expect(clampFraction(asEnv(undefined, 0.8), 0.05, 1, 0.8)).toBe(0.8); // default survives intact
  expect(clampCap(asEnv(undefined, 0.8), 0.05, 1, 0.8)).toBe(1); // …which clampCap would ROUND away
  expect(clampFraction(asEnv("nonsense", 0.8), 0.05, 1, 0.8)).toBe(0.8);
  expect(clampFraction(asEnv("5", 0.8), 0.05, 1, 0.8)).toBe(1);
});
