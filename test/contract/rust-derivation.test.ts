/**
 * `contracts/openapi.rust.yaml` is the progenitor input (OpenAPI 3.0) derived from the truth file by
 * `scripts/gen-contract-rust.ts`. This test is the derivation's contract: no 3.1-only construct
 * survives, progenitor's one-type-per-response-group invariant holds, the v1 CLI surface is intact,
 * and the committed bytes are what a fresh derivation produces.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  deriveRustSpec,
  DERIVED_PATH,
  responseTypeConflicts,
  RUST_EXCLUDED_OPERATIONS,
  RUST_OPENAPI_VERSION,
  TRUTH_PATH,
} from "../../scripts/gen-contract-rust";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const truthText = readFileSync(TRUTH_PATH, "utf8");
const derivedText = readFileSync(DERIVED_PATH, "utf8");
const truth = Bun.YAML.parse(truthText) as Obj;
const derived = Bun.YAML.parse(derivedText) as Obj;

/** The operations the v1 `shepherd` CLI calls (epic #2487). Never excluded, never reshaped. */
const CLI_V1_OPERATIONS = [
  "getHealth",
  "listSessions",
  "getSession",
  "getHolds",
  "gitStates",
  "listReviewsInflight",
  "createSession",
  "replySession",
  "interruptSession",
  "archiveSession",
  "resumeSession",
];

/** The follow-up verbs (#2486): work intake, reviews and the merge train. */
const CLI_V2_OPERATIONS = [
  "getBacklog",
  "listIssues",
  "listDrain",
  "listDrainQueue",
  "putRepoConfig",
  "refreshUpNext",
  "startUpNext",
  "listHeld",
  "spawnHeld",
  "discardHeld",
  "reviewPr",
  "reviewPlan",
  "mergePullRequest",
  "listAutomerge",
  "setSessionAutomerge",
];

/** Settings and diagnostics verbs (#2494). */
const CLI_V3_OPERATIONS = [
  "getSettings",
  "patchSettings",
  "getRepoConfig",
  "getDiagnostics",
  "fixDiagnostics",
];

function nodes(root: unknown): { path: string; node: Obj }[] {
  const out: { path: string; node: Obj }[] = [];
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) return v.forEach((item, i) => walk(item, `${path}/${i}`));
    if (!isObj(v)) return;
    out.push({ path, node: v });
    for (const [k, child] of Object.entries(v)) walk(child, `${path}/${k}`);
  };
  walk(root, "#");
  return out;
}

const derivedNodes = nodes(derived);

function operationIds(doc: Obj): string[] {
  return nodes(doc)
    .filter(({ path }) => path.startsWith("#/paths/"))
    .map(({ node }) => node.operationId)
    .filter((id): id is string => typeof id === "string")
    .sort();
}

const schemasOf = (doc: Obj): Obj => (doc.components as { schemas: Obj }).schemas;

describe("progenitor (OpenAPI 3.0) derivation", () => {
  test("declares OpenAPI 3.0", () => {
    expect(derived.openapi).toBe(RUST_OPENAPI_VERSION);
    expect(String(truth.openapi)).toStartWith("3.1");
  });

  test("no 3.1-only construct survives", () => {
    const offenders: string[] = [];
    for (const { path, node } of derivedNodes) {
      // A `properties` map's keys are names: a property literally called `const` is data.
      if (path.endsWith("/properties")) continue;
      if (Array.isArray(node.type)) offenders.push(`${path} type array`);
      if (node.type === "null") offenders.push(`${path} null type`);
      if ("const" in node) offenders.push(`${path} const`);
      if (Array.isArray(node.enum) && node.enum.includes(null)) offenders.push(`${path} null enum`);
      if ("x-shepherd-open-enum" in node || "x-shepherd-explicit-null" in node)
        offenders.push(`${path} flag`);
    }
    expect(offenders).toEqual([]);
  });

  test("open enums decode as plain strings; closed request enums stay closed", () => {
    const schemas = schemasOf(derived);
    expect(schemas.SessionStatus).toEqual({ type: "string" });
    expect((schemas.SandboxProfile as Obj).enum).toEqual(
      (schemasOf(truth).SandboxProfile as Obj).enum,
    );
  });

  test("a nullable $ref property is wrapped in allOf so nullable survives", () => {
    const session = schemasOf(derived).Session as { properties: Obj; required: string[] };
    expect(session.properties.sandboxApplied).toEqual({
      allOf: [{ $ref: "#/components/schemas/SandboxProfile" }],
      nullable: true,
    });
    expect(session.required).toContain("sandboxApplied");
  });

  test("progenitor sees one success and one error body per operation", () => {
    expect(responseTypeConflicts(derived)).toEqual([]);
    // …and the truth genuinely violates it, so the rewrite is not vacuous.
    expect(responseTypeConflicts(truth)).toContain("createSession Success");
  });

  test("every truth operationId survives except the documented exclusions", () => {
    const excluded = Object.keys(RUST_EXCLUDED_OPERATIONS);
    for (const id of excluded) expect(operationIds(truth)).toContain(id);
    expect(operationIds(derived)).toEqual(
      operationIds(truth).filter((id) => !excluded.includes(id)),
    );
    for (const name of Object.keys(schemasOf(truth))) {
      expect(Object.keys(schemasOf(derived))).toContain(name);
    }
  });

  test("the CLI surface is present and never excluded", () => {
    const ids = operationIds(derived);
    for (const id of [...CLI_V1_OPERATIONS, ...CLI_V2_OPERATIONS, ...CLI_V3_OPERATIONS]) {
      expect(ids).toContain(id);
      expect(RUST_EXCLUDED_OPERATIONS).not.toHaveProperty(id);
    }
  });

  test("createSession's 200/201 share one union of HeldTask and Session", () => {
    expect(schemasOf(derived).CreateSessionSuccess).toMatchObject({
      oneOf: [{ $ref: "#/components/schemas/HeldTask" }, { $ref: "#/components/schemas/Session" }],
    });
  });

  test("the committed file is what a fresh derivation produces", async () => {
    expect(await deriveRustSpec(truthText)).toBe(derivedText);
  });
});

