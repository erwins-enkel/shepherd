import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitForge, Issue, PullRequest } from "../src/forge/types";
import {
  DEFAULT_HOUSE_STACK,
  type HouseStack,
  type HouseStackResolution,
} from "../src/house-stack";
import {
  createUpgradeStory,
  frameworkDrift,
  UpgradeStoryNotApplicableError,
  type DriftDeps,
} from "../src/readiness-drift";
import { UPGRADE_STORY_MARKER } from "../src/readiness-drift-core";
import { PRIORITY_LABEL } from "../src/drain-core";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drift-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(rel: string, content: unknown) {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
}

/** Resolver answering from a fixed table; a missing name fails like an offline registry. */
function resolver(versions: Record<string, string>): DriftDeps["resolver"] {
  return {
    async resolve(stack: HouseStack): Promise<HouseStackResolution> {
      const name = stack.npm[0] ?? stack.crates[0]!;
      const eco = stack.npm.length ? "npm" : "crates";
      const version = versions[name];
      if (!version) return { ok: false, errors: [{ ecosystem: eco, name, reason: "timed out" }] };
      return {
        ok: true,
        resolvedAt: "2026-10-15T00:00:00.000Z",
        npm: eco === "npm" ? [{ name, version }] : [],
        crates: eco === "crates" ? [{ name, version }] : [],
        rustToolchain: null,
        swift: [],
        swiftToolchain: null,
      };
    },
  };
}

interface FakeForge {
  forge: GitForge;
  created: { title: string; body: string }[];
  labels: [number, string][];
  issues: Issue[];
}

function fakeForge(o: { prs?: Partial<PullRequest>[]; issues?: Partial<Issue>[] } = {}): FakeForge {
  const f: FakeForge = {
    created: [],
    labels: [],
    issues: (o.issues ?? []) as Issue[],
    forge: null as unknown as GitForge,
  };
  f.forge = {
    isFork: false,
    listPullRequests: async () => (o.prs ?? []) as PullRequest[],
    listIssues: async () => f.issues,
    createIssue: async (i: { title: string; body: string }) => {
      f.created.push(i);
      const n = 200 + f.created.length;
      f.issues.push({ number: n, url: `u${n}`, body: i.body } as Issue);
      return { number: n, url: `u${n}` };
    },
    addIssueLabel: async (n: number, label: string) => {
      f.labels.push([n, label]);
    },
  } as unknown as GitForge;
  return f;
}

const deps = (over: Partial<DriftDeps> = {}): DriftDeps => ({
  resolver: resolver({ "@sveltejs/kit": "3.0.1", svelte: "5.3.0" }),
  forge: null,
  houseStack: DEFAULT_HOUSE_STACK,
  autoLabel: "shepherd",
  runningEpic: null,
  listEpicBranches: async () => [],
  ...over,
});

