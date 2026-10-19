import { describe, it, expect, vi, afterEach } from "vitest";
import type { ComponentProps } from "svelte";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { m } from "#lib/paraglide/messages.js";
import type { Session, SessionStatus } from "#lib/types.js";
import TopBarAssist from "./TopBarAssist.svelte";

type Props = ComponentProps<typeof TopBarAssist>;

const row = (status: SessionStatus) => ({ id: "oa", status }) as Session;

function props(over: Partial<Props> = {}): Props {
  return {
    assistant: null,
    open: false,
    compact: false,
    workingBlocked: {},
    backgroundBusy: {},
    onclick: vi.fn(),
    ...over,
  };
}

const pip = () => document.querySelector<HTMLElement>("[data-pip]");

afterEach(() => {
  document.body.innerHTML = "";
});

describe("TopBarAssist", () => {
  it("toggles through onclick and reports its pressed state", async () => {
    const onclick = vi.fn();
    const view = await render(TopBarAssist, props({ onclick }));
    const btn = page.getByRole("button", { name: m.operator_assistant_title() });
    await expect.element(btn).toHaveAttribute("aria-pressed", "false");
    await expect.element(btn).toHaveTextContent(m.topbar_assist());
    await btn.click();
    expect(onclick).toHaveBeenCalledOnce();

    await view.rerender(props({ open: true }));
    await expect.element(btn).toHaveAttribute("aria-pressed", "true");
    await expect.element(btn).toHaveClass(/\bon\b/);
  });

  it("drops the label when compact but keeps its name", async () => {
    render(TopBarAssist, props({ compact: true }));
    const btn = page.getByRole("button", { name: m.operator_assistant_title() });
    await expect.element(btn).toBeVisible();
    expect(btn.element().textContent?.trim()).toBe("");
  });

  it("shows no pip at rest, without an assistant, or while it waits at its prompt", async () => {
    const view = await render(TopBarAssist, props());
    expect(pip()).toBeNull();
    for (const status of ["idle", "done"] as const) {
      await view.rerender(props({ assistant: row(status) }));
      expect(pip(), status).toBeNull();
    }
  });

  it("lights amber while the assistant works and names it", async () => {
    render(TopBarAssist, props({ assistant: row("running") }));
    await expect
      .element(page.getByRole("button", { name: m.topbar_assist_working() }))
      .toBeInTheDocument();
    expect(pip()?.dataset.pip).toBe("working");
  });

  it("lights red while a command waits for approval, amber once it resumes mid-turn", async () => {
    const view = await render(TopBarAssist, props({ assistant: row("blocked") }));
    await expect
      .element(page.getByRole("button", { name: m.topbar_assist_blocked() }))
      .toBeInTheDocument();
    expect(pip()?.dataset.pip).toBe("blocked");

    // herdr's latched "blocked" after an answered prompt is display-working (display-status.ts)
    await view.rerender(props({ assistant: row("blocked"), workingBlocked: { oa: true } }));
    await vi.waitFor(() => expect(pip()?.dataset.pip).toBe("working"));
  });

  it("counts repo assistants beside the global one, with the most urgent pip of all", async () => {
    const global = row("idle");
    const repo = { ...row("blocked"), id: "oa-r", assistantRepo: "/p/a" } as Session;
    const view = await render(TopBarAssist, props({ assistant: global, assistants: [global] }));
    expect(document.querySelector(".assist-count")).toBeNull();
    expect(pip()).toBeNull();

    await view.rerender(props({ assistant: global, assistants: [global, repo] }));
    await vi.waitFor(() => expect(document.querySelector(".assist-count")?.textContent).toBe("2"));
    expect(pip()?.dataset.pip).toBe("blocked");
    await expect
      .element(
        page.getByRole("button", {
          name: m.topbar_assist_count({ label: m.topbar_assist_blocked(), count: 2 }),
        }),
      )
      .toBeInTheDocument();
  });
});
