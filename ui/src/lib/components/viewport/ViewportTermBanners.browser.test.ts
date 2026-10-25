import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";

const resolveLoginRequest = vi.fn().mockResolvedValue(undefined);
vi.mock("#lib/api.js", async (orig) => ({
  ...(await orig<typeof import("#lib/api.js")>()),
  resolveLoginRequest: (...a: unknown[]) => resolveLoginRequest(...a),
}));
const toastInfo = vi.fn();
vi.mock("#lib/toasts.svelte.js", async (orig) => {
  const mod = await orig<typeof import("#lib/toasts.svelte.js")>();
  return { ...mod, toasts: { ...mod.toasts, info: (...a: unknown[]) => toastInfo(...a) } };
});

const { ApiError } = await import("#lib/api.js");
const { default: ViewportTermBanners } = await import("./ViewportTermBanners.svelte");

const AUTH_URL =
  "https://mcp.notion.com/authorize?response_type=code&client_id=abc&code_challenge=x&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A3118%2Fcallback";

const baseProps = {
  tab: "term",
  sessionId: "s1",
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
  resolveLoginRequest.mockReset().mockResolvedValue(undefined);
  toastInfo.mockReset();
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

describe("current terminal owner", () => {
  it("updates a parked terminal after another takeover without taking it back", async () => {
    const takeover = vi.fn();
    const view = await render(ViewportTermBanners, {
      ...baseProps,
      parked: true,
      takeover,
      owner: { kind: "mac-app", platform: "macos" },
    });
    await expect
      .element(page.getByRole("button", { name: /Active in the Mac app/ }))
      .toBeInTheDocument();
    await view.rerender({ owner: { kind: "pwa", platform: "ios" } });
    await expect
      .element(page.getByRole("button", { name: /Active in the PWA on iOS/ }))
      .toBeInTheDocument();
    expect(takeover).not.toHaveBeenCalled();
    await page.getByRole("button", { name: /Active in the PWA on iOS/ }).click();
    expect(takeover).toHaveBeenCalledTimes(1);
    await view.rerender({ owner: null });
    await expect
      .element(page.getByRole("button", { name: /Not currently open/ }))
      .toBeInTheDocument();
    await view.rerender({ owner: undefined });
    await expect
      .element(page.getByRole("button", { name: /Current access unknown/ }))
      .toBeInTheDocument();
  });
});

describe("ended terminal: reconnect", () => {
  it("names the unreachable machine of a remote session and re-attaches on tap (#2764)", async () => {
    const reattach = vi.fn();
    await render(ViewportTermBanners, {
      ...baseProps,
      ended: true,
      endReason: "machine",
      machine: "MacBook",
      reattach,
    });
    const button = page.getByRole("button", { name: /Reconnect.*MacBook can't be reached/ });
    await expect.element(button).toBeInTheDocument();
    await button.click();
    expect(reattach).toHaveBeenCalledTimes(1);
  });

  it("keeps the herdr copy when herdr itself is down", async () => {
    await render(ViewportTermBanners, { ...baseProps, ended: true, endReason: "unreachable" });
    await expect
      .element(page.getByRole("button", { name: /Reconnect.*herdr may be down/ }))
      .toBeInTheDocument();
  });
});

describe("terminal owner on a narrow screen", () => {
  it("keeps the German title and takeover action readable at phone width", async () => {
    const { getLocale, setLocale } = await import("#lib/paraglide/runtime.js");
    const previous = getLocale();
    try {
      setLocale("de", { reload: false });
      await page.viewport(320, 480);
      await render(ViewportTermBanners, {
        ...baseProps,
        parked: true,
        owner: { kind: "browser", platform: "chromeos" },
      });
      await expect
        .element(page.getByRole("button", { name: /Aktiv im Browser auf ChromeOS/ }))
        .toBeInTheDocument();
      const title = document.querySelector<HTMLElement>(".parked-title")!;
      expect(title.getBoundingClientRect().right).toBeLessThanOrEqual(320);
      expect(title.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
    } finally {
      setLocale(previous, { reload: false });
      await page.viewport(1280, 900);
    }
  });
});

describe("ViewportTermBanners login request bar (#2897)", () => {
  const LOGIN = {
    id: "lr1",
    url: "https://login.example/",
    reason: "Need the dashboard session",
    createdAt: 1,
  };

  it("shows url + reason with Open browser / Done / Cancel on the term tab", async () => {
    render(ViewportTermBanners, { ...baseProps, loginRequest: LOGIN, openBrowser: vi.fn() });
    await expect.element(page.getByText("https://login.example/")).toBeVisible();
    await expect.element(page.getByText("Need the dashboard session")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Open browser" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Done" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  });

  it("Done / Cancel answer the request in place", async () => {
    render(ViewportTermBanners, { ...baseProps, loginRequest: LOGIN });
    await page.getByRole("button", { name: "Done" }).click();
    expect(resolveLoginRequest).toHaveBeenCalledWith("s1", "done");
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(resolveLoginRequest).toHaveBeenLastCalledWith("s1", "cancelled");
  });

  it("Open browser calls openBrowser; hidden without a Browser tab", async () => {
    const openBrowser = vi.fn();
    const r = await render(ViewportTermBanners, { ...baseProps, loginRequest: LOGIN, openBrowser });
    await page.getByRole("button", { name: "Open browser" }).click();
    expect(openBrowser).toHaveBeenCalledOnce();
    await r.rerender({ ...baseProps, loginRequest: LOGIN, openBrowser: null });
    await expect
      .element(page.getByRole("button", { name: "Open browser" }))
      .not.toBeInTheDocument();
  });

  it("hides off the term tab, when parked, and once the request resolves", async () => {
    const r = await render(ViewportTermBanners, { ...baseProps, loginRequest: LOGIN, tab: "diff" });
    await expect.element(page.getByRole("button", { name: "Done" })).not.toBeInTheDocument();
    await r.rerender({ ...baseProps, loginRequest: LOGIN, parked: true });
    await expect.element(page.getByRole("button", { name: "Done" })).not.toBeInTheDocument();
    await r.rerender({ ...baseProps, loginRequest: LOGIN });
    await expect.element(page.getByRole("button", { name: "Done" })).toBeVisible();
    await r.rerender({ ...baseProps, loginRequest: null });
    await expect.element(page.getByRole("button", { name: "Done" })).not.toBeInTheDocument();
  });

  it("stacks under a pending MCP auth strip", async () => {
    render(ViewportTermBanners, { ...baseProps, authUrl: AUTH_URL, loginRequest: LOGIN });
    await expect.element(page.getByText(AUTH_URL)).toBeVisible();
    await expect.element(page.getByText("Need the dashboard session")).toBeVisible();
    const [auth, login] = document.querySelectorAll<HTMLElement>(".auth-banner");
    expect(login.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      auth.getBoundingClientRect().bottom - 1,
    );
  });

  it("swallows a 404 (already answered) but toasts other failures", async () => {
    resolveLoginRequest.mockRejectedValueOnce(new ApiError(404, "gone"));
    render(ViewportTermBanners, { ...baseProps, loginRequest: LOGIN });
    await page.getByRole("button", { name: "Done" }).click();
    await expect.poll(() => resolveLoginRequest.mock.calls.length).toBe(1);
    expect(toastInfo).not.toHaveBeenCalled();
    resolveLoginRequest.mockRejectedValueOnce(new ApiError(500, "boom"));
    await page.getByRole("button", { name: "Done" }).click();
    await expect.poll(() => toastInfo.mock.calls.length).toBe(1);
  });

  it("ellipsizes a long URL, clamps the reason, and wraps actions on a phone", async () => {
    const url = "https://login.example/" + "a".repeat(400);
    const reason = "word ".repeat(200);
    await page.viewport(360, 700);
    try {
      render(ViewportTermBanners, {
        ...baseProps,
        loginRequest: { ...LOGIN, url, reason },
        openBrowser: vi.fn(),
      });
      await expect.element(page.getByRole("button", { name: "Done" })).toBeVisible();
      const bar = document.querySelector<HTMLElement>(".login-banner")!;
      expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
      const urlEl = page.getByText(url).element() as HTMLElement;
      expect(urlEl.title).toBe(url);
      expect(urlEl.scrollWidth).toBeGreaterThan(urlEl.clientWidth); // ellipsized
      const reasonEl = document.querySelector<HTMLElement>(".login-reason")!;
      expect(reasonEl.title).toBe(reason);
      const lh = parseFloat(getComputedStyle(reasonEl).lineHeight) || 20;
      expect(reasonEl.clientHeight).toBeLessThanOrEqual(lh * 2 + 2);
      const text = bar.querySelector<HTMLElement>(".auth-text")!;
      expect(text.getBoundingClientRect().width).toBeGreaterThan(200);
    } finally {
      await page.viewport(1280, 900);
    }
  });
});

describe("ViewportTermBanners plan approval strip (#2779)", () => {
  const PLAN = {
    toolUseId: "toolu_p",
    plan: "Step 1: <b>bold</b> stays text\nStep 2: done",
    truncated: false,
  };

  it("announces the plan and reveals it as plain text on demand", async () => {
    render(ViewportTermBanners, { ...baseProps, plan: PLAN });
    await expect
      .element(page.getByText("Claude's plan is waiting for your approval"))
      .toBeVisible();
    const show = page.getByRole("button", { name: "Show plan" });
    await expect.element(show).toHaveAttribute("aria-expanded", "false");
    await show.click();
    const text = document.querySelector<HTMLElement>(".plan-text");
    expect(text?.textContent).toBe(PLAN.plan);
    expect(text?.querySelector("b")).toBeNull(); // agent text is never parsed as HTML
    await expect
      .element(page.getByRole("button", { name: "Hide plan" }))
      .toHaveAttribute("aria-expanded", "true");
    await expect.element(page.getByText(/shortened/)).not.toBeInTheDocument();
  });

  it("notes a truncated plan and collapses again for the next plan dialog", async () => {
    const r = await render(ViewportTermBanners, {
      ...baseProps,
      plan: { ...PLAN, truncated: true },
    });
    await page.getByRole("button", { name: "Show plan" }).click();
    await expect.element(page.getByText(/shortened/)).toBeVisible();
    await r.rerender({ ...baseProps, plan: { ...PLAN, toolUseId: "toolu_q" } });
    await expect.element(page.getByRole("button", { name: "Show plan" })).toBeVisible();
    expect(document.querySelector(".plan-text")).toBeNull();
  });

  it("wears the shared top-strip chrome from the parent", async () => {
    render(ViewportTermBanners, { ...baseProps, plan: PLAN, authUrl: AUTH_URL });
    await expect.element(page.getByRole("button", { name: "Show plan" })).toBeVisible();
    const [plan, auth] = document.querySelectorAll<HTMLElement>(".auth-banner");
    expect(plan.classList.contains("plan-banner")).toBe(true);
    expect(getComputedStyle(plan).backgroundColor).toBe(getComputedStyle(auth).backgroundColor);
    expect(getComputedStyle(plan, "::after").animationName).not.toBe("none");
  });

  it("renders nothing without a plan or off the term tab", async () => {
    const r = await render(ViewportTermBanners, { ...baseProps, plan: PLAN, tab: "diff" });
    expect(document.querySelector(".plan-banner")).toBeNull();
    await r.rerender({ ...baseProps, plan: null });
    expect(document.querySelector(".plan-banner")).toBeNull();
  });
});
