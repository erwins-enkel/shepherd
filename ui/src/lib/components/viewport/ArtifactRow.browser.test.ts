import { afterEach, describe, expect, it, vi } from "vitest";
import { render as rawRender } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { relativeTimeAgo } from "#lib/format.js";
import { getLocale } from "#lib/i18n.js";
import { m } from "#lib/paraglide/messages.js";
import { clock } from "#lib/now.svelte.js";
import type { SessionArtifact } from "#lib/types.js";
import { userEvent } from "vitest/browser";
import ArtifactRow from "./ArtifactRow.svelte";

const mounted: Array<{ unmount: () => void | Promise<void> }> = [];
async function render(
  ...args: Parameters<typeof rawRender>
): Promise<Awaited<ReturnType<typeof rawRender>>> {
  const result = await rawRender(...args);
  mounted.push(result);
  return result;
}

const URL = "https://claude.ai/artifact/GEQx5QVP82WzdTBfcxx313";
const OTHER = "https://claude.ai/artifact/OtherArtifact000000001";
const CODE_URL = "https://claude.ai/code/artifact/GEQx5QVP82WzdTBfcxx313";
const T0 = Date.now();
const artifact = (partial: Partial<SessionArtifact> = {}): SessionArtifact => ({
  url: URL,
  title: "Shepherd Prüfslot — Desktop, Telefon und Einstellungen",
  versions: 12,
  firstSeenAt: T0 - 3_600_000,
  updatedAt: T0 - 4 * 60_000,
  toolUseId: "toolu_1",
  ...partial,
});

function host(width = 900): HTMLDivElement {
  const h = document.createElement("div");
  h.style.width = `${width}px`;
  document.body.appendChild(h);
  return h;
}
const row = (h: HTMLElement) => h.querySelector<HTMLElement>("section.artifact-row")!;

afterEach(async () => {
  for (const instance of mounted.splice(0).reverse()) await instance.unmount();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  await page.viewport(1280, 900);
});

