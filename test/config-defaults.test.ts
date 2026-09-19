import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { parseEnvNumber, parsePort } from "../src/config";

describe("Codex model config seed", () => {
  test.each([
    [undefined, "gpt-5.6-sol"],
    ["not-a-curated-model", "gpt-5.6-sol"],
    ["gpt-5.5", "gpt-5.5"],
    ["default", "default"],
  ])("environment %s resolves to %s", (value, expected) => {
    const env = { ...process.env };
    delete env.SHEPHERD_DEFAULT_CODEX_MODEL;
    if (value !== undefined) env.SHEPHERD_DEFAULT_CODEX_MODEL = value;
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        'import { config } from "./src/config.ts"; console.log(config.defaultCodexModel);',
      ],
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(expected);
  });
});

// ── numeric env guards (issue #2362) ─────────────────────────────────────────
// A non-numeric value must never become NaN: every comparison against NaN is false, which
// reads as "the guard is off" (a vanished push cooldown, a cap that never trips, zero
// house rules injected). Caps/intervals warn + fall back; the port fails fast.

/** Import config.ts in a child with a doctored env; returns the child's result. Each `undefined`
 *  override is DELETED from the inherited env so an ambient value can't mask the default. */
function spawnConfig(overrides: Record<string, string | undefined>, print: string) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", `import { config } from "./src/config.ts"; ${print}`],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString(),
  };
}

/** Collect console.warn output for the duration of `fn`. */
function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

describe("parseEnvNumber", () => {
  test("unset and blank fall back to the default (blank must not read as an explicit 0)", () => {
    expect(parseEnvNumber(undefined, "SHEPHERD_X", 120000)).toBe(120000);
    expect(parseEnvNumber("", "SHEPHERD_X", 120000)).toBe(120000);
    expect(parseEnvNumber("   ", "SHEPHERD_X", 120000)).toBe(120000);
  });

  test("finite values parse, including an explicit 0 and a negative", () => {
    expect(parseEnvNumber("0", "SHEPHERD_X", 120000)).toBe(0);
    expect(parseEnvNumber("2500", "SHEPHERD_X", 120000)).toBe(2500);
    expect(parseEnvNumber("1.5", "SHEPHERD_X", 120000)).toBe(1.5);
    expect(parseEnvNumber("-1", "SHEPHERD_X", 120000)).toBe(-1);
  });

  test.each([["2m"], ["seven"], ["Infinity"], ["-Infinity"], ["1,000"]])(
    "%s falls back to the default and warns, naming the key",
    (raw) => {
      let parsed = -1;
      const warnings = captureWarnings(() => {
        parsed = parseEnvNumber(raw, "SHEPHERD_PUSH_COOLDOWN_MS", 120000);
      });
      expect(parsed).toBe(120000);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("SHEPHERD_PUSH_COOLDOWN_MS");
      expect(warnings[0]).toContain(raw);
      expect(warnings[0]).toContain("120000");
    },
  );

  test("a valid value is silent", () => {
    expect(captureWarnings(() => parseEnvNumber("5", "SHEPHERD_X", 1))).toEqual([]);
  });
});

describe("parsePort", () => {
  test("unset and blank fall back to the default", () => {
    expect(parsePort(undefined, "SHEPHERD_PORT", 7330)).toBe(7330);
    expect(parsePort("", "SHEPHERD_PORT", 7330)).toBe(7330);
  });

  test("valid ports parse", () => {
    expect(parsePort("7331", "SHEPHERD_PORT", 7330)).toBe(7331);
    expect(parsePort("1", "SHEPHERD_PORT", 7330)).toBe(1);
    expect(parsePort("65535", "SHEPHERD_PORT", 7330)).toBe(65535);
  });

  test.each([["seven"], ["0"], ["-1"], ["70000"], ["7330.5"], ["2m"]])(
    "%s throws, naming the key",
    (raw) => {
      expect(() => parsePort(raw, "SHEPHERD_PORT", 7330)).toThrow(/SHEPHERD_PORT/);
    },
  );
});

describe("config seeds reject non-numeric env values", () => {
  test("SHEPHERD_PORT=seven fails fast and blames SHEPHERD_PORT, not the derived ingress key", () => {
    const r = spawnConfig({ SHEPHERD_PORT: "seven" }, "console.log(config.port);");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("SHEPHERD_PORT");
    // The regression in issue #2362: agentIngressPort defaults to mainPort + 1, so a NaN main
    // port used to reach validateAgentIngressPort, which threw first and named the WRONG key.
    expect(r.stderr).not.toContain("SHEPHERD_AGENT_INGRESS_PORT");
  });

  test("a typo'd push cooldown falls back to the default and says so, rather than vanishing", () => {
    const r = spawnConfig(
      { SHEPHERD_PUSH_COOLDOWN_MS: "2m" },
      "console.log(config.pushCooldownMs);",
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("120000");
    expect(r.stderr).toContain("SHEPHERD_PUSH_COOLDOWN_MS");
  });

  test("a typo'd house-rules budget falls back instead of injecting zero rules", () => {
    const r = spawnConfig(
      { SHEPHERD_HOUSE_RULES_BUDGET_CHARS: "lots" },
      "console.log(config.houseRulesBudgetChars);",
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("4000");
  });

  test("every guarded seed resolves to its default when set-but-empty", () => {
    const r = spawnConfig(
      {
        SHEPHERD_PORT: "",
        SHEPHERD_PUSH_COOLDOWN_MS: "",
        SHEPHERD_AUTOPILOT_STEP_CAP: "",
        SHEPHERD_AUTOMERGE_REBASE_CAP: "",
        SHEPHERD_PREVIEW_SWEEP_MS: "",
        SHEPHERD_PREVIEW_KILL_MAX_AGE_MS: "",
        SHEPHERD_HOUSE_RULES_BUDGET_CHARS: "",
      },
      "console.log(JSON.stringify([config.port, config.pushCooldownMs, config.autopilotStepCap, config.autoMergeRebaseCap, config.previewSweepMs, config.previewKillMaxAgeMs, config.houseRulesBudgetChars]));",
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([7330, 120000, 10, 5, 4000, 10000, 4000]);
  });

  test("no guarded seed can be NaN for a garbage env", () => {
    const r = spawnConfig(
      {
        SHEPHERD_PUSH_COOLDOWN_MS: "2m",
        SHEPHERD_AUTOPILOT_STEP_CAP: "many",
        SHEPHERD_AUTOMERGE_REBASE_CAP: "a few",
        SHEPHERD_PREVIEW_SWEEP_MS: "4s",
        SHEPHERD_PREVIEW_KILL_MAX_AGE_MS: "10s",
        SHEPHERD_HOUSE_RULES_BUDGET_CHARS: "lots",
      },
      "console.log(JSON.stringify([config.pushCooldownMs, config.autopilotStepCap, config.autoMergeRebaseCap, config.previewSweepMs, config.previewKillMaxAgeMs, config.houseRulesBudgetChars]));",
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([120000, 10, 5, 4000, 10000, 4000]);
  });
});
