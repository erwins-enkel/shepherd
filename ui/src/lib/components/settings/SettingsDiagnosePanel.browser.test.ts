import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { m } from "#lib/paraglide/messages.js";
import type { DiagnosticCheck } from "#lib/types.js";
import SettingsDiagnosePanel from "./SettingsDiagnosePanel.svelte";

const herdrDown: DiagnosticCheck = {
  id: "herdr",
  state: "error",
  hintKey: "diagnostics_hint_herdr_missing",
};

describe("SettingsDiagnosePanel — Ask the assistant (#1446)", () => {
  it("asks about a failing check with a question naming it as displayed", async () => {
    const onaskassistant = vi.fn();
    render(SettingsDiagnosePanel, { initialDiagnostics: [herdrDown], onaskassistant });
    await page.getByRole("button", { name: m.operator_assistant_ask() }).click();
    expect(onaskassistant).toHaveBeenCalledExactlyOnceWith(
      m.operator_assistant_ask_check({
        check: m.diagnostics_label_herdr(),
        state: m.diagnostics_state_error(),
      }),
    );
  });

  it("offers no Ask without the page's callback", async () => {
    render(SettingsDiagnosePanel, { initialDiagnostics: [herdrDown] });
    await expect
      .element(page.getByText(m.diagnostics_label_herdr(), { exact: true }))
      .toBeVisible();
    expect(page.getByRole("button", { name: m.operator_assistant_ask() }).query()).toBeNull();
  });
});
