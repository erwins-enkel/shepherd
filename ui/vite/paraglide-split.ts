// Build-time split of the Paraglide message catalog (#3242).
//
// Components import `m` from the `messages.js` barrel, which re-exports every
// message module. The barrel sits in the eager graph, so Rollup put the whole
// catalog in one eager chunk. This plugin rewrites `m.key()` into a direct
// import of `messages/key.js`, so each message follows its consumers into
// their (possibly lazy) chunk. Build-only: dev and vitest keep the barrel.
//
// Data-driven keys go through `keyedMessages(m, ["prefix_"])` (src/lib/keyed-
// messages.ts); there `m` becomes an object of just the matching messages.
// Anything else that can't be rewritten statically (`m[k]`, passing `m`
// around, `import * as`, re-exports) fails the build instead of silently
// pulling the whole catalog back into the bundle.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CallExpression, Identifier, ImportDeclaration, Node, Program } from "estree";
import isReference from "is-reference";
import MagicString from "magic-string";
import { analyze, type Scope } from "periscopic";
import type { Plugin } from "vite";
import { walk } from "zimmerframe";

type Positioned = Node & { start: number; end: number };

export class MessageSplitError extends Error {
  constructor(
    message: string,
    readonly pos: number,
  ) {
    super(message);
  }
}

export interface SplitOptions {
  /** Whether an import specifier names the messages barrel. */
  isBarrel(source: string): boolean;
  /** Module path for a message key, or null when no such message exists. */
  messagePath(key: string): string | null;
  /** Every message key in the catalog. */
  messageKeys(): Iterable<string>;
}

const at = (node: Node) => (node as Positioned).start;

function pathFor(opts: SplitOptions, key: string, node: Node): string {
  const path = opts.messagePath(key);
  if (!path) throw new MessageSplitError(`unknown Paraglide message "${key}"`, at(node));
  return path;
}

/** The literal prefixes of a `keyedMessages(m, ["a_", …])` call whose first argument is `node`. */
function keyedPrefixes(node: Node, parent: Node): string[] | null {
  const call = parent as CallExpression;
  if (call.type !== "CallExpression" || call.arguments[0] !== node) return null;
  if (call.callee.type !== "Identifier" || call.callee.name !== "keyedMessages") return null;
  const list = call.arguments[1];
  if (list?.type !== "ArrayExpression" || !list.elements.length) return null;
  const prefixes = list.elements.map((el) =>
    el?.type === "Literal" && typeof el.value === "string" ? el.value : null,
  );
  return prefixes.every((p) => p) ? (prefixes as string[]) : null;
}

const importLine = (imported: string, local: string, path: string) =>
  `import { ${imported} as ${local} } from ${JSON.stringify(path)};`;

/** True for an `export … from <barrel>` statement, which can't be split. */
function reExportsBarrel(stmt: Program["body"][number], opts: SplitOptions): boolean {
  return (
    (stmt.type === "ExportAllDeclaration" || stmt.type === "ExportNamedDeclaration") &&
    !!stmt.source &&
    opts.isBarrel(String(stmt.source.value))
  );
}

/** Replaces one barrel import with per-message imports; returns the local names bound to `m`. */
function rewriteImport(s: MagicString, stmt: ImportDeclaration, opts: SplitOptions): string[] {
  const namespaces: string[] = [];
  const lines: string[] = [];
  for (const spec of stmt.specifiers) {
    if (spec.type !== "ImportSpecifier")
      throw new MessageSplitError(
        "only named imports from the Paraglide messages barrel can be split",
        at(spec),
      );
    const imported =
      spec.imported.type === "Identifier" ? spec.imported.name : String(spec.imported.value);
    if (imported === "m") namespaces.push(spec.local.name);
    else lines.push(importLine(imported, spec.local.name, pathFor(opts, imported, spec)));
  }
  s.overwrite(at(stmt), (stmt as Positioned).end, lines.join("\n"));
  return namespaces;
}

/** The `m.key` member expression `node` belongs to; throws for any other use of `m`. */
function memberKey(node: Identifier, parent: Node): { member: Node; key: Identifier } {
  if (
    parent.type !== "MemberExpression" ||
    parent.object !== node ||
    parent.computed ||
    parent.property.type !== "Identifier"
  )
    throw new MessageSplitError(
      `"${node.name}" from the Paraglide messages barrel must be used as ${node.name}.<key> or keyedMessages(${node.name}, ["prefix_"])`,
      at(node),
    );
  return { member: parent, key: parent.property };
}

