import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { m } from "#lib/paraglide/messages.js";
import { reviews, repoConfig } from "#lib/reviews.svelte.js";
import type { AutoMergeStatus, GitState, MergeWaitCode } from "#lib/types.js";
import AutoMergeBanner from "./AutoMergeBanner.svelte";

const ID = "s1";
const REPO = "/r";

const git = (): GitState => ({
  kind: "github",
  state: "open",
  number: 335,
  url: "https://github.com/o/r/pull/335",
  checks: "success",
  deployConfigured: false,
  headSha: "4fba4eef7b56773fc2e159104f1826a0a337b20b",
});

const status = (code: MergeWaitCode | null): AutoMergeStatus => ({
  repoPath: REPO,
  enabled: true,
  state: null,
  detail: null,
  sessionId: null,
  waiting: code ? [{ sessionId: ID, code }] : [],
});

function mount(code: MergeWaitCode | null, over: Record<string, unknown> = {}) {
  let owned = false;
  const props = {
    sessionId: ID,
    repoPath: REPO,
    git: git(),
    status: status(code),
    tab: "term",
    stripTaken: false,
    handedBack: false,
    get owned() {
      return owned;
    },
    set owned(v: boolean) {
      owned = v;
    },
    ...over,
  };
  render(AutoMergeBanner, props);
  return { owned: () => owned };
}

const banner = () => document.querySelector<HTMLElement>(".am-banner");

beforeEach(() => {
  reviews.reviewing = {};
  reviews.reviewerEnv = {};
  repoConfig.autoAddress = {};
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("AutoMergeBanner", () => {
  it("running critic: Shepherd-owned and dims (the review banner shows its progress)", async () => {
    reviews.reviewing = { [ID]: true };
    const h = mount("critic_pending");
    await expect.poll(() => banner()?.dataset.owner).toBe("shepherd");
    expect(banner()!.textContent).toContain(m.automergebanner_shepherd_lead());
    expect(h.owned()).toBe(true);
  });

  it("pending verdict without a running critic: strip shows, terminal is not dimmed", async () => {
    const h = mount("critic_pending");
    await expect
      .poll(() => banner()?.textContent ?? "")
      .toContain(m.automergebanner_critic_pending({ sha: "4fba4ee" }));
    expect(h.owned()).toBe(false);
  });

  it("critic error: amber operator strip, no dimming", async () => {
    const h = mount("critic_error");
    await expect.poll(() => banner()?.dataset.owner).toBe("operator");
    expect(banner()!.textContent).toContain(m.automergebanner_operator_lead());
    expect(banner()!.textContent).toContain(m.automergebanner_critic_error());
    expect(h.owned()).toBe(false);
  });

  it("branch protection on a green PR: amber operator strip, no dimming", async () => {
    const h = mount("protection_blocked");
    await expect.poll(() => banner()?.dataset.owner).toBe("operator");
    expect(banner()!.textContent).toContain(m.automergebanner_protection_blocked());
    expect(h.owned()).toBe(false);
  });

  it("autopilot handed back: amber operator strip saying so, no dimming", async () => {
    const h = mount("checks_failed", { handedBack: true });
    await expect.poll(() => banner()?.dataset.owner).toBe("operator");
    expect(banner()!.textContent).toContain(m.automergebanner_handed_back());
    expect(h.owned()).toBe(false);
  });

  it("yields the bottom strip to the review / CI banner but still dims", async () => {
    const h = mount("checks_pending", { stripTaken: true });
    await expect.poll(() => h.owned()).toBe(true);
    expect(banner()).toBeNull();
  });

  it("renders nothing when the train does not hold this PR or off the terminal tab", async () => {
    mount(null);
    mount("behind", { tab: "diff" });
    await new Promise((r) => setTimeout(r, 20));
    expect(banner()).toBeNull();
  });

  it("phone width: wraps so the reason after the dash is never clipped", async () => {
    const [w, h] = [window.innerWidth, window.innerHeight];
    await page.viewport(360, 800);
    try {
      mount("protection_blocked");
      await expect.poll(() => banner()).not.toBeNull();
      const text = banner()!.querySelector<HTMLElement>(".am-text")!;
      expect(text.textContent).toContain(m.automergebanner_protection_blocked());
      expect(getComputedStyle(text).whiteSpace).not.toBe("nowrap");
      expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth);
    } finally {
      await page.viewport(w, h);
    }
  });

  it("offers the structured full auto-merge explanation", async () => {
    mount("behind");
    await expect
      .poll(() => banner()?.querySelector(`[aria-label="${m.automergebanner_tip_title()}"]`))
      .not.toBeNull();
  });

  it("no checks (no_ci / checks_absent): amber strip with a Merge-without-CI action (#3221)", async () => {
    for (const code of ["no_ci", "checks_absent"] as const) {
      mount(code);
      await expect.poll(() => banner()?.dataset.owner).toBe("operator");
      expect(banner()!.querySelector(".am-merge")?.textContent).toBe(
        m.automergebanner_merge_without_ci(),
      );
      document.body.innerHTML = "";
    }
  });

  it("other codes offer no merge action", async () => {
    mount("critic_error");
    await expect.poll(() => banner()?.dataset.owner).toBe("operator");
    expect(banner()!.querySelector(".am-merge")).toBeNull();
  });
});
