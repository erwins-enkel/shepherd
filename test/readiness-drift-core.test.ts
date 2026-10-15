import { describe, expect, test } from "bun:test";
import {
  claudeMdPins,
  compareLine,
  dependabotBumps,
  driftRows,
  lowestLine,
  parseCargoToml,
  parsePackageJson,
  renderUpgradeStory,
  resolverState,
  trackedDeclared,
  trackedKeys,
  UPGRADE_STORY_MARKER,
} from "../src/readiness-drift-core";
import { DEFAULT_HOUSE_STACK, renderHouseStackRules } from "../src/house-stack";

describe("lowestLine", () => {
  test.each([
    ["^2.70.0", "2"],
    ["~2", "2"],
    ["2.x", "2"],
    [">= 2.1 <4", "2"],
    ["^1.0.0 || ^2.0.0", "1"],
    ["1.2.3 - 2.3.4", "1"],
    ["v3.0.1", "3"],
    ["^0.4.1", "0.4"],
    ["0.x", "0.0"],
    ["=1.0.3", "1"],
    [">=1.2, <2", "1"],
  ])("%s → %s", (range, line) => expect(lowestLine(range)).toBe(line));

  test.each(["*", "latest", "workspace:^1", "file:../x", "github:a/b", "npm:foo@^2", "<4", ""])(
    "%s → null",
    (range) => expect(lowestLine(range)).toBeNull(),
  );
});

describe("compareLine", () => {
  test("majors and 0.x minors", () => {
    expect(compareLine("2", "3")).toBeLessThan(0);
    expect(compareLine("3", "3")).toBe(0);
    expect(compareLine("0.4", "0.5")).toBeLessThan(0);
    expect(compareLine("0.9", "1")).toBeLessThan(0);
  });
});

describe("parsePackageJson", () => {
  test("all dep sections + packageManager; skips non-version specs", () => {
    const text = JSON.stringify({
      dependencies: { svelte: "^4.2.0", local: "workspace:*" },
      devDependencies: { "@sveltejs/kit": "^2.70.0" },
      peerDependencies: { vite: ">=5" },
      packageManager: "bun@1.2.3+sha256.abc",
    });
    expect(parsePackageJson(text, "ui/package.json")).toEqual([
      { ecosystem: "npm", name: "svelte", line: "4", manifest: "ui/package.json" },
      { ecosystem: "npm", name: "@sveltejs/kit", line: "2", manifest: "ui/package.json" },
      { ecosystem: "npm", name: "vite", line: "5", manifest: "ui/package.json" },
      { ecosystem: "npm", name: "bun", line: "1", manifest: "ui/package.json" },
    ]);
  });

  test("invalid JSON → []", () => expect(parsePackageJson("{", "package.json")).toEqual([]));
});

describe("parseCargoToml", () => {
  test("string + table specs, renames, workspace deps; skips path-only", () => {
    const text = `
[dependencies]
serde = "1.0"
tokio = { version = "0.4", features = ["full"] }
local = { path = "../local" }
renamed = { package = "clap", version = "3" }

[dev-dependencies]
insta = "=1.2.0"

[workspace.dependencies]
axum = "0.7"
`;
    expect(parseCargoToml(text, "Cargo.toml").map((d) => `${d.name}@${d.line}`)).toEqual([
      "serde@1",
      "tokio@0.4",
      "clap@3",
      "insta@1",
      "axum@0.7",
    ]);
  });

  test("invalid TOML → []", () => expect(parseCargoToml("[[[", "Cargo.toml")).toEqual([]));
});

describe("claudeMdPins", () => {
  test("reads the format renderHouseStackRules writes", () => {
    const { claudeMd } = renderHouseStackRules({
      ok: true,
      resolvedAt: "2026-10-15T00:00:00.000Z",
      npm: [
        { name: "@sveltejs/kit", version: "3.0.1" },
        { name: "svelte", version: "5.1.0" },
      ],
      crates: [{ name: "serde", version: "1.0.200" }],
      rustToolchain: "1.90.0",
    });
    expect(claudeMdPins(claudeMd)).toEqual({ npm: ["@sveltejs/kit", "svelte"], crates: ["serde"] });
  });
});

