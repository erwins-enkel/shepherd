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
});
