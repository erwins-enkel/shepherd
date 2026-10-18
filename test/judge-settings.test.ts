import { test, expect, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JudgeError, type Judge } from "../src/judge";
import type {
  TypeSafeJudgeOptions,
  TypeSafeProbeOptions,
  TypeSafeProbeResult,
} from "../src/judge-typesafe";
import {
  DEFAULT_JUDGE_BASE_URL,
  DEFAULT_JUDGE_MODEL,
  JudgeSettings,
  normalizeJudgeBaseUrl,
  type JudgeConnectionStatus,
  type JudgeEnv,
  type JudgeSaveError,
} from "../src/judge-settings";

const KEY = "jev_live_0123456789abcdef";
const OTHER_KEY = "jev_live_fedcba9876543210";
const NO_ENV: JudgeEnv = { key: null, model: null, baseUrl: null, timeoutMs: null };

function harness(
  env: JudgeEnv = NO_ENV,
  probeResult: TypeSafeProbeResult = { ok: true, models: ["jev-1.13.0", "jev-1.14.0"] },
) {
  const dir = mkdtempSync(join(tmpdir(), "judge-settings-"));
  const path = join(dir, "judge.json");
  const probes: TypeSafeProbeOptions[] = [];
  const built: TypeSafeJudgeOptions[] = [];
  let answer: () => Promise<unknown> = async () => ({
    answers: {},
    model: "m",
    usage: {},
    costUsd: 0,
  });
  let probe = probeResult;
  let clock = 1_000;
  const settings = new JudgeSettings(path, env, {
    probe: async (o) => {
      probes.push(o);
      return probe;
    },
    createJudge: (o) => {
      built.push(o);
      return { ask: () => answer() } as unknown as Judge;
    },
    now: () => clock,
  });
  settings.load();
  return {
    path,
    settings,
    probes,
    built,
    setProbe: (r: TypeSafeProbeResult) => (probe = r),
    setAnswer: (f: () => Promise<unknown>) => (answer = f),
    tick: (ms: number) => (clock += ms),
  };
}

const ok = (r: JudgeConnectionStatus | JudgeSaveError | null) => r as JudgeConnectionStatus;
const err = (r: JudgeConnectionStatus | JudgeSaveError | null) => r as JudgeSaveError;

test("a fresh server has no key, no client, and the defaults in force", () => {
  const { settings } = harness();
  expect(settings.client()).toBeNull();
  expect(settings.hasKey()).toBe(false);
  expect(settings.status()).toMatchObject({
    keySource: "none",
    keyLast4: null,
    model: DEFAULT_JUDGE_MODEL,
    baseUrl: DEFAULT_JUDGE_BASE_URL,
    timeoutMs: 8_000,
    lastVerify: null,
  });
});

test("a verified key is stored at 0600 and arms a client without a restart", async () => {
  const { settings, path, probes, built } = harness();
  const status = ok(await settings.save({ key: `  ${KEY}  ` }));
  expect(probes).toEqual([{ apiKey: KEY, baseUrl: DEFAULT_JUDGE_BASE_URL, deadlineMs: 8_000 }]);
  expect(status).toMatchObject({
    keySource: "stored",
    keyLast4: "cdef",
    keySavedAt: 1_000,
    lastVerify: { result: "ok", at: 1_000, status: null },
    models: ["jev-1.13.0", "jev-1.14.0"],
  });
  expect(settings.client()).not.toBeNull();
  expect(built.at(-1)).toEqual({
    apiKey: KEY,
    baseUrl: DEFAULT_JUDGE_BASE_URL,
    model: DEFAULT_JUDGE_MODEL,
    deadlineMs: 8_000,
  });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    key: KEY,
    keyBaseUrl: DEFAULT_JUDGE_BASE_URL,
    keySavedAt: 1_000,
  });
});

test("the key never appears in a status", async () => {
  const { settings } = harness();
  await settings.save({ key: KEY });
  expect(JSON.stringify(settings.status())).not.toContain(KEY);
});

test("a rejected or unreachable key writes nothing and arms nothing", async () => {
  for (const probe of [
    { ok: false, kind: "rejected", status: 401 },
    { ok: false, kind: "unreachable", status: null },
  ] as const) {
    const { settings, path } = harness(NO_ENV, probe);
    const result = err(await settings.save({ key: KEY, model: "jev-1.14.0" }));
    expect(result).toEqual({
      error: probe.kind === "rejected" ? "key_rejected" : "unreachable",
      field: "key",
      status: probe.status,
    });
    expect(existsSync(path)).toBe(false);
    expect(settings.client()).toBeNull();
    expect(settings.status().model).toBe(DEFAULT_JUDGE_MODEL);
  }
});

test("a rejected replacement leaves the key in force untouched", async () => {
  const h = harness();
  await h.settings.save({ key: KEY });
  h.setProbe({ ok: false, kind: "rejected", status: 401 });
  expect(err(await h.settings.save({ key: OTHER_KEY })).error).toBe("key_rejected");
  expect(h.settings.status()).toMatchObject({
    keySource: "stored",
    keyLast4: "cdef",
    lastVerify: { result: "ok" },
  });
});

