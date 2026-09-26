import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The Rust CLI builds the same kickoff prompts the web UI does (merge-train launcher, retry
// steer), from EN copies it embeds with include_str!. The UI's EN catalog is the source of truth.
const ROOT = join(import.meta.dir, "..");
const en = JSON.parse(readFileSync(join(ROOT, "ui", "messages", "en.json"), "utf8")) as Record<
  string,
  string
>;

const PAIRS: [file: string, key: string][] = [
  ["merge_train_ready.txt", "herd_merge_train_prompt"],
  ["merge_train_selected.txt", "prspanel_merge_train_prompt"],
  ["retry_continue.txt", "retry_continue_steer"],
];

describe("CLI prompt copies match the EN catalog", () => {
  for (const [file, key] of PAIRS) {
    test(`cli/src/prompts/${file} == en.json ${key}`, () => {
      const copy = readFileSync(join(ROOT, "cli", "src", "prompts", file), "utf8");
      expect(copy).toBe(en[key] ?? "");
      expect(copy.length).toBeGreaterThan(0);
    });
  }
});
