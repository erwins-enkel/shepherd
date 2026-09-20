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

  test("every open enum named as a component splits into a <Name>Known closed enum", () => {
    const truthSchemas = (truth.components as { schemas: Obj }).schemas;
    const derivedSchemas = (derived.components as { schemas: Obj }).schemas;
    const flagged = Object.keys(truthSchemas).filter(
      (name) => isObj(truthSchemas[name]) && truthSchemas[name]["x-shepherd-open-enum"] === true,
    );
    expect(flagged).toContain("SessionStatus");
    for (const name of flagged) {
      expect(derivedSchemas[name]).toEqual({
        anyOf: [{ $ref: `#/components/schemas/${name}Known` }, { type: "string" }],
      });
      const known = derivedSchemas[`${name}Known`] as Obj;
      expect(known.type).toBe("string");
      expect(known.enum).toEqual((truthSchemas[name] as Obj).enum as unknown[]);
    }
  });

  test("the committed file is what a fresh derivation produces", async () => {
    expect(await deriveSwiftSpec(truthText)).toBe(derivedText);
  });
});

test("explicit null write scalars remain required opaque generated values", async () => {
  const input = `openapi: 3.1.0
info: {title: Fixture, version: '1'}
paths: {}
components:
  schemas:
    Override:
      type: object
      required: [enabled]
      properties:
        enabled:
          type: [boolean, 'null']
          x-shepherd-explicit-null: true
`;
  const result = Bun.YAML.parse(await deriveSwiftSpec(input)) as {
    components: {
      schemas: { Override: { required: string[]; properties: { enabled: { type?: unknown } } } };
    };
  };
  expect(result.components.schemas.Override.required).toEqual(["enabled"]);
  expect(result.components.schemas.Override.properties.enabled.type).toBeUndefined();
});

test.each(["[boolean, string, 'null']", "[object, 'null']", "boolean"])(
  "explicit null rejects invalid scalar type %s with its pointer",
  async (type) => {
    const input = doc(
      [
        "    Override:",
        "      type: object",
        "      required: [enabled]",
        "      properties:",
        "        enabled:",
        `          type: ${type}`,
        "          x-shepherd-explicit-null: true",
      ].join("\n"),
    );
    await expect(deriveSwiftSpec(input)).rejects.toThrow(
      "invalid explicit-null scalar at #/components/schemas/Override/properties/enabled",
    );
  },
);

test("explicit null rejects an array item where nullableOk is false with its pointer", async () => {
  const input = doc(
    [
      "    Override:",
      "      type: array",
      "      items:",
      "        type: [boolean, 'null']",
      "        x-shepherd-explicit-null: true",
    ].join("\n"),
  );
  await expect(deriveSwiftSpec(input)).rejects.toThrow(
    "invalid explicit-null scalar at #/components/schemas/Override/items",
  );
});

/** Minimal document the unit cases below hang their one interesting schema off. */
function doc(schemas: string): string {
  return [
    "openapi: 3.1.0",
    "info: { title: t, version: '1' }",
    "paths: {}",
    "components:",
    "  schemas:",
    schemas,
  ].join("\n");
}

async function derive(schemas: string): Promise<Obj> {
  const out = Bun.YAML.parse(await deriveSwiftSpec(doc(schemas))) as Obj;
  return (out.components as { schemas: Obj }).schemas;
}

/**
 * The rules above are stated over whole documents; these pin the walk itself. The derivation is
 * schema-aware — it must know a `properties` key is a name, not a keyword — and strict: where it
 * cannot rewrite a construct faithfully it throws with the offending JSON pointer instead of
 * quietly dropping nullability.
 */
describe("derivation is schema-aware and strict", () => {
  test("properties named after keywords are data, not keywords", async () => {
    const schemas = await derive(
      [
        "    Thing:",
        "      type: object",
        "      required: [const, enum, oneOf]",
        "      properties:",
        "        const: { type: string }",
        "        enum: { type: integer }",
        "        oneOf: { type: boolean }",
      ].join("\n"),
    );
    expect(schemas.Thing).toEqual({
      type: "object",
      required: ["const", "enum", "oneOf"],
      properties: {
        const: { type: "string" },
        enum: { type: "integer" },
        oneOf: { type: "boolean" },
      },
    });
  });

  test("a nullable union under items throws — there is no required list to relax", async () => {
    const promise = derive(
      [
        "    Thing:",
        "      type: array",
        "      items:",
        "        oneOf:",
        "          - { type: string }",
        '          - { type: "null" }',
      ].join("\n"),
    );
    await expect(promise).rejects.toThrow(
      /unsupported nullable union at #\/components\/schemas\/Thing\/items/,
    );
  });

  test("a nullable union inside allOf throws", async () => {
    const promise = derive(
      [
        "    Thing:",
        "      allOf:",
        "        - { type: object }",
        "        - oneOf:",
        "            - { type: string }",
        '            - { type: "null" }',
      ].join("\n"),
    );
    await expect(promise).rejects.toThrow(
      /unsupported composition at #\/components\/schemas\/Thing\/allOf\/1/,
    );
  });

  test("a nullable union carrying sibling constraints throws", async () => {
    const promise = derive(
      [
        "    Thing:",
        "      type: object",
        "      properties:",
        "        inner:",
        "          required: [a]",
        "          oneOf:",
        "            - { type: object }",
        '            - { type: "null" }',
      ].join("\n"),
    );
    await expect(promise).rejects.toThrow(/sibling keys \[required\]/);
  });

  test("a named open enum becomes an alias onto a generated <Name>Known", async () => {
    const schemas = await derive(
      [
        "    Colour:",
        "      type: string",
        "      enum: [red, green]",
        "      x-shepherd-open-enum: true",
      ].join("\n"),
    );
    expect(schemas.Colour).toEqual({
      anyOf: [{ $ref: "#/components/schemas/ColourKnown" }, { type: "string" }],
    });
    expect(schemas.ColourKnown).toEqual({ type: "string", enum: ["red", "green"] });
    // Insertion order is part of the determinism guarantee: the companion follows its source.
    expect(Object.keys(schemas)).toEqual(["Colour", "ColourKnown"]);
  });

  test("rule (a) drops exactly the collapsed property from required", async () => {
    const schemas = await derive(
      [
        "    Thing:",
        "      type: object",
        "      required: [before, nullable, after]",
        "      properties:",
        "        before: { type: string }",
        "        nullable:",
        "          oneOf:",
        "            - { type: string }",
        '            - { type: "null" }',
        "        after: { type: string }",
      ].join("\n"),
    );
    expect(schemas.Thing).toEqual({
      type: "object",
      required: ["before", "after"],
      properties: {
        before: { type: "string" },
        nullable: { type: "string" },
        after: { type: "string" },
      },
    });
  });
});

