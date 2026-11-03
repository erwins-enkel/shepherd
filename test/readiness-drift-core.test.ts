import { describe, expect, test } from "bun:test";
import {
  admitsLine,
  claudeMdPins,
  compareLine,
  dependabotBumps,
  dependabotMajorHolds,
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

describe("admitsLine", () => {
  test.each([
    ["^8.57.0 || ^9.0.0", "9"],
    [">=5", "7"],
    ["> 4", "5"],
    [">=1.2, <3.1", "3"],
    ["<=3 >=2", "3"],
    ["1.2.3 - 3.0.0", "3"],
    ["^3.0.0", "3"],
    ["3.x", "3"],
    ["~0.4.1", "0.4"],
    ["0.x", "0.7"],
  ])("%s admits %s", (range, target) => expect(admitsLine(range, target)).toBe(true));

  test.each([
    ["^8.57.0", "9"],
    ["~2", "3"],
    [">=5 <9", "9"],
    [">=5 <9.0.0", "9"],
    ["1.2.3 - 2.9.0", "3"],
    ["^0.4.1", "0.5"],
    ["^4", "3"],
  ])("%s does not admit %s", (range, target) => expect(admitsLine(range, target)).toBe(false));
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
      { ecosystem: "npm", name: "svelte", line: "4", spec: "^4.2.0", manifest: "ui/package.json" },
      {
        ecosystem: "npm",
        name: "@sveltejs/kit",
        line: "2",
        spec: "^2.70.0",
        manifest: "ui/package.json",
      },
      { ecosystem: "npm", name: "vite", line: "5", spec: ">=5", manifest: "ui/package.json" },
      { ecosystem: "npm", name: "bun", line: "1", spec: "1.2.3", manifest: "ui/package.json" },
    ]);
  });

  test("npm aliases declare the aliased package; unversioned aliases are skipped", () => {
    const text = JSON.stringify({
      devDependencies: {
        "@typescript/native": "npm:typescript@^7.0.2",
        "kit-next": "npm:@sveltejs/kit@^3.1.0",
        bare: "npm:typescript",
        tagged: "npm:typescript@latest",
      },
    });
    expect(parsePackageJson(text, "package.json")).toEqual([
      {
        ecosystem: "npm",
        name: "typescript",
        line: "7",
        spec: "^7.0.2",
        manifest: "package.json",
        aliased: true,
      },
      {
        ecosystem: "npm",
        name: "@sveltejs/kit",
        line: "3",
        spec: "^3.1.0",
        manifest: "package.json",
        aliased: true,
      },
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
        { ecosystem: "npm", name: "svelte", line: "4", spec: "^4", manifest: "a" },
        { ecosystem: "npm", name: "lodash", line: "4", spec: "^4", manifest: "a" },
        { ecosystem: "npm", name: "zod", line: "3", spec: "^3", manifest: "a" },
        { ecosystem: "npm", name: "svelte", line: "5", spec: "^5", manifest: "b" },
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

describe("dependabotMajorHolds", () => {
  const config = (ecosystem: string, ignore: string) =>
    `version: 2\nupdates:\n  - package-ecosystem: "${ecosystem}"\n    directory: "/"\n    ignore:\n${ignore}`;

  test("exact name with semver-major, or with nothing narrowing it, is a hold", () => {
    const major =
      '      - dependency-name: "typescript"\n        update-types: ["version-update:semver-major"]\n';
    const everything = '      - dependency-name: "svelte"\n';
    expect([...dependabotMajorHolds(config("npm", major + everything))]).toEqual([
      "npm:typescript",
      "npm:svelte",
    ]);
  });

  test("semver-major alongside versions still holds", () => {
    const both =
      '      - dependency-name: "typescript"\n        versions: [">=9"]\n        update-types: ["version-update:semver-major"]\n';
    expect([...dependabotMajorHolds(config("npm", both))]).toEqual(["npm:typescript"]);
  });

  test("maps bun → npm and cargo → crates; other ecosystems never hold", () => {
    const entry = '      - dependency-name: "serde"\n';
    expect([...dependabotMajorHolds(config("bun", entry))]).toEqual(["npm:serde"]);
    expect([...dependabotMajorHolds(config("cargo", entry))]).toEqual(["crates:serde"]);
    expect([...dependabotMajorHolds(config("github-actions", entry))]).toEqual([]);
  });

  test("globs, minor-only and versions-only ignores are not holds", () => {
    const entries = [
      '      - dependency-name: "*"\n        update-types: ["version-update:semver-major"]\n',
      '      - dependency-name: "@types/*"\n',
      '      - dependency-name: "typescript"\n        update-types: ["version-update:semver-minor"]\n',
      '      - dependency-name: "typescript"\n        versions: ["7.x"]\n',
      '      - dependency-name: "typescript"\n        update-types: "version-update:semver-minor"\n',
    ].join("");
    expect([...dependabotMajorHolds(config("npm", entries))]).toEqual([]);
  });

  test("malformed or shapeless config → no holds", () => {
    for (const text of [
      "",
      "updates: [",
      "version: 2",
      "updates: nope",
      "updates:\n  - nope",
      'updates:\n  - package-ecosystem: "npm"\n    ignore: nope',
      'updates:\n  - package-ecosystem: "npm"\n    ignore:\n      - nope',
    ]) {
      expect(dependabotMajorHolds(text).size).toBe(0);
    }
  });
});

describe("driftRows", () => {
  const pkgs = trackedDeclared(
    [
      {
        ecosystem: "npm",
        name: "@sveltejs/kit",
        line: "2",
        spec: "^2",
        manifest: "ui/package.json",
      },
      {
        ecosystem: "npm",
        name: "@sveltejs/kit",
        line: "3",
        spec: "^3",
        manifest: "site/package.json",
      },
      { ecosystem: "npm", name: "svelte", line: "5", spec: "^5", manifest: "ui/package.json" },
      { ecosystem: "npm", name: "vite", line: "6", spec: "^6", manifest: "ui/package.json" },
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

  test("a declaration ahead of stable (prerelease major) is not behind", () => {
    const pkgs = trackedDeclared(
      [
        {
          ecosystem: "npm",
          name: "@sveltejs/kit",
          line: lowestLine("^3.0.0-next.4")!,
          spec: "^3.0.0-next.4",
          manifest: "package.json",
        },
      ],
      trackedKeys(DEFAULT_HOUSE_STACK, { npm: [], crates: [] }),
    );
    const rows = driftRows(pkgs, new Map([["npm:@sveltejs/kit", "2.70.0"]]), new Map());
    expect(rows[0]).toMatchObject({ state: "ok", installed: "3", target: "2" });
  });

  test("a range already admitting the target line is not behind (peer || / open >=)", () => {
    const decl = (spec: string, line: string, manifest: string) => ({
      ecosystem: "npm" as const,
      name: "vite",
      line,
      spec,
      manifest,
    });
    const tracked = trackedKeys(DEFAULT_HOUSE_STACK, { npm: [], crates: [] });
    const latest = new Map([["npm:vite", "9.1.0"]]);
    const peers = trackedDeclared(
      [decl("^8.57.0 || ^9.0.0", "8", "package.json"), decl("^9", "9", "package.json")],
      tracked,
    );
    expect(driftRows(peers, latest, new Map())[0]).toMatchObject({ state: "ok" });
    const open = trackedDeclared([decl(">=5", "5", "package.json")], tracked);
    expect(driftRows(open, latest, new Map())[0]).toMatchObject({ state: "ok" });
    const capped = trackedDeclared(
      [decl(">=5 <9", "5", "a/package.json"), decl("^8 || ^9", "8", "b/package.json")],
      tracked,
    );
    expect(driftRows(capped, latest, new Map())[0]).toMatchObject({
      state: "behind",
      installed: "5",
      manifests: ["a/package.json"],
    });
  });

  describe("intentional holds", () => {
    const tracked = trackedKeys(DEFAULT_HOUSE_STACK, { npm: ["typescript"], crates: [] });
    const manifest = (deps: Record<string, string>, path = "package.json") =>
      parsePackageJson(JSON.stringify({ devDependencies: deps }), path);
    const bridge = { typescript: "~6.0.3", "@typescript/native": "npm:typescript@^7.0.2" };
    const rowFor = (
      declared: ReturnType<typeof parsePackageJson>,
      version: string,
      holds?: Set<string>,
    ) =>
      driftRows(
        trackedDeclared(declared, tracked),
        new Map([["npm:typescript", version]]),
        new Map(),
        holds,
      )[0]!;

    test("alias on the target line holds the lagging sibling", () => {
      expect(rowFor(manifest(bridge), "7.0.2")).toMatchObject({
        state: "held",
        hold: "alias",
        installed: "6",
        target: "7",
        manifests: ["package.json"],
      });
    });

    test("a lagging alias beside a current direct declaration is held too", () => {
      const legacy = { typescript: "^7.0.0", "ts-legacy": "npm:typescript@^5.0.0" };
      expect(rowFor(manifest(legacy), "7.0.2")).toMatchObject({
        state: "held",
        hold: "alias",
        installed: "5",
      });
    });

    test("an alias on the target line holds every lagging sibling", () => {
      const both = { ...bridge, "ts-legacy": "npm:typescript@^5.0.0" };
      expect(rowFor(manifest(both), "7.0.2")).toMatchObject({
        state: "held",
        hold: "alias",
        installed: "5",
      });
    });

    test("a lagging alias holds only itself: a direct lagging sibling stays behind", () => {
      const declared = parsePackageJson(
        JSON.stringify({
          peerDependencies: { typescript: ">=5" },
          devDependencies: { typescript: "~6.0.3", "ts-legacy": "npm:typescript@^5.0.0" },
        }),
        "package.json",
      );
      expect(rowFor(declared, "7.0.2")).toMatchObject({
        state: "behind",
        hold: null,
        installed: "6",
        manifests: ["package.json"],
      });
    });

    test("an alias below the target holds nothing", () => {
      expect(rowFor(manifest(bridge), "8.0.0")).toMatchObject({
        state: "behind",
        hold: null,
        installed: "6",
      });
    });

    test("a lone lagging alias is behind", () => {
      const lone = { "ts-old": "npm:typescript@^6.0.0" };
      expect(rowFor(manifest(lone), "7.0.2")).toMatchObject({ state: "behind", installed: "6" });
    });

    test("an alias only holds its own manifest", () => {
      const declared = [
        ...manifest(bridge, "a/package.json"),
        ...manifest({ typescript: "^5.0.0" }, "b/package.json"),
      ];
      expect(rowFor(declared, "7.0.2")).toMatchObject({
        state: "behind",
        hold: null,
        installed: "5",
        manifests: ["b/package.json"],
      });
    });

    test("a current direct sibling without an alias holds nothing", () => {
      const declared = [
        ...parsePackageJson(
          JSON.stringify({
            peerDependencies: { typescript: "^6.0.0" },
            devDependencies: { typescript: "^7.0.0" },
          }),
          "package.json",
        ),
      ];
      expect(rowFor(declared, "7.0.2")).toMatchObject({ state: "behind", hold: null });
    });

    test("a Dependabot major hold covers every lagging declaration", () => {
      const declared = [
        ...manifest({ typescript: "~6.0.3" }, "a/package.json"),
        ...manifest({ typescript: "^5.0.0" }, "b/package.json"),
      ];
      const row = rowFor(declared, "7.0.2", new Set(["npm:typescript"]));
      expect(row).toMatchObject({ state: "held", hold: "dependabot", installed: "5" });
      expect(row.manifests).toEqual(["a/package.json", "b/package.json"]);
    });

    test("alias wins as the reason when both signals apply", () => {
      expect(rowFor(manifest(bridge), "7.0.2", new Set(["npm:typescript"]))).toMatchObject({
        state: "held",
        hold: "alias",
      });
    });

    test("alias reason needs every lagging declaration alias-held", () => {
      const declared = [
        ...manifest(bridge, "a/package.json"),
        ...manifest({ typescript: "^5.0.0" }, "b/package.json"),
      ];
      expect(rowFor(declared, "7.0.2", new Set(["npm:typescript"]))).toMatchObject({
        state: "held",
        hold: "dependabot",
      });
    });

    test("a current or unknown package never reports a hold", () => {
      const holds = new Set(["npm:typescript"]);
      expect(rowFor(manifest({ typescript: "^7.0.0" }), "7.0.2", holds)).toMatchObject({
        state: "ok",
        hold: null,
      });
      const unknown = driftRows(
        trackedDeclared(manifest(bridge), tracked),
        new Map(),
        new Map(),
        holds,
      )[0];
      expect(unknown).toMatchObject({ state: "unknown", hold: null });
    });

    test("held never counts as unknown for the resolver", () => {
      expect(resolverState([rowFor(manifest(bridge), "7.0.2")])).toBe("ok");
    });
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
      hold: null,
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
