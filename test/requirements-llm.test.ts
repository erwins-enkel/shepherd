import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../src/config";
import { __setApiKeyConfigDirProvisionForTest } from "../src/spawn-auth";
import {
  type RequirementsAgentDeps,
  deriveRequirementsViaAgent,
  deriveRequirementsViaJudge,
} from "../src/requirements-llm";
import type { Judge } from "../src/judge";
import type { JudgeSpendLedger } from "../src/judge-spend";
import { REQUIREMENTS_FILE } from "../src/requirements-classify-core";
import { REQUIREMENTS_FIXTURES } from "../scripts/eval-fixtures/requirements";

// The helper that reads a task's requirements (#2773): spawned, polled, torn down — and on every
// failure nothing derived. Herdr, the answer file and the clock are stubbed; nothing spawns.

beforeEach(() => {
  __setApiKeyConfigDirProvisionForTest(() => "/tmp/shepherd-test-apikey-config");
});

afterEach(() => {
  __setApiKeyConfigDirProvisionForTest(null);
});

interface Calls {
  started: { label: string; cwd: string; argv: string[] } | null;
  stopped: string[];
  cleaned: string[];
  sleeps: number;
}

function harness(answer: () => string | null, over: Partial<RequirementsAgentDeps> = {}) {
  const calls: Calls = { started: null, stopped: [], cleaned: [], sleeps: 0 };
  let clock = 0;
  const deps: RequirementsAgentDeps = {
    herdr: {
      start: async (label: string, cwd: string, argv: string[]) => {
        calls.started = { label, cwd, argv };
        return { terminalId: "term_r", cwd } as never;
      },
      stop: async (id: string) => {
        calls.stopped.push(id);
      },
    },
    makeTmpDir: () => "/tmp/requirements-xyz",
    readAnswer: answer,
    cleanup: (cwd) => calls.cleaned.push(cwd),
    now: () => clock,
    sleep: async (ms) => {
      calls.sleeps++;
      clock += ms;
    },
    timeoutMs: 30_000,
    pollMs: 500,
    ...over,
  };
  return { deps, calls };
}

const fixtureAnswer = (expect: (typeof REQUIREMENTS_FIXTURES)[number]["expect"]): string =>
  expect === "unclear"
    ? JSON.stringify({ requirements: [], unclear: true, options: [["xcode"], []] })
    : // What a well-behaved helper writes may leave out what is implied (`sdk:ios` ⇒ `xcode`).
      JSON.stringify({
        requirements: expect.filter((c) => !(c === "xcode" && expect.includes("sdk:ios"))),
        unclear: false,
        options: [],
      });

