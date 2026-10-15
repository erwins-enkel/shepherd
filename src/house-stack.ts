/**
 * House Stack (#3108): the operator's standing package list per ecosystem, resolved to current
 * stable versions from the registries — never from model memory. The bootstrap directive (#3109)
 * injects the rendered pins and writes them into the new project's CLAUDE.md as hard rules.
 *
 * Resolution is all-or-nothing: one package that can't be resolved fails the whole run with a
 * per-package reason, so no pin is ever a guess. Only successes are cached.
 */
import { mapBounded } from "./map-bounded";

export const HOUSE_STACK_SETTING = "houseStack";

export interface HouseStack {
  /** npm package names (JS/TS ecosystem). */
  npm: string[];
  /** crates.io crate names (Rust ecosystem). */
  crates: string[];
  /** Pin the current stable Rust toolchain (rust-toolchain.toml). */
  rustToolchain: boolean;
}

export const DEFAULT_HOUSE_STACK: HouseStack = {
  npm: [
    "svelte",
    "@sveltejs/kit",
    "tailwindcss",
    "vite",
    "typescript",
    "prettier",
    "eslint",
    "husky",
    "lint-staged",
    "fallow",
    "vitest",
    "@playwright/test",
    "bun",
  ],
  crates: [],
  rustToolchain: true,
};

export const HOUSE_STACK_MAX_ENTRIES = 60;
const NPM_NAME_RE = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const CRATE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const STABLE_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

type ParseResult = { ok: true; value: HouseStack } | { ok: false; error: string };

function parseNames(
  raw: unknown,
  field: string,
  valid: (name: string) => boolean,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: `houseStack.${field} must be an array` };
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      return { ok: false, error: `houseStack.${field} entries must be strings` };
    }
    const name = item.trim();
    if (!name) continue;
    if (!valid(name)) return { ok: false, error: `houseStack.${field}: invalid name "${name}"` };
    if (!out.includes(name)) out.push(name);
  }
  if (out.length > HOUSE_STACK_MAX_ENTRIES) {
    return { ok: false, error: `houseStack.${field}: at most ${HOUSE_STACK_MAX_ENTRIES} entries` };
  }
  return { ok: true, value: out };
}

/** Validate + normalize (trim, drop blanks, dedupe) an operator-supplied House Stack. */
export function parseHouseStack(raw: unknown): ParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "houseStack must be an object" };
  }
  const r = raw as Record<string, unknown>;
  const npm = parseNames(r.npm, "npm", (n) => n.length <= 214 && NPM_NAME_RE.test(n));
  if (!npm.ok) return npm;
  const crates = parseNames(r.crates, "crates", (n) => CRATE_NAME_RE.test(n));
  if (!crates.ok) return crates;
  if (typeof r.rustToolchain !== "boolean") {
    return { ok: false, error: "houseStack.rustToolchain must be a boolean" };
  }
  return {
    ok: true,
    value: { npm: npm.value, crates: crates.value, rustToolchain: r.rustToolchain },
  };
}

/** The persisted setting, or the default when unset or unreadable. */
export function storedHouseStack(stored: string | null | undefined): HouseStack {
  if (!stored) return structuredClone(DEFAULT_HOUSE_STACK);
  try {
    const parsed = parseHouseStack(JSON.parse(stored));
    if (parsed.ok) return parsed.value;
  } catch {
    // corrupt row → default below
  }
  return structuredClone(DEFAULT_HOUSE_STACK);
}

/** Per-project override (e.g. from a PRD): each list/flag the override sets replaces the base's. */
export function mergeHouseStack(base: HouseStack, override: Partial<HouseStack>): HouseStack {
  return {
    npm: override.npm ?? base.npm,
    crates: override.crates ?? base.crates,
    rustToolchain: override.rustToolchain ?? base.rustToolchain,
  };
}

export type Ecosystem = "npm" | "crates" | "rust";

export interface ResolvedPackage {
  name: string;
  version: string;
}

export interface HouseStackError {
  ecosystem: Ecosystem;
  name: string;
  reason: string;
}

export type HouseStackResolution =
  | {
      ok: true;
      resolvedAt: string;
      npm: ResolvedPackage[];
      crates: ResolvedPackage[];
      rustToolchain: string | null;
    }
  | { ok: false; errors: HouseStackError[] };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface HouseStackResolverDeps {
  fetch?: Fetch;
  now?: () => number;
  timeoutMs?: number;
  ttlMs?: number;
}

const NPM_REGISTRY = "https://registry.npmjs.org";
const CRATES_API = "https://crates.io/api/v1/crates";
const RUST_CHANNEL_URL = "https://static.rust-lang.org/dist/channel-rust-stable.toml";
// crates.io's crawler policy rejects requests without an identifying User-Agent.
const USER_AGENT = "shepherd (https://github.com/erwins-enkel/shepherd)";
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const CONCURRENCY = 6;
const RUST_VERSION_RE = /\[pkg\.rust\]\s*\nversion\s*=\s*"(\d+\.\d+\.\d+)[ "]/;

class LookupError extends Error {}

async function boundedText(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_LIMIT) {
      await reader.cancel();
      throw new LookupError("response too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function stableOrThrow(value: unknown): string {
  if (typeof value === "string" && STABLE_RE.test(value)) return value;
  throw new LookupError(`no stable version (got ${JSON.stringify(value ?? null)})`);
}

function errorReason(err: unknown): string {
  if (err instanceof LookupError) return err.message;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return "timed out";
  }
  if (err instanceof SyntaxError) return "malformed response";
  return err instanceof Error ? err.message : String(err);
}

