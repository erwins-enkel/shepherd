import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";

const { default: ViewportTermBanners } = await import("./ViewportTermBanners.svelte");

const AUTH_URL =
  "https://mcp.notion.com/authorize?response_type=code&client_id=abc&code_challenge=x&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A3118%2Fcallback";

const baseProps = {
  tab: "term",
  scrolledUp: false,
  parked: false,
  ended: false,
  endReason: "gone" as const,
  resuming: false,
  resumeFailed: false,
  resumable: false,
  scrollToTop: vi.fn(),
  scrollToBottom: vi.fn(),
  takeover: vi.fn(),
  reattach: vi.fn(),
  resumeSession: vi.fn(),
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ViewportTermBanners auth banner", () => {
  it("shows the full URL and Open/Copy when an authUrl is pending", async () => {
    render(ViewportTermBanners, { ...baseProps, authUrl: AUTH_URL });
    await expect.element(page.getByText(AUTH_URL)).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /open/i })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("Open opens the URL in a new tab with noopener", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(ViewportTermBanners, { ...baseProps, authUrl: AUTH_URL });
    await page.getByRole("button", { name: /open/i }).click();
    expect(open).toHaveBeenCalledWith(AUTH_URL, "_blank", "noopener,noreferrer");
  });

  it("Copy writes the URL to the clipboard and flips the label to Copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(ViewportTermBanners, { ...baseProps, authUrl: AUTH_URL });
    await page.getByRole("button", { name: /copy/i }).click();
    expect(writeText).toHaveBeenCalledWith(AUTH_URL);
    await expect.element(page.getByRole("button", { name: /copied/i })).toBeInTheDocument();
  });

  it("renders nothing when there is no authUrl", async () => {
    render(ViewportTermBanners, { ...baseProps, authUrl: null });
    await expect.element(page.getByRole("button", { name: /open/i })).not.toBeInTheDocument();
  });

  it("rest state: amber wash that preserves the strip's translucency", async () => {
    render(ViewportTermBanners, { ...baseProps, authUrl: AUTH_URL });
    const banner = document.querySelector<HTMLElement>(".auth-banner");
    expect(banner).not.toBeNull();
    // Resolve the intended wash through a probe element so the assertion tracks the
    // design tokens instead of hard-coding channel values.
    const probe = document.createElement("div");
    document.body.appendChild(probe);
    probe.style.background =
      "color-mix(in srgb, color-mix(in srgb, var(--color-amber) 14%, var(--color-head)) 96%, transparent)";
    const expected = getComputedStyle(probe).backgroundColor;
    expect(getComputedStyle(banner!).backgroundColor).toBe(expected);
    // Translucency guard: the pre-existing 96% alpha must survive the amber wash.
    expect(alphaOf(expected)).toBeGreaterThan(0.9);
    expect(alphaOf(expected)).toBeLessThan(1);
    // Wash guard: the surface is genuinely tinted, not the plain head tone.
    probe.style.background = "color-mix(in srgb, var(--color-head) 96%, transparent)";
    expect(getComputedStyle(banner!).backgroundColor).not.toBe(
      getComputedStyle(probe).backgroundColor,
    );
  });

  it("pulsing ::after halo: pointer-transparent, glowing, and continuous", async () => {
    render(ViewportTermBanners, { ...baseProps, authUrl: AUTH_URL });
    const banner = document.querySelector<HTMLElement>(".auth-banner");
    expect(banner).not.toBeNull();
    const after = getComputedStyle(banner!, "::after");
    expect(after.content).toBe('""');
    // The overlay-interaction guard: the halo layer must never intercept input.
    expect(after.pointerEvents).toBe("none");
    expect(after.boxShadow).not.toBe("none");
    // Svelte hashes component-local keyframe names, so match the authored substring,
    // never the unscoped literal.
    expect(after.animationName).not.toBe("none");
    expect(after.animationName).toContain("auth-banner-glow");
    expect(parseFloat(after.animationDuration)).toBeGreaterThan(0);
    expect(after.animationIterationCount).toBe("infinite");
  });
});

/** Alpha channel of a computed color, handling both `rgba(r, g, b, a)` and
 *  `color(srgb r g b / a)` serializations; a fully-opaque serialization has no
 *  alpha component, which reads as 1. */
function alphaOf(color: string): number {
  const m = /\/\s*([\d.]+)\)\s*$/.exec(color) ?? /rgba\([^)]*,\s*([\d.]+)\)\s*$/.exec(color);
  return m ? parseFloat(m[1]) : 1;
}