describe("frameworkDrift", () => {
  test("major behind → behind row (nested manifest, Dependabot signal)", async () => {
    write("ui/package.json", { devDependencies: { "@sveltejs/kit": "^2.70.0", svelte: "^5.0.0" } });
    write("node_modules/x/package.json", { dependencies: { svelte: "^3.0.0" } });
    const f = fakeForge({
      prs: [
        {
          number: 124,
          url: "pr124",
          title: "Bump @sveltejs/kit from 2.70.0 to 3.0.1",
          kind: "dependabot",
        },
      ],
    });
    const out = await frameworkDrift(dir, deps({ forge: f.forge, runningEpic: 9 }));
    expect(out.rows.map((r) => [r.name, r.state])).toEqual([
      ["@sveltejs/kit", "behind"],
      ["svelte", "ok"],
    ]);
    expect(out.rows[0]!.manifests).toEqual(["ui/package.json"]);
    expect(out.rows[0]!.dependabot.map((b) => b.number)).toEqual([124]);
    expect(out.resolver).toBe("ok");
    expect(out.canCreateStory).toBe(true);
    expect(out.runningEpic).toBe(9);
  });

  test("library peer range admitting the current major → no warning", async () => {
    write("package.json", {
      peerDependencies: { eslint: "^8.57.0 || ^9.0.0", vite: ">=5" },
      devDependencies: { eslint: "^9.0.0", vite: "^7.0.0" },
    });
    const out = await frameworkDrift(
      dir,
      deps({ resolver: resolver({ eslint: "9.30.0", vite: "7.1.0" }) }),
    );
    expect(out.rows.map((r) => [r.name, r.state])).toEqual([
      ["eslint", "ok"],
      ["vite", "ok"],
    ]);
  });

  test("up to date → no behind rows", async () => {
    write("package.json", { dependencies: { "@sveltejs/kit": "^3.0.0" } });
    const out = await frameworkDrift(dir, deps());
    expect(out.rows.map((r) => r.state)).toEqual(["ok"]);
    expect(out.canCreateStory).toBe(false);
  });

  test("offline resolver → unknown, never behind", async () => {
    write("package.json", { dependencies: { "@sveltejs/kit": "^2.0.0" } });
    const throwing: DriftDeps["resolver"] = {
      resolve: () => Promise.reject(new Error("ENOTFOUND")),
    };
    for (const r of [resolver({}), throwing]) {
      const out = await frameworkDrift(dir, deps({ resolver: r }));
      expect(out.rows.map((x) => x.state)).toEqual(["unknown"]);
      expect(out.resolver).toBe("offline");
    }
  });

  test("CLAUDE.md pins extend the tracked set; untracked deps ignored", async () => {
    write(
      "CLAUDE.md",
      "## Pinned stack\n\n- Use `zod@3` (npm, resolved 3.1.0 on 2026-01-01), NEVER an older version.\n",
    );
    write("package.json", { dependencies: { zod: "^3.0.0", lodash: "^3.0.0" } });
    const out = await frameworkDrift(dir, deps({ resolver: resolver({ zod: "4.0.0" }) }));
    expect(out.rows.map((r) => [r.name, r.state])).toEqual([["zod", "behind"]]);
  });

  test("Cargo crates from the House Stack", async () => {
    write("Cargo.toml", '[dependencies]\naxum = "0.7"\n');
    const stack = { ...DEFAULT_HOUSE_STACK, crates: ["axum"] };
    const out = await frameworkDrift(
      dir,
      deps({ houseStack: stack, resolver: resolver({ axum: "0.8.1" }) }),
    );
    expect(out.rows.map((r) => [r.name, r.installed, r.target, r.state])).toEqual([
      ["axum", "0.7", "0.8", "behind"],
    ]);
  });

  describe("intentional holds", () => {
    const pinTypescript = () =>
      write(
        "CLAUDE.md",
        "## Pinned stack\n\n- Use `typescript@7` (npm, resolved 7.0.2 on 2026-11-02), NEVER an older version.\n",
      );
    const tsDeps = () => deps({ resolver: resolver({ typescript: "7.0.2" }) });
    const stateOf = async () =>
      (await frameworkDrift(dir, tsDeps())).rows.map((r) => [r.state, r.hold]);
    const ignore = (entry: string, ecosystem = "npm") =>
      `version: 2\nupdates:\n  - package-ecosystem: "${ecosystem}"\n    directory: "/"\n    schedule:\n      interval: "daily"\n    ignore:\n      - ${entry}\n`;
    const majorEntry =
      'dependency-name: "typescript"\n        update-types: ["version-update:semver-major"]';

    beforeEach(pinTypescript);

    test("hundesport: TypeScript API bridge + npm-aliased TypeScript 7 → held", async () => {
      write("package.json", {
        devDependencies: {
          typescript: "~6.0.3",
          "@typescript/native": "npm:typescript@^7.0.2",
        },
      });
      expect(await stateOf()).toEqual([["held", "alias"]]);
    });

    test.each(["dependabot.yml", "dependabot.yaml"])(
      "%s semver-major ignore → held",
      async (file) => {
        write("package.json", { devDependencies: { typescript: "~6.0.3" } });
        write(`.github/${file}`, ignore(majorEntry));
        expect(await stateOf()).toEqual([["held", "dependabot"]]);
      },
    );

    test("blanket, minor-only, versions-only and foreign-ecosystem ignores stay behind", async () => {
      write("package.json", { devDependencies: { typescript: "~6.0.3" } });
      for (const config of [
        ignore('dependency-name: "*"\n        update-types: ["version-update:semver-major"]'),
        ignore(
          'dependency-name: "typescript"\n        update-types: ["version-update:semver-minor"]',
        ),
        ignore('dependency-name: "typescript"\n        versions: ["7.x"]'),
        ignore(majorEntry, "github-actions"),
      ]) {
        write(".github/dependabot.yml", config);
        expect(await stateOf()).toEqual([["behind", null]]);
      }
    });

    test("malformed dependabot.yml → still behind, no throw", async () => {
      write("package.json", { devDependencies: { typescript: "~6.0.3" } });
      write(".github/dependabot.yml", "updates: [");
      expect(await stateOf()).toEqual([["behind", null]]);
    });

    test("only held rows → no upgrade story", async () => {
      write("package.json", {
        devDependencies: {
          typescript: "~6.0.3",
          "@typescript/native": "npm:typescript@^7.0.2",
        },
      });
      const f = fakeForge();
      await expect(createUpgradeStory(dir, { ...tsDeps(), forge: f.forge })).rejects.toThrow(
        new UpgradeStoryNotApplicableError("no_drift"),
      );
      expect(f.created).toEqual([]);
    });
  });

  test("no tracked packages → resolver none", async () => {
    const out = await frameworkDrift(dir, deps());
    expect(out.rows).toEqual([]);
    expect(out.resolver).toBe("none");
  });
});

