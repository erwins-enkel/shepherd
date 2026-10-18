import { test, expect, describe } from "bun:test";
import {
  parseAskInput,
  resolveAskAnswers,
  askKeySequence,
  expectedAskAnswers,
  normalizeAskAnswers,
  askAnswersMatch,
  sanitizeOtherText,
  type AskQuestion,
} from "../src/ask-user-question";

const D = "\x1b[B";
const opt = (...labels: string[]) => labels.map((label) => ({ label, description: label }));
const q = (question: string, multiSelect: boolean, ...labels: string[]) => ({
  question,
  header: question.slice(0, 5),
  options: opt(...labels),
  multiSelect,
});
const ans = (i: number, optionIndices: number[], text?: string) => ({
  blockId: "toolu_1",
  questionId: String(i),
  optionIndices,
  ...(text === undefined ? {} : { text }),
});

function keysFor(questions: AskQuestion[], raw: ReturnType<typeof ans>[]) {
  const resolved = resolveAskAnswers(questions, raw);
  if (!resolved) throw new Error("unresolved");
  return { keys: askKeySequence(resolved), expected: expectedAskAnswers(resolved) };
}

describe("parseAskInput", () => {
  test("valid input, preview + unknown fields tolerated", () => {
    const parsed = parseAskInput({
      questions: [
        {
          question: "Pick?",
          header: "Pick",
          multiSelect: false,
          extra: 1,
          options: [
            { label: "A", description: "a", preview: "```x```" },
            { label: "B", description: "b" },
          ],
        },
      ],
    });
    expect(parsed).toEqual([
      {
        question: "Pick?",
        header: "Pick",
        multiSelect: false,
        options: [
          { label: "A", description: "a" },
          { label: "B", description: "b" },
        ],
      },
    ]);
  });

  test("rejects shapes the panel cannot type without throwing", () => {
    expect(parseAskInput(null)).toBeNull();
    expect(parseAskInput({ questions: [] })).toBeNull();
    expect(parseAskInput({ questions: Array(5).fill(q("x", false, "a", "b")) })).toBeNull();
    expect(parseAskInput({ questions: [{ question: "x", kind: "text" }] })).toBeNull();
    expect(parseAskInput({ questions: [q("x", false, "only")] })).toBeNull();
    expect(parseAskInput({ questions: [{ question: "x", options: [{ label: 1 }, { label: "b" }] }] })).toBeNull();
  });
});

describe("askKeySequence (spike-verified on Claude Code 2.1.301)", () => {
  test("1 question single → one digit, auto-submits", () => {
    const { keys, expected } = keysFor([q("Pet?", false, "Cat", "Dog")], [ans(0, [1])]);
    expect(keys).toEqual(["2"]);
    expect(expected).toEqual({ "Pet?": "Dog" });
  });

  test("1 question single + Other → Other digit, text, Enter, no review", () => {
    const { keys, expected } = keysFor([q("Pet?", false, "Cat", "Dog")], [ans(0, [], "Hamster 2")]);
    expect(keys).toEqual(["3", "Hamster 2", "\r"]);
    expect(expected).toEqual({ "Pet?": "Hamster 2" });
  });

  test("1 question multi + Other → toggles, Down×n, text, Down, Enter, review submit", () => {
    const { keys, expected } = keysFor([q("Pick fruit?", true, "Apple", "Pear")], [ans(0, [1], "Kiwi")]);
    expect(keys).toEqual(["2", "3", D, D, "Kiwi", D, "\r", "1"]);
    expect(expected).toEqual({ "Pick fruit?": "Pear, Kiwi" });
  });

  test("2 questions single + multi", () => {
    const { keys, expected } = keysFor(
      [q("Color?", false, "Red", "Blue"), q("Tops?", true, "Cheese", "Ham")],
      [ans(0, [1]), ans(1, [0, 1])],
    );
    expect(keys).toEqual(["2", "1", "2", D, D, D, "\r", "1"]);
    expect(expected).toEqual({ "Color?": "Blue", "Tops?": "Cheese, Ham" });
  });

  test("4 questions mixed", () => {
    const { keys, expected } = keysFor(
      [
        q("Color?", false, "Red", "Blue"),
        q("Tops?", true, "Cheese", "Ham", "Olives"),
        q("Drinks?", true, "Cola", "Water"),
        q("Size?", false, "Small", "Large"),
      ],
      [ans(0, [1]), ans(1, [2, 0]), ans(2, [1], "Juice"), ans(3, [0])],
    );
    expect(keys).toEqual([
      "2",
      "1", "3", D, D, D, D, "\r",
      "2", "3", D, D, "Juice", D, "\r",
      "1",
      "1",
    ]);
    expect(expected).toEqual({
      "Color?": "Blue",
      "Tops?": "Cheese, Olives",
      "Drinks?": "Water, Juice",
      "Size?": "Small",
    });
  });
});

describe("resolveAskAnswers", () => {
  const qs = [q("A?", false, "x", "y"), q("B?", true, "x", "y")];
  test("fails closed on invalid answers", () => {
    expect(resolveAskAnswers(qs, [ans(0, [0])])).toBeNull(); // missing question
    expect(resolveAskAnswers(qs, [ans(0, [0, 1]), ans(1, [0])])).toBeNull(); // two singles
    expect(resolveAskAnswers(qs, [ans(0, [0], "o"), ans(1, [0])])).toBeNull(); // single + other
    expect(resolveAskAnswers(qs, [ans(0, [2]), ans(1, [0])])).toBeNull(); // out of range
    expect(resolveAskAnswers(qs, [ans(0, [0]), ans(1, [])])).toBeNull(); // empty multi
    expect(resolveAskAnswers(qs, [ans(0, [0]), ans(1, [0, 0])])).toBeNull(); // duplicate
    expect(resolveAskAnswers(qs, [ans(0, [], "  \n ")!, ans(1, [0])])).toBeNull(); // blank other
    expect(resolveAskAnswers(qs, [ans(0, [0]), ans(0, [0]), ans(1, [0])])).toBeNull(); // dup id
  });
  test("multi may be Other alone", () => {
    expect(resolveAskAnswers(qs, [ans(0, [1]), ans(1, [], "none")])).toEqual([
      { question: qs[0]!, optionIndices: [1], other: null },
      { question: qs[1]!, optionIndices: [], other: "none" },
    ]);
  });
});

test("sanitizeOtherText strips control chars incl. newline and ESC", () => {
  expect(sanitizeOtherText("a\nb\r\x1b[Bc\t d ")).toBe("a b [Bc d");
  expect(sanitizeOtherText("\n\x1b")).toBeNull();
  expect(sanitizeOtherText("x".repeat(600))?.length).toBe(500);
});

test("normalizeAskAnswers + askAnswersMatch", () => {
  const actual = normalizeAskAnswers({ "A?": "x", "B?": ["x", "y"], bad: 3 });
  expect(actual).toEqual({ "A?": "x", "B?": "x, y" });
  expect(askAnswersMatch({ "A?": "x", "B?": "x, y" }, actual!)).toBe(true);
  expect(askAnswersMatch({ "A?": "y", "B?": "x, y" }, actual!)).toBe(false);
  expect(askAnswersMatch({ "A?": "x" }, actual!)).toBe(false);
  expect(normalizeAskAnswers("nope")).toBeNull();
});
