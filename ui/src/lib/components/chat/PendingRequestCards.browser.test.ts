import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";

const resolveLoginRequest = vi.fn().mockResolvedValue(undefined);
const resolveGhPermissionRequest = vi.fn().mockResolvedValue(undefined);
vi.mock("#lib/api.js", async (orig) => ({
  ...(await orig<typeof import("#lib/api.js")>()),
  resolveLoginRequest: (...a: unknown[]) => resolveLoginRequest(...a),
  resolveGhPermissionRequest: (...a: unknown[]) => resolveGhPermissionRequest(...a),
}));
const toastInfo = vi.fn();
vi.mock("#lib/toasts.svelte.js", async (orig) => {
  const mod = await orig<typeof import("#lib/toasts.svelte.js")>();
  return { ...mod, toasts: { ...mod.toasts, info: (...a: unknown[]) => toastInfo(...a) } };
});

const { ApiError } = await import("#lib/api.js");
const { default: PendingRequestCards } = await import("./PendingRequestCards.svelte");

const GH = {
  id: "gr1",
  permission: "workflows" as const,
  reason: "Push the <b>CI</b> change",
  files: [".github/workflows/a.yml", ".github/workflows/b.yml", "c.yml", "d.yml", "e.yml"],
  createdAt: 1,
};
const LOGIN = {
  id: "lr1",
  url: "https://login.example/",
  reason: "Need the dashboard session",
  createdAt: 1,
};
const base = { sessionId: "s1", loginRequest: null, ghPermissionRequest: null, openBrowser: null };

afterEach(() => {
  document.body.innerHTML = "";
  resolveLoginRequest.mockReset().mockResolvedValue(undefined);
  resolveGhPermissionRequest.mockReset().mockResolvedValue(undefined);
  toastInfo.mockReset();
});

describe("PendingRequestCards gh permission", () => {
  it("shows title, plain-text reason and the first 3 files with a +N more", async () => {
    render(PendingRequestCards, { ...base, ghPermissionRequest: GH });
    await expect
      .element(page.getByText("Agent needs the GitHub workflows permission to push"))
      .toBeVisible();
    await expect.element(page.getByText("Push the <b>CI</b> change")).toBeVisible();
    expect(document.querySelector(".ac-notice b")).toBeNull();
    await expect
      .element(page.getByText(".github/workflows/a.yml, .github/workflows/b.yml, c.yml +2 more"))
      .toBeVisible();
  });

  it("Grant / Deny answer the request", async () => {
    render(PendingRequestCards, { ...base, ghPermissionRequest: GH });
    await page.getByRole("button", { name: "Grant" }).click();
    expect(resolveGhPermissionRequest).toHaveBeenCalledWith("s1", "granted");
    await page.getByRole("button", { name: "Deny" }).click();
    expect(resolveGhPermissionRequest).toHaveBeenLastCalledWith("s1", "denied");
  });

  it("disables the buttons while an answer is in flight", async () => {
    let release!: () => void;
    resolveGhPermissionRequest.mockReturnValue(new Promise<void>((r) => (release = r)));
    render(PendingRequestCards, { ...base, ghPermissionRequest: GH });
    await page.getByRole("button", { name: "Grant" }).click();
    await expect.element(page.getByRole("button", { name: "Grant" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Deny" })).toBeDisabled();
    release();
    await expect.element(page.getByRole("button", { name: "Grant" })).toBeEnabled();
  });

  it("shows the server's error inline; a 404 counts as done", async () => {
    resolveGhPermissionRequest.mockRejectedValueOnce(
      new ApiError(409, "App installation lacks workflows", "mint-failed", true),
    );
    render(PendingRequestCards, { ...base, ghPermissionRequest: GH });
    await page.getByRole("button", { name: "Grant" }).click();
    await expect
      .element(page.getByRole("alert").getByText("App installation lacks workflows"))
      .toBeVisible();
    resolveGhPermissionRequest.mockRejectedValueOnce(new ApiError(404, "gone"));
    await page.getByRole("button", { name: "Grant" }).click();
    await expect
      .element(page.getByText("App installation lacks workflows"))
      .not.toBeInTheDocument();
  });
});

describe("PendingRequestCards login request", () => {
  it("shows url + reason and answers Done / Cancel", async () => {
    render(PendingRequestCards, { ...base, loginRequest: LOGIN });
    await expect.element(page.getByText("The agent wants you to log in")).toBeVisible();
    await expect.element(page.getByText("https://login.example/")).toBeVisible();
    await expect.element(page.getByText("Need the dashboard session")).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    expect(resolveLoginRequest).toHaveBeenCalledWith("s1", "done");
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(resolveLoginRequest).toHaveBeenLastCalledWith("s1", "cancelled");
  });

  it("Open browser calls openBrowser; hidden without a Browser tab", async () => {
    const openBrowser = vi.fn();
    const r = await render(PendingRequestCards, { ...base, loginRequest: LOGIN, openBrowser });
    await page.getByRole("button", { name: "Open browser" }).click();
    expect(openBrowser).toHaveBeenCalledOnce();
    await r.rerender({ ...base, loginRequest: LOGIN, openBrowser: null });
    await expect
      .element(page.getByRole("button", { name: "Open browser" }))
      .not.toBeInTheDocument();
  });

  it("toasts a non-404 answer failure", async () => {
    resolveLoginRequest.mockRejectedValueOnce(new ApiError(500, "boom"));
    render(PendingRequestCards, { ...base, loginRequest: LOGIN });
    await page.getByRole("button", { name: "Done" }).click();
    await vi.waitFor(() => expect(toastInfo).toHaveBeenCalledOnce());
  });
});

it("renders nothing without an open request", async () => {
  render(PendingRequestCards, base);
  expect(document.querySelector(".ac-notice")).toBeNull();
});
