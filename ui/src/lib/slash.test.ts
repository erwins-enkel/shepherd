import { describe, it, expect } from "vitest";
import { matchSlashTrigger, filterCommands, applyCommandPick } from "./slash";
import type { SlashCommand } from "./types";

const cmd = (name: string): SlashCommand => ({ name, description: "", scope: "user" });

describe("matchSlashTrigger", () => {
  it("triggers on a leading slash at the caret", () => {
    expect(matchSlashTrigger("/cre", 4)).toEqual({ query: "cre", start: 0 });
  });

  it("triggers with an empty query right after the slash", () => {
    expect(matchSlashTrigger("/", 1)).toEqual({ query: "", start: 0 });
  });

  it("triggers when the slash starts a token after a space (mid-text)", () => {
    expect(matchSlashTrigger("fix /foo", 8)).toEqual({ query: "foo", start: 4 });
  });

  it("triggers when the slash starts a token after a newline", () => {
    expect(matchSlashTrigger("ctx\n/sha", 8)).toEqual({ query: "sha", start: 4 });
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
    expect(matchSlashTrigger("/foobar", 4)).toEqual({ query: "foo", start: 0 });
  });

  it("does not trigger on empty input", () => {
    expect(matchSlashTrigger("", 0)).toBeNull();
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
});
