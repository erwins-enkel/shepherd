import { describe, expect, it } from "vitest";
import { blockCard, blockContext, chatTimeline } from "./chat-timeline";
import type { ChatEntry } from "./assistant-chat";
import type { ActivityEntry, BlockReason } from "./types";

const msg = (kind: "assistant" | "user", text: string, ts: number): ChatEntry => ({
  kind,
  text,
  ts,
});
const call = (summary: string, ts: number): ActivityEntry => ({
  ts,
  tool: "Bash",
  summary,
  status: "ok",
});

describe("chatTimeline", () => {
  it("interleaves messages and tool runs by time, grouping consecutive calls", () => {
    const rows = chatTimeline(
      [msg("user", "go", 10), msg("assistant", "done", 50)],
      [call("a", 5), call("b", 20), call("c", 30), call("d", 60)],
    );
    expect(rows.map((r) => (r.kind === "tools" ? r.calls.map((c) => c.summary) : r.text))).toEqual([
      ["a"],
      "go",
      ["b", "c"],
      "done",
      ["d"],
    ]);
  });

  it("puts the message before a tool call with the same stamp", () => {
    const rows = chatTimeline([msg("assistant", "on it", 10)], [call("a", 10)]);
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "tools"]);
  });

  it("keeps an unstamped message in place", () => {
    const rows = chatTimeline([msg("user", "x", 0), msg("assistant", "y", 40)], [call("a", 20)]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "tools", "assistant"]);
  });

  it("keeps keys stable as rows and calls are appended", () => {
    const before = chatTimeline([msg("user", "go", 10)], [call("a", 20)]);
    const after = chatTimeline(
      [msg("user", "go", 10), msg("assistant", "ok", 40)],
      [call("a", 20), call("b", 30)],
    );
    expect(after.slice(0, 2).map((r) => r.key)).toEqual(before.map((r) => r.key));
    expect(new Set(after.map((r) => r.key)).size).toBe(after.length);
  });

  it("disambiguates rows sharing a stamp", () => {
    const rows = chatTimeline([msg("user", "a", 1), msg("user", "b", 1)]);
    expect(rows[0].key).not.toBe(rows[1].key);
  });
});

describe("blockContext", () => {
  it("takes the lines above the option run", () => {
    const tail = [
      "● Bash(touch x)",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
      "Esc to cancel",
    ];
    expect(blockContext(tail)).toEqual(["● Bash(touch x)", "Do you want to proceed?"]);
  });

  it("takes the last lines when there is no option run", () => {
    const tail = ["1", "2", "3", "4", "5", "6", "7", "Overwrite? (y/n)"].map((l, i) =>
      i < 7 ? `line ${l}` : l,
    );
    expect(blockContext(tail)).toEqual([
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7",
      "Overwrite? (y/n)",
    ]);
  });
});

describe("blockCard", () => {
  const reason = (shape: BlockReason["shape"], options: BlockReason["options"] = []) => ({
    shape,
    options,
    tail: [],
  });
  it("answers menus with options, (y/n) prompts and quota", () => {
    expect(blockCard(reason("menu", [{ label: "Yes", send: "1" }]))).toBe("menu");
    expect(blockCard(reason("yes-no"))).toBe("yes-no");
    expect(blockCard(reason("quota"))).toBe("quota");
  });
  it("leaves the rest to the composer or the Terminal", () => {
    expect(blockCard(null)).toBeNull();
    expect(blockCard(reason("menu"))).toBeNull();
    expect(blockCard(reason("awaiting-input"))).toBeNull();
    expect(blockCard(reason("stall"))).toBeNull();
  });
});
