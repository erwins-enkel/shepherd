import { test, expect, beforeEach, afterEach } from "bun:test";
import { llmName, namingPrompt, NAME_FILE } from "../src/namer-llm";
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

function makeDeps(over: Partial<import("../src/namer-llm").LlmNamerDeps> = {}) {
  const calls: any = { started: null, stopped: false, cleaned: false };
  const base = {
    herdr: {
      start: (name: string, cwd: string, argv: string[], env?: Record<string, string>) => {
        calls.started = { name, cwd, argv, env };
        return { terminalId: "term_n", cwd } as any;
      },
      stop: () => {
        calls.stopped = true;
      },
    },
    makeTmpDir: () => "/tmp/namer-xyz",
    cleanup: () => {
      calls.cleaned = true;
    },
    now: () => 0,
    sleep: async () => {},
    timeoutMs: 30_000,
    pollMs: 1_000,
    ...over,
  };
  return { deps: base as any, calls };
}

test("namingPrompt embeds the task and asks for a kebab slug in NAME_FILE", () => {
  const p = namingPrompt("Fix the login bug");
  expect(p).toContain("Fix the login bug");
  expect(p).toContain(NAME_FILE);
  expect(p.toLowerCase()).toContain("kebab");
});

test("llmName: returns sanitized slug, spawns haiku, stops + cleans up", async () => {
  const { deps, calls } = makeDeps({ readName: () => "Mobile Footer Settings!" });
  const slug = await llmName("the mobile footer needs settings", deps, "name TASK-07");
  expect(slug).toBe("mobile-footer-settings");
  expect(calls.started.name).toBe("name TASK-07");
  expect(calls.started.cwd).toBe("/tmp/namer-xyz");
  expect(calls.started.argv[0]).toBe("claude");
  expect(calls.started.argv).toContain("--model");
  expect(calls.started.argv).toContain("haiku");
  const pm = calls.started.argv.indexOf("--permission-mode");
  expect(calls.started.argv[pm + 1]).toBe("dontAsk");
  expect(calls.started.argv[calls.started.argv.length - 1]).toBe(
    namingPrompt("the mobile footer needs settings"),
  );
  expect(calls.stopped).toBe(true);
  expect(calls.cleaned).toBe(true);
});

test("llmName: codex provider spawns headless `codex exec` (no claude flags)", async () => {
  const { deps, calls } = makeDeps({
    provider: "codex",
    model: "gpt-5.5",
    readName: () => "mobile footer",
  });
  await llmName("the mobile footer needs settings", deps, "l");
  expect(calls.started.argv).toEqual([
    "codex",
    "exec",
    "--sandbox",
    "workspace-write",
    "-m",
    "gpt-5.5",
    namingPrompt("the mobile footer needs settings"),
  ]);
  expect(calls.started.argv).not.toContain("--settings");
});

test("llmName: subscription mode — --settings unchanged + no env 4th arg", async () => {
  const { calls } = await withAuth("subscription", "/ignored.sh", async () => {
    const d = makeDeps({ readName: () => "ok-slug" });
    await llmName("x", d.deps, "l");
    return d;
  });
  const argv = calls.started.argv;
  const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
  expect(settings).toEqual({ disableAllHooks: true });
  expect(calls.started.env).toBeUndefined();
});

test("llmName: api-key mode — --settings gains apiKeyHelper + CLAUDE_CONFIG_DIR env", async () => {
  const { calls } = await withAuth("api-key", "/helper.sh", async () => {
    const d = makeDeps({ readName: () => "ok-slug" });
    await llmName("x", d.deps, "l");
    return d;
  });
  const argv = calls.started.argv;
  const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
  expect(settings.disableAllHooks).toBe(true);
  expect(settings.apiKeyHelper).toBe("/helper.sh");
  expect(calls.started.env).toBeDefined();
  expect(Object.keys(calls.started.env)).toEqual(["CLAUDE_CONFIG_DIR"]);
});

test("llmName: api-key mode without a configured key fails closed (returns null, no spawn)", async () => {
  const { result, calls } = await withAuth("api-key", null, async () => {
    const d = makeDeps({ readName: () => "ok-slug" });
    const r = await llmName("x", d.deps, "l");
    return { result: r, calls: d.calls };
  });
  expect(result).toBeNull();
  expect(calls.started).toBeNull();
});

test("llmName: takes only the first non-empty line", async () => {
  const { deps } = makeDeps({ readName: () => "\n  diff-view-scroll  \nextra junk here" });
  expect(await llmName("scroll broken in diff view", deps, "l")).toBe("diff-view-scroll");
});

test("llmName: null on symbol-only/garbage file, still stops + cleans", async () => {
  const { deps, calls } = makeDeps({ readName: () => "   !!!   " });
  expect(await llmName("x", deps, "l")).toBeNull();
  expect(calls.stopped).toBe(true);
  expect(calls.cleaned).toBe(true);
});

test("llmName: null on timeout (file never appears), still cleans up", async () => {
  let t = 0;
  const { deps, calls } = makeDeps({
    readName: () => null,
    now: () => (t += 11_000),
    timeoutMs: 30_000,
  });
  expect(await llmName("x", deps, "l")).toBeNull();
  expect(calls.stopped).toBe(true);
  expect(calls.cleaned).toBe(true);
});

test("llmName: null when spawn throws (no claude / herdr down), still cleans", async () => {
  const calls: any = { cleaned: false };
  const deps: any = {
    herdr: {
      start: () => {
        throw new Error("spawn failed");
      },
      stop: () => {},
    },
    makeTmpDir: () => "/tmp/namer-xyz",
    cleanup: () => {
      calls.cleaned = true;
    },
    now: () => 0,
    sleep: async () => {},
  };
  expect(await llmName("x", deps, "l")).toBeNull();
  expect(calls.cleaned).toBe(true);
});
