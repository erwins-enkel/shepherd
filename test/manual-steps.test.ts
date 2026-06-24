import { test, expect, describe } from "bun:test";
import { parseManualSteps } from "../src/manual-steps";

const block = (lines: string) => "Some PR prose.\n\n```shepherd:manual-steps\n" + lines + "\n```\n";

describe("parseManualSteps — manual-operator-step carrier parsing (#1059)", () => {
  test("empty / falsy body → []", () => {
    expect(parseManualSteps("")).toEqual([]);
    expect(parseManualSteps("just prose, no carrier")).toEqual([]);
  });

  test("fenced block: each task line → a step, order preserved", () => {
    const body = block(
      "- [ ] Set FLOWAGENT_WORKER_CONCURRENCY=4 in prod env\n- [x] Run `bun run backfill` once after deploy",
    );
    expect(parseManualSteps(body)).toEqual([
      { id: "ms1", text: "Set FLOWAGENT_WORKER_CONCURRENCY=4 in prod env", postMerge: false },
      { id: "ms2", text: "Run `bun run backfill` once after deploy", postMerge: false },
    ]);
  });

  test("POST-MERGE prefix (case-insensitive) sets postMerge + is stripped", () => {
    const body = block(
      "- [ ] POST-MERGE: rotate the webhook secret\n- [ ] post-merge: restart worker",
    );
    expect(parseManualSteps(body)).toEqual([
      { id: "ms1", text: "rotate the webhook secret", postMerge: true },
      { id: "ms2", text: "restart worker", postMerge: true },
    ]);
  });

  test("non-list lines inside the fence are ignored", () => {
    const body = block("Here are the steps:\n- [ ] do the thing\nthanks!");
    expect(parseManualSteps(body)).toEqual([{ id: "ms1", text: "do the thing", postMerge: false }]);
  });

  test("empty task line (no text) is skipped", () => {
    const body = block("- [ ] \n- [ ] real step");
    expect(parseManualSteps(body)).toEqual([{ id: "ms1", text: "real step", postMerge: false }]);
  });

  test("Manual-Step: trailer lines (column-0 anchored) are parsed", () => {
    const body =
      "PR body\n\nManual-Step: set the env var\nManual-Step: POST-MERGE: flip the flag\n";
    expect(parseManualSteps(body)).toEqual([
      { id: "ms1", text: "set the env var", postMerge: false },
      { id: "ms2", text: "flip the flag", postMerge: true },
    ]);
  });

  test("quoted / indented / blockquoted Manual-Step: lines must NOT match", () => {
    const body = [
      "Note: a reviewer wrote `Manual-Step: do X` inline.",
      "> Manual-Step: this is quoted in a blockquote",
      "   Manual-Step: this is indented",
      "see Manual-Step: in the middle of a sentence",
    ].join("\n");
    expect(parseManualSteps(body)).toEqual([]);
  });

  test("merge + dedupe across both sources in normalized space; postMerge OR-ed", () => {
    const body =
      block("- [ ] Restart the   worker") + "\nManual-Step: POST-MERGE: restart the worker\n"; // same step, whitespace + post-merge differ
    expect(parseManualSteps(body)).toEqual([
      { id: "ms1", text: "Restart the   worker", postMerge: true },
    ]);
  });

  test("malformed: unclosed fence still reads task lines to end of body", () => {
    const body = "intro\n\n```shepherd:manual-steps\n- [ ] orphaned step\n- [ ] second";
    expect(parseManualSteps(body)).toEqual([
      { id: "ms1", text: "orphaned step", postMerge: false },
      { id: "ms2", text: "second", postMerge: false },
    ]);
  });

  test("block + distinct trailer steps both appear, in order", () => {
    const body = block("- [ ] block step") + "\nManual-Step: trailer step\n";
    expect(parseManualSteps(body)).toEqual([
      { id: "ms1", text: "block step", postMerge: false },
      { id: "ms2", text: "trailer step", postMerge: false },
    ]);
  });
});