test("the environment wins per field and its fields cannot be saved", async () => {
  const env: JudgeEnv = { key: null, model: "jev-env", baseUrl: null, timeoutMs: 5_000 };
  const { settings } = harness(env);
  expect(settings.status()).toMatchObject({
    model: "jev-env",
    timeoutMs: 5_000,
    env: { key: false, model: true, baseUrl: false, timeoutMs: true },
  });
  expect(err(await settings.save({ model: "jev-1.14.0" }))).toEqual({
    error: "env_locked",
    field: "model",
  });
  expect(err(await settings.save({ timeoutMs: 9_000 }))).toEqual({
    error: "env_locked",
    field: "timeoutMs",
  });
});

test("an environment key also locks the base URL — it is where the key would go", async () => {
  const { settings, built } = harness({ ...NO_ENV, key: KEY });
  expect(settings.status()).toMatchObject({ keySource: "env", keyLast4: "cdef", keySavedAt: null });
  expect(settings.client()).not.toBeNull();
  expect(built.at(-1)?.apiKey).toBe(KEY);
  expect(err(await settings.save({ baseUrl: "https://elsewhere.example" }))).toEqual({
    error: "env_locked",
    field: "baseUrl",
  });
  expect(err(await settings.save({ key: OTHER_KEY }))).toEqual({
    error: "env_locked",
    field: "key",
  });
});

test("an environment key never goes to a base URL stored before it arrived", () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-settings-"));
  const path = join(dir, "judge.json");
  // Allowed while there was no key at all — and harmless then, since nothing was sent anywhere.
  writeFileSync(path, JSON.stringify({ baseUrl: "https://attacker.example" }));
  const built: TypeSafeJudgeOptions[] = [];
  const settings = new JudgeSettings(
    path,
    { ...NO_ENV, key: KEY },
    {
      probe: async () => ({ ok: true, models: [] }),
      createJudge: (o) => {
        built.push(o);
        return {} as Judge;
      },
    },
  );
  settings.load();
  expect(built.at(-1)?.baseUrl).toBe(DEFAULT_JUDGE_BASE_URL);
  expect(settings.status().baseUrl).toBe(DEFAULT_JUDGE_BASE_URL);
});

test("moving the base URL away from a stored key needs the key again", async () => {
  const h = harness();
  await h.settings.save({ key: KEY });
  expect(err(await h.settings.save({ baseUrl: "https://judge.example" }))).toEqual({
    error: "key_required",
    field: "baseUrl",
  });
  expect(h.settings.status().baseUrl).toBe(DEFAULT_JUDGE_BASE_URL);

  const moved = ok(await h.settings.save({ baseUrl: "https://judge.example/", key: KEY }));
  expect(h.probes.at(-1)?.baseUrl).toBe("https://judge.example");
  expect(moved).toMatchObject({ keySource: "stored", baseUrl: "https://judge.example" });
  expect(JSON.parse(readFileSync(h.path, "utf8"))).toMatchObject({
    baseUrl: "https://judge.example",
    keyBaseUrl: "https://judge.example",
  });
});

test("a stored key bound to another base URL than the environment's is never sent there", () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-settings-"));
  const path = join(dir, "judge.json");
  writeFileSync(
    path,
    JSON.stringify({ key: KEY, keyBaseUrl: DEFAULT_JUDGE_BASE_URL, keySavedAt: 1 }),
  );
  const built: TypeSafeJudgeOptions[] = [];
  const settings = new JudgeSettings(
    path,
    { ...NO_ENV, baseUrl: "https://attacker.example" },
    {
      probe: async () => ({ ok: true, models: [] }),
      createJudge: (o) => {
        built.push(o);
        return {} as Judge;
      },
    },
  );
  settings.load();
  expect(built).toEqual([]);
  expect(settings.client()).toBeNull();
  expect(settings.status()).toMatchObject({
    keySource: "none",
    keyLast4: null,
    staleKeyHost: "api.typesafe.ai",
  });
});

test("a broken file is ignored with a message that never quotes it", () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-settings-"));
  const path = join(dir, "judge.json");
  writeFileSync(path, `{"key": ${KEY}}`); // not JSON: a parse error could echo the token
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const settings = new JudgeSettings(path, NO_ENV, {
      probe: async () => ({ ok: true, models: [] }),
      createJudge: () => ({}) as Judge,
    });
    settings.load();
    expect(settings.hasKey()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(" ")).not.toContain(KEY);
  } finally {
    warn.mockRestore();
  }
});

test("a key without its base-URL binding is not trusted", () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-settings-"));
  const path = join(dir, "judge.json");
  writeFileSync(path, JSON.stringify({ key: KEY }));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const settings = new JudgeSettings(path, NO_ENV, {
      probe: async () => ({ ok: true, models: [] }),
      createJudge: () => ({}) as Judge,
    });
    settings.load();
    expect(settings.hasKey()).toBe(false);
  } finally {
    warn.mockRestore();
  }
});

