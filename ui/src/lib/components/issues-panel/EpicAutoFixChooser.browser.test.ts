import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../../app.css";
import EpicAutoFixChooser from "./EpicAutoFixChooser.svelte";
import type { EpicAutoBlockers } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

const ok = (id: string) => ({ id, ok: true });
const bad = (id: string) => ({ id, ok: false });

// "Behebung" Fall A: Standard + Codex.
const FALL_A: EpicAutoBlockers = {
  causes: [
    { code: "sandbox_interactive", scope: "repo", detail: "standard" },
    { code: "sandbox_provider_unconfined", scope: "epic", detail: "codex" },
  ],
  options: [
    {
      id: "autonomous_claude",
      changes: { sandboxProfile: "autonomous", agentProvider: "claude" },
      enabled: true,
      checks: [ok("bwrap"), ok("egress"), ok("remote_https")],
    },
    { id: "trusted", changes: { sandboxProfile: "trusted" }, enabled: true, checks: [] },
    {
      id: "autonomous",
      changes: { sandboxProfile: "autonomous" },
      enabled: false,
      why: "cli",
      checks: [bad("cli"), ok("bwrap"), ok("egress"), ok("remote_https")],
    },
  ],
  preselect: "autonomous_claude",
};

// "Behebung" Fall C: bubblewrap missing and an SSH remote — Trusted is the only way.
const FALL_C: EpicAutoBlockers = {
  causes: [
    { code: "sandbox_interactive", scope: "repo", detail: "standard" },
    { code: "sandbox_backend_unavailable", scope: "host", detail: "standard" },
  ],
  options: [
    {
      id: "autonomous",
      changes: { sandboxProfile: "autonomous" },
      enabled: false,
      why: "bwrap",
      checks: [ok("cli"), bad("bwrap"), ok("egress"), bad("remote_https")],
    },
    { id: "trusted", changes: { sandboxProfile: "trusted" }, enabled: true, checks: [] },
  ],
  preselect: "trusted",
};

function mount(blockers: EpicAutoBlockers, onapply = vi.fn()) {
  render(EpicAutoFixChooser, {
    props: { blockers, repoName: "hundesport", applyLabel: m.epic_autofix_apply(), onapply },
  });
  return onapply;
}

const radios = () => page.getByRole("radio").elements() as HTMLInputElement[];
const checkedId = () => radios().find((r) => r.checked)?.value;

describe("EpicAutoFixChooser (#3454)", () => {
  it("Fall A: two causes with scope chips, three ways in a labelled group, one disabled", async () => {
    mount(FALL_A);
    await expect.element(page.getByRole("group", { name: m.epic_autofix_legend() })).toBeVisible();
    const chips = page.getByRole("button", { name: m.epic_autofix_scope_repo(), exact: true });
    await expect.element(chips).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: m.epic_autofix_scope_epic(), exact: true }))
      .toBeVisible();
    expect(radios()).toHaveLength(3);
    expect(
      radios()
        .filter((r) => r.disabled)
        .map((r) => r.value),
    ).toEqual(["autonomous"]);
    expect(checkedId()).toBe("autonomous_claude");
    await expect
      .element(page.getByText(m.epic_autofix_disabled_cli({ cli: m.agent_provider_codex() })))
      .toBeVisible();
    await expect
      .element(page.getByText(m.epic_autofix_risk_trusted({ repo: "hundesport" })))
      .toBeVisible();
  });

  it("the scope chip carries the REPO/EPIC/HOST explanation and opens it on click", async () => {
    mount(FALL_A);
    const chip = page.getByRole("button", { name: m.epic_autofix_scope_repo(), exact: true });
    expect(chip.element().getAttribute("aria-description")).toContain(
      m.tooltip_autofix_scope_host_body(),
    );
    await chip.click();
    await expect.element(page.getByText(m.tooltip_autofix_scope_title())).toBeVisible();
  });

  it("arrow keys move the choice and skip the disabled way; the focus is visible", async () => {
    const onapply = mount(FALL_A);
    const first = radios()[0]!;
    first.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(checkedId()).toBe("trusted");
    expect(document.activeElement).toBe(radios()[1]);
    await userEvent.keyboard("{ArrowDown}");
    expect(checkedId()).toBe("autonomous_claude"); // wrapped past the disabled one
    await userEvent.keyboard("{ArrowUp}");
    expect(checkedId()).toBe("trusted");
    const focused = document.activeElement as HTMLElement;
    expect(getComputedStyle(focused).outlineStyle).not.toBe("none");
    await page.getByRole("button", { name: m.epic_autofix_apply() }).click();
    expect(onapply).toHaveBeenCalledWith("trusted");
  });

  it("Fall C: Trusted preselected as the only way; Autonomous lists what fails and what to do", async () => {
    const onapply = mount(FALL_C);
    expect(checkedId()).toBe("trusted");
    await expect.element(page.getByText(m.epic_autofix_body_only_way())).toBeVisible();
    await expect.element(page.getByText(m.epic_autofix_check_bwrap_fail())).toBeVisible();
    await expect.element(page.getByText(m.epic_autofix_check_remote_fail())).toBeVisible();
    await expect.element(page.getByText(m.epic_autofix_disabled_host())).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: m.epic_autofix_scope_host(), exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: m.epic_autofix_apply() }).click();
    expect(onapply).toHaveBeenCalledWith("trusted");
  });

  it("waits while an apply is in flight", async () => {
    render(EpicAutoFixChooser, {
      props: {
        blockers: FALL_A,
        repoName: "hundesport",
        applyLabel: m.epic_autofix_apply(),
        busy: true,
        onapply: vi.fn(),
      },
    });
    await expect.element(page.getByRole("button", { name: m.epic_autofix_apply() })).toBeDisabled();
  });
});
