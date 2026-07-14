import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import InfoTipsForceHarness from "./InfoTipsForceHarness.test.svelte";
import { infoTips } from "$lib/info-tips.svelte";

afterEach(() => infoTips.set(false));

// The /design-system route sets INFO_TIPS_FORCE so its component catalogue always shows the
// real affordances — a specimen that vanished based on the viewer's personal preference would
// make the reference lie. This harness reproduces that setContext exactly.
describe("INFO_TIPS_FORCE — design-system catalogue exemption", () => {
  it("renders InfoTip and the glossary term even while the preference hides them", async () => {
    infoTips.set(true);
    render(InfoTipsForceHarness);

    await expect.element(page.getByRole("button", { name: "What this does" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "epic" })).toBeInTheDocument();
    expect(document.querySelectorAll(".gloss-term").length).toBeGreaterThan(0);
  });
});
