import { describe, it, expect, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import type { SlashCommand } from "$lib/types";

const { default: SlashCommandMenu } = await import("./SlashCommandMenu.svelte");

afterEach(() => {
  document.body.innerHTML = "";
});

function command(
  name: string,
  providers: NonNullable<SlashCommand["providers"]>,
  description = "",
): SlashCommand {
  return {
    id: `test:${providers.join("+")}:${name}`,
    name,
    displayName: name,
    description,
    scope: "user",
    kind: "skill",
    invocationName: name,
    sourceNamespace: "test",
    providers,
    invocations: Object.fromEntries(
      providers.map((p) => [p, p === "codex" ? `$${name}` : `/${name}`]),
    ) as SlashCommand["invocations"],
  };
}

describe("SlashCommandMenu", () => {
  it("shows a Codex invocation for a Codex-only row even under a Claude-preferred menu", () => {
    render(SlashCommandMenu, {
      commands: [command("codex-only", ["codex"])],
      activeIndex: 0,
      provider: "claude",
      onpick: () => {},
      onhover: () => {},
    });

    expect(document.querySelector(".sc-name")?.textContent).toBe("$codex-only");
  });

  it("keeps the preferred provider display for rows available in both providers", () => {
    render(SlashCommandMenu, {
      commands: [command("shared", ["claude", "codex"])],
      activeIndex: 0,
      provider: "claude",
      onpick: () => {},
      onhover: () => {},
    });

    expect(document.querySelector(".sc-name")?.textContent).toBe("/shared");
  });
});

// The row clamps the description to one line (`.sc-desc` is nowrap + ellipsis), so the
// hover tooltip is the only way to read what a command actually does.
describe("SlashCommandMenu description tooltip", () => {
  const LONG =
    "Review the changes since a fixed point (commit, branch, tag, or merge-base) along " +
    "two axes — Standards (does the code follow this repo's documented coding standards?) " +
    "and Spec (does the code match what the originating issue asked for?).";

  const desc = () => document.querySelector(".sc-desc") as HTMLElement;
  const tip = () => document.querySelector(".status-tip:popover-open");
  // statusTip dismisses on scroll/resize, and the browser-test harness emits both while
  // the container settles after mount — so retry the hover until it sticks rather than
  // hovering once and racing the harness.
  const hover = (el: HTMLElement) =>
    vi.waitFor(() => {
      el.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse", bubbles: true }));
      expect(tip()).not.toBeNull();
    });

  async function renderOne(description: string, onpick: (cmd: SlashCommand) => void = () => {}) {
    render(SlashCommandMenu, {
      commands: [command("code-review", ["claude"], description)],
      activeIndex: 0,
      provider: "claude",
      onpick,
      onhover: () => {},
    });
    // The harness emits scroll/resize while the container settles after mount, and
    // statusTip dismisses on both — let that pass before any hover.
    await new Promise((r) => setTimeout(r, 300));
  }

  it("hovering the clipped description reveals the full text in a wide tooltip", async () => {
    await renderOne(LONG);
    // The DOM already carries the full string — only CSS clips it — so the tooltip's job
    // is purely to make it visible.
    expect(desc().textContent).toBe(LONG);

    await hover(desc());
    expect(tip()?.textContent).toBe(LONG);
    expect(tip()?.getAttribute("role")).toBe("tooltip");
    // Prose variant: the 260px status width would stack this into ~20 lines.
    expect(tip()?.classList.contains("status-tip-wide")).toBe(true);
  });

  it("keeps the row pickable while the pointer sits on the description", async () => {
    const picked: string[] = [];
    await renderOne(LONG, (cmd) => picked.push(cmd.name));

    await hover(desc());
    desc().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(picked).toEqual(["code-review"]);
  });

  // The server sends descriptions uncapped, so the panel is height-bounded and scrolls.
  // statusTip otherwise closes on any scroll — which would make an overlong description
  // impossible to finish reading.
  it("survives a scroll raised inside the panel, but still closes on a page scroll", async () => {
    await renderOne("sentence. ".repeat(200).trim());
    await hover(desc());
    const panel = tip() as HTMLElement;
    expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight); // actually overflowing

    panel.dispatchEvent(new Event("scroll", { bubbles: false }));
    await new Promise((r) => setTimeout(r, 30));
    expect(tip()).not.toBeNull();

    document.dispatchEvent(new Event("scroll", { bubbles: false }));
    await vi.waitFor(() => expect(tip()).toBeNull());
  });

  it("renders no description row — and no tooltip — for a command without one", async () => {
    await renderOne("");
    expect(desc()).toBeNull();

    // Plain dispatch, not the retrying `hover` helper — nothing is expected to open here.
    document
      .querySelector(".sc-row")!
      .dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse", bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(tip()).toBeNull();
  });
});
