import { describe, expect, it } from "vitest";
import { chatEntries, unsettled, viewFocus, yesNoQuestions } from "./assistant-chat";
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

  it("settles a send with images on an echo containing the typed words", () => {
    const withImage = { text: "look\n\n/a/x.png", at: 100_000, match: "look" };
    expect(
      unsettled([withImage], [{ kind: "user", text: "look\n\n[Image #1]", ts: 101_000 }]),
    ).toEqual([]);
    expect(unsettled([withImage], [{ kind: "user", text: "other", ts: 101_000 }])).toEqual([
      withImage,
    ]);
    const imageOnly = { text: "/a/x.png", at: 100_000, match: "" };
    expect(unsettled([imageOnly], [{ kind: "user", text: "[Image #1]", ts: 30_000 }])).toEqual([
      imageOnly,
    ]);
    expect(unsettled([imageOnly], [{ kind: "user", text: "[Image #1]", ts: 101_000 }])).toEqual([]);
  });

  it("settles each repeated send with its own echo", () => {
    const first = { text: "Yes", at: 100_000 };
    const second = { text: "Yes", at: 110_000 };
    const echo = (ts: number) => ({ kind: "user" as const, text: "Yes", ts });
    expect(unsettled([first, second], [echo(101_000)])).toEqual([second]);
    expect(unsettled([first, second], [echo(101_000), echo(111_000)])).toEqual([]);
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

describe("yesNoQuestions", () => {
  it.each([
    "Soll ich fortfahren? (Ja/Nein)",
    "**Soll ich fortfahren ( ja / nein )?**  ",
    "Context.\n\nContinue? **(YES/NO)**",
  ])("recognizes an explicit final question: %s", (text) => {
    expect(yesNoQuestions(text)).toHaveLength(1);
    expect(yesNoQuestions(text)[0].number).toBeNull();
  });

  it("returns every numbered question, preserving its number", () => {
    expect(yesNoQuestions("Entscheidungen:\n1. Starten? (Ja/Nein)\n2) Stoppen (Ja/Nein)?")).toEqual(
      [
        { number: "1", text: "Starten? (Ja/Nein)" },
        { number: "2", text: "Stoppen (Ja/Nein)?" },
      ],
    );
  });

  it("recognizes a final standalone question after a separate status list", () => {
    expect(
      yesNoQuestions("1. PR gemergt\n2. Epic fortgesetzt\n\nSoll ich fortfahren? (Ja/Nein)"),
    ).toEqual([{ number: null, text: "Soll ich fortfahren? (Ja/Nein)" }]);
  });

  it.each(["\n", "\n\n"])(
    "recognizes the trailing question list after an earlier status list (%j)",
    (separator) => {
      expect(
        yesNoQuestions(
          "1. PR gemergt\n2. Epic fortgesetzt\n\n1. Starten? (Ja/Nein)" +
            separator +
            "2. Stoppen? (Ja/Nein)",
        ),
      ).toEqual([
        { number: "1", text: "Starten? (Ja/Nein)" },
        { number: "2", text: "Stoppen? (Ja/Nein)" },
      ]);
    },
  );

  it("includes blank-separated list items", () => {
    expect(yesNoQuestions("1. Start? (Yes/No)\n\n2. Stop? (Yes/No)").map((q) => q.number)).toEqual([
      "1",
      "2",
    ]);
  });

  it.each([
    "> Example question:\nContinue? (Yes/No)",
    "1. First question wraps\n   Continue? (Yes/No)",
    "1. First question wraps\n   Continue? (Yes/No)\n2. Stop? (Yes/No)",
    "(Ja/Nein)?",
  ])("does not mistake partial lists or quote continuations for questions: %s", (text) => {
    expect(yesNoQuestions(text)).toEqual([]);
  });

  it.each([
    "Fortfahren?",
    "Antworten sind Ja/Nein",
    "(Ja/Nein)",
    "Starten? (Ja/Nein)\nDanach geht es weiter.",
    "> Starten? (Ja/Nein)",
    "```\nStarten? (Ja/Nein)\n```",
    "```text\nStarten? (Ja/Nein)",
    "    Starten? (Ja/Nein)",
    "1. Starten? (Ja/Nein)\n2. Welche Farbe?",
    "1. Welche Farbe?\n2. Starten? (Ja/Nein)",
    "1. Welche Farbe?\n\n2. Starten? (Ja/Nein)",
  ])("ignores unsupported content: %s", (text) => {
    expect(yesNoQuestions(text)).toEqual([]);
  });
});
