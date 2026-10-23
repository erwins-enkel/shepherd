import { afterEach, describe, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../../app.css";
import type { EpicChild } from "#lib/types.js";
import { THEMES, expectQuietLegible } from "#lib/test-support/contrast.js";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, getRepoConfig: vi.fn(async () => ({})) };
});

const { default: EpicRunSteps } = await import("./EpicRunSteps.svelte");
const { default: EpicChildSteps } = await import("./EpicChildSteps.svelte");

function child(over: Partial<EpicChild>): EpicChild {
  return {
    number: 1,
    title: "c",
    url: "u",
    order: 0,
    body: "",
    blockedBy: [],
    state: "ready",
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    claimed: false,
    ...over,
  };
}

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.body.innerHTML = "";
});

// #3283: slate (--status-done) is 3.0:1 on the panel — "done" words in the epic steps read
// muted instead.
describe("epic steps done-word contrast", () => {
  for (const theme of THEMES) {
    it(`EpicRunSteps keeps 'complete' legible and un-green: ${theme}`, async () => {
      document.documentElement.dataset.theme = theme;
      render(EpicRunSteps, {
        repoPath: `/repo/steps-${theme}`,
        steps: {
          kind: "winding",
          slots: { used: 0, max: 2 },
          now: [],
          leftBehind: 0,
          handover: null,
          leader: null,
        },
        titleFor: () => null,
      });
      expectQuietLegible(document.querySelector<HTMLElement>(".done")!);
    });

    it(`EpicChildSteps keeps a merged sibling chip legible and un-green: ${theme}`, async () => {
      document.documentElement.dataset.theme = theme;
      const merged = child({ number: 2, state: "merged" });
      render(EpicChildSteps, {
        child: child({ number: 3, blockedBy: [2] }),
        siblings: [merged],
        titleFor: () => null,
      });
      expectQuietLegible(document.querySelector<HTMLElement>(".chip.tone-done")!);
    });
  }
});
