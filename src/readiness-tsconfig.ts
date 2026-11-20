// tsconfig strictness for the readiness `ts_strict` guardrail (#4080).
//
// Resolves the effective `compilerOptions.strict` (and `noUncheckedIndexedAccess`) of one
// tsconfig with TypeScript's merge semantics: bases in `extends` (string or array) apply in
// order, later wins, and the config's own options override them. Relative bases and package
// bases installed in an in-repo node_modules are followed (a safe subset of tsc's lookup), only
// inside the repo, a bounded number of hops deep, with async I/O only — the analyzer runs on the
// server's single loop. A base that can't be followed (absolute path, package not installed or
// redirected by `exports`/`typesVersions`, outside the repo, missing, unparseable, oversized,
// cyclic, over budget) makes every option it could set UNKNOWN, so it never fails open into a
// pass; a nearer config that sets the option explicitly still decides. A root's project
// `references` (one level) are evaluated the same way, since `tsc -b` checks each referenced
// project under its own options.

import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type TsStrictness = "strict" | "loose" | "unknown";

export interface TsConfigStrictness {
  /** Repo-relative path of the evaluated tsconfig. */
  path: string;
  strict: TsStrictness;
  noUncheckedIndexedAccess: boolean;
  /** Why it isn't strict — verbatim generated-artifact text; `""` when strict. */
  reason: string;
}

/** Files read per evaluated tsconfig — configs (the root one included) plus package bases'
 *  package.json. Each `extends` entry spends its config's unit before any lookup, so an entry
 *  that fails to resolve still counts and entries past the budget do no I/O at all. */
const MAX_CONFIGS = 8;
/** Project `references` followed from one root tsconfig. */
const MAX_REFERENCES = 16;
const MAX_BYTES = 256 * 1024;

type OptValue = boolean | "unknown" | undefined;

interface Effective {
  strict: OptValue;
  /** Where a non-true `strict` came from (reported verbatim). */
  strictReason: string;
  noUncheckedIndexedAccess: OptValue;
}

interface Walk {
  /** realpath of the repo — nothing outside it is read. */
  root: string;
  /** Remaining file reads ({@link MAX_CONFIGS}); spent before the lookup, never refunded. */
  left: number;
  /** Configs on the current extends path (cycle guard; a diamond is not a cycle). */
  stack: Set<string>;
}

/** A config in the chain that can't be read; its message is the reported reason. */
class Unresolved extends Error {}

const UNSET: Effective = {
  strict: undefined,
  strictReason: "",
  noUncheckedIndexedAccess: undefined,
};

/** `b` over `a`, option by option — an option `b` leaves unset keeps `a`'s value. */
function overlay(a: Effective, b: Effective): Effective {
  const strictFromB = b.strict !== undefined;
  return {
    strict: strictFromB ? b.strict : a.strict,
    strictReason: strictFromB ? b.strictReason : a.strictReason,
    noUncheckedIndexedAccess: b.noUncheckedIndexedAccess ?? a.noUncheckedIndexedAccess,
  };
}

function unknownBase(reason: string): Effective {
  return { strict: "unknown", strictReason: reason, noUncheckedIndexedAccess: "unknown" };
}

function ownOptions(cfg: Record<string, unknown>): Effective {
  const co = cfg.compilerOptions;
  const opts = co && typeof co === "object" ? (co as Record<string, unknown>) : {};
  const strict = typeof opts.strict === "boolean" ? opts.strict : undefined;
  const nuia = opts.noUncheckedIndexedAccess;
  return {
    strict,
    strictReason: strict === false ? "strict: false" : "",
    noUncheckedIndexedAccess: typeof nuia === "boolean" ? nuia : undefined,
  };
}

function extendsList(cfg: Record<string, unknown>): string[] {
  const ext = cfg.extends;
  if (typeof ext === "string") return [ext];
  return Array.isArray(ext) ? ext.filter((e): e is string => typeof e === "string") : [];
}

/** realpath of `file`, contained in the repo. */
async function locate(file: string, root: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(file);
  } catch {
    throw new Unresolved("not found");
  }
  const rel = relative(root, real);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Unresolved("outside the repository");
  return real;
}

