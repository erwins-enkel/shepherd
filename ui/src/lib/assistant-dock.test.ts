import { describe, expect, it } from "vitest";
import type { ChatEntry } from "./assistant-chat";
import {
  newestReply,
  previewLine,
  repoHue,
  repoMonogram,
  unreadCount,
  urgentPip,
} from "./assistant-dock";

const reply = (text: string, ts: number): ChatEntry => ({ kind: "assistant", text, ts });
const said = (text: string, ts: number): ChatEntry => ({ kind: "user", text, ts });

describe("repo marks", () => {
  it("a repo keeps one data hue", () => {
    expect(repoHue("/p/shepherd")).toBe(repoHue("/p/shepherd"));
    expect(repoHue("/p/shepherd")).toMatch(/^var\(--color-data-[1-6]\)$/);
  });
  it("the monogram is the first letter or digit, upper-cased", () => {
    expect(repoMonogram("shepherd")).toBe("S");
    expect(repoMonogram("_hunde-frontend")).toBe("H");
    expect(repoMonogram("---")).toBe("?");
  });
});

describe("previewLine", () => {
  it("is the newest reply as one plain line", () => {
    const entries = [reply("old", 1), said("q", 2), reply("**Fix** in `Chat`\n\nnext", 3)];
    expect(previewLine(entries)).toBe("Fix in Chat next");
  });
  it("drops code blocks and keeps a link's words", () => {
    expect(previewLine([reply("See [the PR](https://x/1)\n```sh\nrm -rf\n```", 1)])).toBe(
      "See the PR",
    );
  });
  it("is null with no reply", () => {
    expect(previewLine([said("hi", 1)])).toBeNull();
  });
});

describe("unread replies", () => {
  const entries = [reply("a", 10), said("b", 20), reply("c", 30), reply("d", 40)];
  it("counts the replies after the newest one seen", () => {
    expect(newestReply(entries)).toBe(40);
    expect(unreadCount(entries, 10)).toBe(2);
    expect(unreadCount(entries, newestReply(entries))).toBe(0);
  });
});

describe("urgentPip", () => {
  it("waiting on the operator beats working, rest shows none", () => {
    expect(urgentPip(["running", "blocked", null])).toBe("blocked");
    expect(urgentPip(["idle", "running"])).toBe("working");
    expect(urgentPip(["idle", "done", null])).toBeNull();
  });
});
