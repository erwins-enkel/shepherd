import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import ModelCliPicker from "./ModelCliPicker.svelte";

function select(id: string, value: string) {
  const element = document.querySelector<HTMLSelectElement>(id)!;
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

const modelSelect = () => document.querySelector<HTMLSelectElement>("#mcp-model")!;

describe("ModelCliPicker Codex choices", () => {
  it.each([false, true])(
    "keeps the previous provider-switch fallback with handoff %s",
    async (handoff) => {
      const onconfirm = vi.fn();
      render(ModelCliPicker, {
        x: 0,
        y: 0,
        title: "Choose model",
        confirmLabel: "Confirm choice",
        fableAvailable: true,
        initialProvider: "claude",
        initialModel: "opus",
        handoff,
        onconfirm,
        onclose: vi.fn(),
      });
      await expect.poll(() => modelSelect().value).toBe("opus");
      select("#mcp-provider", "codex");
      await expect.poll(() => modelSelect().value).toBe("gpt-6.1-sol");
      await page.getByRole("button", { name: "Confirm choice" }).click();
      expect(onconfirm).toHaveBeenCalledExactlyOnceWith({
        agentProvider: "codex",
        model: "gpt-6.1-sol",
        effort: null,
        ...(handoff ? { handoffMode: "resume" } : {}),
      });
    },
  );

  it.each(["gpt-6.2-sol", "gpt-6.2-astra"])(
    "confirms an explicit %s selection with ultra",
    async (model) => {
      const onconfirm = vi.fn();
      render(ModelCliPicker, {
        x: 0,
        y: 0,
        title: "Choose model",
        confirmLabel: "Confirm choice",
        fableAvailable: true,
        initialProvider: "codex",
        initialModel: "gpt-6.1-sol",
        onconfirm,
        onclose: vi.fn(),
      });
      await expect
        .poll(() => Array.from(modelSelect().options).map((option) => option.value))
        .toContain(model);
      select("#mcp-model", model);
      await expect
        .poll(() =>
          Array.from(document.querySelector<HTMLSelectElement>("#mcp-effort")!.options).map(
            (option) => option.value,
          ),
        )
        .toContain("ultra");
      select("#mcp-effort", "ultra");
      await page.getByRole("button", { name: "Confirm choice" }).click();
      expect(onconfirm).toHaveBeenCalledExactlyOnceWith({
        agentProvider: "codex",
        model,
        effort: "ultra",
      });
    },
  );
});
