import { afterEach, describe, expect, it, vi } from "vitest";
import { render as rawRender } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../../app.css";
import { relativeTimeAgo } from "#lib/format.js";
import { getLocale } from "#lib/i18n.js";
import { clock } from "#lib/now.svelte.js";
import { m } from "#lib/paraglide/messages.js";
import type { SessionArtifact } from "#lib/types.js";
import ArtifactMenu from "./ArtifactMenu.svelte";

const mounted: Array<{ unmount: () => void | Promise<void> }> = [];
async function render(
  ...args: Parameters<typeof rawRender>
): Promise<Awaited<ReturnType<typeof rawRender>>> {
  const result = await rawRender(...args);
  mounted.push(result);
  return result;
}

const T0 = Date.now();
const art = (n: number, partial: Partial<SessionArtifact> = {}): SessionArtifact => ({
  url: `https://claude.ai/artifact/Artifact${String(n).padStart(14, "0")}`,
  title: `Artifact ${n}`,
  versions: n,
  firstSeenAt: T0 - 3_600_000,
  updatedAt: T0 - n * 60_000,
  toolUseId: `toolu_${n}`,
  ...partial,
});
// newest first, as the rows pass them
const three = [art(1), art(2), art(3)];

/** A trigger near the bottom of the viewport, like the rows above the steer bar. */
function trigger(): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = "All 3";
  b.style.cssText = "position:fixed;right:40px;bottom:20px;";
  document.body.appendChild(b);
  b.focus();
  return b;
}

async function open(
  props: Partial<{
    artifacts: SessionArtifact[];
    mode: "all" | "single";
    touch: boolean;
    onshowinchat: (id: string | null) => void;
    onhide: () => void;
    onclose: () => void;
  }> = {},
) {
  const opener = trigger();
  const onclose = props.onclose ?? vi.fn();
  const screen = await render(ArtifactMenu, {
    props: {
      anchor: opener.getBoundingClientRect(),
      opener,
      artifacts: three,
      onshowinchat: vi.fn(),
      onhide: vi.fn(),
      ...props,
      onclose,
    },
  });
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
  return { screen, menu, opener, onclose };
}

const active = () => document.activeElement as HTMLElement;

afterEach(async () => {
  for (const instance of mounted.splice(0).reverse()) await instance.unmount();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  await page.viewport(1280, 900);
});