describe("deriveRequirementsViaAgent", () => {
  test("every issue fixture's answer comes through as the expected requirements", async () => {
    for (const fixture of REQUIREMENTS_FIXTURES) {
      const { deps, calls } = harness(() => fixtureAnswer(fixture.expect));
      const result = await deriveRequirementsViaAgent(fixture, deps, `requirements ${fixture.id}`);
      if (fixture.expect === "unclear") {
        expect(result, fixture.id).toEqual({ status: "unclear", options: [["xcode"], []] });
      } else {
        expect(result, fixture.id).toEqual({ status: "derived", requirements: fixture.expect });
      }
      expect(calls.stopped).toEqual(["term_r"]);
      expect(calls.cleaned).toEqual(["/tmp/requirements-xyz"]);
    }
  });

  test("the helper reads the task, never the repository", async () => {
    const { deps, calls } = harness(() =>
      JSON.stringify({ requirements: [], unclear: false, options: [] }),
    );
    await deriveRequirementsViaAgent(
      { prompt: "Füge in der Web-UI einen Schalter für den Dunkelmodus hinzu" },
      deps,
      "requirements t1",
    );
    const { argv, cwd, label } = calls.started!;
    expect(label).toBe("requirements t1");
    expect(cwd).toBe("/tmp/requirements-xyz");
    expect(argv).not.toContain("--add-dir");
    const prompt = argv.at(-1)!;
    expect(prompt).toContain("Dunkelmodus");
    expect(prompt).toContain(REQUIREMENTS_FILE);
    expect(prompt).not.toContain("native/");
  });

  test("a Codex helper is constrained by the requirements schema and captures its last message", async () => {
    const { deps, calls } = harness(
      () => JSON.stringify({ requirements: ["xcode"], unclear: false, options: [] }),
      { provider: "codex", model: "gpt-5.6-luna" },
    );
    const result = await deriveRequirementsViaAgent({ prompt: "x" }, deps, "requirements c");
    expect(result).toEqual({ status: "derived", requirements: ["xcode"] });
    const argv = calls.started!.argv.join(" ");
    expect(argv).toContain("requirements.json");
    expect(argv).toContain(".shepherd-last-message.txt");
  });

  test("no answer within the deadline: nothing derived, the helper torn down", async () => {
    const { deps, calls } = harness(() => null, { timeoutMs: 2_000 });
    const result = await deriveRequirementsViaAgent({ prompt: "x" }, deps, "requirements t");
    expect(result).toEqual({ status: "failed", cause: "timeout" });
    expect(calls.stopped).toEqual(["term_r"]);
    expect(calls.cleaned).toEqual(["/tmp/requirements-xyz"]);
  });

  test("an answer that never parses is an error, not a slow answer", async () => {
    const { deps } = harness(() => "{not json", { timeoutMs: 1_000 });
    expect(await deriveRequirementsViaAgent({ prompt: "x" }, deps, "requirements t")).toEqual({
      status: "failed",
      cause: "error",
    });
  });

  test("a partial write is read again on the next poll", async () => {
    const answers = [
      '{"requirements": ["andr',
      '{"requirements":["android-sdk"],"unclear":false,"options":[]}',
    ];
    const { deps } = harness(() => answers.shift() ?? null);
    expect(await deriveRequirementsViaAgent({ prompt: "x" }, deps, "requirements t")).toEqual({
      status: "derived",
      requirements: ["android-sdk"],
    });
  });

  test("an answer naming anything outside the vocabulary derives nothing", async () => {
    const { deps } = harness(() =>
      JSON.stringify({ requirements: ["xcode", "macbook.tailnet.ts.net"], unclear: false }),
    );
    expect(await deriveRequirementsViaAgent({ prompt: "x" }, deps, "requirements t")).toEqual({
      status: "failed",
      cause: "error",
    });
  });

  test("herdr or the CLI not there: unavailable, the temp dir cleaned", async () => {
    const { deps, calls } = harness(() => null, {
      herdr: {
        start: async () => {
          throw new Error("herdr down");
        },
        stop: async () => {},
      },
    });
    expect(await deriveRequirementsViaAgent({ prompt: "x" }, deps, "requirements t")).toEqual({
      status: "failed",
      cause: "unavailable",
    });
    expect(calls.cleaned).toEqual(["/tmp/requirements-xyz"]);
  });

  test("a temp dir that cannot be made is an error, never a throw", async () => {
    const { deps, calls } = harness(() => null, {
      makeTmpDir: () => {
        throw new Error("disk full");
      },
    });
    expect(await deriveRequirementsViaAgent({ prompt: "x" }, deps, "requirements t")).toEqual({
      status: "failed",
      cause: "error",
    });
    expect(calls.started).toBeNull();
  });

  test("api-key mode without a key: a Claude helper is never spawned", async () => {
    const prev = { mode: config.authMode, helper: config.authApiKeyHelperPath };
    config.authMode = "api-key";
    config.authApiKeyHelperPath = null;
    try {
      const { deps, calls } = harness(() => null);
      expect(await deriveRequirementsViaAgent({ prompt: "x" }, deps, "requirements t")).toEqual({
        status: "failed",
        cause: "unavailable",
      });
      expect(calls.started).toBeNull();
    } finally {
      config.authMode = prev.mode;
      config.authApiKeyHelperPath = prev.helper;
    }
  });

  test("an abort ends the wait early and still tears the helper down", async () => {
    const controller = new AbortController();
    const { deps, calls } = harness(() => null, { signal: controller.signal });
    deps.sleep = async () => {
      calls.sleeps++;
      if (calls.sleeps === 3) controller.abort();
    };
    expect(await deriveRequirementsViaAgent({ prompt: "x" }, deps, "requirements t")).toEqual({
      status: "failed",
      cause: "error",
    });
    expect(calls.sleeps).toBe(3);
    expect(calls.stopped).toEqual(["term_r"]);
    expect(calls.cleaned).toEqual(["/tmp/requirements-xyz"]);
  });

  test("already aborted: nothing is spawned", async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps, calls } = harness(() => null, { signal: controller.signal });
    await deriveRequirementsViaAgent({ prompt: "x" }, deps, "requirements t");
    expect(calls.started).toBeNull();
  });

  test("screenshots are copied into the temp dir and read there, never the repository", async () => {
    const staged: { images: readonly string[]; cwd: string }[] = [];
    const { deps, calls } = harness(
      () => JSON.stringify({ requirements: ["ios-simulator"], unclear: false, options: [] }),
      {
        stageScreenshots: (images, cwd) => {
          staged.push({ images, cwd });
          return ["screenshot-1.png"];
        },
      },
    );
    const result = await deriveRequirementsViaAgent(
      { prompt: "Fix das", images: ["/stage/a.png", "/stage/b.mp4"] },
      deps,
      "requirements s",
    );
    expect(result).toEqual({
      status: "derived",
      requirements: ["ios-simulator", "sdk:ios", "xcode"],
    });
    expect(staged).toEqual([
      { images: ["/stage/a.png", "/stage/b.mp4"], cwd: "/tmp/requirements-xyz" },
    ]);
    const { argv } = calls.started!;
    expect(argv).not.toContain("--add-dir");
    expect(argv.join(" ")).toContain("Read");
    expect(argv.at(-1)).toContain("screenshot-1.png");
  });

  test("no screenshot to show: the Write-only helper as before", async () => {
    const { deps, calls } = harness(
      () => JSON.stringify({ requirements: [], unclear: false, options: [] }),
      { stageScreenshots: () => [] },
    );
    await deriveRequirementsViaAgent({ prompt: "x", images: ["/stage/a.pdf"] }, deps, "r");
    const allowed = calls.started!.argv[calls.started!.argv.indexOf("--allowedTools") + 1];
    expect(allowed).toBe("Write");
    expect(calls.started!.argv.at(-1)).not.toContain("screenshot");
  });
});

