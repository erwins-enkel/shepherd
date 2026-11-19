// tsconfig strictness for the readiness `ts_strict` guardrail (#4080).
//
// Resolves the effective `compilerOptions.strict` (and `noUncheckedIndexedAccess`) of one
// tsconfig with TypeScript's merge semantics: bases in `extends` (string or array) apply in
// order, later wins, and the config's own options override them. Only local, relative bases
// inside the repo are followed, a bounded number of hops deep, with async I/O only — the
// analyzer runs on the server's single loop. A base that can't be followed (package specifier,
// absolute path, outside the repo, missing, unparseable, oversized, cyclic, over budget) makes
// every option it could set UNKNOWN, so it never fails open into a pass; a nearer config that
// sets the option explicitly still decides. A root's project `references` (one level) are
// evaluated the same way, since `tsc -b` checks each referenced project under its own options.

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

/** Config files read per evaluated tsconfig, the root one included. */
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

/** The effective options of one `extends` entry, or UNKNOWN ones when it can't be followed. */
async function baseOptions(spec: string, fromDir: string, w: Walk): Promise<Effective> {
  if (isAbsolute(spec)) return unknownBase(`extends \`${spec}\` (absolute path, not resolved)`);
  if (!spec.startsWith("./") && !spec.startsWith("../"))
    return unknownBase(`extends \`${spec}\` (package base, not resolved)`);
  // Like tsc: a relative base without the `.json` suffix gets it appended.
  const file = resolve(fromDir, spec.endsWith(".json") ? spec : `${spec}.json`);
  try {
    return await effectiveOptions(file, w);
  } catch (e) {
    if (e instanceof Unresolved) return unknownBase(`extends \`${spec}\`: ${e.message}`);
    throw e;
  }
}

async function effectiveOptions(file: string, w: Walk): Promise<Effective> {
  if (w.left-- <= 0) throw new Unresolved(`extends chain exceeds ${MAX_CONFIGS} configs`);
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
    eff.strict === false ? eff.strictReason : "strict not set (TypeScript default: off)";
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
      left: MAX_CONFIGS,
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
 * {@link MAX_REFERENCES} references, each chain at most {@link MAX_CONFIGS} files of at most
 * 256 KiB, all inside `repoDir`.
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