describe("createUpgradeStory", () => {
  beforeEach(() => write("package.json", { dependencies: { "@sveltejs/kit": "^2.70.0" } }));

  test("files the story with auto + priority labels and epic branches; dedupes", async () => {
    const f = fakeForge();
    const d = deps({ forge: f.forge, listEpicBranches: async () => ["epic/3114-x"] });
    const first = await createUpgradeStory(dir, d);
    expect(first).toEqual({ status: "created", number: 201, url: "u201" });
    expect(f.created[0]!.title).toBe("Upgrade framework majors: @sveltejs/kit 2 → 3");
    expect(f.created[0]!.body).toContain("`epic/3114-x`");
    expect(f.created[0]!.body).toContain(UPGRADE_STORY_MARKER);
    expect(f.labels).toEqual([
      [201, "shepherd"],
      [201, PRIORITY_LABEL],
    ]);
    const second = await createUpgradeStory(dir, d);
    expect(second).toEqual({ status: "exists", number: 201, url: "u201" });
    expect(f.created).toHaveLength(1);
    expect((await frameworkDrift(dir, d)).openStory).toEqual({ number: 201, url: "u201" });
  });

  test("label failure still reports created", async () => {
    const f = fakeForge();
    (f.forge as { addIssueLabel: unknown }).addIssueLabel = async () => {
      throw new Error("422");
    };
    expect((await createUpgradeStory(dir, deps({ forge: f.forge }))).status).toBe("created");
  });

  test("no drift / no forge / fork → not applicable", async () => {
    const f = fakeForge();
    const upToDate = deps({ forge: f.forge, resolver: resolver({ "@sveltejs/kit": "2.80.0" }) });
    await expect(createUpgradeStory(dir, upToDate)).rejects.toThrow(UpgradeStoryNotApplicableError);
    await expect(createUpgradeStory(dir, deps())).rejects.toThrow(UpgradeStoryNotApplicableError);
    (f.forge as { isFork: boolean }).isFork = true;
    await expect(createUpgradeStory(dir, deps({ forge: f.forge }))).rejects.toThrow(
      UpgradeStoryNotApplicableError,
    );
    expect(f.created).toHaveLength(0);
  });
});

test("Package.swift: a tracked package a major behind is reported, untracked ones aren't", async () => {
  write(
    "Package.swift",
    `.package(url: "https://github.com/Acme/Kit.git", from: "1.0.0"),
     .package(url: "https://github.com/acme/other", from: "1.0.0"),`,
  );
  write(
    ".build/checkouts/dep/Package.swift",
    `.package(url: "https://github.com/a/b", from: "1.0.0")`,
  );
  const seen: HouseStack[] = [];
  const drift = await frameworkDrift(
    dir,
    deps({
      houseStack: { ...DEFAULT_HOUSE_STACK, swift: ["acme/kit"] },
      resolver: {
        resolve: async (stack) => {
          seen.push(stack);
          return {
            ok: true,
            resolvedAt: "x",
            npm: [],
            crates: [],
            rustToolchain: null,
            swift: stack.swift.map((name) => ({ name, version: "2.1.0" })),
            swiftToolchain: null,
          };
        },
      },
    }),
  );
  expect(drift.rows.map((r) => [r.ecosystem, r.name, r.installed, r.target, r.state])).toEqual([
    ["swift", "acme/kit", "1", "2", "behind"],
  ]);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.swift).toEqual(["acme/kit"]);
  expect(seen[0]!.swiftToolchain).toBe(false);
});

test("Package.swift: a repo's CLAUDE.md pin tracks the package it also declares", async () => {
  write("Package.swift", `.package(url: "https://github.com/acme/kit", from: "1.0.0")`);
  write(
    "CLAUDE.md",
    "- Use Swift package `acme/kit` (x), NEVER an older version.\n- Use Swift package `acme/undeclared` (x)\n",
  );
  const seen: string[] = [];
  const drift = await frameworkDrift(
    dir,
    deps({
      resolver: {
        resolve: async (stack) => {
          seen.push(...stack.swift);
          return { ok: false, errors: [] };
        },
      },
    }),
  );
  expect(drift.rows.map((r) => r.name)).toEqual(["acme/kit"]);
  expect(seen).toEqual(["acme/kit"]);
});