test("model, base URL and timeout are validated, and defaults are not stored", async () => {
  const { settings, path } = harness();
  expect(err(await settings.save({ model: "two words" })).error).toBe("model_invalid");
  expect(err(await settings.save({ baseUrl: "ftp://x.example" })).error).toBe("base_url_invalid");
  expect(err(await settings.save({ baseUrl: "https://u:p@x.example" })).error).toBe(
    "base_url_invalid",
  );
  expect(err(await settings.save({ timeoutMs: 999 })).error).toBe("timeout_invalid");
  expect(err(await settings.save({ timeoutMs: 60_001 })).error).toBe("timeout_invalid");
  expect(err(await settings.save({ timeoutMs: 1.5e3 + 0.5 })).error).toBe("timeout_invalid");
  expect(err(await settings.save({ key: "short" })).error).toBe("key_invalid");
  expect(err(await settings.save({ key: "has a space inside" })).error).toBe("key_invalid");
  expect(existsSync(path)).toBe(false);

  const saved = ok(
    await settings.save({
      model: "jev-1.14.0",
      baseUrl: "https://judge.example/",
      timeoutMs: 12_000,
    }),
  );
  expect(saved).toMatchObject({
    model: "jev-1.14.0",
    baseUrl: "https://judge.example",
    timeoutMs: 12_000,
  });
  const reset = ok(await settings.save({ model: "", baseUrl: "", timeoutMs: 8_000 }));
  expect(reset).toMatchObject({ model: DEFAULT_JUDGE_MODEL, baseUrl: DEFAULT_JUDGE_BASE_URL });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
});

test("changing the model rebuilds the client in place", async () => {
  const h = harness();
  await h.settings.save({ key: KEY });
  const before = h.settings.client();
  await h.settings.save({ model: "jev-1.14.0", timeoutMs: 3_000 });
  expect(h.settings.client()).not.toBe(before);
  expect(h.built.at(-1)).toMatchObject({ apiKey: KEY, model: "jev-1.14.0", deadlineMs: 3_000 });
});

test("a real call's 401 is remembered until the next success", async () => {
  const h = harness();
  await h.settings.save({ key: KEY });
  h.setAnswer(async () => {
    throw new JudgeError("judge: 401 nope", 401);
  });
  h.tick(10);
  await expect(h.settings.client()!.ask("s", {})).rejects.toThrow("401");
  expect(h.settings.status().authFailure).toEqual({ status: 401, at: 1_010 });

  h.setAnswer(async () => ({ answers: {}, model: "m", usage: {}, costUsd: 0 }));
  h.tick(10);
  await h.settings.client()!.ask("s", {});
  expect(h.settings.status()).toMatchObject({ authFailure: null, lastOkAt: 1_020 });
});

test("a transport error is not an auth failure", async () => {
  const h = harness();
  await h.settings.save({ key: KEY });
  h.setAnswer(async () => {
    throw new JudgeError("judge: 503 busy", 503);
  });
  await expect(h.settings.client()!.ask("s", {})).rejects.toThrow("503");
  expect(h.settings.status().authFailure).toBeNull();
});

test("Test re-checks the key in force and records the result", async () => {
  const h = harness();
  expect(await h.settings.verify()).toBeNull();
  await h.settings.save({ key: KEY });
  h.setProbe({ ok: false, kind: "rejected", status: 403 });
  h.tick(5);
  expect(ok(await h.settings.verify()).lastVerify).toEqual({
    result: "rejected",
    at: 1_005,
    status: 403,
  });
  h.setProbe({ ok: true, models: ["jev-2"] });
  expect(ok(await h.settings.verify())).toMatchObject({
    lastVerify: { result: "ok" },
    models: ["jev-2"],
  });
});

test("remove forgets the key and keeps the advanced fields", async () => {
  const h = harness();
  await h.settings.save({ key: KEY, model: "jev-1.14.0" });
  const status = await h.settings.remove();
  expect(status).toMatchObject({ keySource: "none", model: "jev-1.14.0", lastVerify: null });
  expect(h.settings.client()).toBeNull();
  expect(JSON.parse(readFileSync(h.path, "utf8"))).toEqual({ model: "jev-1.14.0" });

  await h.settings.save({ model: "" });
  await h.settings.remove();
  expect(existsSync(h.path)).toBe(false);
});

test("base URLs normalise to an http(s) root without credentials, query or fragment", () => {
  expect(normalizeJudgeBaseUrl("https://api.typesafe.ai/")).toBe("https://api.typesafe.ai");
  expect(normalizeJudgeBaseUrl("http://10.0.0.5:8080/jev//")).toBe("http://10.0.0.5:8080/jev");
  expect(normalizeJudgeBaseUrl("https://x.example/?a=1")).toBeNull();
  expect(normalizeJudgeBaseUrl("https://x.example/#f")).toBeNull();
  expect(normalizeJudgeBaseUrl("file:///etc/passwd")).toBeNull();
  expect(normalizeJudgeBaseUrl("not a url")).toBeNull();
});