/**
 * Each of these pins one throw site that the tests above never reach: `closedType`'s guard,
 * `namedOpenEnum`'s nullable-named-component guard, the unhandled-schema-keyword guard, the
 * `allOf` guard's open-enum trigger (as opposed to its already-covered nullable-union trigger),
 * the inline nullable-open-enum-outside-`properties` guard, and the `<Name>Known` collision
 * guard.
 */
describe("every remaining throw path in the derivation is reachable", () => {
  test("closedType throws when a flagged enum's type is not a single non-null type", async () => {
    const promise = derive(
      [
        "    Thing:",
        "      type: object",
        "      properties:",
        "        colour:",
        "          type: [string, integer]",
        "          enum: [red, 1]",
        "          x-shepherd-open-enum: true",
      ].join("\n"),
    );
    await expect(promise).rejects.toThrow(
      /unsupported open enum at #\/components\/schemas\/Thing\/properties\/colour: expected a single non-null type, got \["string","integer"\]/,
    );
  });

  test("namedOpenEnum throws when a named open-enum component is itself nullable", async () => {
    const promise = derive(
      [
        "    Colour:",
        '      type: [string, "null"]',
        "      enum: [red, green, null]",
        "      x-shepherd-open-enum: true",
      ].join("\n"),
    );
    await expect(promise).rejects.toThrow(
      /unsupported nullable open enum at #\/components\/schemas\/Colour: a named component cannot drop nullability/,
    );
  });

  test("an unhandled schema keyword throws with its own pointer", async () => {
    const promise = derive(
      [
        "    Thing:",
        "      type: object",
        "      patternProperties:",
        "        '^x-': { type: string }",
      ].join("\n"),
    );
    await expect(promise).rejects.toThrow(
      /unsupported schema keyword "patternProperties" at #\/components\/schemas\/Thing/,
    );
  });

  test("an open enum inside allOf throws, not only a nullable union", async () => {
    const promise = derive(
      [
        "    Thing:",
        "      allOf:",
        "        - { type: object }",
        "        - type: string",
        "          enum: [a, b]",
        "          x-shepherd-open-enum: true",
      ].join("\n"),
    );
    await expect(promise).rejects.toThrow(
      /unsupported composition at #\/components\/schemas\/Thing\/allOf\/1: allOf may not contain a nullable union or an open enum/,
    );
  });

  test("a nullable flagged enum outside properties throws", async () => {
    const promise = derive(
      [
        "    Thing:",
        "      type: array",
        "      items:",
        '        type: [string, "null"]',
        "        enum: [a, b, null]",
        "        x-shepherd-open-enum: true",
      ].join("\n"),
    );
    await expect(promise).rejects.toThrow(
      /unsupported nullable open enum at #\/components\/schemas\/Thing\/items: only a property schema can become optional/,
    );
  });

  test("a <Name>Known name collision throws", async () => {
    const promise = derive(
      [
        "    Colour:",
        "      type: string",
        "      enum: [red, green]",
        "      x-shepherd-open-enum: true",
        "    ColourKnown:",
        "      type: string",
      ].join("\n"),
    );
    await expect(promise).rejects.toThrow(
      /cannot split open enum at #\/components\/schemas\/Colour: component "ColourKnown" already exists/,
    );
  });
});

describe("component names that collide with schema keywords", () => {
  test("a components.schemas entry literally named const or enum survives as a name", async () => {
    const schemas = await derive(
      ["    const:", "      type: string", "    enum:", "      type: integer"].join("\n"),
    );
    expect(schemas.const).toEqual({ type: "string" });
    expect(schemas.enum).toEqual({ type: "integer" });
  });
});

describe("namedOpenEnum description handling", () => {
  test("description is copied onto both the alias and the generated Known component", async () => {
    const schemas = await derive(
      [
        "    Colour:",
        "      type: string",
        "      enum: [red, green]",
        "      x-shepherd-open-enum: true",
        "      description: a colour",
      ].join("\n"),
    );
    expect(schemas.Colour).toEqual({
      description: "a colour",
      anyOf: [{ $ref: "#/components/schemas/ColourKnown" }, { type: "string" }],
    });
    expect(schemas.ColourKnown).toEqual({
      type: "string",
      enum: ["red", "green"],
      description: "a colour",
    });
  });
});
