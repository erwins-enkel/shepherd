import { afterEach, describe, expect, it } from "vitest";
import { m } from "#lib/paraglide/messages.js";
import { setLocale } from "#lib/paraglide/runtime.js";
import { repoSettingsSearchEntries, searchRepoSettings } from "./search";
import { REPO_SETTINGS_SECTIONS, sectionLabel } from "./sections";

afterEach(() => setLocale("en", { reload: false }));

describe("repo settings search", () => {
  it("does not return results for empty or whitespace queries", () => {
    expect(searchRepoSettings("")).toEqual([]);
    expect(searchRepoSettings("  \n")).toEqual([]);
  });

  it("matches names, descriptions and sections without case sensitivity", () => {
    const entries = repoSettingsSearchEntries();
    const entry = entries.find((e) => e.field === "criticEnabled")!;
    expect(searchRepoSettings(`  ${entry.name.toUpperCase()}  `)).toContainEqual(entry);
    expect(searchRepoSettings(entry.description)).toContainEqual(entry);
    const q = sectionLabel("review").toLowerCase();
    expect(searchRepoSettings(q)).toEqual(
      entries.filter((e) =>
        [e.name, e.description, e.section ? sectionLabel(e.section) : ""].some((text) =>
          text.toLowerCase().includes(q),
        ),
      ),
    );
    expect(searchRepoSettings("zzzz_no_such_setting")).toEqual([]);
  });

  it("covers every section with unique targets in stable section order", () => {
    const entries = repoSettingsSearchEntries();
    expect(new Set(entries.map((e) => e.field)).size).toBe(entries.length);
    expect([...new Set(entries.flatMap((e) => (e.section ? [e.section] : [])))]).toEqual([
      ...REPO_SETTINGS_SECTIONS,
    ]);
    expect(entries.find((e) => e.field === "egressExtraHosts")?.fallbackField).toBe(
      "sandboxProfile",
    );
    expect(entries.find((e) => e.field === "browserAllowedHosts")?.fallbackField).toBe(
      "sharedBrowserEnabled",
    );
    expect(entries.find((e) => e.field === "signoffAuthority")?.fallbackField).toBe("draftMode");
  });

  for (const locale of ["en", "de"] as const) {
    it(`uses current ${locale} labels`, () => {
      setLocale(locale, { reload: false });
      expect(
        searchRepoSettings(m.automation_sandbox_profile_label()).some(
          (e) => e.field === "sandboxProfile",
        ),
      ).toBe(true);
      expect(repoSettingsSearchEntries().find((e) => e.field === "schedules")?.name).toBe(
        m.schedules_title(),
      );
    });
  }
});
