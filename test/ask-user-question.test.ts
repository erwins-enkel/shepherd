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
        allowOther: false,
        options: [
          { label: "A", description: "a", preview: "```x```" },
          { label: "B", description: "b" },
        ],
      },
    ]);
  });

  test("blank previews and multi-select previews keep the plain layout", () => {
    const options = (preview: unknown) => [
      { label: "A", description: "a", preview },
      { label: "B", description: "b", preview },
    ];
    const plain = (multiSelect: boolean, question: string) => ({
      question,
      header: "",
      multiSelect,
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    });
    const parse = (multiSelect: boolean, preview: unknown) =>
      parseAskInput({
        questions: [{ question: "Q?", multiSelect, options: options(preview) }],
      });
    expect(parse(false, "  \n")).toEqual([plain(false, "Q?")]);
    expect(parse(false, 7)).toEqual([plain(false, "Q?")]);
    expect(parse(true, "drawing")).toEqual([plain(true, "Q?")]);
  });

  test("caps the preview copy; the layout check reads the full value", () => {
    const parsed = parseAskInput({
      questions: [
        {
          question: "Q?",
          options: [{ label: "A", preview: "x".repeat(9000) }, { label: "B" }],
        },
        {
          question: "R?",
          options: [{ label: "A" }, { label: "B", preview: `${" ".repeat(9000)}y` }],
        },
      ],
    });
    expect(parsed?.[0]?.options[0]?.preview?.length).toBe(8000);
    expect(parsed?.[1]?.allowOther).toBe(false);
  });

  test("rejects shapes the panel cannot type without throwing", () => {
    expect(parseAskInput(null)).toBeNull();
    expect(parseAskInput({ questions: [] })).toBeNull();
    expect(parseAskInput({ questions: Array(5).fill(q("x", false, "a", "b")) })).toBeNull();
    expect(parseAskInput({ questions: [{ question: "x", kind: "text" }] })).toBeNull();
    expect(parseAskInput({ questions: [q("x", false, "only")] })).toBeNull();
    expect(
      parseAskInput({ questions: [{ question: "x", options: [{ label: 1 }, { label: "b" }] }] }),
    ).toBeNull();
  });
});