describe("deriveRequirementsViaJudge", () => {
  const judgeAnswering = (probabilities: Record<string, number>, asked: unknown[] = []): Judge => ({
    ask: (async (state: unknown, questions: unknown) => {
      asked.push({ state, questions });
      return {
        answers: {
          requirements: { type: "choice", choice: "none", probabilities, vendorConfidence: 1 },
        },
        model: "jev-test",
        usage: { inputTokens: 100, outputTokens: 0 },
        costUsd: 0.001,
      };
    }) as Judge["ask"],
  });
  const ledger = (allow = true) => {
    const booked: number[] = [];
    const spend = { allow: () => allow, record: (usd: number) => booked.push(usd) };
    return { spend: spend as unknown as JudgeSpendLedger, booked };
  };
  const quiet = () => {};

  test("a clear pick is derived, the call booked", async () => {
    const asked: unknown[] = [];
    const { spend, booked } = ledger();
    const judge = judgeAnswering(
      { none: 0.05, "ios-simulator": 0.9, ios: 0.05, macos: 0, android: 0, "ios-and-android": 0 },
      asked,
    );
    expect(
      await deriveRequirementsViaJudge({ prompt: "UI-Test im Simulator" }, judge, spend, quiet),
    ).toEqual({
      status: "derived",
      requirements: ["ios-simulator", "sdk:ios", "xcode"],
    });
    expect(booked).toEqual([0.001]);
    expect(JSON.stringify(asked)).toContain("UI-Test im Simulator");
  });

  test("over the daily ceiling or failing: null, so the helper answers", async () => {
    const judge = judgeAnswering({ none: 1 });
    expect(
      await deriveRequirementsViaJudge({ prompt: "x" }, judge, ledger(false).spend, quiet),
    ).toBeNull();
    const broken: Judge = {
      ask: (async () => {
        throw new Error("judge: 503");
      }) as Judge["ask"],
    };
    expect(await deriveRequirementsViaJudge({ prompt: "x" }, broken, null, quiet)).toBeNull();
  });
});
