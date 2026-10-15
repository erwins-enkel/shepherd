import { test, expect, describe } from "bun:test";
import {
  DEFAULT_HOUSE_STACK,
  HOUSE_STACK_MAX_ENTRIES,
  HouseStackResolver,
  mergeHouseStack,
  parseHouseStack,
  renderHouseStackRules,
  storedHouseStack,
  type HouseStack,
} from "../src/house-stack";

type Route = { status?: number; body: unknown } | (() => never | Promise<never>);

function stubFetch(routes: Record<string, Route>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes[url];
    if (!route) return new Response("nope", { status: 404 });
    if (typeof route === "function") return route();
    const text = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return new Response(text, { status: route.status ?? 200 });
  };
  return { fetch, calls };
}

const NPM = "https://registry.npmjs.org";
const CRATES = "https://crates.io/api/v1/crates";
const RUST = "https://static.rust-lang.org/dist/channel-rust-stable.toml";
const RUST_TOML = `[pkg.cargo]\nversion = "0.100.0 (x 2026-09-28)"\n\n[pkg.rust]\nversion = "1.99.0 (b940084d7 2026-09-28)"\n`;

const stack = (s: Partial<HouseStack>): HouseStack => ({
  npm: [],
  crates: [],
  rustToolchain: false,
  ...s,
});

describe("parseHouseStack", () => {
  test("normalizes: trims, drops blanks, dedupes", () => {
    const r = parseHouseStack({
      npm: [" svelte ", "", "svelte", "@sveltejs/kit"],
      crates: ["serde"],
      rustToolchain: true,
    });
    expect(r).toEqual({
      ok: true,
      value: { npm: ["svelte", "@sveltejs/kit"], crates: ["serde"], rustToolchain: true },
    });
  });

  test("rejects bad shapes and names", () => {
    expect(parseHouseStack(null).ok).toBe(false);
    expect(parseHouseStack([]).ok).toBe(false);
    expect(parseHouseStack({ npm: "svelte", crates: [], rustToolchain: true }).ok).toBe(false);
    expect(parseHouseStack({ npm: [1], crates: [], rustToolchain: true }).ok).toBe(false);
    expect(parseHouseStack({ npm: [], crates: [], rustToolchain: "yes" }).ok).toBe(false);
    const bad = parseHouseStack({ npm: ["Svelte Kit"], crates: [], rustToolchain: true });
    expect(bad).toEqual({ ok: false, error: 'houseStack.npm: invalid name "Svelte Kit"' });
    expect(parseHouseStack({ npm: ["../x"], crates: [], rustToolchain: true }).ok).toBe(false);
    expect(parseHouseStack({ npm: [], crates: ["9lives"], rustToolchain: true }).ok).toBe(false);
  });

  test("caps entries per list", () => {
    const many = Array.from({ length: HOUSE_STACK_MAX_ENTRIES + 1 }, (_, i) => `p${i}`);
    expect(parseHouseStack({ npm: many, crates: [], rustToolchain: false }).ok).toBe(false);
  });
});

describe("storedHouseStack / mergeHouseStack", () => {
  test("default when unset or corrupt", () => {
    expect(storedHouseStack(null)).toEqual(DEFAULT_HOUSE_STACK);
    expect(storedHouseStack("{not json")).toEqual(DEFAULT_HOUSE_STACK);
    expect(storedHouseStack(JSON.stringify({ npm: 1 }))).toEqual(DEFAULT_HOUSE_STACK);
  });

  test("returns the stored value", () => {
    const v = stack({ npm: ["svelte"] });
    expect(storedHouseStack(JSON.stringify(v))).toEqual(v);
  });

  test("override replaces only the fields it sets", () => {
    const base = stack({ npm: ["svelte"], crates: ["serde"], rustToolchain: true });
    expect(mergeHouseStack(base, { npm: ["react"] })).toEqual({
      npm: ["react"],
      crates: ["serde"],
      rustToolchain: true,
    });
  });
});

