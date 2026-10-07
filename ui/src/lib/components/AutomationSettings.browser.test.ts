import { describe, it, expect, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { tick } from "svelte";
import "../../app.css";
import AutomationSettings from "./AutomationSettings.svelte";
import { infoTips } from "$lib/info-tips.svelte";
import { m } from "$lib/paraglide/messages";
import { repoConfig } from "$lib/reviews.svelte";
import { toasts } from "$lib/toasts.svelte";

afterEach(() => infoTips.set(false));

// The ⓘ explainers are toggled with `hidden`, not {#if}, so a collapsed detail block is
// ALREADY in the DOM. An "is it absent when tips are hidden?" assertion would therefore pass
// even with no guard at all. Every test below expands the row FIRST, then hides tips, then
// asserts the block is gone from the DOM — which is what makes the assertion bite.
const sandboxTip = () =>
  document.querySelector<HTMLButtonElement>('button[aria-controls="auto-detail-sandbox"]');
const sandboxDetail = () => document.querySelector<HTMLElement>(".sandbox-detail");
const criticTip = () =>
  document.querySelector<HTMLButtonElement>('button[aria-controls="auto-detail-critic"]');
const criticDetail = () => document.querySelector<HTMLElement>("#auto-detail-critic");

// The panel is mounted once per test; wait for the critic switch so we know it has rendered.
async function mount() {
  render(AutomationSettings, { repoPath: "/tmp/repo" });
  await expect
    .element(page.getByRole("switch", { name: m.automation_critic_name() }))
    .toBeVisible();
}

describe("AutomationSettings — hide-info-tips preference", () => {
  it("sandbox row: expanded detail is removed outright when tips are hidden", async () => {
    await mount();

    // Expand the sandbox explainer for real, so the block is genuinely visible.
    expect(sandboxTip()).not.toBeNull();
    sandboxTip()!.click();
    await tick();
    expect(sandboxDetail()!.hidden).toBe(false);

    infoTips.set(true);
    await tick();

    // The sandbox explainer is hand-written rather than emitted by {#snippet detail}, so it
    // needs its own guard — without it the ⓘ would vanish and strand these two paragraphs.
    expect(sandboxTip()).toBeNull();
    expect(sandboxDetail()).toBeNull();
    expect(page.getByText(m.automation_sandbox_profile_caveats()).query()).toBeNull();
  });

  it("snippet-driven row: expanded detail is removed outright when tips are hidden", async () => {
    await mount();

    expect(criticTip()).not.toBeNull();
    criticTip()!.click();
    await tick();
    expect(criticDetail()!.hidden).toBe(false);

    infoTips.set(true);
    await tick();

    expect(criticTip()).toBeNull();
    expect(criticDetail()).toBeNull();
  });

  it("no ⓘ survives anywhere when tips are hidden", async () => {
    infoTips.set(true);
    await mount();

    expect(document.querySelectorAll("button.info")).toHaveLength(0);
    expect(document.querySelectorAll(".auto-detail")).toHaveLength(0);
  });

  it("re-enabling tips restores a cleanly collapsed panel (no stale expansion)", async () => {
    await mount();

    sandboxTip()!.click();
    await tick();
    expect(sandboxDetail()!.hidden).toBe(false);

    infoTips.set(true);
    await tick(); // let the $effect observe the flip before re-enabling

    infoTips.set(false);
    await tick();

    // openDetail is component-local state that survives the flip without a remount; the
    // $effect reset is what stops the row coming back still expanded.
    expect(sandboxTip()).not.toBeNull();
    expect(sandboxDetail()!.hidden).toBe(true);
  });

  it("renders the ⓘ affordances by default (preference off)", async () => {
    await mount();

    expect(document.querySelectorAll("button.info").length).toBeGreaterThan(0);
    expect(sandboxDetail()).not.toBeNull();
  });
});

describe("AutomationSettings — Open shared browser", () => {
  const REPO = "/tmp/repo";
  const openButton = () => page.getByRole("button", { name: m.automation_shared_browser_open() });

  afterEach(() => {
    vi.unstubAllGlobals();
    repoConfig.sharedBrowser = {};
    for (const t of toasts.items) toasts.close(t.id);
  });

  // Only the open endpoint is faked; every other request the panel makes keeps its real path.
  const realFetch = globalThis.fetch;
  function stubFetch(open: () => Response) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "/api/repo-browser/open" ? open() : realFetch(input, init),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("is shown only while the toggle is on", async () => {
    stubFetch(() => Response.json({ ok: true, url: "about:blank" }));
    repoConfig.sharedBrowser = { [REPO]: false };
    await mount();
    expect(openButton().query()).toBeNull();
    repoConfig.sharedBrowser = { [REPO]: true };
    await expect.element(openButton()).toBeVisible();
  });

  it("calls the open endpoint with the repo and session", async () => {
    const fetchMock = stubFetch(() => Response.json({ ok: true, url: "about:blank" }));
    repoConfig.sharedBrowser = { [REPO]: true };
    render(AutomationSettings, { repoPath: REPO, sessionId: "sess-1" });
    await expect.element(openButton()).toBeVisible();
    (openButton().element() as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/repo-browser/open")).toBe(true),
    );
    const call = fetchMock.mock.calls.find(([u]) => String(u) === "/api/repo-browser/open")!;
    const init = (call as unknown as [string, RequestInit])[1];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ repo: REPO, sessionId: "sess-1" });
    expect(toasts.items).toEqual([]);
  });

  it("maps a refusal code to a toast", async () => {
    stubFetch(() => Response.json({ error: "cap", code: "cap" }, { status: 503 }));
    repoConfig.sharedBrowser = { [REPO]: true };
    await mount();
    (openButton().element() as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(toasts.items.map((t) => t.text)).toEqual([m.automation_shared_browser_open_cap()]),
    );
  });
});
