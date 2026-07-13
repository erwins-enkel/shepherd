import { describe, it, expect } from "vitest";
import {
  matchSlashTrigger,
  filterCommands,
  applyCommandPick,
  applyMentionPick,
  commandInvocationProvider,
} from "./slash";
import type { SlashCommand } from "./types";

const cmd = (name: string, providers: SlashCommand["providers"] = ["claude"]): SlashCommand => ({
  id: `test:${providers.join("+")}:${name}`,
  name,
  displayName: name,
  description: "",
  scope: "user",
  kind: "skill",
  invocationName: name,
  sourceNamespace: `test:${providers.join("+")}`,
  providers,
  invocations: Object.fromEntries(
    providers.map((p) => [p, p === "codex" ? `$${name}` : `/${name}`]),
  ) as SlashCommand["invocations"],
});

describe("matchSlashTrigger", () => {
  it("triggers on a leading slash at the caret", () => {
    expect(matchSlashTrigger("/cre", 4)).toEqual({ query: "cre", start: 0, trigger: "/" });
  });

  it("triggers with an empty query right after the slash", () => {
    expect(matchSlashTrigger("/", 1)).toEqual({ query: "", start: 0, trigger: "/" });
  });

  it("triggers when the slash starts a token after a space (mid-text)", () => {
    expect(matchSlashTrigger("fix /foo", 8)).toEqual({ query: "foo", start: 4, trigger: "/" });
  });

  it("triggers when the slash starts a token after a newline", () => {
    expect(matchSlashTrigger("ctx\n/sha", 8)).toEqual({ query: "sha", start: 4, trigger: "/" });
  });

  it("does not trigger once a space ends the command token", () => {
    expect(matchSlashTrigger("/foo bar", 8)).toBeNull();
  });

  it("does not trigger when the slash is mid-word (a path, not a token)", () => {
    expect(matchSlashTrigger("a/foo", 5)).toBeNull();
    expect(matchSlashTrigger("see src/foo", 11)).toBeNull();
  });

  it("uses the text before the caret, not the whole string", () => {
    // caret sits inside the slash token even though more text follows
    expect(matchSlashTrigger("/foobar", 4)).toEqual({ query: "foo", start: 0, trigger: "/" });
  });

  it("does not trigger on empty input", () => {
    expect(matchSlashTrigger("", 0)).toBeNull();
  });

  it("triggers Codex skill mentions from dollar tokens", () => {
    expect(matchSlashTrigger("use $front", 10)).toEqual({
      query: "front",
      start: 4,
      trigger: "$",
    });
  });

  it("triggers the Codex alias only for a bare at sign", () => {
    expect(matchSlashTrigger("use @", 5)).toEqual({ query: "", start: 4, trigger: "@" });
    expect(matchSlashTrigger("use @file", 9)).toBeNull();
    expect(matchSlashTrigger("use @file.txt", 13)).toBeNull();
    expect(matchSlashTrigger("use @dir/file", 13)).toBeNull();
    expect(matchSlashTrigger("use @foo", 8)).toBeNull();
  });

  it("suppresses shell variable dollar tokens", () => {
    expect(matchSlashTrigger("echo $HOME", 10)).toBeNull();
    expect(matchSlashTrigger("echo ${HOME}", 12)).toBeNull();
    expect(matchSlashTrigger("echo $1", 7)).toBeNull();
    expect(matchSlashTrigger("echo $?", 7)).toBeNull();
  });
});

describe("applyCommandPick", () => {
  it("seeds the command on an otherwise-empty prompt", () => {
    // user typed "/cr", caret at end, picks "create_plan"
    expect(applyCommandPick("/cr", 0, 3, "create_plan")).toEqual({
      value: "/create_plan ",
      caret: 13,
    });
  });

  it("hoists a mid-text command to the front, folding the rest into the argument", () => {
    // "the names are bad /sh" → picks "shaping" → command leads, text becomes its arg
    const text = "the names are bad /sh";
    const trig = matchSlashTrigger(text, text.length)!;
    expect(applyCommandPick(text, trig.start, text.length, "shaping")).toEqual({
      value: "/shaping the names are bad",
      caret: 9,
    });
  });

  it("keeps text that follows the caret as part of the argument", () => {
    // "/rev the diff", caret right after "/rev", picks "review"
    expect(applyCommandPick("/rev the diff", 0, 4, "review")).toEqual({
      value: "/review the diff",
      caret: 8,
    });
  });
});

describe("applyMentionPick", () => {
  it("replaces a dollar query in place with the exact Codex mention", () => {
    expect(applyMentionPick("use $fro please", 4, 8, "frontmatter-name")).toEqual({
      value: "use $frontmatter-name please",
      caret: 22,
    });
  });

  it("replaces a bare at alias in place with a dollar mention", () => {
    expect(applyMentionPick("use @", 4, 5, "frontmatter-name")).toEqual({
      value: "use $frontmatter-name ",
      caret: 22,
    });
  });
});

describe("filterCommands", () => {
  const list = [cmd("deploy"), cmd("create_plan"), cmd("git:commit"), cmd("review")];

  it("returns everything for an empty query", () => {
    expect(filterCommands(list, "")).toEqual(list);
  });

  it("is case-insensitive", () => {
    expect(filterCommands(list, "DEP").map((c) => c.name)).toEqual(["deploy"]);
  });

  it("ranks prefix matches above mid-name substring matches", () => {
    // "co" is a prefix of nothing, a substring of "git:commit" only
    expect(filterCommands(list, "co").map((c) => c.name)).toEqual(["git:commit"]);
    // "re" prefixes "review"; also a substring of "create_plan"
    expect(filterCommands(list, "re").map((c) => c.name)).toEqual(["review", "create_plan"]);
  });

  it("drops non-matches", () => {
    expect(filterCommands(list, "zzz")).toEqual([]);
  });

  it("filters to the requested provider", () => {
    const rows = [cmd("claude-only", ["claude"]), cmd("codex-only", ["codex"])];
    expect(filterCommands(rows, "", "codex").map((c) => c.name)).toEqual(["codex-only"]);
  });
});

describe("commandInvocationProvider", () => {
  it("keeps a preferred provider when the row supports it", () => {
    expect(commandInvocationProvider(cmd("shared", ["claude", "codex"]), "codex")).toBe("codex");
    expect(commandInvocationProvider(cmd("shared", ["claude", "codex"]), "claude")).toBe("claude");
  });

  it("falls back to the row's actual provider when the preferred provider is incompatible", () => {
    expect(commandInvocationProvider(cmd("codex-only", ["codex"]), "claude")).toBe("codex");
  });
});
