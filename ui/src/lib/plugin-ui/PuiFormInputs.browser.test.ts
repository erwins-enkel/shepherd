// Tests for the plugin-ui input nodes (issue #1961).
//
// Deliberately ONE file for all four node types rather than one per component: what is under
// test is the cross-component FORM-SCOPE CONTRACT — a value typed into any input node reaches
// the body of a `submit: true` action-button under its `name`. Split per component, each file
// would have to rebuild the same button + fetch scaffolding and the contract itself would be
// visible nowhere.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { tick } from "svelte";
import "../../app.css";
import PluginUIRoot from "./PluginUIRoot.svelte";
import PuiTextInput from "./PuiTextInput.svelte";
import type { PluginUINode } from "$lib/types";

const ROUTE = { method: "POST", path: "config" };

/** Mount input nodes plus a submitting Save button inside a PluginUIRoot, exactly as the
 *  Settings panel mounts a published view. */
async function renderForm(children: PluginUINode[], buttonProps: Record<string, unknown> = {}) {
  const node: PluginUINode = {
    type: "stack",
    children: [
      ...children,
      {
        type: "action-button",
        props: { label: "Save", submit: true, route: ROUTE, ...buttonProps },
      },
    ],
  };
  return await render(PluginUIRoot, { pluginId: "bridge", node });
}

let bodies: unknown[] = [];

function mockFetch() {
  bodies = [];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(init?.body === undefined ? undefined : JSON.parse(init.body as string));
    return new Response("saved", { status: 200 });
  }) as unknown as typeof fetch;
}

/** Click Save and resolve once THIS click's POST body has been captured. Waiting on a growth
 *  in `bodies` (not on it being non-empty) is what makes repeated saves in one test honest —
 *  otherwise the second assertion races and reads the previous body back. */
async function save(container: HTMLElement): Promise<unknown> {
  const button = container.querySelector(".pui-action") as HTMLButtonElement;
  const before = bodies.length;
  button.click();
  await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(before));
  // The button disables itself while the POST is in flight; wait for it to settle so a
  // follow-up save in the same test isn't silently swallowed by the disabled state.
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  return bodies[bodies.length - 1];
}

/** Type into a text-like control the way an operator does (fires `input`). */
function type(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("plugin-ui input nodes", () => {
  beforeEach(() => {
    mockFetch();
  });

  it("sends each node type under its name, with the right JS type", async () => {
    const { container } = await renderForm([
      { type: "text-input", props: { name: "relayUrl", label: "Relay URL" } },
      {
        type: "select",
        props: { name: "verbosity", options: [{ value: "quiet" }, { value: "loud" }] },
      },
      { type: "checkbox", props: { name: "relayEvents" } },
      { type: "number", props: { name: "retries" } },
    ]);

    type(container.querySelector(".pui-input") as HTMLInputElement, "wss://relay/buzz");

    const select = container.querySelector("select") as HTMLSelectElement;
    select.value = "loud";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));

    type(container.querySelectorAll("input")[2] as HTMLInputElement, "4");

    expect(await save(container)).toEqual({
      relayUrl: "wss://relay/buzz",
      verbosity: "loud",
      relayEvents: true,
      retries: 4,
    });
  });

  it("seeds fields from the published value, so an untouched form submits current config", async () => {
    const { container } = await renderForm([
      { type: "text-input", props: { name: "relayUrl", value: "wss://seeded" } },
      { type: "checkbox", props: { name: "relayEvents", value: true } },
      { type: "number", props: { name: "retries", value: 3 } },
    ]);

    expect(await save(container)).toEqual({
      relayUrl: "wss://seeded",
      relayEvents: true,
      retries: 3,
    });
  });

  it("merges fields OVER a colliding static body key", async () => {
    const { container } = await renderForm(
      [{ type: "text-input", props: { name: "relayUrl", value: "wss://from-field" } }],
      { body: { section: "relay", relayUrl: "wss://from-body" } },
    );

    expect(await save(container)).toEqual({
      section: "relay",
      relayUrl: "wss://from-field",
    });
  });

  it("a button WITHOUT submit posts only its static body", async () => {
    const { container } = await renderForm(
      [{ type: "text-input", props: { name: "relayUrl", value: "wss://ignored" } }],
      { submit: false, body: { ping: true } },
    );

    expect(await save(container)).toEqual({ ping: true });
  });

  it("number posts null when empty or unparseable, never NaN", async () => {
    const { container } = await renderForm([
      { type: "number", props: { name: "retries", value: 3 } },
    ]);
    const input = container.querySelector(".pui-input") as HTMLInputElement;

    type(input, "");
    expect(await save(container)).toEqual({ retries: null });

    type(input, "abc");
    expect(await save(container)).toEqual({ retries: null });

    type(input, "-2.5");
    expect(await save(container)).toEqual({ retries: -2.5 });
  });

  it("number keeps half-typed input intact (no numeric round-trip clobber)", async () => {
    const { container } = await renderForm([{ type: "number", props: { name: "retries" } }]);
    const input = container.querySelector(".pui-input") as HTMLInputElement;

    // "1." is not a complete number; the control must still show what was typed.
    type(input, "1.");
    await tick();
    expect(input.value).toBe("1.");

    type(input, "1.5");
    expect(await save(container)).toEqual({ retries: 1.5 });
  });

  it("select clamps an unknown or missing seed to the first offered option", async () => {
    const options = [{ value: "quiet", label: "Quiet" }, { value: "loud" }];

    const unknownSeed = await renderForm([
      { type: "select", props: { name: "verbosity", value: "screaming", options } },
    ]);
    expect(await save(unknownSeed.container)).toEqual({ verbosity: "quiet" });

    mockFetch();
    const noSeed = await renderForm([{ type: "select", props: { name: "verbosity", options } }]);
    expect(await save(noSeed.container)).toEqual({ verbosity: "quiet" });
  });

  it("uses the label as the accessible name, falling back to the field name", async () => {
    const { container } = await renderForm([
      { type: "text-input", props: { name: "relayUrl", label: "Relay URL" } },
      { type: "text-input", props: { name: "buzzBin" } },
    ]);
    const [labelled, bare] = [...container.querySelectorAll<HTMLInputElement>(".pui-input")];

    expect(labelled.getAttribute("aria-label")).toBeNull();
    expect(labelled.labels?.[0]?.textContent?.trim()).toBe("Relay URL");
    expect(bare.getAttribute("aria-label")).toBe("buzzBin");
  });

  it("secret renders a masked control (masking only — the value still posts as text)", async () => {
    const { container } = await renderForm([
      { type: "text-input", props: { name: "token", secret: true } },
    ]);
    const input = container.querySelector(".pui-input") as HTMLInputElement;
    expect(input.type).toBe("password");

    type(input, "s3cret");
    expect(await save(container)).toEqual({ token: "s3cret" });
  });

  it("without a form scope (bare mount) the input still edits but contributes nothing", async () => {
    // Rendered directly, NOT via PluginUIRoot — no context, so no scope to register into.
    const { container } = await render(PuiTextInput, {
      node: { type: "text-input", props: { name: "orphan" } },
    });
    const input = container.querySelector(".pui-input") as HTMLInputElement;
    type(input, "typed");
    await tick();
    expect(input.value).toBe("typed");
  });
});

