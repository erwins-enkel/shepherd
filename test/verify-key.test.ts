import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  verifyApiKey,
  matchAuthError,
  AUTH_ERROR_SIGNATURES,
  SENTINEL,
  VERIFY_FILE,
  type VerifyKeyDeps,
} from "../src/verify-key";
import { config } from "../src/config";
import { __setApiKeyConfigDirProvisionForTest } from "../src/spawn-auth";

beforeEach(() => {
  __setApiKeyConfigDirProvisionForTest(() => "/tmp/shepherd-test-apikey-config");
});

afterEach(() => {
  __setApiKeyConfigDirProvisionForTest(null);
});

async function withAuth<T>(
  mode: typeof config.authMode,
  helper: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const prevMode = config.authMode;
  const prevPath = config.authApiKeyHelperPath;
  config.authMode = mode;
  config.authApiKeyHelperPath = helper;
  try {
    return await fn();
  } finally {
    config.authMode = prevMode;
    config.authApiKeyHelperPath = prevPath;
  }
}

function makeDeps(over: Partial<VerifyKeyDeps> & { readAsync?: () => Promise<string> } = {}) {
  const calls: any = { started: null, stopped: false, cleaned: false, reads: 0 };
  const { readAsync: readAsyncOver, ...rest } = over;
  const base: VerifyKeyDeps = {
    herdr: {
      start: (name: string, cwd: string, argv: string[], env?: Record<string, string>) => {
        calls.started = { name, cwd, argv, env };
        return { terminalId: "term_v", cwd } as any;
      },
      stop: () => {
        calls.stopped = true;
      },
      readAsync: async () => {
        calls.reads += 1;
        return readAsyncOver ? await readAsyncOver() : "";
      },
    },
    makeTmpDir: () => "/tmp/verify-xyz",
    readSentinel: () => null,
    cleanup: () => {
      calls.cleaned = true;
    },
    now: () => 0,
    sleep: async () => {},
    timeoutMs: 30_000,
    pollMs: 750,
    ...rest,
  };
  return { deps: base, calls };
}

test("SENTINEL + VERIFY_FILE are the agreed constants", () => {
  expect(SENTINEL).toBe("SHEPHERD_KEY_OK_8F3A");
  expect(VERIFY_FILE).toBe(".shepherd-verify");
});

test("verifyApiKey: sentinel file present with token → ok", async () => {
  const { deps, calls } = await withAuth("api-key", "/helper.sh", async () => {
    const d = makeDeps({ readSentinel: () => `${SENTINEL}\n` });
    const r = await verifyApiKey(d.deps);
    expect(r).toEqual({ ok: true });
    return d;
  });
  expect(calls.started).not.toBeNull();
  expect(calls.stopped).toBe(true);
  expect(calls.cleaned).toBe(true);
  void deps;
});

test("verifyApiKey: file present but missing sentinel → keeps polling, then times out", async () => {
  let t = 0;
  const { deps: _d, calls } = await withAuth("api-key", "/helper.sh", async () => {
    const d = makeDeps({
      readSentinel: () => "some unrelated content",
      now: () => (t += 6_000),
      timeoutMs: 30_000,
    });
    const r = await verifyApiKey(d.deps);
    expect(r).toEqual({ ok: false, reason: "timeout" });
    return d;
  });
  expect(calls.stopped).toBe(true);
  expect(calls.cleaned).toBe(true);
  void _d;
});

test("verifyApiKey: auth-error pane text + no file → not-authenticated, FAST-fail before deadline", async () => {
  let t = 0;
  await withAuth("api-key", "/helper.sh", async () => {
    const d = makeDeps({
      readSentinel: () => null,
      readAsync: async () => 'API Error: 401 {"error":{"type":"authentication_error"}}',
      // clock advances 1s per call — far below the 30s deadline
      now: () => (t += 1_000),
      timeoutMs: 30_000,
    });
    const r = await verifyApiKey(d.deps);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not-authenticated");
    expect(r.detail).toContain("401");
    // fast-fail: clock never reached the deadline
    expect(t).toBeLessThan(30_000);
  });
});

test("verifyApiKey: benign idle pane text + no file → timeout (no false-positive)", async () => {
  let t = 0;
  await withAuth("api-key", "/helper.sh", async () => {
    const d = makeDeps({
      readSentinel: () => null,
      readAsync: async () => "Welcome to Claude Code. Writing file...\n> ",
      now: () => (t += 6_000),
      timeoutMs: 30_000,
    });
    const r = await verifyApiKey(d.deps);
    expect(r).toEqual({ ok: false, reason: "timeout" });
  });
});