/** Resolves a House Stack to current stable versions. One instance per process (shared cache). */
export class HouseStackResolver {
  readonly #fetch: Fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #ttlMs: number;
  readonly #cache = new Map<string, { version: string; at: number }>();

  constructor(deps: HouseStackResolverDeps = {}) {
    this.#fetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.#now = deps.now ?? Date.now;
    this.#timeoutMs = deps.timeoutMs ?? 5_000;
    this.#ttlMs = deps.ttlMs ?? 60 * 60 * 1000;
  }

  async resolve(stack: HouseStack): Promise<HouseStackResolution> {
    const jobs: { ecosystem: Ecosystem; name: string }[] = [
      ...stack.npm.map((name) => ({ ecosystem: "npm" as const, name })),
      ...stack.crates.map((name) => ({ ecosystem: "crates" as const, name })),
      ...(stack.rustToolchain ? [{ ecosystem: "rust" as const, name: "stable" }] : []),
    ];
    const results = await mapBounded(jobs, CONCURRENCY, async (job) => {
      try {
        return { ...job, version: await this.#cached(job.ecosystem, job.name) };
      } catch (err) {
        return { ...job, reason: errorReason(err) };
      }
    });
    const errors: HouseStackError[] = [];
    for (const r of results) {
      if ("reason" in r) errors.push({ ecosystem: r.ecosystem, name: r.name, reason: r.reason });
    }
    if (errors.length > 0) return { ok: false, errors };
    const pick = (eco: Ecosystem) =>
      results
        .filter((r) => r.ecosystem === eco)
        .map((r) => ({ name: r.name, version: (r as { version: string }).version }));
    return {
      ok: true,
      resolvedAt: new Date(this.#now()).toISOString(),
      npm: pick("npm"),
      crates: pick("crates"),
      rustToolchain: pick("rust")[0]?.version ?? null,
    };
  }

  async #cached(ecosystem: Ecosystem, name: string): Promise<string> {
    const key = `${ecosystem}:${name}`;
    const hit = this.#cache.get(key);
    if (hit && this.#now() - hit.at < this.#ttlMs) return hit.version;
    const version = await this.#lookup(ecosystem, name);
    this.#cache.set(key, { version, at: this.#now() });
    return version;
  }

  async #get(url: string): Promise<string> {
    const res = await this.#fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (res.status === 404) throw new LookupError("not found");
    if (!res.ok) throw new LookupError(`HTTP ${res.status}`);
    return boundedText(res);
  }

  async #lookup(ecosystem: Ecosystem, name: string): Promise<string> {
    if (ecosystem === "npm") {
      const body = JSON.parse(await this.#get(`${NPM_REGISTRY}/${name}/latest`)) as {
        version?: unknown;
      };
      return stableOrThrow(body.version);
    }
    if (ecosystem === "crates") {
      const body = JSON.parse(await this.#get(`${CRATES_API}/${name}`)) as {
        crate?: { max_stable_version?: unknown };
      };
      return stableOrThrow(body.crate?.max_stable_version);
    }
    const match = RUST_VERSION_RE.exec(await this.#get(RUST_CHANNEL_URL));
    if (!match) throw new LookupError("stable channel version not found");
    return match[1]!;
  }
}

const PACKAGE_MANAGERS = ["bun", "pnpm", "npm", "yarn"];

/** The pinned line: the major, or major.minor for a 0.x package (where minors break). */
export function pinOf(version: string): string {
  const [major, minor] = version.split(".");
  return major === "0" ? `${major}.${minor}` : major!;
}

export interface HouseStackRules {
  /** Hard rules for the project's CLAUDE.md. */
  claudeMd: string;
  /** Block for the bootstrap directive. */
  directive: string;
  /** Fields for the root package.json, when the stack names a package manager. */
  packageJson: { packageManager?: string; engines?: Record<string, string> };
  /** rust-toolchain.toml contents, when the toolchain is pinned. */
  rustToolchainToml?: string;
}

/** Render resolved versions into the pins the bootstrap writes. Agent-facing → fixed English. */
export function renderHouseStackRules(
  resolved: Extract<HouseStackResolution, { ok: true }>,
): HouseStackRules {
  const date = resolved.resolvedAt.slice(0, 10);
  const lines = [
    ...resolved.npm.map(
      (p) =>
        `- Use \`${p.name}@${pinOf(p.version)}\` (npm, resolved ${p.version} on ${date}), NEVER an older version.`,
    ),
    ...resolved.crates.map(
      (p) =>
        `- Use crate \`${p.name} = "${pinOf(p.version)}"\` (resolved ${p.version} on ${date}), NEVER an older version.`,
    ),
    ...(resolved.rustToolchain
      ? [
          `- Use Rust toolchain \`${resolved.rustToolchain}\` (stable on ${date}, pinned in rust-toolchain.toml), NEVER an older one.`,
        ]
      : []),
  ];
  const claudeMd = ["## Pinned stack", "", ...lines].join("\n");
  const directive = [
    "Pinned stack (resolved from the package registries by Shepherd — do not substitute versions from memory):",
    ...lines,
  ].join("\n");
  const pm = resolved.npm.find((p) => PACKAGE_MANAGERS.includes(p.name));
  const packageJson: HouseStackRules["packageJson"] = pm
    ? { packageManager: `${pm.name}@${pm.version}`, engines: { [pm.name]: `>=${pm.version}` } }
    : {};
  return {
    claudeMd,
    directive,
    packageJson,
    ...(resolved.rustToolchain
      ? { rustToolchainToml: `[toolchain]\nchannel = "${resolved.rustToolchain}"\n` }
      : {}),
  };
}
