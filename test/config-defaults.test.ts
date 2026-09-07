import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

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