test("verifyApiKey: spawn throws → spawn-failed, still cleans up", async () => {
  await withAuth("api-key", "/helper.sh", async () => {
    const calls: any = { cleaned: false };
    const deps: VerifyKeyDeps = {
      herdr: {
        start: () => {
          throw new Error("spawn failed");
        },
        stop: () => {},
        readAsync: async () => "",
      },
      makeTmpDir: () => "/tmp/verify-xyz",
      readSentinel: () => null,
      cleanup: () => {
        calls.cleaned = true;
      },
      now: () => 0,
      sleep: async () => {},
    };
    const r = await verifyApiKey(deps);
    expect(r).toEqual({ ok: false, reason: "spawn-failed" });
    expect(calls.cleaned).toBe(true);
  });
});

test("verifyApiKey: not api-key mode → not-api-key-mode, no spawn", async () => {
  const { result, calls } = await withAuth("subscription", "/ignored.sh", async () => {
    const d = makeDeps({ readSentinel: () => `${SENTINEL}` });
    const r = await verifyApiKey(d.deps);
    return { result: r, calls: d.calls };
  });
  expect(result).toEqual({ ok: false, reason: "not-api-key-mode" });
  expect(calls.started).toBeNull();
});

test("verifyApiKey: api-key mode but no key → not-configured, no spawn", async () => {
  const { result, calls } = await withAuth("api-key", null, async () => {
    const d = makeDeps({ readSentinel: () => `${SENTINEL}` });
    const r = await verifyApiKey(d.deps);
    return { result: r, calls: d.calls };
  });
  expect(result).toEqual({ ok: false, reason: "not-configured" });
  expect(calls.started).toBeNull();
});

test("verifyApiKey: argv carries sentinel prompt + apiKeyHelper; env carries CLAUDE_CONFIG_DIR", async () => {
  const { calls } = await withAuth("api-key", "/helper.sh", async () => {
    const d = makeDeps({ readSentinel: () => SENTINEL });
    await verifyApiKey(d.deps);
    return d;
  });
  const argv: string[] = calls.started.argv;
  expect(argv[0]).toBe("claude");
  expect(argv).toContain("--model");
  expect(argv).toContain("haiku");
  // prompt is the trailing arg, references the sentinel + verify file
  const prompt = argv[argv.length - 1];
  expect(prompt).toContain(SENTINEL);
  expect(prompt).toContain(VERIFY_FILE);
  // dontAsk sits LAST before the prompt (variadic --allowedTools guard)
  const pm = argv.indexOf("--permission-mode");
  expect(argv[pm + 1]).toBe("dontAsk");
  expect(pm + 2).toBe(argv.length - 1);
  // bare Write, not path-scoped
  const at = argv.indexOf("--allowedTools");
  expect(argv[at + 1]).toBe("Write");
  // settings carry the apiKeyHelper
  const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
  expect(settings.disableAllHooks).toBe(true);
  expect(settings.apiKeyHelper).toBe("/helper.sh");
  // env points at the credential-less mirror
  expect(calls.started.env).toBeDefined();
  expect(Object.keys(calls.started.env)).toEqual(["CLAUDE_CONFIG_DIR"]);
});

test("matchAuthError: every signature matches a representative real error string", () => {
  const samples = [
    'API Error: 401 {"type":"error","error":{"type":"invalid_request_error","message":"invalid x-api-key"}}',
    '{"error":{"type":"authentication_error","message":"unauthorized"}}',
    "API Error: 401 Unauthorized",
    "status: 401 forbidden",
    "Error: Invalid API key provided",
    "Please run /login to authenticate.",
    "OAuth token has expired. Please re-authenticate.",
  ];
  for (const s of samples) {
    expect(matchAuthError(s)).not.toBeNull();
  }
  // every signature is exercised by at least one sample
  for (const re of AUTH_ERROR_SIGNATURES) {
    expect(samples.some((s) => re.test(s))).toBe(true);
  }
});

test("matchAuthError: benign / successful output does NOT match", () => {
  const benign = [
    "Welcome to Claude Code!",
    "Writing SHEPHERD_KEY_OK_8F3A to .shepherd-verify",
    "I have written the file and will now stop.",
    "Reading task description... done. Status: 200 OK",
    "> ",
    "",
  ];
  for (const b of benign) {
    expect(matchAuthError(b)).toBeNull();
  }
});

test("matchAuthError: returns the trimmed matched line", () => {
  const text = "line one\n   API Error: 401 Unauthorized   \nline three";
  const m = matchAuthError(text);
  expect(m).toBe("API Error: 401 Unauthorized");
});
