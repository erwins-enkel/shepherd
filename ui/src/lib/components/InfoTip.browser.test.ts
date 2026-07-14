import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import InfoTip from "./InfoTip.svelte";
import { infoTips } from "$lib/info-tips.svelte";

afterEach(() => infoTips.set(false));

describe("InfoTip — hide-info-tips preference", () => {
  it("renders the (i) affordance by default (preference off)", async () => {
    render(InfoTip, { text: "Explanation body", label: "What this does" });

    await expect.element(page.getByRole("button", { name: "What this does" })).toBeInTheDocument();
  });

  it("renders nothing at all when the operator hides info tips", async () => {
    infoTips.set(true);
    render(InfoTip, { text: "Explanation body", label: "What this does" });

    // The whole affordance is gone — not merely non-visible. A left-behind button would be
    // a dead control, which is the outcome "remove the affordance entirely" rules out.
    expect(document.querySelectorAll(".info")).toHaveLength(0);
    expect(document.querySelectorAll(".info-tooltip")).toHaveLength(0);
  });

  it("re-renders the affordance when the preference is turned back off", async () => {
    infoTips.set(true);
    render(InfoTip, { text: "Explanation body", label: "What this does" });
    expect(document.querySelectorAll(".info")).toHaveLength(0);

    infoTips.set(false);
    await expect.element(page.getByRole("button", { name: "What this does" })).toBeInTheDocument();
  });
});
