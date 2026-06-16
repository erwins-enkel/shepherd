import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import { m } from "$lib/paraglide/messages";
import { pwaDocLink } from "$lib/diagnostics-docs";
import type { PwaRowState } from "$lib/pwa";

// PwaInstallRow reads pwaRowState() on mount (browser-only); mock it so each test
// can drive the row into a specific state.
const state = vi.hoisted(() => ({ value: "optional" as PwaRowState }));
vi.mock("$lib/pwa", async (importOriginal) => {
  const orig = await importOriginal<typeof import("$lib/pwa")>();
  return { ...orig, pwaRowState: () => state.value };
});

import PwaInstallRow from "./PwaInstallRow.svelte";

beforeEach(() => {
  state.value = "optional";
  document.body.innerHTML = "";
});

describe("pwaDocLink", () => {
  it("returns a help URL for ios and android", () => {
    expect(pwaDocLink("ios")).toContain("support.apple.com");
    expect(pwaDocLink("android")).toContain("support.google.com");
  });
  it("returns undefined for optional and installed (nothing wrong → no link)", () => {
    expect(pwaDocLink("optional")).toBeUndefined();
    expect(pwaDocLink("installed")).toBeUndefined();
  });
});

describe("PwaInstallRow learn-more link", () => {
  it("renders a Learn more link with the right href on ios", async () => {
    state.value = "ios";
    render(PwaInstallRow);
    const link = document.querySelector<HTMLAnchorElement>("a.doc-link");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe(pwaDocLink("ios"));
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.textContent).toContain(m.diagnostics_learn_more());
  });

  it("renders a Learn more link with the right href on android", async () => {
    state.value = "android";
    render(PwaInstallRow);
    const link = document.querySelector<HTMLAnchorElement>("a.doc-link");
    expect(link?.getAttribute("href")).toBe(pwaDocLink("android"));
  });

  it("renders NO link on optional", async () => {
    state.value = "optional";
    render(PwaInstallRow);
    expect(document.querySelector("a.doc-link")).toBeNull();
  });

  it("renders NO link on installed", async () => {
    state.value = "installed";
    render(PwaInstallRow);
    expect(document.querySelector("a.doc-link")).toBeNull();
  });
});
