import { describe, it, expect, beforeEach } from "vitest";

// Stub localStorage before importing the module so the singleton's read() at init doesn't touch
// a real or missing localStorage. (Mirrors herd-width.svelte.test.ts.)
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    for (const k of Object.keys(store)) delete store[k];
  },
};
// @ts-expect-error stubbing global
globalThis.localStorage = localStorageMock;

import { assistantLayout, parseAssistantLayout } from "./assistant-layout.svelte";

const KEY = "shepherd:assistant-layout";

beforeEach(() => {
  assistantLayout.set("standard");
  localStorageMock.clear();
});

describe("parseAssistantLayout", () => {
  it("keeps a known layout", () => {
    expect(parseAssistantLayout("half")).toBe("half");
    expect(parseAssistantLayout("wide")).toBe("wide");
    expect(parseAssistantLayout("talk")).toBe("talk");
  });

  it("falls back to standard for a missing or unknown value", () => {
    expect(parseAssistantLayout(null)).toBe("standard");
    expect(parseAssistantLayout("")).toBe("standard");
    expect(parseAssistantLayout("sideways")).toBe("standard");
  });
});

describe("assistantLayout", () => {
  it("persists a picked layout and clears the key for standard", () => {
    assistantLayout.set("wide");
    expect(assistantLayout.layout).toBe("wide");
    expect(localStorageMock.getItem(KEY)).toBe("wide");

    assistantLayout.set("standard");
    expect(assistantLayout.layout).toBe("standard");
    expect(localStorageMock.getItem(KEY)).toBeNull();
  });

  it("unfolds talk back to the layout picked before it", () => {
    assistantLayout.set("half");
    assistantLayout.set("talk");
    assistantLayout.unfold();
    expect(assistantLayout.layout).toBe("half");
  });

  it("unfolds to standard when talk was picked from it", () => {
    assistantLayout.set("talk");
    assistantLayout.unfold();
    expect(assistantLayout.layout).toBe("standard");
  });

  it("leaves any other layout alone on unfold", () => {
    assistantLayout.set("half");
    assistantLayout.set("wide");
    assistantLayout.unfold();
    expect(assistantLayout.layout).toBe("wide");
  });
});
