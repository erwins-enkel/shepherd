import { afterEach, describe, expect, it, vi } from "vitest";
import { render as rawRender } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { relativeTimeAgo } from "#lib/format.js";
import { getLocale } from "#lib/i18n.js";
import { m } from "#lib/paraglide/messages.js";
import { clock } from "#lib/now.svelte.js";
import type { SessionArtifact } from "#lib/types.js";
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
    await render(ArtifactRow, { target: h, props: { artifact: artifact() } });
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
    await render(ArtifactRow, { target: h, props: { artifact: artifact() } });
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
    const screen = await render(ArtifactRow, { target: h, props: { artifact: artifact() } });
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
    const screen = await render(ArtifactRow, { target: h, props: { artifact: artifact() } });
    await screen.getByRole("button", { name: m.artifactrow_copy() }).click();
    expect(write).toHaveBeenCalledWith(URL);
    await screen.rerender({
      artifact: artifact({
        url: "https://claude.ai/artifact/OtherArtifact000000001",
        title: "Other",
      }),
    });
    settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(row(h).querySelector("button")?.textContent?.trim()).toBe(m.artifactrow_copy());
  });

  it("a title longer than the row stays on one line", async () => {
    const h = host(600);
    await render(ArtifactRow, {
      target: h,
      props: { artifact: artifact({ title: "Ein sehr langer Titel ".repeat(20) }) },
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
      props: { artifact: artifact({ versions: 123456 }), mobile: true, touch: true },
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
    expect(url.textContent).toBe("claude.ai/artifact/GEQx…313");
  });

  it("360px: stacked, Copy link · Open ↗, every target ≥ 44px, no horizontal overflow", async () => {
    await page.viewport(360, 800);
    const h = host(360);
    await render(ArtifactRow, {
      target: h,
      props: { artifact: artifact(), mobile: true, touch: true },
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
});
