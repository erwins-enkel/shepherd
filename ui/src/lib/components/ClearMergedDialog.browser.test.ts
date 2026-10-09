import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import ClearMergedDialog from "./ClearMergedDialog.svelte";
import type { Session } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

const s = (id: string, repo: string) =>
  ({ id, desig: `TASK-${id}`, name: `task-${id}`, repoPath: `/p/${repo}` }) as Session;

// Two merged sessions in the filtered repo, three in repos the filter hides.
const sessions = [
  s("h1", "hunde-frontend"),
  s("x1", "shepherd"),
  s("h2", "hunde-frontend"),
  s("x2", "shepherd"),
  s("b1", "BarTab"),
];

function renderDialog(overrides: Partial<Parameters<typeof ClearMergedDialog>[1]> = {}) {
  const props = {
    sessions,
    leftovers: {},
    probesUnavailable: false,
    repoFilter: new Set(["/p/hunde-frontend"]),
    onclose: vi.fn(),
    onconfirm: vi.fn(),
    ...overrides,
  };
  render(ClearMergedDialog, props);
  return props;
}

beforeEach(async () => {
  await page.viewport(1280, 900);
});

describe("ClearMergedDialog under a repo filter", () => {
  it("decommissions only the merged sessions the filter shows by default", async () => {
    const props = renderDialog();
    await expect
      .element(page.getByText(m.clearmerged_scoped_desc({ repo: "hunde-frontend", count: 2 })))
      .toBeVisible();
    await page.getByRole("button", { name: m.clearmerged_confirm({ count: 2 }) }).click();
    expect(props.onconfirm).toHaveBeenCalledWith(["h1", "h2"]);
  });

  it("summarizes the hidden repos and lists their sessions only when unfolded", async () => {
    renderDialog();
    const disclosure = page.getByRole("button", { name: m.clearmerged_outside({ count: 3 }) });
    await expect.element(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect.element(page.getByText("shepherd 2 · BarTab 1")).toBeVisible();
    expect(page.getByText("task-x1", { exact: true }).elements()).toHaveLength(0);

    await disclosure.click();
    await expect.element(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect.element(page.getByText("task-x1", { exact: true })).toBeVisible();
  });

  it("offers a separate action that decommissions every repo's merged sessions", async () => {
    const props = renderDialog();
    await page.getByRole("button", { name: m.clearmerged_confirm_all({ count: 5 }) }).click();
    expect(props.onconfirm).toHaveBeenCalledWith(["h1", "x1", "h2", "x2", "b1"]);
  });

  it("relabels the hidden repos as decommissioned too while the all action is hovered", async () => {
    renderDialog();
    await userEvent.hover(
      page.getByRole("button", { name: m.clearmerged_confirm_all({ count: 5 }) }),
    );
    await expect
      .element(page.getByRole("button", { name: m.clearmerged_outside_armed({ count: 3 }) }))
      .toBeVisible();
  });

  it("counts leftovers separately for the filtered and the hidden sessions", async () => {
    renderDialog({ leftovers: { h1: 2, x1: 3, b1: 1 } });
    await expect.element(page.getByText(m.clearmerged_leftovers({ count: 2 }))).toBeVisible();
    await expect
      .element(page.getByText(m.clearmerged_outside_leftovers({ count: 4 })))
      .toBeVisible();
  });
});

describe("ClearMergedDialog without anything hidden", () => {
  it("clears every merged session with one action when the herd is unfiltered", async () => {
    const props = renderDialog({ repoFilter: new Set() });
    await expect.element(page.getByText(m.clearmerged_desc({ count: 5 }))).toBeVisible();
    expect(
      page.getByRole("button", { name: m.clearmerged_confirm_all({ count: 5 }) }).elements(),
    ).toHaveLength(0);
    await page.getByRole("button", { name: m.clearmerged_confirm({ count: 5 }) }).click();
    expect(props.onconfirm).toHaveBeenCalledWith(["h1", "x1", "h2", "x2", "b1"]);
  });

  it("keeps the plain layout when the filter already covers every merged session", async () => {
    renderDialog({ sessions: [sessions[0]!, sessions[2]!] });
    await expect.element(page.getByText(m.clearmerged_desc({ count: 2 }))).toBeVisible();
    expect(page.getByText(m.clearmerged_outside({ count: 0 })).elements()).toHaveLength(0);
  });
});
