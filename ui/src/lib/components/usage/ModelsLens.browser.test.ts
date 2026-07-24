import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../../app.css";
import { m } from "$lib/paraglide/messages";
import { formatTokenLabel } from "$lib/format";
import ModelsLens from "./ModelsLens.svelte";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ModelsLens", () => {
  it("renders independent provider totals, top six plus Other, and exact displayed 100% sums", () => {
    render(ModelsLens, {
      models: {
        claude: {
          totalTokens: 3600,
          byModel: {
            "claude-opus-4-8": 1000,
            "claude-sonnet-4-5": 800,
            "claude-haiku-4-5": 600,
            fable: 400,
            alpha: 300,
            beta: 200,
            gamma: 150,
            delta: 150,
          },
          byRole: {
            coding: {
              "claude-opus-4-8": 1000,
              "claude-sonnet-4-5": 800,
              "claude-haiku-4-5": 600,
              fable: 400,
              alpha: 300,
              beta: 200,
              gamma: 150,
              delta: 150,
            },
          },
        },
        codex: { totalTokens: 1000, byModel: { "gpt-5.5": 700, unknown: 300 }, byRole: {} },
      },
    });

    const claude = document.querySelector<HTMLElement>('[data-provider="claude"]')!;
    const codex = document.querySelector<HTMLElement>('[data-provider="codex"]')!;
    expect(claude.textContent).toContain("Opus 4.8");
    expect(claude.textContent).toContain(m.usage_models_other());
    expect(claude.querySelectorAll(".model-list li")).toHaveLength(7);
    expect(codex.textContent).toContain("GPT-5.5");
    expect(codex.textContent).toContain(formatTokenLabel(1000));
    expect(codex.querySelector(".role-unavailable")).not.toBeNull();
    expect(document.querySelectorAll('[role="img"]')).toHaveLength(2);

    for (const block of [claude, codex]) {
      const sum = [...block.querySelectorAll<HTMLElement>(".model-pct")].reduce(
        (total, node) => total + Number.parseFloat(node.textContent ?? "0"),
        0,
      );
      expect(sum).toBeCloseTo(100, 10);
    }
  });

  it("shows a provider-specific zero total and no misleading bar for empty data", () => {
    render(ModelsLens, {
      models: {
        claude: { totalTokens: 0, byModel: {}, byRole: {} },
        codex: { totalTokens: 0, byModel: {}, byRole: {} },
      },
    });

    expect(document.querySelectorAll('[role="img"]')).toHaveLength(0);
    expect(document.querySelectorAll(".empty")).toHaveLength(2);
    expect(document.body.textContent).toContain(formatTokenLabel(0));
  });

  it("uses locale-independent slug ordering at the top-six boundary", () => {
    render(ModelsLens, {
      models: {
        claude: {
          totalTokens: 700,
          byModel: {
            alpha: 100,
            beta: 100,
            delta: 100,
            epsilon: 100,
            gamma: 100,
            omega: 100,
            Zulu: 100,
          },
          byRole: {
            coding: {
              alpha: 100,
              beta: 100,
              delta: 100,
              epsilon: 100,
              gamma: 100,
              omega: 100,
              Zulu: 100,
            },
          },
        },
        codex: { totalTokens: 0, byModel: {}, byRole: {} },
      },
    });

    const claude = document.querySelector<HTMLElement>('[data-provider="claude"]')!;
    const modelList = claude.querySelector<HTMLElement>(".model-list")!;
    expect(modelList.textContent).toContain("Zulu");
    expect(modelList.textContent).not.toContain("Omega");
  });

  it("expands Claude roles into models with provider and role percentages", () => {
    render(ModelsLens, {
      models: {
        claude: {
          totalTokens: 500,
          byModel: { "claude-opus-4-8": 200, "claude-sonnet-4-5": 300 },
          byRole: {
            coding: { "claude-sonnet-4-5": 300 },
            review: { "claude-opus-4-8": 100 },
            plan_gate: { "claude-opus-4-8": 100 },
          },
        },
        codex: { totalTokens: 0, byModel: {}, byRole: {} },
      },
    });

    const claude = document.querySelector<HTMLElement>('[data-provider="claude"]')!;
    const roles = claude.querySelectorAll<HTMLDetailsElement>(".role-detail");
    expect(roles).toHaveLength(3);
    expect([...roles].map((role) => role.dataset.role)).toEqual(["coding", "review", "plan_gate"]);

    const planGate = claude.querySelector<HTMLDetailsElement>('[data-role="plan_gate"]')!;
    expect(planGate.querySelector("summary")?.textContent).toContain("20.0%");
    planGate.querySelector<HTMLElement>("summary")!.click();
    expect(planGate.open).toBe(true);

    const modelRow = planGate.querySelector<HTMLElement>(".role-model-row")!;
    expect(modelRow.textContent).toContain("Opus 4.8");
    expect(modelRow.textContent).toContain("100.0%");
    expect(modelRow.textContent).toContain(formatTokenLabel(100));
  });
});
