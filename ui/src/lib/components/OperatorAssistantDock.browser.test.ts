import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRawSnippet } from "svelte";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import { m } from "#lib/paraglide/messages.js";
import type { Session } from "#lib/types.js";
import type { AssistantEntry } from "#lib/operator-assistant.svelte.js";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    listRepos: vi.fn(async () => ({
      recentWindowDays: 14,
      repos: [
        { name: "shepherd", path: "/p/shepherd", display: "shepherd", lastUsedAt: 3 },
        { name: "calendar", path: "/p/calendar", display: "calendar", lastUsedAt: 2 },
        { name: "secret", path: "/p/secret", display: "secret", hidden: true },
      ],
    })),
    getSessionMessages: vi.fn(async (id: string) => ({
      messages:
        id === "oa-c"
          ? [{ role: "assistant", text: "Checks are **green**. May I merge?", ts: 5 }]
          : [],
      awaitingInput: false,
      pendingQuestion: null,
      unavailable: null,
    })),
  };
});
const { AssistantLifecycle } = await import("#lib/operator-assistant.svelte.js");
const { default: OperatorAssistantDock } = await import("./OperatorAssistantDock.svelte");

const row = (id: string, assistantRepo: string | null, status = "idle") =>
  ({ id, desig: id, status, assistantRepo, operatorAssistant: true }) as unknown as Session;

const ENTRIES: AssistantEntry[] = [
  { repo: null, session: row("oa-g", null) },
  { repo: "/p/shepherd", session: row("oa-s", "/p/shepherd", "running") },
  { repo: "/p/calendar", session: row("oa-c", "/p/calendar", "blocked") },
];

// The page's panel, reduced to a marker naming the open entry (and whether it got the tabs).
const panel = createRawSnippet((entry: () => AssistantEntry, switcher: () => unknown) => ({
  render: () =>
    `<div data-testid="open-panel" data-repo="${entry().repo ?? "global"}" data-tabs="${switcher() ? "yes" : "no"}"></div>`,
}));

function mount(over: Record<string, unknown> = {}) {
  const props = {
    entries: ENTRIES,
    open: "/p/shepherd",
    lifecycle: new AssistantLifecycle({
      setAssistant: vi.fn(),
      setAssistantUnavailable: vi.fn(),
      dropAssistantScope: vi.fn(),
    }),
    onopen: vi.fn(),
    onstart: vi.fn(),
    onclose: vi.fn(),
    panel,
    ...over,
  };
  return { props, view: render(OperatorAssistantDock, props as never) };
}

/** Waits until the element's text contains every part. */
const textOf = (loc: { element(): Element }, ...parts: string[]) =>
  vi.waitFor(() => {
    for (const p of parts) expect(loc.element().textContent).toContain(p);
  });

const openPanel = () => document.querySelector<HTMLElement>("[data-testid=open-panel]");

beforeEach(async () => {
  await page.viewport(1280, 900);
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("OperatorAssistantDock", () => {
  it("stacks every assistant in a fixed order with one open, the rest as bars", async () => {
    mount();
    await expect.element(page.getByText(m.assistant_dock_count({ count: 3 }))).toBeVisible();
    await vi.waitFor(() => expect(openPanel()?.dataset.repo).toBe("/p/shepherd"));
    const bars = [...document.querySelectorAll(".ab")];
    expect(bars.map((b) => b.getAttribute("aria-label"))).toEqual([
      m.assistant_bar_open({ name: m.operator_assistant_title() }),
      m.assistant_bar_open({ name: "calendar" }),
    ]);
    // The open panel keeps its place between the two bars.
    const order = [...document.querySelectorAll(".oad > *")].map((el) =>
      el.matches("[data-testid=open-panel]")
        ? "panel"
        : (el.className.match(/\b(oad-strip|ab)\b/)?.[1] ?? "?"),
    );
    expect(order).toEqual(["oad-strip", "ab", "panel", "ab"]);
  });

  it("a bar shows its state and newest reply, and opens its assistant", async () => {
    const { props } = mount();
    const bar = page.getByRole("button", { name: m.assistant_bar_open({ name: "calendar" }) });
    await textOf(bar, m.assistant_bar_blocked(), "Checks are green. May I merge?");
    expect(bar.element().querySelector("[data-pip]")?.getAttribute("data-pip")).toBe("blocked");
    await bar.click();
    expect(props.onopen).toHaveBeenCalledWith("/p/calendar");
  });

  it("+ Repo assistant lists the repos, marks running ones and starts the pick", async () => {
    const { props } = mount();
    await page.getByRole("button", { name: m.assistant_dock_add() }).click();
    const menu = page.getByRole("menu", { name: m.assistant_dock_menu_label() });
    await expect.element(menu).toBeVisible();
    const items = menu.getByRole("menuitem");
    await vi.waitFor(() => expect(items.all()).toHaveLength(2));
    await textOf(items.first(), "shepherd", m.assistant_dock_running());
    await expect.element(items.first()).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(items.nth(1)).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(props.onstart).toHaveBeenCalledWith("/p/calendar");
    expect(menu.query()).toBeNull();
  });

  it("Escape closes the menu back onto its button", async () => {
    mount();
    const add = page.getByRole("button", { name: m.assistant_dock_add() });
    await add.click();
    await expect.element(page.getByRole("menu")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(page.getByRole("menu").query()).toBeNull();
    await expect.element(add).toHaveFocus();
  });

  it("closes the dock from its strip", async () => {
    const { props } = mount();
    await page.getByRole("button", { name: m.operator_assistant_close() }).click();
    expect(props.onclose).toHaveBeenCalledOnce();
  });

  it("a lone global assistant still offers + Repo assistant", async () => {
    mount({ entries: [ENTRIES[0]], open: null });
    await expect.element(page.getByText(m.assistant_dock_label())).toBeVisible();
    await expect.element(page.getByRole("button", { name: m.assistant_dock_add() })).toBeVisible();
    await vi.waitFor(() => expect(openPanel()?.dataset.repo).toBe("global"));
  });

  it("on a phone the stack becomes tabs handed to the open panel", async () => {
    await page.viewport(390, 844);
    mount({ mobile: true });
    await vi.waitFor(() => expect(openPanel()?.dataset.tabs).toBe("yes"));
    expect(document.querySelector(".ab")).toBeNull();
  });
});
