import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import { m } from "$lib/paraglide/messages";
import { putSettings } from "$lib/api";

// Onboarding never fetches diagnostics itself (checks arrive as a prop); the picker step
// does call listDirs/putSettings via DirPicker/Onboarding, so stub those two.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    listDirs: vi.fn(async (path?: string) => ({
      path: path ?? "/home",
      display: path ?? "~",
      parent: path ? "/" : null,
      entries: [],
    })),
    putSettings: vi.fn(async (repoRoot: string) => ({
      repoRoot,
      repoRootDisplay: repoRoot,
      firstRunPending: false,
    })),
  };
});

const { default: Onboarding } = await import("./Onboarding.svelte");

const mockPutSettings = vi.mocked(putSettings);

describe("Onboarding — blocking first-run picker", () => {
  beforeEach(() => vi.clearAllMocks());

  it("non-blocking mode shows Dismiss and skips the picker", async () => {
    const ondismiss = vi.fn();
    render(Onboarding, { checks: null, ondismiss });

    await expect
      .element(page.getByRole("button", { name: m.onboarding_dismiss() }))
      .toBeInTheDocument();
    expect(page.getByRole("button", { name: m.onboarding_pick_root_confirm() }).query()).toBeNull();

    await page.getByRole("button", { name: m.onboarding_dismiss() }).click();
    expect(ondismiss).toHaveBeenCalledOnce();
  });

  it("blocking mode hides Dismiss, requires a pick, and calls putSettings + onpicked", async () => {
    const ondismiss = vi.fn();
    const onpicked = vi.fn();
    render(Onboarding, {
      checks: null,
      ondismiss,
      blocking: true,
      repoRoot: "/home",
      repoRootDisplay: "~",
      settingsLoaded: true,
      onpicked,
    });

    // No Dismiss escape hatch while blocking.
    expect(page.getByRole("button", { name: m.onboarding_dismiss() }).query()).toBeNull();

    const confirm = page.getByRole("button", { name: m.onboarding_pick_root_confirm() });
    await expect.element(confirm).toBeInTheDocument();
    // Enabled once the initial directory listing resolves.
    await expect.poll(() => confirm.element().hasAttribute("disabled")).toBe(false);

    await confirm.click();
    expect(mockPutSettings).toHaveBeenCalledWith("/home");
    await expect.poll(() => onpicked.mock.calls.length).toBe(1);
    expect(onpicked).toHaveBeenCalledWith("/home");

    // Escape must not invoke the dismiss handler while blocking.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(ondismiss).not.toHaveBeenCalled();
  });
});