describe("ArtifactMenu: all", () => {
  it("is a labelled menu: header, every artifact newest first, then Hide", async () => {
    const { menu } = await open();
    expect(menu.getAttribute("aria-label")).toBe(m.artifactrow_menu_label());
    expect(menu.querySelector(".am-head")?.textContent).toBe(m.artifactrow_menu_head());
    const entries = [...menu.querySelectorAll<HTMLElement>(".am-entry")];
    expect(entries.map((e) => e.getAttribute("aria-label"))).toEqual([
      "Artifact 1",
      "Artifact 2",
      "Artifact 3",
    ]);
    const facts = entries[1]!.querySelector(".am-facts")!.textContent;
    const when = relativeTimeAgo(three[1]!.updatedAt, clock.current, getLocale());
    expect(facts).toBe(m.artifactrow_menu_facts({ n: 2, when }));
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.at(-1)?.textContent?.trim()).toBe(m.artifactrow_hide());
    expect(items).toHaveLength(3 * 3 + 1);
  });

  it("opens above the trigger and focuses the first entry", async () => {
    const { menu, opener } = await open();
    expect(menu.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      opener.getBoundingClientRect().top,
    );
    expect(active()).toBe(menu.querySelector(".am-open"));
  });

  it("each entry opens its artifact in a new tab", async () => {
    const { menu } = await open();
    const links = [...menu.querySelectorAll<HTMLAnchorElement>("a.am-open")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(three.map((a) => a.url));
    for (const a of links) {
      expect(a.getAttribute("role")).toBe("menuitem");
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener");
      expect(a.textContent).toContain(m.artifactrow_open());
    }
  });

  it("every icon button is named; Copy writes the url and confirms, the menu stays open", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const { menu, onclose } = await open();
    for (const b of menu.querySelectorAll<HTMLElement>(".am-icon"))
      expect(b.getAttribute("aria-label")).toBeTruthy();
    const copy = menu.querySelectorAll<HTMLButtonElement>(".am-entry")[1]!.querySelector("button")!;
    expect(copy.getAttribute("aria-label")).toBe(m.artifactrow_copy());
    copy.click();
    await expect.poll(() => copy.getAttribute("aria-label")).toBe(m.artifactrow_copied());
    expect(write).toHaveBeenCalledWith(three[1]!.url);
    expect(copy.textContent).toBe("✓");
    expect(document.querySelector('[role="status"]')?.textContent).toBe(m.artifactrow_copied());
    expect(onclose).not.toHaveBeenCalled();
  });

  it("Show in Chat hands over that artifact's latest publish and closes", async () => {
    const onshowinchat = vi.fn();
    const { menu, onclose } = await open({ onshowinchat });
    const entry = menu.querySelectorAll<HTMLElement>(".am-entry")[2]!;
    const chat = [...entry.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.getAttribute("aria-label") === m.artifactrow_show_in_chat(),
    )!;
    chat.click();
    expect(onclose).toHaveBeenCalled();
    expect(onshowinchat).toHaveBeenCalledWith("toolu_3");
  });

  it("Hide for this session hides and closes", async () => {
    const onhide = vi.fn();
    const { menu, onclose } = await open({ onhide });
    menu.querySelector<HTMLButtonElement>(".am-foot")!.click();
    expect(onclose).toHaveBeenCalled();
    expect(onhide).toHaveBeenCalledOnce();
  });

  it("without callbacks the menu only opens and copies", async () => {
    const { menu } = await open({ onshowinchat: undefined, onhide: undefined });
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(3 * 2);
    expect(menu.querySelector(".am-foot")).toBeNull();
  });

  it("↑/↓ move between entries and Hide, ←/→ within an entry, Home/End, Tab through all", async () => {
    const { menu } = await open();
    const entries = [...menu.querySelectorAll<HTMLElement>(".am-entry")];
    const items = (i: number) => [...entries[i]!.querySelectorAll<HTMLElement>(".am-item")];
    const hide = menu.querySelector<HTMLElement>(".am-foot")!;
    expect(active()).toBe(items(0)[0]);
    await userEvent.keyboard("{ArrowDown}");
    expect(active()).toBe(items(1)[0]);
    await userEvent.keyboard("{ArrowRight}");
    expect(active()).toBe(items(1)[1]);
    await userEvent.keyboard("{ArrowRight}");
    expect(active()).toBe(items(1)[2]);
    await userEvent.keyboard("{ArrowRight}");
    expect(active(), "wraps within the entry").toBe(items(1)[0]);
    await userEvent.keyboard("{ArrowLeft}");
    expect(active()).toBe(items(1)[2]);
    await userEvent.keyboard("{ArrowDown}");
    expect(active(), "the next entry's Open").toBe(items(2)[0]);
    await userEvent.keyboard("{ArrowDown}");
    expect(active()).toBe(hide);
    await userEvent.keyboard("{ArrowDown}");
    expect(active(), "wraps to the top").toBe(items(0)[0]);
    await userEvent.keyboard("{ArrowUp}");
    expect(active()).toBe(hide);
    await userEvent.keyboard("{Home}");
    expect(active()).toBe(items(0)[0]);
    await userEvent.keyboard("{End}");
    expect(active()).toBe(hide);
    await userEvent.keyboard("{Tab}");
    expect(active()).toBe(items(0)[0]);
    await userEvent.keyboard("{Tab}");
    expect(active()).toBe(items(0)[1]);
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(active()).toBe(items(0)[0]);
  });

  it("its keys never reach the dashboard's window shortcut, which switches sessions on ↑/↓", async () => {
    // The dashboard (+page.svelte) binds `<svelte:window onkeydown>`: a plain ↑/↓ outside a text
    // field cycles the selected session — and with it the Viewport, closing this menu.
    const reached: string[] = [];
    const dashboard = (e: KeyboardEvent) => reached.push(e.key);
    window.addEventListener("keydown", dashboard);
    try {
      const { menu, onclose } = await open();
      const items = [
        ...menu.querySelectorAll<HTMLElement>(".am-entry")[0]!.querySelectorAll(".am-item"),
      ];
      for (const key of ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "End", "Home", "Tab"])
        await userEvent.keyboard(`{${key}}`);
      expect(reached).toEqual([]);
      expect(active(), "Home, then Tab onto Copy").toBe(items[1]);
      expect(onclose).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", dashboard);
    }
  });

  it("Escape closes, and focus returns to the trigger", async () => {
    const onclose = vi.fn();
    const { screen, opener } = await open({ onclose });
    await userEvent.keyboard("{Escape}");
    expect(onclose).toHaveBeenCalled();
    await screen.unmount();
    mounted.length = 0;
    await expect.poll(() => document.activeElement).toBe(opener);
  });

  it("an outside click or scroll closes; scrolling the list itself does not", async () => {
    const many = Array.from({ length: 30 }, (_, i) => art(i + 1));
    const { menu, onclose } = await open({ artifacts: many });
    const list = menu.querySelector<HTMLElement>(".am-list")!;
    expect(list.scrollHeight, "a long list scrolls").toBeGreaterThan(list.clientHeight);
    expect(menu.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    list.scrollTop = 200;
    list.dispatchEvent(new Event("scroll"));
    expect(onclose).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("scroll"));
    expect(onclose).toHaveBeenCalledTimes(1);
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(onclose).toHaveBeenCalledTimes(2);
  });

  it("touch: every item is a 44px target", async () => {
    const { menu } = await open({ touch: true });
    for (const item of menu.querySelectorAll<HTMLElement>(".am-item")) {
      const r = item.getBoundingClientRect();
      expect(r.height).toBeGreaterThanOrEqual(44);
      expect(r.width).toBeGreaterThanOrEqual(44);
    }
  });
});

describe("ArtifactMenu: single", () => {
  it("offers only Show in Chat and Hide for the one artifact", async () => {
    const onshowinchat = vi.fn();
    const { menu } = await open({ mode: "single", artifacts: [art(4)], onshowinchat });
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((i) => i.textContent?.trim())).toEqual([
      m.artifactrow_show_in_chat(),
      m.artifactrow_hide(),
    ]);
    expect(menu.querySelector(".am-head")).toBeNull();
    expect(active()).toBe(items[0]);
    await userEvent.keyboard("{ArrowDown}");
    expect(active()).toBe(items[1]);
    await userEvent.keyboard("{ArrowUp}");
    items[0]!.click();
    expect(onshowinchat).toHaveBeenCalledWith("toolu_4");
  });
});