/** Reads at most {@link MAX_BYTES} through one handle — the size bound is the read itself, so a
 *  file swapped or grown between a check and the read can't slip past it. */
async function readBounded(file: string): Promise<string> {
  let fh: FileHandle;
  try {
    fh = await open(file, "r");
  } catch {
    throw new Unresolved("unreadable");
  }
  try {
    const buf = Buffer.alloc(MAX_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (!bytesRead) break;
      n += bytesRead;
    }
    if (n > MAX_BYTES) throw new Unresolved("larger than 256 KiB");
    return buf.toString("utf8", 0, n);
  } catch (e) {
    throw e instanceof Unresolved ? e : new Unresolved("unreadable");
  } finally {
    await fh.close();
  }
}

async function parseConfig(file: string): Promise<Record<string, unknown>> {
  const text = await readBounded(file);
  let cfg: unknown;
  try {
    cfg = Bun.JSONC.parse(text);
  } catch {
    throw new Unresolved("unparseable JSONC");
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg))
    throw new Unresolved("not a JSON object");
  return cfg as Record<string, unknown>;
}

async function statOf(file: string) {
  try {
    return await stat(file);
  } catch {
    return null; // missing or unreadable — not there for resolution purposes
  }
}

/** tsc's `fileExists`: a regular file (a directory doesn't count). */
const isRegularFile = async (file: string) => (await statOf(file))?.isFile() ?? false;

/** Like tsc: a relative base as written when that file exists, else with `.json` appended
 *  (unless it already ends in `.json`, in which case it is simply not found). */
async function relativeBase(spec: string, fromDir: string): Promise<string> {
  const file = resolve(fromDir, spec);
  if (spec.endsWith(".json") || (await isRegularFile(file))) return file;
  return `${file}.json`;
}

interface PackageSpec {
  name: string;
  /** The path after the package name; `""` for a bare package. */
  sub: string;
}

/** `@scope/name/sub` or `name/sub` split into package name and subpath; null when malformed. */
function parsePackageSpec(spec: string): PackageSpec | null {
  if (spec.includes("\\")) return null;
  const parts = spec.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  const n = spec.startsWith("@") ? 2 : 1;
  if (parts.length < n) return null;
  return { name: parts.slice(0, n).join("/"), sub: parts.slice(n).join("/") };
}

/** realpath of the nearest `node_modules/<name>` from `fromDir` up to the repo root. */
async function findPackageDir(name: string, fromDir: string, root: string): Promise<string> {
  for (let d = fromDir; ; d = dirname(d)) {
    const candidate = join(d, "node_modules", name);
    if ((await statOf(candidate))?.isDirectory()) return locate(candidate, root);
    if (d === root || dirname(d) === d) throw new Unresolved("package not found in node_modules");
  }
}

const overBudget = () => new Unresolved(`extends chain exceeds ${MAX_CONFIGS} configs`);

/** The package's package.json; `{}` when it has none. Charged to the read budget. */
async function packageJson(pkgDir: string, w: Walk): Promise<Record<string, unknown>> {
  if (w.left-- <= 0) throw overBudget();
  let file: string;
  try {
    file = await locate(join(pkgDir, "package.json"), w.root);
  } catch (e) {
    if (e instanceof Unresolved && e.message === "not found") return {};
    throw e;
  }
  return parseConfig(file);
}

/** The `exports` target for `sub` — an exact key with a string value only. */
function exportsTarget(exp: unknown, sub: string): string {
  const key = sub ? `./${sub}` : ".";
  const isMap = exp && typeof exp === "object" && !Array.isArray(exp);
  const target = isMap ? (exp as Record<string, unknown>)[key] : key === "." ? exp : undefined;
  if (typeof target !== "string" || !target.startsWith("./"))
    throw new Unresolved("package `exports` not resolved");
  return target;
}

/** The config file a package base names, following tsc's config lookup in a package without
 *  `exports` redirects: the `tsconfig` field or tsconfig.json for a bare package, else the
 *  subpath as a `.json` file, then as a directory's tsconfig.json. */