describe("plugin-ui form scope re-seeding", () => {
  beforeEach(() => {
    mockFetch();
  });

  /** Re-render the same PluginUIRoot instance with a new node tree — what a plugin's
   *  `publishUI` does when it refreshes its panel. */
  function form(value: string) {
    return {
      type: "stack",
      children: [
        { type: "text-input", props: { name: "relayUrl", value } },
        { type: "action-button", props: { label: "Save", submit: true, route: ROUTE } },
      ],
    } as PluginUINode;
  }

  it("a re-publish with an UNCHANGED value leaves an in-progress edit alone", async () => {
    const { container, rerender } = await render(PluginUIRoot, {
      pluginId: "bridge",
      node: form("wss://seeded"),
    });
    const input = container.querySelector(".pui-input") as HTMLInputElement;

    type(input, "wss://operator-is-typing");
    // The plugin re-publishes (e.g. a status timer) carrying the same stored value.
    await rerender({ pluginId: "bridge", node: form("wss://seeded") });
    await tick();

    expect(input.value).toBe("wss://operator-is-typing");
    expect(await save(container)).toEqual({ relayUrl: "wss://operator-is-typing" });
  });

  it("a re-publish with a CHANGED value snaps the field to the persisted truth", async () => {
    const { container, rerender } = await render(PluginUIRoot, {
      pluginId: "bridge",
      node: form("wss://seeded"),
    });
    const input = container.querySelector(".pui-input") as HTMLInputElement;

    type(input, "wss://typed");
    await rerender({ pluginId: "bridge", node: form("wss://saved") });
    await tick();

    expect(input.value).toBe("wss://saved");
    expect(await save(container)).toEqual({ relayUrl: "wss://saved" });
  });

  it("a field removed by a later publish stops contributing its key", async () => {
    const withField: PluginUINode = {
      type: "stack",
      children: [
        { type: "text-input", props: { name: "relayUrl", value: "wss://x" } },
        { type: "action-button", props: { label: "Save", submit: true, route: ROUTE } },
      ],
    };
    const withoutField: PluginUINode = {
      type: "stack",
      children: [{ type: "action-button", props: { label: "Save", submit: true, route: ROUTE } }],
    };

    const { container, rerender } = await render(PluginUIRoot, {
      pluginId: "bridge",
      node: withField,
    });
    expect(await save(container)).toEqual({ relayUrl: "wss://x" });

    await rerender({ pluginId: "bridge", node: withoutField });
    await tick();
    expect(await save(container)).toEqual({});
  });
});