describe("ArtifactRow", () => {
  it("shows the label, title, version, age and shortened url", async () => {
    const h = host();
    await render(ArtifactRow, { target: h, props: { sessionId: "s1", artifacts: [artifact()] } });
    const r = row(h);
    expect(r.getAttribute("aria-label")).toBe(m.artifactrow_aria());
    expect(r.querySelector(".art-label")?.textContent).toBe(m.artifactrow_label());
    const title = r.querySelector<HTMLElement>(".art-title")!;
    expect(title.textContent).toBe(artifact().title);
    expect(title.getAttribute("title")).toBe(artifact().title);
    const facts = r.querySelector(".art-facts")!.textContent!;
    expect(facts).toContain(m.artifactrow_version({ n: 12 }));
    const when = relativeTimeAgo(artifact().updatedAt, clock.current, getLocale());
    expect(facts).toContain(m.artifactrow_updated({ when }));
    const url = r.querySelector<HTMLElement>(".art-url")!;
    expect(url.textContent).toBe("claude.ai/artifact/GEQx…313");
    expect(url.getAttribute("title")).toBe(URL);
    expect(getComputedStyle(url).fontFamily).toContain("mono");
  });

  it("Open ↗ is the one amber link to the artifact in a new tab", async () => {
    const h = host();
    await render(ArtifactRow, { target: h, props: { sessionId: "s1", artifacts: [artifact()] } });
    const links = [...row(h).querySelectorAll<HTMLAnchorElement>("a")];
    expect(links).toHaveLength(1);
    const open = links[0]!;
    expect(open.textContent?.trim()).toBe(m.artifactrow_open());
    expect(open.getAttribute("href")).toBe(URL);
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener");
    expect(open.classList.contains("primary")).toBe(true);
    expect(row(h).querySelectorAll(".primary")).toHaveLength(1);
  });

  it("Copy link writes the url and confirms", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const h = host();
    const screen = await render(ArtifactRow, {
      target: h,
      props: { sessionId: "s1", artifacts: [artifact()] },
    });
    await screen.getByRole("button", { name: m.artifactrow_copy() }).click();
    expect(write).toHaveBeenCalledWith(URL);
    await expect
      .element(screen.getByRole("button", { name: m.artifactrow_copied() }))
      .toBeVisible();
  });

  it("a copy that settles after the artifact changed confirms nothing", async () => {
    let settle = () => {};
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockImplementation(() => new Promise<void>((resolve) => (settle = resolve)));
    const h = host();
    const screen = await render(ArtifactRow, {
      target: h,
      props: { sessionId: "s1", artifacts: [artifact()] },
    });
    await screen.getByRole("button", { name: m.artifactrow_copy() }).click();
    expect(write).toHaveBeenCalledWith(URL);
    // A → B → A: back on the same url, the pending copy still belongs to the first showing.
    await screen.rerender({
      sessionId: "s1",
      artifacts: [artifact({ url: OTHER, title: "Other" })],
    });
    await screen.rerender({ sessionId: "s1", artifacts: [artifact()] });
    settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(row(h).querySelector("button")?.textContent?.trim()).toBe(m.artifactrow_copy());
  });

  it("a copy that settles after switching to another session with the same url confirms nothing", async () => {
    let settle = () => {};
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
      () => new Promise<void>((resolve) => (settle = resolve)),
    );
    const h = host();
    const screen = await render(ArtifactRow, {
      target: h,
      props: { sessionId: "s1", artifacts: [artifact()] },
    });
    await screen.getByRole("button", { name: m.artifactrow_copy() }).click();
    await screen.rerender({ sessionId: "s2", artifacts: [artifact()] });
    settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(row(h).querySelector("button")?.textContent?.trim()).toBe(m.artifactrow_copy());
  });

  it("a title longer than the row stays on one line", async () => {
    const h = host(600);
    await render(ArtifactRow, {
      target: h,
      props: {
        sessionId: "s1",
        artifacts: [artifact({ title: "Ein sehr langer Titel ".repeat(20) })],
      },
    });
    const title = row(h).querySelector<HTMLElement>(".art-title")!;
    expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
    expect(title.getBoundingClientRect().height).toBeLessThan(40);
  });

  it("phone: long facts wrap and the shortened url stays whole and visible", async () => {
    await page.viewport(320, 800);
    const h = host(320);
    await render(ArtifactRow, {
      target: h,
      props: {
        sessionId: "s1",
        artifacts: [artifact({ url: CODE_URL, versions: 123456 })],
        mobile: true,
        touch: true,
      },
    });
    const r = row(h);
    r.style.fontSize = "150%";
    const facts = r.querySelector<HTMLElement>(".art-facts")!;
    facts.style.fontSize = "18px";
    const url = r.querySelector<HTMLElement>(".art-url")!;
    expect(facts.scrollWidth, "facts never overflow").toBeLessThanOrEqual(facts.clientWidth);
    expect(url.getBoundingClientRect().right).toBeLessThanOrEqual(
      r.getBoundingClientRect().right + 1,
    );
    expect(url.scrollWidth).toBeLessThanOrEqual(url.clientWidth + 1);
    expect(url.textContent).toBe("claude.ai/code/artifact/GEQx…313");
  });

  it("360px: stacked, Copy link · Open ↗, every target ≥ 44px, no horizontal overflow", async () => {
    await page.viewport(360, 800);
    const h = host(360);
    await render(ArtifactRow, {
      target: h,
      props: { sessionId: "s1", artifacts: [artifact()], mobile: true, touch: true },
    });
    const r = row(h);
    expect(r.scrollWidth, "no horizontal overflow").toBeLessThanOrEqual(r.clientWidth);
    const info = r.querySelector<HTMLElement>(".art-info")!;
    const actions = r.querySelector<HTMLElement>(".art-actions")!;
    expect(actions.getBoundingClientRect().top, "actions below the facts").toBeGreaterThanOrEqual(
      info.getBoundingClientRect().bottom,
    );
    const targets = [...r.querySelectorAll<HTMLElement>("button, a[href]")];
    expect(targets.map((t) => t.textContent?.trim())).toEqual([
      m.artifactrow_copy(),
      m.artifactrow_open(),
    ]);
    for (const t of targets) {
      const rect = t.getBoundingClientRect();
      expect(rect.height, `${t.textContent} height`).toBeGreaterThanOrEqual(44);
      expect(rect.width, `${t.textContent} width`).toBeGreaterThanOrEqual(44);
      expect(rect.right, `${t.textContent} inside the row`).toBeLessThanOrEqual(
        r.getBoundingClientRect().right + 1,
      );
    }
  });

  it("several artifacts: the newest with “Newest of N”, and “All N” opens the menu of every one", async () => {
    const h = host();
    const newest = artifact({ title: "Newest", versions: 3 });
    const older = artifact({ url: OTHER, title: "Older", updatedAt: T0 - 60 * 60_000 });
    const onshowinchat = vi.fn();
    const onhide = vi.fn();
    const screen = await render(ArtifactRow, {
      target: h,
      props: { sessionId: "s1", artifacts: [newest, older], onshowinchat, onhide },
    });
    const r = row(h);
    expect(r.querySelector(".art-title")?.textContent).toBe("Newest");
    const facts = r.querySelector(".art-facts")!.textContent!;
    expect(facts.startsWith(m.artifactrow_newest_of({ n: 2 }))).toBe(true);
    expect(facts).toContain(m.artifactrow_version({ n: 3 }));
    expect(r.querySelector(".art-url"), "the url gives way to the count").toBeNull();
    expect(r.querySelectorAll(".primary")).toHaveLength(1);

    const all = screen.getByRole("button", { name: m.artifactrow_all({ n: 2 }) });
    await expect.element(all).toHaveAttribute("aria-haspopup", "menu");
    await expect.element(all).toHaveAttribute("aria-expanded", "false");
    await all.click();
    await expect.element(all).toHaveAttribute("aria-expanded", "true");
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(
      [...menu.querySelectorAll(".am-entry")].map((e) => e.getAttribute("aria-label")),
    ).toEqual(["Newest", "Older"]);
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await expect.poll(() => document.activeElement).toBe(all.element());
  });

  it("one artifact: ⋯ holds Show in Chat and Hide for this session", async () => {
    const h = host();
    const onshowinchat = vi.fn();
    const onhide = vi.fn();
    const screen = await render(ArtifactRow, {
      target: h,
      props: { sessionId: "s1", artifacts: [artifact()], onshowinchat, onhide },
    });
    expect(row(h).querySelector(".art-facts .art-url")).not.toBeNull();
    await screen.getByRole("button", { name: m.artifactrow_more_aria() }).click();
    const items = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
    expect(items.map((i) => i.textContent?.trim())).toEqual([
      m.artifactrow_show_in_chat(),
      m.artifactrow_hide(),
    ]);
    items[0]!.click();
    expect(onshowinchat).toHaveBeenCalledWith("toolu_1");
    await screen.getByRole("button", { name: m.artifactrow_more_aria() }).click();
    document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')[1]!.click();
    expect(onhide).toHaveBeenCalledOnce();
  });

  it("one artifact without callbacks has no ⋯", async () => {
    const h = host();
    await render(ArtifactRow, { target: h, props: { sessionId: "s1", artifacts: [artifact()] } });
    expect(row(h).querySelector(".more")).toBeNull();
  });

  it("phone with several artifacts: All N · Copy link · Open ↗, every target ≥ 44px", async () => {
    await page.viewport(360, 800);
    const h = host(360);
    await render(ArtifactRow, {
      target: h,
      props: {
        sessionId: "s1",
        artifacts: [artifact(), artifact({ url: OTHER, updatedAt: T0 - 9e6 })],
        mobile: true,
        touch: true,
        onshowinchat: () => {},
        onhide: () => {},
      },
    });
    const r = row(h);
    expect(r.scrollWidth, "no horizontal overflow").toBeLessThanOrEqual(r.clientWidth);
    const targets = [...r.querySelectorAll<HTMLElement>("button, a[href]")];
    expect(targets.map((t) => t.textContent?.trim())).toEqual([
      `${m.artifactrow_all({ n: 2 })}▴`,
      m.artifactrow_copy(),
      m.artifactrow_open(),
    ]);
    for (const t of targets) {
      const rect = t.getBoundingClientRect();
      expect(rect.height).toBeGreaterThanOrEqual(44);
      expect(rect.right).toBeLessThanOrEqual(r.getBoundingClientRect().right + 1);
    }
  });

  it("a second artifact arriving closes the open ⋯ menu", async () => {
    const h = host();
    const screen = await render(ArtifactRow, {
      target: h,
      props: { sessionId: "s1", artifacts: [artifact()], onhide: () => {} },
    });
    await screen.getByRole("button", { name: m.artifactrow_more_aria() }).click();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await screen.rerender({
      sessionId: "s1",
      artifacts: [artifact({ url: OTHER }), artifact()],
      onhide: () => {},
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("a session switch closes an open menu", async () => {
    const h = host();
    const two = [artifact(), artifact({ url: OTHER })];
    const screen = await render(ArtifactRow, {
      target: h,
      props: { sessionId: "s1", artifacts: two },
    });
    await screen.getByRole("button", { name: m.artifactrow_all({ n: 2 }) }).click();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await screen.rerender({ sessionId: "s2", artifacts: two });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
