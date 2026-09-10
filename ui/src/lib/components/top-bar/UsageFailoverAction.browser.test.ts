import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import UsageFailoverAction from "./UsageFailoverAction.svelte";
import { m } from "$lib/paraglide/messages";

const OFFER = { from: "codex", to: "claude", fromFreePct: 23, toFreePct: 79 } as const;
const ACTIVE = { active: true, from: "codex", current: "claude" } as const;

const props = (over: Partial<Record<string, unknown>> = {}) => ({
  offer: null,
  failover: null,
  busy: false,
  failed: false,
  onEngage: vi.fn(),
  onRelease: vi.fn(),
  ...over,
});

describe("UsageFailoverAction", () => {
  it("renders nothing with neither an offer nor an active failover", () => {
    render(UsageFailoverAction, { props: props() });
    expect(document.querySelector(".failover")).toBeNull();
  });

  it("offers the switch and names the target CLI", async () => {
    render(UsageFailoverAction, { props: props({ offer: OFFER }) });
    await expect
      .element(
        page.getByRole("button", {
          name: m.usage_failover_engage({ provider: m.agent_provider_claude() }),
        }),
      )
      .toBeVisible();
  });

  it("states both providers and both percentages, so it cannot contradict the hero", async () => {
    render(UsageFailoverAction, { props: props({ offer: OFFER }) });
    const reason = document.querySelector(".failover-reason")!.textContent!;
    expect(reason).toContain("23");
    expect(reason).toContain("79");
    expect(reason).toContain(m.agent_provider_codex());
    expect(reason).toContain(m.agent_provider_claude());
  });

  it("clicking the offer engages", async () => {
    const onEngage = vi.fn();
    render(UsageFailoverAction, { props: props({ offer: OFFER, onEngage }) });
    await page
      .getByRole("button", {
        name: m.usage_failover_engage({ provider: m.agent_provider_claude() }),
      })
      .click();
    expect(onEngage).toHaveBeenCalledTimes(1);
  });

  it("an active failover shows the revert instead of the offer", async () => {
    const onRelease = vi.fn();
    render(UsageFailoverAction, { props: props({ offer: OFFER, failover: ACTIVE, onRelease }) });
    await page
      .getByRole("button", {
        name: m.usage_failover_revert({ provider: m.agent_provider_codex() }),
      })
      .click();
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it("disables the button while a request is in flight", () => {
    render(UsageFailoverAction, { props: props({ offer: OFFER, busy: true }) });
    expect(document.querySelector<HTMLButtonElement>(".failover-btn")!.disabled).toBe(true);
  });

  it("surfaces a refused switch as an alert", async () => {
    render(UsageFailoverAction, { props: props({ offer: OFFER, failed: true }) });
    await expect.element(page.getByRole("alert")).toHaveTextContent(m.usage_failover_failed());
  });
});