/**
 * Rewrites every reference to the `m` bindings in `namespaces` (scope-aware, so
 * shadowing locals are left alone). Returns key → module path for the imports.
 */
function rewriteReferences(
  s: MagicString,
  ast: Program,
  namespaces: Set<string>,
  opts: SplitOptions,
): Map<string, string> {
  const keys = new Map<string, string>();
  const use = (key: string, node: Node) => {
    if (!keys.has(key)) keys.set(key, pathFor(opts, key, node));
  };
  const { map, scope: root } = analyze(ast);
  walk(ast as Node, root as Scope, {
    _(node, { state, next }) {
      if (node.type === "ImportDeclaration") return;
      next(map.get(node) ?? state);
    },
    Identifier(node: Identifier, { state, path }) {
      const parent = path.at(-1);
      if (!namespaces.has(node.name) || !parent || !isReference(node, parent)) return;
      if (state.find_owner(node.name) !== root) return;
      const prefixes = keyedPrefixes(node, parent);
      if (prefixes) {
        const family = [...opts.messageKeys()].filter((k) => prefixes.some((p) => k.startsWith(p)));
        for (const key of family) use(key, node);
        const object = `{ ${family.map((k) => `${k}: __pm_${k}`).join(", ")} }`;
        s.overwrite(at(node), (node as Positioned).end, object);
        return;
      }
      const { member, key } = memberKey(node, parent);
      use(key.name, key);
      s.overwrite(at(member), (member as Positioned).end, `__pm_${key.name}`);
    },
  });
  return keys;
}

/**
 * Rewrites barrel imports in `code` (parsed as `ast`) into per-message
 * imports. Returns null when the module doesn't import the barrel.
 */
export function rewriteMessageImports(code: string, ast: Program, opts: SplitOptions) {
  const s = new MagicString(code);
  const namespaces = new Set<string>();
  let touched = false;

  for (const stmt of ast.body) {
    if (reExportsBarrel(stmt, opts))
      throw new MessageSplitError(
        "re-exporting the Paraglide messages barrel defeats per-message splitting",
        at(stmt),
      );
    if (stmt.type !== "ImportDeclaration" || !opts.isBarrel(String(stmt.source.value))) continue;
    touched = true;
    for (const name of rewriteImport(s, stmt, opts)) namespaces.add(name);
  }
  if (!touched) return null;

  if (namespaces.size) {
    const keys = rewriteReferences(s, ast, namespaces, opts);
    s.prepend(
      [...keys].map(([key, path]) => importLine(key, `__pm_${key}`, path)).join("\n") + "\n",
    );
  }

  return { code: s.toString(), map: s.generateMap({ hires: true }) };
}

function readCatalog(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const file of readdirSync(dir)) {
    if (file === "_index.js" || !file.endsWith(".js")) continue;
    const text = readFileSync(dir + file, "utf8");
    const name = (/^export \{ \w+ as "(\w+)" \}/m.exec(text) ??
      /^export const (\w+) =/m.exec(text))?.[1];
    if (name) files.set(name, dir + file);
  }
  return files;
}

/** Vite plugin applying {@link rewriteMessageImports} to the app's own modules. */
export function paraglideSplit({ srcDir, outdir }: { srcDir: string; outdir: string }): Plugin {
  const src = resolve(srcDir) + "/";
  const out = resolve(outdir) + "/";
  // Export name → module file. Paraglide sanitizes file names and re-exports
  // under the real key (`export { …_alreadyredeemed1 as "…_alreadyRedeemed" }`),
  // so read each module's own export.
  let files: Map<string, string> | null = null;
  // Read on first use, not in buildStart: Paraglide (re)compiles the outdir in its
  // own buildStart, and Rollup runs those hooks in parallel.
  const catalog = () => (files ??= readCatalog(`${out}messages/`));
  const opts: SplitOptions = {
    isBarrel: (source) => /(^|\/)paraglide\/messages(\.js)?$/.test(source),
    messagePath: (key) => catalog().get(key) ?? null,
    messageKeys: () => catalog().keys(),
  };
  return {
    name: "shepherd:paraglide-split",
    apply: "build",
    enforce: "post",
    buildStart() {
      files = null;
    },
    transform(code, id) {
      if (id.includes("?") || !id.startsWith(src) || id.startsWith(out)) return null;
      if (!code.includes("paraglide/messages")) return null;
      try {
        return rewriteMessageImports(code, this.parse(code) as Program, opts);
      } catch (e) {
        if (e instanceof MessageSplitError) this.error(e.message, e.pos);
        throw e;
      }
    },
  };
}