async function packageEntry(pkgDir: string, sub: string, w: Walk): Promise<string> {
  const pj = await packageJson(pkgDir, w);
  if (pj.typesVersions !== undefined) throw new Unresolved("package `typesVersions` not resolved");
  if (pj.exports !== undefined) return resolve(pkgDir, exportsTarget(pj.exports, sub));
  if (!sub) return resolve(pkgDir, typeof pj.tsconfig === "string" ? pj.tsconfig : "tsconfig.json");
  if (sub.endsWith(".json")) return resolve(pkgDir, sub);
  const file = resolve(pkgDir, `${sub}.json`);
  if (await isRegularFile(file)) return file;
  if (await isRegularFile(join(pkgDir, sub, "package.json")))
    throw new Unresolved("nested package.json not resolved");
  return join(pkgDir, sub, "tsconfig.json");
}

/** The effective options of one `extends` entry, or UNKNOWN ones when it can't be followed. */
async function baseOptions(spec: string, fromDir: string, w: Walk): Promise<Effective> {
  if (isAbsolute(spec)) return unknownBase(`extends \`${spec}\` (absolute path, not resolved)`);
  const relativeSpec = spec.startsWith("./") || spec.startsWith("../");
  const pkg = relativeSpec ? null : parsePackageSpec(spec);
  if (!relativeSpec && !pkg) return unknownBase(`extends \`${spec}\` (invalid package specifier)`);
  try {
    // Charged up front (covers the base config's read): a failed lookup still counts, and once
    // the budget is spent no entry does I/O, however many `extends` lists.
    if (w.left-- <= 0) throw overBudget();
    const file = pkg
      ? await packageEntry(await findPackageDir(pkg.name, fromDir, w.root), pkg.sub, w)
      : await relativeBase(spec, fromDir);
    return await effectiveOptions(file, w);
  } catch (e) {
    if (e instanceof Unresolved) return unknownBase(`extends \`${spec}\`: ${e.message}`);
    throw e;
  }
}

/** `file`'s effective options; its read is already charged to `w` by the caller. */
async function effectiveOptions(file: string, w: Walk): Promise<Effective> {
  const real = await locate(file, w.root);
  if (w.stack.has(real)) throw new Unresolved("extends cycle");
  const cfg = await parseConfig(real);
  w.stack.add(real);
  try {
    let merged = UNSET;
    for (const spec of extendsList(cfg))
      merged = overlay(merged, await baseOptions(spec, dirname(real), w));
    return overlay(merged, ownOptions(cfg));
  } finally {
    w.stack.delete(real);
  }
}

function verdict(path: string, eff: Effective): TsConfigStrictness {
  const noUncheckedIndexedAccess = eff.noUncheckedIndexedAccess === true;
  if (eff.strict === true) return { path, strict: "strict", noUncheckedIndexedAccess, reason: "" };
  if (eff.strict === "unknown")
    return { path, strict: "unknown", noUncheckedIndexedAccess, reason: eff.strictReason };
  const reason =
    eff.strict === false
      ? eff.strictReason
      : "strict not set explicitly (off by default before TypeScript 6)";
  return { path, strict: "loose", noUncheckedIndexedAccess, reason };
}

function unknownAt(path: string, reason: string): TsConfigStrictness {
  return { path, strict: "unknown", noUncheckedIndexedAccess: false, reason };
}

/** Effective strictness of one config (its `extends` chain resolved), under a fresh budget. */
async function evaluate(root: string, rel: string): Promise<TsConfigStrictness> {
  try {
    const eff = await effectiveOptions(resolve(root, rel), {
      root,
      left: MAX_CONFIGS - 1, // the root config's own read
      stack: new Set(),
    });
    return verdict(rel, eff);
  } catch (e) {
    if (!(e instanceof Unresolved)) throw e;
    return unknownAt(rel, e.message);
  }
}

/** The parsed config at repo-relative `rel`, or the reason it can't be read. */
async function readConfig(root: string, rel: string): Promise<Record<string, unknown> | string> {
  try {
    return await parseConfig(await locate(resolve(root, rel), root));
  } catch (e) {
    if (!(e instanceof Unresolved)) throw e;
    return e.message;
  }
}

