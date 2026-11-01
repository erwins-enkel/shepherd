// The filterable plugin-ui list nodes: `multi-select`, searchable `select` and `action-list`.
// Asserts on what reaches the plugin (the submitted body, the POST), plus the two ways a list
// can lose an operator's work: a republish remounting it, and Escape closing the Settings sheet.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { userEvent } from "vitest/browser";
import { tick } from "svelte";
import "../../app.css";
import { m } from "#lib/paraglide/messages.js";
import { toasts } from "#lib/toasts.svelte.js";
import PluginUIRoot from "./PluginUIRoot.svelte";
import type { PluginUINode } from "#lib/types.js";

const ROUTE = { method: "POST", path: "repo/add" };
const repos = (...names: string[]) => names.map((n) => ({ value: `/r/${n}`, label: `acme/${n}` }));
const MANY = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];

const multi = (options = repos(...MANY)): PluginUINode => ({
  type: "multi-select",
  props: { name: "addRepos", label: "Repository", options },
});
const search = (options = repos(...MANY)): PluginUINode => ({
  type: "select",
  props: { name: "mapRepo", label: "Repository", searchable: true, options },
});
const view = (...children: PluginUINode[]): PluginUINode => ({
  type: "stack",
  children: [
    ...children,
    { type: "action-button", props: { label: "Add", submit: true, route: ROUTE } },
  ],
});

const clearToasts = () => [...toasts.items].forEach((t) => toasts.close(t.id));

let bodies: unknown[] = [];
let respond: () => Response = () => new Response("", { status: 200 });

beforeEach(() => {
  bodies = [];
  respond = () => new Response("", { status: 200 });
  clearToasts();
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(init?.body === undefined ? undefined : JSON.parse(init.body as string));
    return respond();
  }) as unknown as typeof fetch;
});

async function save(container: HTMLElement): Promise<unknown> {
  const button = container.querySelector(".pui-action") as HTMLButtonElement;
  const before = bodies.length;
  button.click();
  await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(before));
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  return bodies[bodies.length - 1];
}

const row = (c: HTMLElement, label: string) =>
  [...c.querySelectorAll<HTMLElement>('[role="option"]')].find((r) =>
    r.textContent?.includes(label),
  )!;
const labels = (c: HTMLElement) =>
  [...c.querySelectorAll('[role="option"]')].map((r) => r.textContent?.trim());
const filterOf = (c: HTMLElement) => c.querySelector('input[role="combobox"]') as HTMLInputElement;

