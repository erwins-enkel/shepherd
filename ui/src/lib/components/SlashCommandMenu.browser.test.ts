import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import type { SlashCommand } from "$lib/types";

const { default: SlashCommandMenu } = await import("./SlashCommandMenu.svelte");

afterEach(() => {
  document.body.innerHTML = "";
});

function command(name: string, providers: NonNullable<SlashCommand["providers"]>): SlashCommand {
  return {
    id: `test:${providers.join("+")}:${name}`,
    name,
    displayName: name,
    description: "",
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
