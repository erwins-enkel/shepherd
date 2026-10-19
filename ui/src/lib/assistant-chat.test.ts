import { describe, expect, it } from "vitest";
import { chatEntries, unsettled, viewFocus } from "./assistant-chat";
import type { AssistantViewReport } from "./operator-assistant-view";

const user = (text: string, ts = 1000) => ({ role: "user" as const, text, ts });
const agent = (text: string, ts = 1000) => ({ role: "assistant" as const, text, ts });

describe("chatEntries", () => {
  it("keeps the operator's and the assistant's words as they are", () => {
    expect(chatEntries([user("wie ist der status?"), agent("Alles grün.")])).toEqual([
      { kind: "user", text: "wie ist der status?", ts: 1000 },
      { kind: "assistant", text: "Alles grün.", ts: 1000 },
    ]);
  });

  it("turns a background task's notification into a quiet event row (its summary)", () => {
    const notice =
      "<task-notification>\n<task-id>bo8g</task-id>\n<summary>Monitor event: calendar sessions</summary>\n<event>TASK-2241 st=running</event>\n</task-notification>";
    expect(chatEntries([user(notice, 5)])).toEqual([
      { kind: "event", text: "Monitor event: calendar sessions", ts: 5 },
    ]);
  });

  it("drops a notification without a summary", () => {
    expect(
      chatEntries([user("<task-notification>\n<task-id>x</task-id>\n</task-notification>")]),
    ).toEqual([]);
  });

  it("shows a slash command as the line the operator typed", () => {
    const cmd =
      "<command-message>design</command-message>\n<command-name>/design</command-name>\n<command-args>B bitte</command-args>";
    expect(chatEntries([user(cmd)])).toEqual([{ kind: "user", text: "/design B bitte", ts: 1000 }]);
    expect(chatEntries([user("<command-name>/clear</command-name>")])).toEqual([
      { kind: "user", text: "/clear", ts: 1000 },
    ]);
  });

  it("drops other harness records (command output, caveats)", () => {
    expect(
      chatEntries([
        user("<local-command-stdout>ok</local-command-stdout>"),
        user("<local-command-caveat>Caveat: …</local-command-caveat>"),
      ]),
    ).toEqual([]);
  });

  it("keeps operator text that merely starts with an unknown tag", () => {
    expect(chatEntries([user("<div> rendert nicht")])).toEqual([
      { kind: "user", text: "<div> rendert nicht", ts: 1000 },
    ]);
  });
});

describe("unsettled", () => {
  const sent = { text: "  wie ist der status? ", at: 100_000 };

  it("keeps a send the transcript has not logged yet", () => {
    expect(unsettled([sent], [{ kind: "assistant", text: "x", ts: 99_000 }])).toEqual([sent]);
  });

  it("settles once a user row with the same text is logged", () => {
    expect(unsettled([sent], [{ kind: "user", text: "wie ist der status?", ts: 101_000 }])).toEqual(
      [],
    );
  });

  it("tolerates a minute of clock skew, not an old identical message", () => {
    expect(unsettled([sent], [{ kind: "user", text: "wie ist der status?", ts: 30_000 }])).toEqual([
      sent,
    ]);
    expect(unsettled([sent], [{ kind: "user", text: "wie ist der status?", ts: 95_000 }])).toEqual(
      [],
    );
  });
});

describe("viewFocus", () => {
  const report = (focus: AssistantViewReport["focus"]): AssistantViewReport => ({
    v: 1,
    client: { kind: "browser", platform: "macos" },
    repoFilter: [],
    focus,
  });
  const herd = [{ id: "s1", desig: "TASK-2237" }];

  it("names the session in view and its tab", () => {
    expect(viewFocus(report({ kind: "session", id: "s1", tab: "term" }), herd)).toEqual({
      desig: "TASK-2237",
      tab: "term",
      host: null,
    });
  });

  it("names a mirrored session with its machine", () => {
    expect(viewFocus(report({ kind: "remote", desig: "TASK-9", host: "macbook" }), herd)).toEqual({
      desig: "TASK-9",
      tab: null,
      host: "macbook",
    });
  });

  it("is null with nothing in view, an unknown session, or no report", () => {
    expect(viewFocus(report({ kind: "none" }), herd)).toBeNull();
    expect(viewFocus(report({ kind: "session", id: "gone", tab: null }), herd)).toBeNull();
    expect(viewFocus(null, herd)).toBeNull();
  });
});
