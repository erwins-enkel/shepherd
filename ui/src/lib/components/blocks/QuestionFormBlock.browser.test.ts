import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import QuestionFormBlock from "./QuestionFormBlock.svelte";

describe("QuestionFormBlock", () => {
  it("renders single-kind prompt, options as radios, and kind hint", async () => {
    const { container } = render(QuestionFormBlock, {
      block: {
        type: "question-form",
        id: "qf1",
        questions: [
          {
            id: "q1",
            prompt: "Which approach do you prefer?",
            kind: "single",
            options: ["Option A", "Option B"],
          },
        ],
      },
    });
    await expect.element(page.getByText("Which approach do you prefer?")).toBeInTheDocument();
    // kind hint
    await expect.element(page.getByText("Select one")).toBeInTheDocument();
    // radio inputs
    const radios = container.querySelectorAll('input[type="radio"]');
    expect(radios.length).toBe(2);
    await expect.element(page.getByText("Option A")).toBeInTheDocument();
    await expect.element(page.getByText("Option B")).toBeInTheDocument();
  });

  it("renders multi-kind options as checkboxes", async () => {
    const { container } = render(QuestionFormBlock, {
      block: {
        type: "question-form",
        id: "qf2",
        questions: [
          {
            id: "q2",
            prompt: "Select all valid options",
            kind: "multi",
            options: ["Choice X", "Choice Y", "Choice Z"],
          },
        ],
      },
    });
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(3);
    await expect.element(page.getByText("Select all that apply")).toBeInTheDocument();
  });

  it("renders freeform prompt with free-response affordance and no options", async () => {
    const { container } = render(QuestionFormBlock, {
      block: {
        type: "question-form",
        id: "qf3",
        questions: [
          {
            id: "q3",
            prompt: "Describe your reasoning",
            kind: "freeform",
          },
        ],
      },
    });
    await expect.element(page.getByText("Describe your reasoning")).toBeInTheDocument();
    await expect.element(page.getByText("Free response")).toBeInTheDocument();
    // no radio or checkbox inputs for freeform
    const inputs = container.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    expect(inputs.length).toBe(0);
  });

  it("all rendered inputs are disabled", async () => {
    const { container } = render(QuestionFormBlock, {
      block: {
        type: "question-form",
        id: "qf4",
        questions: [
          {
            id: "q4",
            prompt: "Pick one",
            kind: "single",
            options: ["Yes", "No"],
          },
          {
            id: "q5",
            prompt: "Pick many",
            kind: "multi",
            options: ["A", "B"],
          },
        ],
      },
    });
    const allInputs = container.querySelectorAll("input");
    expect(allInputs.length).toBeGreaterThan(0);
    for (const input of allInputs) {
      expect(input.disabled).toBe(true);
    }
  });
});