describe("trackedDeclared", () => {
  test("keeps tracked packages only, grouped, sorted", () => {
    const tracked = trackedKeys(DEFAULT_HOUSE_STACK, { npm: ["zod"], crates: [] });
    const out = trackedDeclared(
      [
        { ecosystem: "npm", name: "svelte", line: "4", manifest: "a" },
        { ecosystem: "npm", name: "lodash", line: "4", manifest: "a" },
        { ecosystem: "npm", name: "zod", line: "3", manifest: "a" },
        { ecosystem: "npm", name: "svelte", line: "5", manifest: "b" },
      ],
      tracked,
    );
    expect(out.map((p) => p.name)).toEqual(["svelte", "zod"]);
    expect(out[0]!.declarations).toHaveLength(2);
  });
});

describe("dependabotBumps", () => {
  test("cross-line bumps by tracked name; skips same-line, other kinds, grouped", () => {
    const pr = (number: number, title: string, kind = "dependabot") => ({
      number,
      url: `u${number}`,
      title,
      kind,
    });
    const out = dependabotBumps([
      pr(124, "chore(deps): bump @sveltejs/kit from 2.70.0 to 3.0.1 in /ui"),
      pr(125, "Bump svelte from 5.1.0 to 5.2.0"),
      pr(126, "Bump the npm group across 1 directory with 3 updates"),
      pr(127, "bump vite from 5.0.0 to 6.0.0", "regular"),
    ]);
    expect([...out.keys()]).toEqual(["@sveltejs/kit"]);
    expect(out.get("@sveltejs/kit")).toEqual([
      { number: 124, url: "u124", from: "2.70.0", to: "3.0.1" },
    ]);
  });
});

describe("driftRows", () => {
  const pkgs = trackedDeclared(
    [
      { ecosystem: "npm", name: "@sveltejs/kit", line: "2", manifest: "ui/package.json" },
      { ecosystem: "npm", name: "@sveltejs/kit", line: "3", manifest: "site/package.json" },
      { ecosystem: "npm", name: "svelte", line: "5", manifest: "ui/package.json" },
      { ecosystem: "npm", name: "vite", line: "6", manifest: "ui/package.json" },
    ],
    trackedKeys(DEFAULT_HOUSE_STACK, { npm: [], crates: [] }),
  );

  test("behind / ok / unknown; behind lists lagging manifests", () => {
    const latest = new Map<string, string | null>([
      ["npm:@sveltejs/kit", "3.0.1"],
      ["npm:svelte", "5.3.0"],
      ["npm:vite", null],
    ]);
    const bump = { number: 1, url: "u", from: "2.70.0", to: "3.0.1" };
    const rows = driftRows(pkgs, latest, new Map([["@sveltejs/kit", [bump]]]));
    expect(rows.map((r) => [r.name, r.state, r.installed, r.target])).toEqual([
      ["@sveltejs/kit", "behind", "2", "3"],
      ["svelte", "ok", "5", "5"],
      ["vite", "unknown", "6", null],
    ]);
    expect(rows[0]!.manifests).toEqual(["ui/package.json"]);
    expect(rows[0]!.dependabot).toEqual([bump]);
    expect(resolverState(rows)).toBe("partial");
  });

  test("all lookups failed → offline, nothing behind", () => {
    const rows = driftRows(pkgs, new Map(), new Map());
    expect(rows.every((r) => r.state === "unknown")).toBe(true);
    expect(resolverState(rows)).toBe("offline");
    expect(resolverState([])).toBe("none");
  });
});

describe("renderUpgradeStory", () => {
  test("title, packages, epic branches, marker", () => {
    const row = {
      ecosystem: "npm" as const,
      name: "@sveltejs/kit",
      installed: "2",
      latest: "3.0.1",
      target: "3",
      state: "behind" as const,
      manifests: ["package.json"],
      dependabot: [{ number: 124, url: "u", from: "2.70.0", to: "3.0.1" }],
    };
    const { title, body } = renderUpgradeStory([row], ["epic/7-foo"]);
    expect(title).toBe("Upgrade framework majors: @sveltejs/kit 2 → 3");
    expect(body).toContain(
      "`@sveltejs/kit` (npm): 2 → 3 (latest 3.0.1) in `package.json` (Dependabot #124)",
    );
    expect(body).toContain("- `epic/7-foo`");
    expect(body).toContain(UPGRADE_STORY_MARKER);
    const many = renderUpgradeStory([row, row, row, row], []);
    expect(many.title.endsWith(", …")).toBe(true);
    expect(many.body).not.toContain("epic branches");
  });
});