describe("HouseStackResolver", () => {
  test("resolves npm, crates and the rust toolchain", async () => {
    const { fetch, calls } = stubFetch({
      [`${NPM}/svelte/latest`]: { body: { version: "5.40.1" } },
      [`${NPM}/@sveltejs/kit/latest`]: { body: { version: "3.1.0" } },
      [`${CRATES}/serde`]: { body: { crate: { max_stable_version: "1.0.229" } } },
      [RUST]: { body: RUST_TOML },
    });
    const r = new HouseStackResolver({ fetch, now: () => Date.parse("2026-10-15T08:00:00Z") });
    const res = await r.resolve(
      stack({ npm: ["svelte", "@sveltejs/kit"], crates: ["serde"], rustToolchain: true }),
    );
    expect(res).toEqual({
      ok: true,
      resolvedAt: "2026-10-15T08:00:00.000Z",
      npm: [
        { name: "svelte", version: "5.40.1" },
        { name: "@sveltejs/kit", version: "3.1.0" },
      ],
      crates: [{ name: "serde", version: "1.0.229" }],
      rustToolchain: "1.99.0",
    });
    expect(calls.every((c) => c.headers["User-Agent"]?.startsWith("shepherd"))).toBe(true);
  });

  test("one failure fails the whole run with per-package reasons", async () => {
    const { fetch } = stubFetch({
      [`${NPM}/svelte/latest`]: { body: { version: "5.40.1" } },
      [`${NPM}/beta-only/latest`]: { body: { version: "2.0.0-rc.1" } },
      [`${NPM}/broken/latest`]: { status: 503, body: "down" },
      [`${NPM}/garbled/latest`]: { body: "<html>" },
      [`${CRATES}/serde`]: { body: { crate: {} } },
      [RUST]: { body: "[pkg.cargo]\n" },
    });
    const res = await new HouseStackResolver({ fetch }).resolve(
      stack({
        npm: ["svelte", "beta-only", "broken", "garbled", "missing"],
        crates: ["serde"],
        rustToolchain: true,
      }),
    );
    expect(res).toEqual({
      ok: false,
      errors: [
        { ecosystem: "npm", name: "beta-only", reason: 'no stable version (got "2.0.0-rc.1")' },
        { ecosystem: "npm", name: "broken", reason: "HTTP 503" },
        { ecosystem: "npm", name: "garbled", reason: "malformed response" },
        { ecosystem: "npm", name: "missing", reason: "not found" },
        { ecosystem: "crates", name: "serde", reason: "no stable version (got null)" },
        { ecosystem: "rust", name: "stable", reason: "stable channel version not found" },
      ],
    });
  });

  test("timeout and offline are clear errors", async () => {
    const { fetch } = stubFetch({
      [`${NPM}/slow/latest`]: () => {
        throw new DOMException("timed out", "TimeoutError");
      },
      [`${NPM}/offline/latest`]: () => {
        throw new TypeError("Unable to connect");
      },
    });
    const res = await new HouseStackResolver({ fetch }).resolve(
      stack({ npm: ["slow", "offline"] }),
    );
    expect(res).toEqual({
      ok: false,
      errors: [
        { ecosystem: "npm", name: "slow", reason: "timed out" },
        { ecosystem: "npm", name: "offline", reason: "Unable to connect" },
      ],
    });
  });

  test("real timeout aborts a hanging request", async () => {
    const fetch = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    const res = await new HouseStackResolver({ fetch, timeoutMs: 20 }).resolve(
      stack({ npm: ["svelte"] }),
    );
    expect(res).toEqual({
      ok: false,
      errors: [{ ecosystem: "npm", name: "svelte", reason: "timed out" }],
    });
  });

  test("caches successes within the TTL, refetches after, never caches failures", async () => {
    let now = 0;
    let version = "5.0.0";
    let fail = false;
    let count = 0;
    const fetch = async () => {
      count++;
      if (fail) return new Response("down", { status: 500 });
      return new Response(JSON.stringify({ version }));
    };
    const r = new HouseStackResolver({ fetch, now: () => now, ttlMs: 1000 });
    const s = stack({ npm: ["svelte"] });
    await r.resolve(s);
    version = "5.1.0";
    now = 999;
    expect((await r.resolve(s)).ok && count).toBe(1);
    now = 1000;
    const fresh = await r.resolve(s);
    expect(fresh.ok && fresh.npm[0]!.version).toBe("5.1.0");
    expect(count).toBe(2);
    fail = true;
    now = 5000;
    expect((await r.resolve(s)).ok).toBe(false);
    expect((await r.resolve(s)).ok).toBe(false);
    expect(count).toBe(4);
  });
});

describe("renderHouseStackRules", () => {
  const resolved = {
    ok: true as const,
    resolvedAt: "2026-10-15T08:00:00.000Z",
    npm: [
      { name: "@sveltejs/kit", version: "3.1.0" },
      { name: "fallow", version: "0.12.3" },
      { name: "bun", version: "1.3.9" },
    ],
    crates: [{ name: "serde", version: "1.0.229" }],
    rustToolchain: "1.99.0",
  };

  test("pins majors (minor for 0.x) as NEVER-older rules", () => {
    const r = renderHouseStackRules(resolved);
    expect(r.claudeMd).toContain(
      "- Use `@sveltejs/kit@3` (npm, resolved 3.1.0 on 2026-10-15), NEVER an older version.",
    );
    expect(r.claudeMd).toContain("`fallow@0.12`");
    expect(r.claudeMd).toContain('`serde = "1"`');
    expect(r.claudeMd).toContain("Rust toolchain `1.99.0`");
    expect(r.directive).toContain("do not substitute versions from memory");
  });

  test("packageManager/engines from the package manager; rust-toolchain.toml", () => {
    const r = renderHouseStackRules(resolved);
    expect(r.packageJson).toEqual({ packageManager: "bun@1.3.9", engines: { bun: ">=1.3.9" } });
    expect(r.rustToolchainToml).toBe('[toolchain]\nchannel = "1.99.0"\n');
  });

  test("no package manager / toolchain → nothing to pin there", () => {
    const r = renderHouseStackRules({ ...resolved, npm: [resolved.npm[0]!], rustToolchain: null });
    expect(r.packageJson).toEqual({});
    expect(r.rustToolchainToml).toBeUndefined();
  });
});