/** Repo-relative config paths of a config's own `references` (a dir means its tsconfig.json). */
function referencePaths(cfg: Record<string, unknown>, fromRel: string): string[] {
  const refs = Array.isArray(cfg.references) ? cfg.references : [];
  return refs.flatMap((r: unknown) => {
    const p = r && typeof r === "object" ? (r as { path?: unknown }).path : undefined;
    if (typeof p !== "string") return [];
    // An absolute path stays absolute, so the containment check rejects it rather than it
    // being re-read as repo-relative.
    const target = isAbsolute(p) ? p : join(dirname(fromRel), p);
    return [p.endsWith(".json") ? target : join(target, "tsconfig.json")];
  });
}

const isEmptyArray = (v: unknown) => Array.isArray(v) && v.length === 0;

/** No input files of its own: `files: []` with no or empty `include`, or `include: []` with no
 *  `files` (the create-vite and Nx solution layouts) — only its references compile anything. */
function compilesNothing(cfg: Record<string, unknown>): boolean {
  const { files, include } = cfg;
  if (isEmptyArray(files)) return include === undefined || isEmptyArray(include);
  return files === undefined && isEmptyArray(include);
}

/** A solution-style config with references; `null` when it compiles files of its own. */
function solutionRefs(cfg: Record<string, unknown>, rel: string): string[] | null {
  const refs = referencePaths(cfg, rel);
  return refs.length && compilesNothing(cfg) ? refs : null;
}

/** A referenced project, judged by its own options — unknown when it is itself a solution root
 *  (references are followed one level only). */
async function evaluateReference(root: string, rel: string): Promise<TsConfigStrictness> {
  const cfg = await readConfig(root, rel);
  if (typeof cfg === "string") return unknownAt(rel, cfg);
  const nested = solutionRefs(cfg, rel);
  if (!nested) return evaluate(root, rel);
  const names = nested.slice(0, 3).map((n) => `\`${n}\``);
  if (nested.length > 3) names.push("…");
  return unknownAt(
    rel,
    `solution-style config; its references (${names.join(", ")}) are not followed`,
  );
}

/**
 * Effective strictness of the tsconfig at repo-relative `rel` and of each project it lists in
 * `references` (one level — `tsc -b` checks every referenced project under its own options), or
 * `[]` when there is none. A solution-style root that compiles nothing itself is left out, so
 * the prescription names the referenced configs that actually need `strict`. Bounded: at most
 * {@link MAX_REFERENCES} references, each chain at most {@link MAX_CONFIGS} files (configs and
 * package bases' package.json) of at most 256 KiB, all inside `repoDir`; once a chain's budget is
 * spent, its remaining `extends` entries do no I/O.
 */
export async function tsconfigStrictness(
  repoDir: string,
  rel: string,
): Promise<TsConfigStrictness[]> {
  let root: string;
  try {
    root = await realpath(repoDir);
    await stat(join(root, rel));
  } catch {
    return [];
  }
  const cfg = await readConfig(root, rel);
  if (typeof cfg === "string") return [unknownAt(rel, cfg)];
  const refs = referencePaths(cfg, rel);
  if (refs.length > MAX_REFERENCES)
    return [unknownAt(rel, `more than ${MAX_REFERENCES} project references`)];
  const own = solutionRefs(cfg, rel) ? [] : [evaluate(root, rel)];
  return Promise.all([...own, ...refs.map((r) => evaluateReference(root, r))]);
}

/**
 * One list from each scanned root's {@link tsconfigStrictness} result (`perRoot[i]` belongs to
 * `rootConfigs[i]`), each config path reported once. A path that is another root's own existing
 * tsconfig is left to that root's evaluation, which follows its references where a reference
 * evaluation would stop at a solution-style config.
 */
export function mergeTsconfigs(
  rootConfigs: string[],
  perRoot: TsConfigStrictness[][],
): TsConfigStrictness[] {
  const owned = new Set(rootConfigs.filter((_, i) => perRoot[i]?.length));
  const seen = new Set<string>();
  return perRoot.flatMap((list, i) =>
    list.filter((c) => {
      if (seen.has(c.path) || (owned.has(c.path) && c.path !== rootConfigs[i])) return false;
      seen.add(c.path);
      return true;
    }),
  );
}