describe("askKeySequence (spike-verified on Claude Code 2.1.316)", () => {
  test("1 question single → Down×index, Enter, auto-submits", () => {
    const { keys, expected } = keysFor([q("Pet?", false, "Cat", "Dog")], [ans(0, [1])]);
    expect(keys).toEqual([D, "\r"]);
    expect(expected).toEqual({ "Pet?": "Dog" });
  });

  test("1 question single + Other → Other digit, text, Enter, no review", () => {
    const { keys, expected } = keysFor([q("Pet?", false, "Cat", "Dog")], [ans(0, [], "Hamster 2")]);
    expect(keys).toEqual(["3", "Hamster 2", "\r"]);
    expect(expected).toEqual({ "Pet?": "Hamster 2" });
  });

  test("1 question multi + Other → toggles, Down×n, text, Down, Enter, review submit", () => {
    const { keys, expected } = keysFor(
      [q("Pick fruit?", true, "Apple", "Pear")],
      [ans(0, [1], "Kiwi")],
    );
    expect(keys).toEqual(["2", "3", D, D, "Kiwi", D, "\r", "1"]);
    expect(expected).toEqual({ "Pick fruit?": "Pear, Kiwi" });
  });

  test("2 questions single + multi", () => {
    const { keys, expected } = keysFor(
      [q("Color?", false, "Red", "Blue"), q("Tops?", true, "Cheese", "Ham")],
      [ans(0, [1]), ans(1, [0, 1])],
    );
    expect(keys).toEqual([D, "\r", "1", "2", D, D, D, "\r", "1"]);
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
      D,
      "\r",
      "1",
      "3",
      D,
      D,
      D,
      D,
      "\r",
      "2",
      "3",
      D,
      D,
      "Juice",
      D,
      "\r",
      "\r",
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

test("preview question typed by index, first option needs Enter only", () => {
  const parsed = parseAskInput({
    questions: [
      q("Plain?", false, "A1", "A2", "A3", "A4"),
      {
        question: "Preview?",
        header: "P",
        multiSelect: false,
        options: [
          { label: "B1", description: "", preview: "one" },
          { label: "B2", description: "", preview: "two" },
        ],
      },
      q("Third?", false, "C1", "C2"),
      q("Multi?", true, "D1", "D2"),
    ],
  })!;
  const { keys, expected } = keysFor(parsed, [ans(0, [3]), ans(1, [1]), ans(2, [0]), ans(3, [1])]);
  expect(keys).toEqual([D, D, D, "\r", D, "\r", "\r", "2", D, D, D, "\r", "1"]);
  expect(expected).toEqual({
    "Plain?": "A4",
    "Preview?": "B2",
    "Third?": "C1",
    "Multi?": "D2",
  });
});

describe("expectedAskAnswers quoting (measured on Claude Code 2.1.316)", () => {
  const expectFor = (labels: string[], picked: number[], text?: string) =>
    expectedAskAnswers(resolveAskAnswers([q("Q?", true, ...labels)], [ans(0, picked, text)])!)[
      "Q?"
    ];

  test.each([
    [["a, b", "c"], [0], undefined, '"a, b"'],
    [['say "hi"', "plain"], [0, 1], undefined, '"say \\"hi\\"", plain'],
    [["p\\q, r", "plain\\s"], [0, 1], undefined, '"p\\\\q, r", plain\\s'],
    [["one", "two"], [0], "x, y", 'one, "x, y"'],
    [["one", "two"], [], "x, y", '"x, y"'],
  ] as [string[], number[], string | undefined, string][])(
    "%j %j %j",
    (labels, picked, text, measured) => {
      expect(expectFor(labels, picked, text)).toBe(measured);
      expect(askAnswersMatch({ "Q?": expectFor(labels, picked, text)! }, { "Q?": measured })).toBe(
        true,
      );
    },
  );

  test("single-select stays raw", () => {
    const resolved = resolveAskAnswers([q("Q?", false, "a, b", "c")], [ans(0, [0])])!;
    expect(expectedAskAnswers(resolved)).toEqual({ "Q?": "a, b" });
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
  test("a preview question rejects Other text", () => {
    const preview = parseAskInput({
      questions: [
        {
          question: "P?",
          options: [
            { label: "x", preview: "drawing" },
            { label: "y", preview: "drawing" },
          ],
        },
      ],
    })!;
    expect(resolveAskAnswers(preview, [ans(0, [], "mine")])).toBeNull();
    expect(resolveAskAnswers(preview, [ans(0, [1])])?.[0]?.optionIndices).toEqual([1]);
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

test("Codex freeform and disabled Other validate against the server question", () => {
  const freeform = {
    question: "Note?",
    header: "",
    options: [],
    multiSelect: false,
    kind: "freeform" as const,
    allowOther: false,
  };
  expect(
    resolveAskAnswers([freeform], [{ blockId: "q", questionId: "0", text: "hello" }])?.[0]?.other,
  ).toBe("hello");
  const choice = {
    ...freeform,
    kind: "single" as const,
    options: [
      { label: "Yes", description: "" },
      { label: "No", description: "" },
    ],
  };
  expect(
    resolveAskAnswers([choice], [{ blockId: "q", questionId: "0", text: "not offered" }]),
  ).toBeNull();
});

test("Codex partial answers preserve the original question id", () => {
  const q = {
    id: "1",
    question: "Second?",
    header: "",
    options: [
      { label: "A", description: "" },
      { label: "B", description: "" },
    ],
    multiSelect: false,
  };
  expect(
    resolveAskAnswers([q], [{ blockId: "q", questionId: "0", optionIndices: [0] }]),
  ).toBeNull();
  expect(
    resolveAskAnswers([q], [{ blockId: "q", questionId: "1", optionIndices: [1] }])?.[0]
      ?.optionIndices,
  ).toEqual([1]);
});
