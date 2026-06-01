import { describe, it, expect } from "vitest";
import { matchSlashTrigger, filterCommands } from "./slash";
import type { SlashCommand } from "./types";

const cmd = (name: string): SlashCommand => ({ name, description: "", scope: "user" });

describe("matchSlashTrigger", () => {
  it("triggers on a leading slash at the caret", () => {
    expect(matchSlashTrigger("/cre", 4)).toEqual({ query: "cre" });
  });

  it("triggers with an empty query right after the slash", () => {
    expect(matchSlashTrigger("/", 1)).toEqual({ query: "" });
  });

  it("does not trigger when the slash is not at the start", () => {
    expect(matchSlashTrigger("fix /foo", 8)).toBeNull();
  });

  it("does not trigger once a space ends the command token", () => {
    expect(matchSlashTrigger("/foo bar", 8)).toBeNull();
  });

  it("uses the text before the caret, not the whole string", () => {
    // caret sits inside the slash token even though more text follows
    expect(matchSlashTrigger("/foobar", 4)).toEqual({ query: "foo" });
  });

  it("does not trigger on empty input", () => {
    expect(matchSlashTrigger("", 0)).toBeNull();
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