function type(el: HTMLInputElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("multi-select", () => {
  it("shows why when the plugin refuses an Add with nothing picked", async () => {
    respond = () => new Response("Pick at least one repository.", { status: 400 });
    const { container } = await render(PluginUIRoot, { pluginId: "p", node: view(multi()) });
    await save(container);
    await vi.waitFor(() =>
      expect(toasts.items.some((t) => t.text === "Pick at least one repository.")).toBe(true),
    );
  });

  it("submits every picked row as a string[], in one POST", async () => {
    const { container } = await render(PluginUIRoot, { pluginId: "p", node: view(multi()) });
    row(container, "alpha").click();
    row(container, "gamma").click();
    await tick();
    expect(await save(container)).toEqual({ addRepos: ["/r/alpha", "/r/gamma"] });
    expect(container.textContent).toContain(m.plugin_ui_list_picked({ count: 2 }));
  });

  it("untoggles a row, and keeps picks the filter hides", async () => {
    const { container } = await render(PluginUIRoot, { pluginId: "p", node: view(multi()) });
    row(container, "alpha").click();
    row(container, "beta").click();
    await tick();
    row(container, "beta").click();
    await tick();
    type(filterOf(container), "gamma");
    await tick();
    expect(labels(container)).toEqual(["acme/gamma"]);
    expect(await save(container)).toEqual({ addRepos: ["/r/alpha"] });
  });

  it("drops picks when a republish removes them, and keeps the rest", async () => {
    const { container, rerender } = await render(PluginUIRoot, {
      pluginId: "p",
      node: view(multi()),
    });
    row(container, "alpha").click();
    row(container, "beta").click();
    await tick();
    await rerender({ pluginId: "p", node: view(multi(repos("beta", "gamma"))) });
    await tick();
    expect(await save(container)).toEqual({ addRepos: ["/r/beta"] });
  });

  it("keeps picks and filter text when a row opens above it", async () => {
    const list: PluginUINode = {
      type: "action-list",
      props: {
        param: "repo",
        route: { method: "POST", path: "repo/open" },
        items: repos("watched").map((r) => ({ ...r, current: false })),
      },
    };
    // The panels' shape: the watched section is one stack, so the picker's index never moves.
    const panel = (open: boolean) =>
      view(
        {
          type: "stack",
          children: [list, ...(open ? [{ type: "text-input", props: { name: "f" } }] : [])],
        },
        multi(),
      );
    const { container, rerender } = await render(PluginUIRoot, {
      pluginId: "p",
      node: panel(false),
    });
    row(container, "alpha").click();
    type(filterOf(container), "alp");
    await tick();
    await rerender({ pluginId: "p", node: panel(true) });
    await tick();
    expect(filterOf(container).value).toBe("alp");
    expect(((await save(container)) as { addRepos: string[] }).addRepos).toEqual(["/r/alpha"]);
  });

  it("drives the cursor from the filter with arrows and Enter", async () => {
    const { container } = await render(PluginUIRoot, { pluginId: "p", node: view(multi()) });
    filterOf(container).focus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await tick();
    expect(await save(container)).toEqual({ addRepos: ["/r/beta"] });
  });

  it("hides the filter on a short list, which then takes the keyboard itself", async () => {
    const { container } = await render(PluginUIRoot, {
      pluginId: "p",
      node: view(multi(repos("alpha", "beta"))),
    });
    expect(filterOf(container)).toBeNull();
    (container.querySelector('[role="listbox"]') as HTMLElement).focus();
    await userEvent.keyboard("{ArrowDown} ");
    await tick();
    expect(await save(container)).toEqual({ addRepos: ["/r/beta"] });
  });

  it("matches the hidden value too, so a folder name finds a differently named slug", async () => {
    const { container } = await render(PluginUIRoot, {
      pluginId: "p",
      node: view(multi([...repos(...MANY), { value: "/src/old-folder", label: "acme/renamed" }])),
    });
    type(filterOf(container), "old-folder");
    await tick();
    expect(labels(container)).toEqual(["acme/renamed"]);
  });

  it("doesn't match the root every repo path shares", async () => {
    const options = [...MANY, "old-folder"].map((n) => ({
      value: `/home/patrick/Work/${n}`,
      label: `acme/${n === "old-folder" ? "renamed" : n}`,
    }));
    const { container } = await render(PluginUIRoot, { pluginId: "p", node: view(multi(options)) });
    type(filterOf(container), "patrick");
    await tick();
    expect(labels(container)).toEqual([]);
    type(filterOf(container), "old-folder");
    await tick();
    expect(labels(container)).toEqual(["acme/renamed"]);
  });

  it("says so when nothing matches", async () => {
    const { container } = await render(PluginUIRoot, { pluginId: "p", node: view(multi()) });
    type(filterOf(container), "zzzzzz");
    await tick();
    expect(container.textContent).toContain(m.plugin_ui_list_no_matches());
  });
});

describe("Escape in a list filter", () => {
  // a11yDialog's listener is native and on an ancestor, and skips a defaultPrevented event.
  async function mount() {
    const { container } = await render(PluginUIRoot, { pluginId: "p", node: view(multi()) });
    const seen: boolean[] = [];
    container.addEventListener("keydown", (e) => {
      if (e.key === "Escape") seen.push(e.defaultPrevented);
    });
    return { container, seen };
  }

  it("clears the text and leaves the sheet open when the filter has text", async () => {
    const { container, seen } = await mount();
    const filter = filterOf(container);
    filter.focus();
    await userEvent.keyboard("alp");
    await userEvent.keyboard("{Escape}");
    await tick();
    expect(seen).toEqual([true]);
    expect(filter.value).toBe("");
  });

  it("falls through to close the sheet when the filter is empty", async () => {
    const { container, seen } = await mount();
    filterOf(container).focus();
    await userEvent.keyboard("{Escape}");
    expect(seen).toEqual([false]);
  });
});

describe("searchable select", () => {
  it("starts empty and submits the picked row", async () => {
    const { container } = await render(PluginUIRoot, { pluginId: "p", node: view(search()) });
    expect(await save(container)).toEqual({ mapRepo: "" });
    row(container, "beta").click();
    await tick();
    expect(await save(container)).toEqual({ mapRepo: "/r/beta" });
  });

  it("clears when a republish removes the picked option", async () => {
    const { container, rerender } = await render(PluginUIRoot, {
      pluginId: "p",
      node: view(search()),
    });
    row(container, "alpha").click();
    await tick();
    await rerender({ pluginId: "p", node: view(search(repos("beta", "gamma"))) });
    await tick();
    expect(await save(container)).toEqual({ mapRepo: "" });
  });

  it("leaves a plain select seeding its first option", async () => {
    const { container } = await render(PluginUIRoot, {
      pluginId: "p",
      node: view({ type: "select", props: { name: "s", options: repos("alpha", "beta") } }),
    });
    expect(container.querySelector("select")).not.toBeNull();
    expect(await save(container)).toEqual({ s: "/r/alpha" });
  });
});

describe("action-list", () => {
  const list = (current = "/r/a"): PluginUINode => ({
    type: "action-list",
    props: {
      label: "Repositories",
      param: "repo",
      route: { method: "POST", path: "repo/open" },
      items: [
        { value: "/r/a", label: "acme/a", meta: "watching", current: current === "/r/a" },
        { value: "/r/b", label: "acme/b", meta: "off", current: current === "/r/b" },
      ],
    },
  });

  it("POSTs { [param]: value } on a row click and marks the current row", async () => {
    const { container } = await render(PluginUIRoot, { pluginId: "p", node: list() });
    expect(row(container, "acme/a").getAttribute("aria-selected")).toBe("true");
    expect(row(container, "acme/b").getAttribute("aria-selected")).toBe("false");
    expect(row(container, "acme/b").textContent).toContain("off");
    row(container, "acme/b").click();
    await vi.waitFor(() => expect(bodies).toEqual([{ repo: "/r/b" }]));
  });

  it("toasts a 4xx refusal's own text, and stays generic on a 5xx", async () => {
    const { container } = await render(PluginUIRoot, { pluginId: "p", node: list() });
    respond = () => new Response("Unknown repository.", { status: 400 });
    row(container, "acme/b").click();
    await vi.waitFor(() =>
      expect(toasts.items.some((t) => t.text === "Unknown repository.")).toBe(true),
    );
    clearToasts();
    respond = () => new Response("stack trace", { status: 500 });
    row(container, "acme/b").click();
    await vi.waitFor(() =>
      expect(toasts.items.some((t) => t.text === m.plugin_action_failed())).toBe(true),
    );
    expect(toasts.items.some((t) => t.text === "stack trace")).toBe(false);
  });

  it("stays inert without a plugin id", async () => {
    const { container } = await render(PluginUIRoot, { pluginId: "", node: list() });
    row(container, "acme/b").click();
    await tick();
    expect(bodies).toEqual([]);
  });

  it("refuses a route outside the plugin's namespace", async () => {
    const bad: PluginUINode = {
      type: "action-list",
      props: { ...list().props, route: { method: "POST", path: "../x" } },
    };
    const { container } = await render(PluginUIRoot, { pluginId: "p", node: bad });
    row(container, "acme/b").click();
    await tick();
    expect(bodies).toEqual([]);
  });
});