function doc(schemas: string, paths = "{}"): string {
  return [
    "openapi: 3.1.0",
    "info: { title: t, version: '1' }",
    `paths: ${paths}`,
    "components:",
    "  schemas:",
    schemas,
  ].join("\n");
}

async function derive(schemas: string, paths?: string): Promise<Obj> {
  return Bun.YAML.parse(await deriveRustSpec(doc(schemas, paths))) as Obj;
}

describe("derivation rules", () => {
  test("type arrays, const and null enum members map to 3.0", async () => {
    const out = schemasOf(
      await derive(
        [
          "    Thing:",
          "      type: object",
          "      required: [a, b, c]",
          "      properties:",
          "        a: { type: [string, 'null'], enum: [x, y, null] }",
          "        b: { type: boolean, const: true }",
          "        c: { type: [integer, 'null'], x-shepherd-explicit-null: true }",
          "        d: { oneOf: [{ type: string, minLength: 1 }, { type: 'null' }], description: d }",
          "        e: { type: string, enum: [p, q], x-shepherd-open-enum: true }",
        ].join("\n"),
      ),
    );
    expect(out.Thing).toEqual({
      type: "object",
      required: ["a", "b", "c"],
      properties: {
        a: { type: "string", nullable: true, enum: ["x", "y"] },
        b: { type: "boolean", enum: [true] },
        c: { type: "integer", nullable: true },
        d: { type: "string", minLength: 1, description: "d", nullable: true },
        e: { type: "string" },
      },
    });
  });

  test("properties named after keywords are data, not keywords", async () => {
    const out = schemasOf(
      await derive(
        [
          "    Thing:",
          "      type: object",
          "      properties:",
          "        const: { type: string }",
          "        enum: { type: integer }",
        ].join("\n"),
      ),
    );
    expect((out.Thing as Obj).properties).toEqual({
      const: { type: "string" },
      enum: { type: "integer" },
    });
  });

  test.each([
    ["a multi-type array", "      type: [string, integer]", "unsupported type array"],
    [
      "an unhandled keyword",
      "      type: object\n      patternProperties: {}",
      '"patternProperties"',
    ],
    [
      "a numeric exclusive bound",
      "      type: number\n      exclusiveMinimum: 0",
      "exclusive bound",
    ],
    [
      "a nullable union with sibling constraints",
      "      minLength: 1\n      oneOf: [{ type: string }, { type: 'null' }]",
      "sibling keys [minLength]",
    ],
  ])("%s throws with its pointer", async (_, schema, message) => {
    await expect(derive(`    Thing:\n${schema}`)).rejects.toThrow(message);
    await expect(derive(`    Thing:\n${schema}`)).rejects.toThrow("#/components/schemas/Thing");
  });

  test("mixed error bodies become a named union with the generic Error last", async () => {
    const out = await derive(
      [
        "    Error: { type: object, properties: { error: { type: string } } }",
        "    Special: { type: object, properties: { code: { type: string } } }",
      ].join("\n"),
      [
        "",
        "  /x:",
        "    get:",
        "      operationId: getX",
        "      responses:",
        '        "200": { description: ok }',
        '        "400": { description: e, content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } } }',
        '        "409": { description: s, content: { application/json: { schema: { $ref: "#/components/schemas/Special" } } } }',
      ].join("\n"),
    );
    expect(schemasOf(out).GetXError).toMatchObject({
      oneOf: [{ $ref: "#/components/schemas/Special" }, { $ref: "#/components/schemas/Error" }],
    });
    expect(responseTypeConflicts(out)).toEqual([]);
  });

  test("an error group mixing bodyless and JSON responses drops the error bodies", async () => {
    const out = await derive(
      "    Error: { type: object }",
      [
        "",
        "  /x:",
        "    get:",
        "      operationId: getX",
        "      responses:",
        '        "200": { description: ok }',
        '        "400": { description: bare }',
        '        "401": { description: e, content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } } }',
      ].join("\n"),
    );
    const responses = ((out.paths as Obj)["/x"] as { get: { responses: Obj } }).get.responses;
    expect(responses["401"]).toEqual({ description: "e" });
  });

  test("a success group mixing bodyless and JSON responses throws", async () => {
    const paths = [
      "",
      "  /x:",
      "    get:",
      "      operationId: getX",
      "      responses:",
      '        "200": { description: ok, content: { application/json: { schema: { type: string } } } }',
      '        "204": { description: none }',
    ].join("\n");
    await expect(derive("    A: { type: string }", paths)).rejects.toThrow("bodyless and JSON 2xx");
  });
});
