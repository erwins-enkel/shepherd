import { test, expect } from "bun:test";
import { llmName, namingPrompt, NAME_FILE } from "../src/namer-llm";

function makeDeps(over: Partial<import("../src/namer-llm").LlmNamerDeps> = {}) {
  const calls: any = { started: null, stopped: false, cleaned: false };
  const base = {
    herdr: {
      start: (name: string, cwd: string, argv: string[]) => {
        calls.started = { name, cwd, argv };
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
