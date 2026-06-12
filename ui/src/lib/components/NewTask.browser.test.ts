import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import NewTask from "./NewTask.svelte";
import { m } from "$lib/paraglide/messages";

afterEach(() => {
  document.body.innerHTML = "";
});

const base = (extra: Record<string, unknown> = {}) => ({
  onsubmit: vi.fn(),
  ...extra,
});

describe("NewTask initialImages seed", () => {
  it("renders a removable chip per seeded image", async () => {
    render(NewTask, {
      props: base({
        initialImages: [
          { path: "/srv/a.png", name: "a.png" },
          { path: "/srv/b.png", name: "b.png" },
        ],
      }),
    });

    await expect.element(page.getByText("a.png")).toBeInTheDocument();
    await expect.element(page.getByText("b.png")).toBeInTheDocument();
    // Each seeded chip carries its own remove control.
    const removers = page.getByRole("button", { name: m.newtask_remove_image_aria() }).all();
    expect(removers.length).toBe(2);
  });

  it("renders no chips when initialImages is omitted", async () => {
    render(NewTask, { props: base() });
    expect(document.querySelector(".chip")).toBeNull();
  });

  it("removing a seeded chip drops it without mutating the others", async () => {
    render(NewTask, {
      props: base({
        initialImages: [
          { path: "/srv/a.png", name: "a.png" },
          { path: "/srv/b.png", name: "b.png" },
        ],
      }),
    });

    await page.getByRole("button", { name: m.newtask_remove_image_aria() }).first().click();

    expect(page.getByText("a.png").query()).toBeNull();
    await expect.element(page.getByText("b.png")).toBeInTheDocument();
  });
});
