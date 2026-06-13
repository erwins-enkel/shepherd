import { test, expect } from "bun:test";
import { classifyStop, classifierPrompt, VERDICT_FILE } from "../src/autopilot-llm";
import { config } from "../src/config";

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

function makeDeps(over: Partial<import("../src/autopilot-llm").ClassifierDeps> = {}) {
  const calls: any = { started: null, stopped: false, cleaned: false };
  const base = {
    herdr: {
      start: (name: string, cwd: string, argv: string[], env?: Record<string, string>) => {
        calls.started = { name, cwd, argv, env };
        return { terminalId: "term_c", cwd } as any;
      },
      stop: () => {
        calls.stopped = true;
      },
    },
    makeTmpDir: () => "/tmp/autopilot-xyz",
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

test("classifierPrompt embeds the tail + task and asks for the verdict file", () => {
  const p = classifierPrompt(["agent: Shall I write the spec first? (y/n)"], "Build a login page");
  expect(p).toContain("Shall I write the spec first");
  expect(p).toContain("Build a login page");
  expect(p).toContain(VERDICT_FILE);
  expect(p.toLowerCase()).toContain("gate");
  expect(p.toLowerCase()).toContain("question");
  expect(p.toLowerCase()).toContain("complete");
});

test("classifyStop: parses a complete verdict (non-PR deliverable)", async () => {
  const { deps } = makeDeps({
    readVerdict: () => ({ kind: "complete", summary: "Created issue #345." }),
  });
  const v = await classifyStop(["Created the issue. Done."], "create an issue for X", deps, "l");
  expect(v).toEqual({ kind: "complete", summary: "Created issue #345." });
});

test("classifyStop: parses a gate verdict; spawns haiku, dontAsk, Write-only", async () => {
  const { deps, calls } = makeDeps({
    readVerdict: () => ({ kind: "gate", summary: "asking whether to start" }),
  });
  const v = await classifyStop(["Ready to start? (y/n)"], "task", deps, "autopilot TASK-07");
  expect(v).toEqual({ kind: "gate", summary: "asking whether to start" });
  expect(calls.started.name).toBe("autopilot TASK-07");
  expect(calls.started.argv[0]).toBe("claude");
  expect(calls.started.argv).toContain("--model");
  expect(calls.started.argv).toContain("haiku");
  // dontAsk must sit AFTER --allowedTools and BEFORE the prompt
  const pm = calls.started.argv.indexOf("--permission-mode");
  const at = calls.started.argv.indexOf("--allowedTools");
  expect(at).toBeGreaterThan(-1);
  expect(pm).toBeGreaterThan(at);
  expect(calls.started.argv[pm + 1]).toBe("dontAsk");
  expect(calls.started.argv[calls.started.argv.length - 1]).toContain("task");
  expect(calls.stopped).toBe(true);
  expect(calls.cleaned).toBe(true);
});

test("classifyStop: subscription mode — --settings unchanged + no env 4th arg", async () => {
  const { calls } = await withAuth("subscription", "/ignored.sh", async () => {
    const d = makeDeps({ readVerdict: () => ({ kind: "gate", summary: "x" }) });
    await classifyStop(["…"], "task", d.deps, "l");
    return d;
  });
  const argv = calls.started.argv;
  const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
  expect(settings).toEqual({ disableAllHooks: true });
  expect(calls.started.env).toBeUndefined();
});

test("classifyStop: api-key mode — apiKeyHelper in --settings + CLAUDE_CONFIG_DIR env", async () => {
  const { calls } = await withAuth("api-key", "/helper.sh", async () => {
    const d = makeDeps({ readVerdict: () => ({ kind: "gate", summary: "x" }) });
    await classifyStop(["…"], "task", d.deps, "l");
    return d;
  });
  const argv = calls.started.argv;
  const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
  expect(settings.disableAllHooks).toBe(true);
  expect(settings.apiKeyHelper).toBe("/helper.sh");
  expect(Object.keys(calls.started.env)).toEqual(["CLAUDE_CONFIG_DIR"]);
});

test("classifyStop: api-key without configured key fails closed → SURFACE, no spawn", async () => {
  const { result, calls } = await withAuth("api-key", null, async () => {
    const d = makeDeps({ readVerdict: () => ({ kind: "gate", summary: "x" }) });
    const r = await classifyStop(["…"], "task", d.deps, "l");
    return { result: r, calls: d.calls };
  });
  expect(result).toEqual({ kind: "unknown", summary: "" });
  expect(calls.started).toBeNull();
});

test("classifyStop: unknown/surface on timeout (null verdict)", async () => {
  // advancing clock: the verdict never appears, so the poll loop must hit the deadline
  // and bail (a frozen clock would spin forever — the real timeout path needs time to move)
  let t = 0;
  const { deps, calls } = makeDeps({
    readVerdict: () => null,
    now: () => (t += 11_000),
    timeoutMs: 30_000,
  });
  const v = await classifyStop(["…"], "task", deps, "l");
  expect(v).toEqual({ kind: "unknown", summary: "" });
  expect(calls.stopped).toBe(true); // still tore the agent down
  expect(calls.cleaned).toBe(true);
});

test("classifyStop: bad kind coerces to unknown (bias to surface)", async () => {
  const { deps } = makeDeps({ readVerdict: () => ({ kind: "banana", summary: "x" }) as any });
  const v = await classifyStop(["…"], "task", deps, "l");
  expect(v.kind).toBe("unknown");
});

test("classifyStop: valid kind but non-string summary → summary dropped, kind kept", async () => {
  const { deps } = makeDeps({ readVerdict: () => ({ kind: "finished", summary: 42 }) as any });
  const v = await classifyStop(["…"], "task", deps, "l");
  expect(v).toEqual({ kind: "finished", summary: "" });
});

test("classifyStop: surfaces (and cleans up) when the spawn throws", async () => {
  const calls: any = { cleaned: false };
  const deps: any = {
    herdr: {
      start: () => {
        throw new Error("herdr down");
      },
      stop: () => {},
    },
    makeTmpDir: () => "/tmp/autopilot-xyz",
    cleanup: () => {
      calls.cleaned = true;
    },
    now: () => 0,
    sleep: async () => {},
  };
  const v = await classifyStop(["…"], "task", deps, "l");
  expect(v).toEqual({ kind: "unknown", summary: "" });
  expect(calls.cleaned).toBe(true); // temp dir still removed
});
