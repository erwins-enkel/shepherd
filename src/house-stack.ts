/**
 * House Stack (#3108): the operator's standing package list per ecosystem, resolved to current
 * stable versions from the registries — never from model memory. The bootstrap directive (#3109)
 * injects the rendered pins and writes them into the new project's CLAUDE.md as hard rules.
 *
 * Resolution is all-or-nothing: one package that can't be resolved fails the whole run with a
 * per-package reason, so no pin is ever a guess. Only successes are cached.
 */
import { mapBounded } from "./map-bounded";
import { execGit } from "./safe-git";

export const HOUSE_STACK_SETTING = "houseStack";

export interface HouseStack {
  /** npm package names (JS/TS ecosystem). */
  npm: string[];
  /** crates.io crate names (Rust ecosystem). */
  crates: string[];
  /** Pin the current stable Rust toolchain (rust-toolchain.toml). */
  rustToolchain: boolean;
  /** Swift packages on github.com, as lowercase `owner/repo`. */
  swift: string[];
  /** Pin the current stable Swift toolchain (.swift-version). */
  swiftToolchain: boolean;
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
  swift: [],
  swiftToolchain: true,
};

export const HOUSE_STACK_MAX_ENTRIES = 60;
const NPM_NAME_RE = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const CRATE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const STABLE_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SWIFT_RELEASE_RE = /^\d+\.\d+(\.\d+)?$/;

const SWIFT_PACKAGE_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/;

/** The one spelling of a github.com Swift package: lowercase `owner/repo`, from that form,
 *  `github.com/owner/repo` (Dependabot) or its https URL (Package.swift). Null for anything else,
 *  so a repo-controlled name can never point a lookup at another host. */
export function swiftPackageName(raw: string): string | null {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\/$/, "")
    .replace(/\.git$/, "");
  return name.length <= 140 && SWIFT_PACKAGE_RE.test(name) ? name : null;
}

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
  // Both Swift fields postdate stored settings: absent means default, never an invalid stack that
  // would drop the operator's other lists.
  const swift = parseNames(r.swift ?? DEFAULT_HOUSE_STACK.swift, "swift", (n) =>
    Boolean(swiftPackageName(n)),
  );
  if (!swift.ok) return swift;
  const swiftToolchain = r.swiftToolchain ?? DEFAULT_HOUSE_STACK.swiftToolchain;
  if (typeof swiftToolchain !== "boolean") {
    return { ok: false, error: "houseStack.swiftToolchain must be a boolean" };
  }
  return {
    ok: true,
    value: {
      npm: npm.value,
      crates: crates.value,
      rustToolchain: r.rustToolchain,
      swift: [...new Set(swift.value.map((n) => swiftPackageName(n)!))],
      swiftToolchain,
    },
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
    swift: override.swift ?? base.swift,
    swiftToolchain: override.swiftToolchain ?? base.swiftToolchain,
  };
}

export type Ecosystem = "npm" | "crates" | "rust" | "swift" | "swift-toolchain";

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
      swift: ResolvedPackage[];
      swiftToolchain: string | null;
    }
  | { ok: false; errors: HouseStackError[] };

/** A successful resolution — what a bootstrap spawn pins (#3109). */
export type ResolvedHouseStack = Extract<HouseStackResolution, { ok: true }>;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface HouseStackResolverDeps {
  fetch?: Fetch;
  /** `git ls-remote --tags` output for a repo URL. */
  lsRemoteTags?: (url: string) => Promise<string>;
  now?: () => number;
  timeoutMs?: number;
  ttlMs?: number;
}

const NPM_REGISTRY = "https://registry.npmjs.org";
const CRATES_API = "https://crates.io/api/v1/crates";
const RUST_CHANNEL_URL = "https://static.rust-lang.org/dist/channel-rust-stable.toml";
const SWIFT_RELEASES_URL = "https://www.swift.org/api/v1/install/releases.json";
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

/** Newest of `versions` by numeric comparison of their dotted parts. */
function newestVersion(versions: string[]): string | undefined {
  const parts = (v: string) => v.split(".").map(Number);
  return versions.reduce<string | undefined>((best, v) => {
    if (best === undefined) return v;
    const [a, b] = [parts(v), parts(best)];
    const diff = [0, 1, 2].map((i) => (a[i] ?? 0) - (b[i] ?? 0)).find((d) => d !== 0);
    return (diff ?? 0) > 0 ? v : best;
  }, undefined);
}

/** Newest stable tag in `git ls-remote --tags` output; SwiftPM reads `1.2.3` and `v1.2.3`. */
function newestStableTag(lsRemote: string): string | undefined {
  const tags = lsRemote
    .split("\n")
    .map((line) => line.split("\trefs/tags/")[1]?.trim().replace(/^v/, "") ?? "")
    .filter((tag) => STABLE_RE.test(tag));
  return newestVersion(tags);
}

