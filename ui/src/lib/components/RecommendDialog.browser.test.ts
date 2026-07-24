import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import { m } from "$lib/paraglide/messages";

// The dialog fires recommendPrompt from an $effect on mount (the real call spawns a
// second agent), so stub the API before rendering.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    recommendPrompt: vi.fn(async () => ({ prompt: "next: run the tests" })),
  };
});

const { default: RecommendDialog } = await import("./RecommendDialog.svelte");

const props = (model: string) => ({
  sessionId: "s1",
  provider: "claude" as const,
  model,
  onclose: () => {},
});

describe("RecommendDialog header", () => {
  // The header names the model the recommendation run is ABOUT to use, so it takes the
  // configured label — a floating alias reads "Opus (latest)", not the bare token a
  // session card shows. Reverting the swap to modelLabel() renders "opus" and fails this.
  it("labels a floating alias as the latest of its tier", async () => {
    render(RecommendDialog, props("opus"));

    await expect
      .element(page.getByText(`${m.recommend_title()} · ${m.model_configured_opus_latest()}`))
      .toBeVisible();
  });

  // A pinned model name is version-stable, so it reads the same on every surface.
  it("labels a pinned model by its version", async () => {
    render(RecommendDialog, props("claude-opus-5"));

    await expect
      .element(page.getByText(`${m.recommend_title()} · ${m.model_label_opus_5()}`))
      .toBeVisible();
  });
});
