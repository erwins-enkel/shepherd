import { test, expect } from "bun:test";
import { issueSpawnPrompt } from "../src/issue-spawn-prompt";

test("templates a slash-leading title so the CLI can't parse it as a slash command", () => {
  // `claude -p "/foo bar"` → "Unknown command: /foo bar"; the sentence prefix moves the slash
  // off position 0, which is the only thing that reliably avoids the parse.
  expect(issueSpawnPrompt(12, "/foo bar")).toBe("Work on issue #12: /foo bar");
});

test("templates a path-like title — no such command exists, and that is exactly the broken case", () => {
  expect(issueSpawnPrompt(12, "/api/users returns 500")).toBe(
    "Work on issue #12: /api/users returns 500",
  );
});

test("templates a bare slash", () => {
  expect(issueSpawnPrompt(7, "/")).toBe("Work on issue #7: /");
});

test("templates a title whose slash sits behind leading whitespace", () => {
  // Dodging the parse via the CLI's whitespace trimming would be undocumented and
  // provider-specific — template it instead, preserving the title verbatim.
  expect(issueSpawnPrompt(3, "  /foo")).toBe("Work on issue #3:   /foo");
});

test("passes a non-slash title through byte-identical", () => {
  // The byte-identical path is load-bearing: the namer derives branch + worktree names from the
  // prompt, so every ordinary title must keep the slug it has today.
  expect(issueSpawnPrompt(12, "Fix login")).toBe("Fix login");
  expect(issueSpawnPrompt(12, "Rework the /usage probe")).toBe("Rework the /usage probe");
  expect(issueSpawnPrompt(12, "")).toBe("");
});