const LS_REMOTE_TIMEOUT_MS = 15_000;

/** No credential prompt: a missing or auth-walled repo fails fast instead of hanging. */
async function gitLsRemoteTags(url: string): Promise<string> {
  const { stdout } = await execGit(["ls-remote", "--tags", "--refs", url], {
    timeout: LS_REMOTE_TIMEOUT_MS,
    maxBuffer: RESPONSE_LIMIT,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
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
  readonly #lsRemoteTags: (url: string) => Promise<string>;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #ttlMs: number;
  readonly #cache = new Map<string, { version: string; at: number }>();

  constructor(deps: HouseStackResolverDeps = {}) {
    this.#fetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.#lsRemoteTags = deps.lsRemoteTags ?? gitLsRemoteTags;
    this.#now = deps.now ?? Date.now;
    this.#timeoutMs = deps.timeoutMs ?? 5_000;
    this.#ttlMs = deps.ttlMs ?? 60 * 60 * 1000;
  }

  async resolve(stack: HouseStack): Promise<HouseStackResolution> {
    const jobs: { ecosystem: Ecosystem; name: string }[] = [
      ...stack.npm.map((name) => ({ ecosystem: "npm" as const, name })),
      ...stack.crates.map((name) => ({ ecosystem: "crates" as const, name })),
      ...(stack.rustToolchain ? [{ ecosystem: "rust" as const, name: "stable" }] : []),
      ...stack.swift.map((name) => ({ ecosystem: "swift" as const, name })),
      ...(stack.swiftToolchain ? [{ ecosystem: "swift-toolchain" as const, name: "stable" }] : []),
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
      swift: pick("swift"),
      swiftToolchain: pick("swift-toolchain")[0]?.version ?? null,
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
    if (ecosystem === "swift") return this.#lookupSwiftPackage(name);
    if (ecosystem === "swift-toolchain") return this.#lookupSwiftToolchain();
    const match = RUST_VERSION_RE.exec(await this.#get(RUST_CHANNEL_URL));
    if (!match) throw new LookupError("stable channel version not found");
    return match[1]!;
  }

  /** Tags are what SwiftPM resolves against; `git ls-remote` spends no GitHub API budget. */
  async #lookupSwiftPackage(name: string): Promise<string> {
    const pkg = swiftPackageName(name);
    if (!pkg) throw new LookupError("invalid package name");
    let lsRemote: string;
    try {
      lsRemote = await this.#lsRemoteTags(`https://github.com/${pkg}`);
    } catch {
      throw new LookupError("repository not found or unreachable");
    }
    return stableOrThrow(newestStableTag(lsRemote));
  }

  async #lookupSwiftToolchain(): Promise<string> {
    const body = JSON.parse(await this.#get(SWIFT_RELEASES_URL)) as unknown;
    const names = Array.isArray(body)
      ? body
          .map((r: { name?: unknown }) => r?.name)
          .filter((n): n is string => typeof n === "string")
      : [];
    const newest = newestVersion(names.filter((n) => SWIFT_RELEASE_RE.test(n)));
    if (!newest) throw new LookupError("stable toolchain version not found");
    return newest;
  }
}

/** One process-wide resolver, so the Settings route and bootstrap spawns share its registry cache. */
export const sharedHouseStackResolver = new HouseStackResolver();

/** A bootstrap spawn (#3109) refused because the House Stack did not fully resolve — no pin is
 *  ever guessed, so the session does not start. */
export class HouseStackUnresolvedError extends Error {
  constructor(readonly errors: HouseStackError[]) {
    super(
      `house stack unresolved: ${errors.map((e) => `${e.ecosystem}:${e.name} (${e.reason})`).join(", ")}`,
    );
    this.name = "HouseStackUnresolvedError";
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
  /** .swift-version contents, when the toolchain is pinned. */
  swiftVersionFile?: string;
}

/** Render resolved versions into the pins the bootstrap writes. Agent-facing → fixed English. */
export function renderHouseStackRules(resolved: ResolvedHouseStack): HouseStackRules {
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
    ...resolved.swift.map(
      (p) =>
        `- Use Swift package \`${p.name}\` (\`.package(url: "https://github.com/${p.name}", from: "${p.version}")\`, resolved on ${date}), NEVER an older version.`,
    ),
    ...(resolved.swiftToolchain
      ? [
          `- Use Swift toolchain \`${resolved.swiftToolchain}\` (stable on ${date}, pinned in .swift-version), NEVER an older one.`,
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
    ...(resolved.swiftToolchain ? { swiftVersionFile: `${resolved.swiftToolchain}\n` } : {}),
  };
}
