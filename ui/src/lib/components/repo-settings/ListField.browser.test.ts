import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../../app.css";
import { checkEgressHost } from "#lib/list-entries.js";
import ListField, { type ListItemWarning } from "./ListField.svelte";

const errors = {
  empty: () => "empty",
  invalid: () => "invalid",
  duplicate: () => "duplicate",
};

const warn = (item: string): ListItemWarning | null =>
  ["abc.ngrok.io", "x.ngrok.io"].includes(item)
    ? {
        text: "risky host",
        label: `${item} is risky`,
        explanation: { title: "t", summary: "s", sections: [] },
      }
    : null;

function setup(props: { items?: string[]; withWarn?: boolean } = {}) {
  const onchange = vi.fn();
  render(ListField<"empty" | "invalid" | "duplicate">, {
    field: "egressExtraHosts",
    name: "Hosts",
    items: props.items ?? [],
    check: checkEgressHost,
    errors,
    placeholder: "host",
    addLabel: "Add",
    addAnywayLabel: "Add anyway",
    removeLabel: (h: string) => `Remove ${h}`,
    warn: props.withWarn === false ? undefined : warn,
    onchange,
  });
  return onchange;
}

const input = () => page.getByRole("textbox", { name: "Hosts" });

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ListField warnings", () => {
  it("takes a second submit to add a warned entry", async () => {
    const onchange = setup();
    await input().fill("abc.ngrok.io");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    expect(onchange).not.toHaveBeenCalled();
    await expect.element(page.getByRole("status")).toHaveTextContent("risky host");
    await page.getByRole("button", { name: "Add anyway" }).click();
    expect(onchange).toHaveBeenCalledWith(["abc.ngrok.io"]);
  });

  it("editing the entry clears the pending warning", async () => {
    const onchange = setup();
    await input().fill("abc.ngrok.io");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Add anyway" })).toBeVisible();
    await userEvent.type(input(), "x");
    await expect.element(page.getByRole("button", { name: "Add", exact: true })).toBeVisible();
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(onchange).not.toHaveBeenCalled();
  });

  it("adds an unwarned entry at once and marks listed warned entries", async () => {
    const onchange = setup({ items: ["x.ngrok.io"] });
    await expect.element(page.getByRole("button", { name: "x.ngrok.io is risky" })).toBeVisible();
    await input().fill("registry.npmjs.org");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    expect(onchange).toHaveBeenCalledWith(["x.ngrok.io", "registry.npmjs.org"]);
  });

  it("without warn, behaves as before", async () => {
    const onchange = setup({ withWarn: false, items: ["x.ngrok.io"] });
    expect(document.querySelector(".item-warn")).toBeNull();
    await input().fill("abc.ngrok.io");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    expect(onchange).toHaveBeenCalledWith(["x.ngrok.io", "abc.ngrok.io"]);
  });
});
