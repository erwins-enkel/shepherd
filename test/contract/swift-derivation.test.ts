/**
 * `contracts/openapi.swift.yaml` is the swift-openapi-generator input derived from the truth file
 * by `scripts/gen-contract-swift.ts`. This test is the derivation's contract: it proves the
 * derived file contains none of the four constructs the generator chokes on, that it still covers
 * every operation and schema the truth file declares, and that the committed bytes are what a
 * fresh derivation produces — so `bun run test` catches a stale file even where
 * `bun run check:contract-swift` is not wired into CI yet.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { deriveSwiftSpec, DERIVED_PATH, TRUTH_PATH } from "../../scripts/gen-contract-swift";

const truthText = readFileSync(TRUTH_PATH, "utf8");
const derivedText = readFileSync(DERIVED_PATH, "utf8");
const truth = Bun.YAML.parse(truthText) as Record<string, unknown>;
const derived = Bun.YAML.parse(derivedText) as Record<string, unknown>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every object node in the document, with the JSON pointer that reaches it (for failure text). */
function nodes(root: unknown): { path: string; node: Obj }[] {
  const out: { path: string; node: Obj }[] = [];
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}/${i}`));
      return;
    }
    if (!isObj(v)) return;
    out.push({ path, node: v });
    for (const [k, child] of Object.entries(v)) walk(child, `${path}/${k}`);
  };
  walk(root, "#");
  return out;
}

const derivedNodes = nodes(derived);

function operationIds(doc: Record<string, unknown>): string[] {
  return nodes(doc)
    .filter(({ path }) => path.startsWith("#/paths/"))
    .map(({ node }) => node.operationId)
    .filter((id): id is string => typeof id === "string")
    .sort();
}

function schemaNames(doc: Record<string, unknown>): string[] {
  const components = doc.components as { schemas?: Obj } | undefined;
  return Object.keys(components?.schemas ?? {}).sort();
}

describe("swift-openapi-generator derivation", () => {
  test("no union branch is the bare null schema (apple/swift-openapi-generator#817)", () => {
    const offenders: string[] = [];
    for (const { path, node } of derivedNodes) {
      for (const keyword of ["oneOf", "anyOf", "allOf"]) {
        const branches = node[keyword];
        if (!Array.isArray(branches)) continue;
        branches.forEach((b, i) => {
          if (isObj(b) && b.type === "null") offenders.push(`${path}/${keyword}/${i}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no enum contains null (#118) and no const survives (#261)", () => {
    const enumsWithNull: string[] = [];
    const consts: string[] = [];
    for (const { path, node } of derivedNodes) {
      if (Array.isArray(node.enum) && node.enum.includes(null)) enumsWithNull.push(path);
      if ("const" in node) consts.push(path);
    }
    expect(enumsWithNull).toEqual([]);
    expect(consts).toEqual([]);
  });

  test("no x-shepherd-open-enum flag survives the rewrite", () => {
    const flagged = derivedNodes
      .filter(({ node }) => "x-shepherd-open-enum" in node)
      .map(({ path }) => path);
    expect(flagged).toEqual([]);
    // …and the flag is genuinely present in the truth file, so the assertion above is not vacuous.
    expect(nodes(truth).some(({ node }) => node["x-shepherd-open-enum"] === true)).toBe(true);
  });

  test("every operationId and component schema of the truth file survives", () => {
    const truthOps = operationIds(truth);
    expect(truthOps.length).toBeGreaterThan(0);
    expect(operationIds(derived)).toEqual(truthOps);

    const truthSchemas = schemaNames(truth);
    expect(truthSchemas.length).toBeGreaterThan(0);
    for (const name of truthSchemas) expect(schemaNames(derived)).toContain(name);
  });

  test("Session.sandboxApplied collapses to the profile ref and leaves required", () => {
    const session = (derived.components as { schemas: Obj }).schemas.Session as {
      required: string[];
      properties: Obj;
    };
    expect(session.properties.sandboxApplied).toEqual({
      $ref: "#/components/schemas/SandboxProfile",
    });
    expect(session.required).not.toContain("sandboxApplied");
    // The truth file still says it is required-and-nullable — that is the drift this guards.
    const truthSession = (truth.components as { schemas: Obj }).schemas.Session as {
      required: string[];
    };
    expect(truthSession.required).toContain("sandboxApplied");
  });

  test("the committed file is what a fresh derivation produces", async () => {
    expect(await deriveSwiftSpec(truthText)).toBe(derivedText);
  });
});
