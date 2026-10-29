import { expect, test } from "bun:test";
import {
  normalizeStoredAssistantRuntime,
  parseAssistantRuntimePatch,
  resolveAssistantRuntime,
} from "../src/operator-assistant-settings";

const seed = () => normalizeStoredAssistantRuntime(null, { model: "opus", effort: "high" });

test("HUD defaults snapshot Claude preferences, without following subsequent coding changes", () => {
  const initial = seed();
  expect(initial.claude).toEqual({ model: "opus", effort: "high" });
  expect(
    normalizeStoredAssistantRuntime(JSON.stringify(initial), { model: "sonnet", effort: null }),
  ).toEqual(initial);
});

test("partial patches retain the other provider and reject incompatible choices", () => {
  const parsed = parseAssistantRuntimePatch({ codex: { model: "gpt-6-astra" } }, seed());
  expect(parsed).toMatchObject({
    ok: true,
    value: {
      claude: { model: "opus", effort: "high" },
      codex: { model: "gpt-6-astra", effort: null },
    },
  });
  for (const patch of [
    { claude: { model: "gpt-6-astra" } },
    { codex: { model: "opus" } },
    { enabled: "yes" },
    { unknown: true },
    { claude: { effort: "ultra" } },
  ]) {
    expect(parseAssistantRuntimePatch(patch, seed()).ok).toBe(false);
  }
});

test("provider resolution respects preference, availability, disabled and fallback", () => {
  const settings = seed();
  expect(resolveAssistantRuntime(settings, {}).provider).toBe("claude");
  expect(resolveAssistantRuntime(settings, { claude: "missing" })).toMatchObject({
    provider: "codex",
    fallback: "missing",
  });
  expect(
    resolveAssistantRuntime({ ...settings, automaticFallback: false }, { claude: "missing" })
      .provider,
  ).toBeNull();
  expect(resolveAssistantRuntime({ ...settings, enabled: false }, {}).reason).toBe("disabled");
  expect(
    resolveAssistantRuntime(settings, { claude: "capacity", codex: "capacity" }).provider,
  ).toBeNull();
});

test("only fresh confirmed capacity stops the preferred provider", async () => {
  const { assistantProviderExhausted } = await import("../src/operator-assistant-settings");
  const now = Date.now();
  const limits = {
    observed: { session5h: { pct: 100, resetAt: now + 1000, scrapedAt: now }, week: null },
  } as any;
  expect(assistantProviderExhausted(limits, "claude", now)).toBe(true);
  expect(assistantProviderExhausted(limits, "claude", now + 3_600_000)).toBe(false);
  expect(assistantProviderExhausted(null, "claude", now)).toBe(false);
});

test("migration never carries a GPT coding default into the Claude HUD runtime", () => {
  expect(
    normalizeStoredAssistantRuntime(null, { model: "gpt-6-astra", effort: "high" }).claude,
  ).toEqual({ model: null, effort: "high" });
});

test("a corrupt provider field never re-enables a disabled saved HUD", () => {
  expect(
    normalizeStoredAssistantRuntime(JSON.stringify({ enabled: false, codex: { model: 42 } }))
      .enabled,
  ).toBe(false);
});
