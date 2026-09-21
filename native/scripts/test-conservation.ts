/** Source identity accounting; never evaluates Swift conditional compilation. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";

export type TestIdentity = {
  target: string;
  path: string;
  suite: string;
  signature: string;
  line: number;
  attributes: string;
  condition: string;
  bodyHash: string;
  /** Immutable assertion fingerprints enable fail-closed one-to-many splits. */
  assertionHashes?: string[];
  /** Token text plus conditional context, including tokens inside assertion closures. */
  assertionConditionHashes?: string[];
};
export type IdentityMap = {
  oldID: string;
  destinations: string[];
  reason: string;
  assertionChanges: string[];
};
export function identity(test: TestIdentity): string {
  return JSON.stringify([test.target, test.path, test.suite, test.signature]);
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
type Token = { text: string; start: number; end: number; condition: string };

/** Strings (including interpolation), nested comments and delimiters are lexical,
 * not declaration regexes. Unsupported/malformed input fails rather than undercounts. */
function lex(source: string): Token[] {
  const tokens: Token[] = [];
  const branches: string[][] = [];
  let i = 0;
  function comment(): boolean {
    if (source.startsWith("//", i)) {
      while (i < source.length && source[i] !== "\n") i++;
      return true;
    }
    if (!source.startsWith("/*", i)) return false;
    i += 2;
    let depth = 1;
    while (i < source.length && depth) {
      if (source.startsWith("/*", i)) {
        depth++;
        i += 2;
      } else if (source.startsWith("*/", i)) {
        depth--;
        i += 2;
      } else i++;
    }
    if (depth) throw new Error("unterminated comment");
    return true;
  }
  function string(): boolean {
    const opening = /^(#*)("""|")/.exec(source.slice(i));
    if (!opening) return false;
    const hashes = opening[1]!,
      quote = opening[2]!;
    i += opening[0].length;
    while (i < source.length) {
      if (source.startsWith(quote + hashes, i)) {
        i += quote.length + hashes.length;
        return true;
      }
      if (source.startsWith("\\" + hashes, i)) {
        i += 1 + hashes.length;
        if (source[i] === "(") {
          i++;
          let depth = 1;
          while (i < source.length && depth) {
            if (comment() || string()) continue;
            if (source[i] === "(") depth++;
            if (source[i] === ")") depth--;
            i++;
          }
          if (depth) throw new Error("unterminated interpolation");
        } else i++;
      } else i++;
    }
    throw new Error("unterminated string");
  }
  while (i < source.length) {
    if (/\s/.test(source[i]!)) {
      i++;
      continue;
    }
    if (comment()) continue;
    const start = i;
    const directive = /^#(if|elseif|else|endif)\b[^\n]*/.exec(source.slice(i));
    if (directive) {
      const kind = directive[1];
      const text = directive[0].replace(/\/\/.*$/, "").trim();
      if (kind === "if") branches.push([text]);
      else {
        const branch = branches.at(-1);
        if (!branch) throw new Error("unmatched conditional directive");
        if (kind === "endif") branches.pop();
        else {
          if (branch.includes("#else")) throw new Error("branch after #else");
          branch.push(text);
        }
      }
      i += directive[0].length;
      continue;
    }
    if (!string()) {
      const word = /^(?:`[^`\n]+`|[A-Za-z_$][\w$]*)/.exec(source.slice(i));
      i += word ? word[0].length : 1;
    }
    tokens.push({
      text: source.slice(start, i),
      start,
      end: i,
      condition: branches.map((b) => b.join(" → ")).join(" / "),
    });
  }
  if (branches.length) throw new Error("unterminated conditional compilation");
  return tokens;
}
type SuiteDeclaration = { parent: string; attributes: string[] };
function scan(
  source: string,
  target: string,
  path: string,
  suites: Map<string, SuiteDeclaration>,
  collectSuites = false,
): TestIdentity[] {
  function suiteAttributes(name: string, seen = new Set<string>()): string[] {
    if (!name) return [];
    if (seen.has(name)) throw new Error(`cyclic suite declaration ${name}`);
    seen.add(name);
    const declaration = suites.get(name);
    // An extension can name a nested type whose enclosing type has traits.
    if (!declaration) return suiteAttributes(name.split(".").slice(0, -1).join("."), seen);
    return [...suiteAttributes(declaration.parent, seen), ...declaration.attributes];
  }
  const tokens = lex(source);
  const at = (index: number): Token => {
    const token = tokens[index];
    if (!token) throw new Error(`incomplete declaration in ${path}`);
    return token;
  };
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  const closes: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  tokens.forEach((t, n) => {
    if (["(", "[", "{"].includes(t.text)) stack.push(n);
    else if (closes[t.text]) {
      const open = stack.pop();
      if (open === undefined || at(open).text !== closes[t.text])
        throw new Error(`unmatched delimiter in ${path}`);
      pairs.set(open, n);
    }
  });
  if (stack.length) throw new Error(`unmatched delimiter in ${path}`);
  const canonical = (start: number, end: number) =>
    tokens
      .slice(start, end)
      .map((t) => t.text)
      .join(" ");
  const textRange = (start: number, end: number) =>
    source.slice(at(start).start, at(end - 1).end).trim();
  // Normalize source layout without changing whitespace inside literal tokens.
  const signatureRange = (start: number, end: number) => {
    let signature = at(start).text;
    for (let n = start + 1; n < end; n++) {
      signature += source.slice(at(n - 1).end, at(n).start).replace(/\s+/g, " ") + at(n).text;
    }
    return signature;
  };
  const result: TestIdentity[] = [];
  function declarations(
    start: number,
    end: number,
    suite: string,
    xctest: boolean,
    inherited: string[],
  ) {
    let attrs: string[] = [];
    let hasTest = false;
    for (let n = start; n < end; n++) {
      const t = at(n);
      // The declaration registry must not propagate import attributes as suite traits.
      // Leave legacy direct-test metadata unchanged during this supplemental capture.
      if (collectSuites && t.text === "import") attrs = [];
      if (t.text === "@") {
        const first = n;
        if (!tokens[n + 1]) throw new Error("incomplete attribute");
        const name = at(++n).text;
        if (tokens[n + 1]?.text === "(") {
          n = pairs.get(n + 1)!;
        }
        attrs.push(textRange(first, n + 1));
        if (name === "Test") {
          if (hasTest) throw new Error("multiple @Test attributes");
          hasTest = true;
        }
        continue;
      }
      if (["struct", "class", "enum", "extension", "actor"].includes(t.text)) {
        if (hasTest) throw new Error("@Test is not attached to a function");
        let brace = n + 1;
        while (brace < end && at(brace).text !== "{") brace++;
        if (brace === end) throw new Error("missing suite body");
        let nameEnd = n + 2;
        while (tokens[nameEnd]?.text === ".") nameEnd += 2;
        const name = tokens
          .slice(n + 1, nameEnd)
          .map((t) => t.text)
          .join("");
        const qualified = suite ? `${suite}.${name}` : name;
        const isXCTest = tokens.slice(nameEnd, brace).some((t) => t.text === "XCTestCase");
        if (collectSuites && t.text !== "extension") {
          const declaration = { parent: suite, attributes: [...attrs] };
          const previous = suites.get(qualified);
          if (previous && JSON.stringify(previous) !== JSON.stringify(declaration))
            throw new Error(`ambiguous suite attributes ${qualified} in ${path}`);
          suites.set(qualified, declaration);
        }
        const effective =
          t.text === "extension" && !collectSuites
            ? [...suiteAttributes(qualified), ...attrs]
            : [...inherited, ...attrs];
        declarations(brace + 1, pairs.get(brace)!, qualified, isXCTest, effective);
        n = pairs.get(brace)!;
        attrs = [];
        continue;
      }
      if (t.text === "func") {
        let brace = n + 1;
        while (brace < end && at(brace).text !== "{") {
          if (at(brace).text === "(" || at(brace).text === "[") brace = pairs.get(brace)!;
          brace++;
        }
        if (brace === end) throw new Error("function without body");
        const close = pairs.get(brace)!;
        if (hasTest || (xctest && at(n + 1).text.startsWith("test"))) {
          const assertionHashes: string[] = [];
          const assertionConditionHashes: string[] = [];
          for (let k = brace + 1; k < close; k++) {
            const macro =
              at(k).text === "#" && ["expect", "require"].includes(tokens[k + 1]?.text ?? "");
            const xc = /^XCT(?:Assert\w*|Fail|Unwrap)$/.test(at(k).text);
            const issue =
              at(k).text === "Issue" &&
              tokens[k + 1]?.text === "." &&
              tokens[k + 2]?.text === "record";
            const builtin = [
              "assert",
              "assertionFailure",
              "precondition",
              "preconditionFailure",
            ].includes(at(k).text);
            const arg = k + (macro ? 2 : issue ? 3 : 1);
            if ((macro || xc || issue || builtin) && tokens[arg]?.text === "(") {
              let last = pairs.get(arg)!;
              // Include trailing assertion closures (e.g. #expect(throws:) {}).
              if (tokens[last + 1]?.text === "{") last = pairs.get(last + 1)!;
              assertionHashes.push(hash(canonical(k, last + 1)));
              assertionConditionHashes.push(
                hash(
                  JSON.stringify(
                    tokens.slice(k, last + 1).map((token) => [token.text, token.condition]),
                  ),
                ),
              );
            }
          }
          result.push({
            target,
            path,
            suite,
            signature: signatureRange(n + 1, brace),
            line: source.slice(0, t.start).split("\n").length,
            attributes: [...inherited, ...attrs].join("\n"),
            condition: t.condition,
            bodyHash: hash(source.slice(at(brace).start, at(close).end)),
            assertionHashes,
            assertionConditionHashes,
          });
        }
        hasTest = false;
        attrs = [];
        n = close;
        continue;
      }
      if (["let", "var", "init", "deinit", "subscript", "typealias"].includes(t.text)) {
        if (hasTest) throw new Error("@Test is not attached to a function");
        attrs = [];
      }
      if (["{", "(", "["].includes(t.text)) n = pairs.get(n)!;
    }
    if (hasTest) throw new Error("orphan @Test");
  }
  declarations(0, tokens.length, "", false, []);
  return result;
}
const roots = [
  ["ShepherdTests", "native/Apps/ShepherdMac/Tests"],
  ["ShepherdUITests", "native/Apps/ShepherdMac/UITests"],
  ["ShepherdKitTests", "native/Tests/ShepherdKitTests"],
  ["ShepherdAppCoreTests", "native/Tests/ShepherdAppCoreTests"],
] as const;
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? files(join(dir, e.name))
        : e.name.endsWith(".swift")
          ? [join(dir, e.name)]
          : [],
    )
    .sort();
}
function collectTargetTests(
  target: string,
  sources: { path: string; source: string }[],
): TestIdentity[] {
  // Resolve declarations before scanning extensions, irrespective of file order.
  // Each target has its own registry; no import/type-system inference is attempted.
  const suites = new Map<string, SuiteDeclaration>();
  for (const { source, path } of sources) scan(source, target, path, suites, true);
  return sources.flatMap(({ source, path }) => scan(source, target, path, suites));
}

export function collectTests(root: string): TestIdentity[] {
  const tests = roots.flatMap(([target, dir]) => {
    const sources = files(join(root, dir)).map((file) => ({
      path: relative(root, file),
      source: readFileSync(file, "utf8"),
    }));
    return collectTargetTests(target, sources);
  });
  tests.sort((a, b) => identity(a).localeCompare(identity(b), "en"));
  if (new Set(tests.map(identity)).size !== tests.length)
    throw new Error("duplicate current identity");
  return tests;
}

/** Read provenance from immutable Git objects, never from a recaptured worktree. */
export function collectTestsAtRevision(root: string, revision: string): TestIdentity[] {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("provenance requires a full commit SHA");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const tests = roots.flatMap(([target, dir]) => {
    const paths = git("ls-tree", "-r", "--name-only", revision, "--", dir)
      .trim()
      .split("\n")
      .filter((path) => path.endsWith(".swift"));
    const sources = paths.map((path) => ({ path, source: git("show", `${revision}:${path}`) }));
    return collectTargetTests(target, sources);
  });
  tests.sort((a, b) => identity(a).localeCompare(identity(b), "en"));
  if (new Set(tests.map(identity)).size !== tests.length) throw new Error("duplicate Git identity");
  return tests;
}
/** Stage 1 adds one enclosing serialization trait, without replacing any old trait.
 * Restrict the exception to the two prescribed wrappers and unchanged inner suite.
 * Check this before ordinary equality: otherwise losing inner serialization could
 * be concealed by the new outer trait producing the old attribute string.
 */
function preservedAttributes(old: TestIdentity, dest: TestIdentity): boolean {
  const wrapper =
    dest.target === "ShepherdAppCoreTests"
      ? "CoreSeamTests"
      : dest.target === "ShepherdTests"
        ? "MacSeamTests"
        : undefined;
  if (/^(CoreSeamTests|MacSeamTests)\./.test(dest.suite)) {
    // The immutable v1 direct-test capture includes leading @testable import
    // markers. They are not Swift suite traits; mixed targets now import two
    // modules. Normalize only that exact historical prefix, only here.
    const imports = (attributes: string) => attributes.replace(/^(?:@testable\n)+/, "");
    const attributes = imports(dest.attributes);
    const outer = "@Suite(.serialized)\n";
    return (
      wrapper !== undefined &&
      old.target === "ShepherdTests" &&
      dest.suite === `${wrapper}.${old.suite}` &&
      attributes.startsWith(outer) &&
      imports(attributes.slice(outer.length)) === imports(old.attributes)
    );
  }
  return dest.attributes === old.attributes;
}

export function verifyConservation(
  baseline: TestIdentity[],
  current: TestIdentity[],
  mapping: IdentityMap[],
  added: string[],
): void {
  const originalIDs = new Set(baseline.map(identity));
  if (originalIDs.size !== baseline.length) throw new Error("duplicate baseline identity");
  const rows = new Map(mapping.map((row) => [row.oldID, row]));
  if (rows.size !== mapping.length || rows.size !== originalIDs.size)
    throw new Error("mapping must contain every original exactly once");
  const now = new Map(current.map((t) => [identity(t), t]));
  if (now.size !== current.length) throw new Error("duplicate current identity");
  const used = new Set<string>();
  for (const old of baseline) {
    const oldID = identity(old),
      row = rows.get(oldID);
    if (!row || !row.destinations.length || !row.reason.trim())
      throw new Error("missing original " + oldID);
    if (
      ["ShepherdKitTests", "ShepherdUITests"].includes(old.target) &&
      (row.destinations.length !== 1 || row.destinations[0] !== oldID)
    )
      throw new Error("Kit/UI identities must be retained");
    const destinations = row.destinations.map((id) => {
      if (used.has(id)) throw new Error("duplicate destination " + id);
      used.add(id);
      const dest = now.get(id);
      if (!dest) throw new Error("missing destination " + id);
      if (!preservedAttributes(old, dest) || dest.condition !== old.condition)
        throw new Error("changed attributes/conditions " + id);
      return dest;
    });
    if (destinations.some((d) => d.bodyHash !== old.bodyHash)) {
      if (
        !row.assertionChanges.length ||
        row.assertionChanges.some(
          (s) => !/^(import|fixture|resource|current-module):\s*\S.+/.test(s),
        )
      )
        throw new Error("body changes require reviewed extraction explanations " + oldID);
    }
    if (destinations.length > 1) {
      if (
        !old.assertionHashes?.length ||
        old.assertionConditionHashes?.length !== old.assertionHashes.length ||
        destinations.some(
          (d) =>
            !d.assertionHashes || d.assertionConditionHashes?.length !== d.assertionHashes.length,
        )
      )
        throw new Error("split requires original assertion evidence " + oldID);
      const available = destinations.flatMap((d) => d.assertionConditionHashes!);
      for (const assertion of old.assertionConditionHashes!) {
        const index = available.indexOf(assertion);
        if (index < 0) throw new Error("split lost original assertion " + oldID);
        available.splice(index, 1);
      }
    }
  }
  for (const id of added) {
    if (used.has(id) || originalIDs.has(id) || !now.has(id))
      throw new Error("invalid/duplicate addition " + id);
    used.add(id);
  }
  for (const id of now.keys()) if (!used.has(id)) throw new Error("unaccounted addition " + id);
}
export type UpstreamTransition = {
  original: TestIdentity | null;
  upstream: TestIdentity;
  destination: TestIdentity;
  reason: string;
};
export type UpstreamProvenance = {
  schemaVersion: 1;
  originalSHA: string;
  sourceSHA: string;
  sourceBlobs: Record<string, string>;
  transitions: UpstreamTransition[];
};
const sameTest = (a: TestIdentity, b: TestIdentity) =>
  JSON.stringify({ ...a, line: 0 }) === JSON.stringify({ ...b, line: 0 });

/** Every upstream delta has one Git-sourced origin and one exact destination.
 * The original capture is never edited; changed expectations are explicitly
 * chained through upstream. New Stage 1 and upstream tests stay separate.
 */
export function verifyUpstreamTransitions(
  baseline: TestIdentity[],
  upstream: TestIdentity[],
  current: TestIdentity[],
  mapping: IdentityMap[],
  transitions: UpstreamTransition[],
  upstreamAdded: string[],
): TestIdentity[] {
  const originals = new Map(baseline.map((t) => [identity(t), t]));
  const next = new Map(upstream.map((t) => [identity(t), t]));
  const now = new Map(current.map((t) => [identity(t), t]));
  const rows = new Map(mapping.map((row) => [row.oldID, row]));
  const seenOld = new Set<string>(),
    seenNext = new Set<string>(),
    seenDest = new Set<string>();
  const effective = new Map(originals);
  const additions: string[] = [];
  for (const transition of transitions) {
    const { original, upstream: source, destination, reason } = transition;
    const sourceID = identity(source),
      destID = identity(destination);
    if (!reason.trim() || seenNext.has(sourceID) || seenDest.has(destID))
      throw new Error("duplicate or unexplained upstream transition");
    seenNext.add(sourceID);
    seenDest.add(destID);
    if (!next.has(sourceID) || !sameTest(next.get(sourceID)!, source))
      throw new Error("upstream snapshot does not match Git source " + sourceID);
    if (!now.has(destID) || !sameTest(now.get(destID)!, destination))
      throw new Error("upstream destination changed " + destID);
    if (
      JSON.stringify(source.assertionConditionHashes) !==
      JSON.stringify(destination.assertionConditionHashes)
    )
      throw new Error("upstream assertions changed " + destID);
    if (source.condition !== destination.condition || !preservedAttributes(source, destination))
      throw new Error("upstream attributes/conditions changed " + destID);
    if (original) {
      const oldID = identity(original);
      if (seenOld.has(oldID) || !originals.has(oldID) || !sameTest(originals.get(oldID)!, original))
        throw new Error("upstream original does not match immutable baseline " + oldID);
      if (next.has(oldID) && oldID !== sourceID)
        throw new Error("upstream addition cannot replace an unchanged original " + oldID);
      seenOld.add(oldID);
      if (sameTest(original, source)) throw new Error("unnecessary upstream replacement " + oldID);
      if (JSON.stringify(rows.get(oldID)?.destinations) !== JSON.stringify([destID]))
        throw new Error("upstream destination mapping mismatch " + oldID);
      effective.set(oldID, {
        ...source,
        target: original.target,
        path: original.path,
        suite: original.suite,
        signature: original.signature,
        line: original.line,
      });
    } else {
      if (originals.has(sourceID)) throw new Error("original mislabeled as upstream addition");
      additions.push(destID);
    }
  }
  for (const source of upstream) {
    const old = originals.get(identity(source));
    if ((!old || !sameTest(old, source)) && !seenNext.has(identity(source)))
      throw new Error("unmapped upstream change " + identity(source));
  }
  for (const old of baseline) {
    if (!next.has(identity(old)) && !seenOld.has(identity(old)))
      throw new Error("original removed upstream without an explicit successor " + identity(old));
  }
  if (JSON.stringify([...additions].sort()) !== JSON.stringify([...upstreamAdded].sort()))
    throw new Error("upstream additions do not match independent provenance");
  return [...effective.values()];
}

export type FixtureTransition = {
  oldID: string;
  source: TestIdentity;
  destination: TestIdentity;
};
export type FixtureProvenance = {
  schemaVersion: 1;
  sourceSHA: string;
  reviewedSHA: string;
  sourceBlobs: Record<string, string>;
  reviewedBlobs: Record<string, string>;
  transitions: FixtureTransition[];
  snapshots: Record<"source" | "reviewed" | "suite", { file: string; sha256: string }>;
};
const fixtureSignatures = [
  "liveSignInAndRestore() async throws",
  "theSessionListRendersAgainstTheLiveServer() async throws",
];
const fixturePath = "native/Apps/ShepherdMac/Tests/LiveServerTests.swift";
const fixtureSuitePath = "native/Apps/ShepherdMac/Tests/MacSeamTests.swift";
// Durable byte-for-byte Git exports. Feature commit IDs below are metadata only:
// squash merges must not make these snapshots depend on unreachable Git objects.
const fixtureSnapshotPins = {
  source: {
    file: "fixtures/live-server-source.swift.txt",
    sha256: "307ed27071a67a0966c7e4b02d2eb4112491b51bef07d9be2ac732a9ee946b0a",
  },
  reviewed: {
    file: "fixtures/live-server-reviewed.swift.txt",
    sha256: "e852f61b32965484187000680400039dc5adbe45045a8178eba6ae94c96681d7",
  },
  suite: {
    file: "fixtures/mac-seam-suite.swift.txt",
    sha256: "7a607fec597cdc0b210350e07d13c3fa88df524bef6df7586b21f524d013a286",
  },
} as const;

/** Two exact fixture adaptations, anchored to durable Git-sourced snapshots at both ends. Descriptive map
 * strings cannot authorize drift; every assertion and condition is retained except
 * the one explicitly named token-source expression in the second test.
 */
export function verifyFixtureTransitions(
  baseline: TestIdentity[],
  sourceSnapshot: TestIdentity[],
  reviewedSnapshot: TestIdentity[],
  current: TestIdentity[],
  mapping: IdentityMap[],
  transitions: FixtureTransition[],
): TestIdentity[] {
  const effective = new Map(baseline.map((t) => [identity(t), t]));
  const source = new Map(sourceSnapshot.map((t) => [identity(t), t]));
  const reviewed = new Map(reviewedSnapshot.map((t) => [identity(t), t]));
  const now = new Map(current.map((t) => [identity(t), t]));
  const rows = new Map(mapping.map((t) => [t.oldID, t]));
  if (transitions.length !== 2) throw new Error("exactly two fixture transitions required");
  const seen = new Set<string>();
  const assertion = (text: string, conditional: boolean) => {
    const tokens = lex(text);
    return hash(
      conditional
        ? JSON.stringify(tokens.map((t) => [t.text, t.condition]))
        : tokens.map((t) => t.text).join(" "),
    );
  };
  for (const transition of transitions) {
    const { oldID, source: before, destination: after } = transition;
    const original = effective.get(oldID);
    const destID = identity(after);
    if (
      !original ||
      original.path !== fixturePath ||
      original.suite !== "LiveServerTests" ||
      !fixtureSignatures.includes(original.signature) ||
      seen.has(original.signature)
    )
      throw new Error("unlisted or duplicate fixture transition");
    seen.add(original.signature);
    if (
      identity(before) !== destID ||
      after.path !== fixturePath ||
      after.suite !== "MacSeamTests.LiveServerTests" ||
      after.target !== "ShepherdTests" ||
      after.signature !== original.signature ||
      JSON.stringify(rows.get(oldID)?.destinations) !== JSON.stringify([destID]) ||
      rows.get(oldID)?.assertionChanges.length !== 0
    )
      throw new Error("fixture destination mapping changed");
    if (!source.has(identity(before)) || !sameTest(source.get(identity(before))!, before))
      throw new Error("fixture source does not match Git-sourced snapshot");
    if (!reviewed.has(destID) || !sameTest(reviewed.get(destID)!, after))
      throw new Error("fixture adaptation does not match reviewed Git-sourced snapshot");
    if (!now.has(destID) || !sameTest(now.get(destID)!, after))
      throw new Error("fixture destination drift");
    if (
      !preservedAttributes(original, before) ||
      before.attributes !== after.attributes ||
      original.condition !== before.condition ||
      before.condition !== after.condition
    )
      throw new Error("fixture attributes/conditions changed");
    for (const field of ["assertionHashes", "assertionConditionHashes"] as const) {
      if (
        !original[field]?.length ||
        JSON.stringify(original[field]) !== JSON.stringify(before[field])
      )
        throw new Error("fixture source lost original assertions");
      const expected = [...before[field]!];
      if (original.signature === fixtureSignatures[1]) {
        const conditional = field === "assertionConditionHashes";
        const from = assertion("#require(LiveServerEnvironment.token)", conditional);
        const to = assertion("#require(fixtureToken)", conditional);
        const index = expected.indexOf(from);
        if (index < 0 || expected.lastIndexOf(from) !== index)
          throw new Error("fixture token substitution missing or duplicated");
        expected[index] = to;
      }
      if (JSON.stringify(expected) !== JSON.stringify(after[field]))
        throw new Error("fixture lost or substituted an original assertion");
    }
    effective.set(oldID, {
      ...original,
      bodyHash: after.bodyHash,
      assertionHashes: after.assertionHashes,
      assertionConditionHashes: after.assertionConditionHashes,
    });
  }
  return [...effective.values()];
}

export function readFixtureProvenance(root: string): {
  provenance: FixtureProvenance;
  source: TestIdentity[];
  reviewed: TestIdentity[];
} {
  const provenance = JSON.parse(
    readFileSync(join(root, "native/Tests/Conservation/issue-2431-fixtures.json"), "utf8"),
  ) as FixtureProvenance;
  if (
    provenance.schemaVersion !== 1 ||
    provenance.sourceSHA !== "0acfc8726306e4befa48397a6d0dfaa3bb790764" ||
    provenance.reviewedSHA !== "5f5cf8183bd4baebe0d3c2998213362b015b299d"
  )
    throw new Error("unexpected fixture provenance revision");
  const directory = join(root, "native/Tests/Conservation");
  const snapshots = {} as Record<keyof typeof fixtureSnapshotPins, string>;
  if (
    JSON.stringify(Object.keys(provenance.snapshots).sort()) !==
    JSON.stringify(Object.keys(fixtureSnapshotPins).sort())
  )
    throw new Error("fixture snapshot inventory mismatch");
  for (const role of Object.keys(fixtureSnapshotPins) as (keyof typeof fixtureSnapshotPins)[]) {
    const pin = fixtureSnapshotPins[role];
    const recorded = provenance.snapshots[role];
    if (recorded.file !== pin.file || recorded.sha256 !== pin.sha256)
      throw new Error("fixture snapshot pin changed");
    const content = readFileSync(join(directory, pin.file), "utf8");
    if (hash(content) !== pin.sha256) throw new Error("fixture snapshot content changed");
    snapshots[role] = content;
  }
  // Check the historical blob metadata without resolving any feature commit.
  const gitBlob = (content: string) =>
    createHash("sha1")
      .update(`blob ${Buffer.byteLength(content)}\0`)
      .update(content)
      .digest("hex");
  for (const role of ["source", "reviewed"] as const) {
    const blobs = role === "source" ? provenance.sourceBlobs : provenance.reviewedBlobs;
    if (
      JSON.stringify(Object.keys(blobs).sort()) !==
      JSON.stringify([fixturePath, fixtureSuitePath].sort())
    )
      throw new Error("fixture source blob inventory mismatch");
    if (
      blobs[fixturePath] !== gitBlob(snapshots[role]) ||
      blobs[fixtureSuitePath] !== gitBlob(snapshots.suite)
    )
      throw new Error("fixture source blob metadata changed");
  }
  const collect = (role: "source" | "reviewed") =>
    collectTargetTests("ShepherdTests", [
      { path: fixturePath, source: snapshots[role] },
      { path: fixtureSuitePath, source: snapshots.suite },
    ]);
  return { provenance, source: collect("source"), reviewed: collect("reviewed") };
}

if (import.meta.main) {
  const root = process.cwd();
  const baselinePath = join(root, "native/Tests/Conservation/issue-2431-baseline.json");
  const mapPath = join(dirname(baselinePath), "issue-2431-map.json");
  const mode = process.argv.slice(2);
  if (mode.length !== 1 || !["--capture", "--check"].includes(mode[0] ?? ""))
    throw new Error("usage: test-conservation.ts --capture|--check");
  const current = collectTests(root);
  if (!current.length) throw new Error("no test declarations found");
  if (mode[0] === "--capture") {
    if (existsSync(baselinePath) || existsSync(mapPath))
      throw new Error("baseline/map already exist; immutable capture refused");
    const sourceSHA = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const dirty = execFileSync(
      "git",
      ["status", "--porcelain", "--", ...roots.map(([, dir]) => dir)],
      { cwd: root, encoding: "utf8" },
    );
    if (dirty.trim()) throw new Error("test sources must be clean for capture");
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, JSON.stringify({ sourceSHA, tests: current }, null, 2) + "\n", {
      flag: "wx",
    });
    writeFileSync(
      mapPath,
      JSON.stringify(
        {
          mappings: current.map((t) => ({
            oldID: identity(t),
            destinations: [identity(t)],
            reason: "retained",
            assertionChanges: [],
          })),
          added: [],
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
    sourceSHA: string;
    tests: TestIdentity[];
  };
  const map = JSON.parse(readFileSync(mapPath, "utf8")) as {
    mappings: IdentityMap[];
    added: string[];
    upstreamAdded?: string[];
    harnessAdded?: string[];
  };
  if (mode[0] === "--check" && !Array.isArray(map.upstreamAdded))
    throw new Error("pinned upstream provenance mapping is required");
  let expected = baseline.tests;
  if (map.upstreamAdded) {
    if (
      hash(JSON.stringify(map.added)) !==
      "cc26d62201498a1302326a5decd3e0fab0b7d8f01c9f26b66a35d1cf3e6619f7"
    )
      throw new Error("original eight Stage 1 additions changed");
    if (
      hash(readFileSync(baselinePath, "utf8")) !==
      "4597df722a42ac93012462cbbcda09f68cd3d21af86a54c4b1b0242597325af0"
    )
      throw new Error("immutable original baseline changed");
    const provenance = JSON.parse(
      readFileSync(join(dirname(baselinePath), "issue-2431-upstream.json"), "utf8"),
    ) as UpstreamProvenance;
    if (
      provenance.schemaVersion !== 1 ||
      provenance.originalSHA !== baseline.sourceSHA ||
      provenance.sourceSHA !== "c4961c40ec2cdfde9c011387536d2bd0bc1f9e58"
    )
      throw new Error("unexpected upstream provenance revision");
    const upstream = collectTestsAtRevision(root, provenance.sourceSHA);
    const paths = [...new Set(provenance.transitions.map((t) => t.upstream.path))].sort();
    if (JSON.stringify(Object.keys(provenance.sourceBlobs).sort()) !== JSON.stringify(paths))
      throw new Error("upstream source blob inventory mismatch");
    for (const path of paths) {
      const blob = execFileSync("git", ["rev-parse", `${provenance.sourceSHA}:${path}`], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      if (blob !== provenance.sourceBlobs[path])
        throw new Error("upstream source blob changed " + path);
    }
    expected = verifyUpstreamTransitions(
      baseline.tests,
      upstream,
      current,
      map.mappings,
      provenance.transitions,
      map.upstreamAdded,
    );
  }
  const fixtures = readFixtureProvenance(root);
  expected = verifyFixtureTransitions(
    expected,
    fixtures.source,
    fixtures.reviewed,
    current,
    map.mappings,
    fixtures.provenance.transitions,
  );
  verifyConservation(expected, current, map.mappings, [
    ...map.added,
    ...(map.upstreamAdded ?? []),
    ...(map.harnessAdded ?? []),
  ]);
  console.log(
    `sourceSHA=${baseline.sourceSHA}; conserved original identities=${baseline.tests.length}; raw declarations=${current.length}; additional split declarations=${map.mappings.reduce((n, row) => n + row.destinations.length - 1, 0)}; explicit Stage 1 additions=${map.added.length}; upstream additions=${map.upstreamAdded?.length ?? 0}; isolated harness additions=${map.harnessAdded?.length ?? 0}`,
  );
  for (const [target, dir] of roots)
    console.log(
      `${target}: files=${files(join(root, dir)).length}; declarations=${current.filter((t) => t.target === target).length}; conserved originals=${baseline.tests.filter((t) => t.target === target).length}`,
    );
}
