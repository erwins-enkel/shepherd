import { describe, expect, test } from "bun:test";
import { isAbsolute, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import Ajv, { type AnySchema, type ValidateFunction } from "ajv";
import { CODEX_ROLE_OUTPUT_SCHEMAS } from "../src/codex-role-output-schema";
import { parseRecapVerdict } from "../src/recap-core";
import { buildVerdictCore } from "../src/critic-core";

type SchemaName = keyof typeof CODEX_ROLE_OUTPUT_SCHEMAS;

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "codex-role-output");
const CASES: readonly [SchemaName, string][] = [
  ["autopilot", "autopilot.json"],
  ["recap", "recap.json"],
  ["planReview", "plan-review.json"],
  ["critic", "critic.json"],
  ["criticWithPlan", "critic-with-plan.json"],
  ["distiller", "distiller.json"],
  ["optimizer", "optimizer.json"],
  ["mergeIntra", "merge-intra.json"],
  ["mergeCross", "merge-cross.json"],
];

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validators(): Map<SchemaName, ValidateFunction> {
  const ajv = new Ajv({ allErrors: true, strict: true });
  return new Map(
    CASES.map(([name]) => [
      name,
      ajv.compile(readJson(CODEX_ROLE_OUTPUT_SCHEMAS[name]) as AnySchema),
    ]),
  );
}

function assertStructuredOutputSubset(node: unknown, location = "root"): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const schema = node as Record<string, unknown>;
  if (schema.$ref !== undefined) {
    expect(typeof schema.$ref, `${location} $ref`).toBe("string");
    expect((schema.$ref as string).startsWith("#/"), `${location} external $ref`).toBe(true);
  }
  if (schema.type === "object") {
    expect(schema.additionalProperties, `${location} must be closed`).toBe(false);
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    expect(schema.required, `${location} must require every property`).toEqual(
      Object.keys(properties),
    );
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "enum" || key === "required") continue;
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        assertStructuredOutputSubset(item, `${location}.${key}[${index}]`),
      );
    } else {
      assertStructuredOutputSubset(value, `${location}.${key}`);
    }
  }
}

describe("Codex role output schemas", () => {
  test("exports absolute existing paths for all nine role contracts", () => {
    expect(Object.keys(CODEX_ROLE_OUTPUT_SCHEMAS)).toEqual(CASES.map(([name]) => name));
    for (const path of Object.values(CODEX_ROLE_OUTPUT_SCHEMAS)) {
      expect(isAbsolute(path)).toBe(true);
      expect(existsSync(path)).toBe(true);
    }
  });

  test("resolves installation schemas independently of the process cwd", () => {
    const originalCwd = process.cwd();
    const decoyDir = mkdtempSync(join(tmpdir(), "shepherd-schema-decoy-"));
    const decoy = join(decoyDir, "autopilot.json");
    writeFileSync(decoy, '{"decoy":true}');
    try {
      process.chdir(decoyDir);
      expect(CODEX_ROLE_OUTPUT_SCHEMAS.autopilot).not.toBe(decoy);
      expect(readJson(CODEX_ROLE_OUTPUT_SCHEMAS.autopilot)).toEqual(
        expect.objectContaining({ type: "object" }),
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(decoyDir, { recursive: true, force: true });
    }
  });

  test("compiles every schema and accepts its representative fixture", () => {
    const compiled = validators();
    for (const [name, fixture] of CASES) {
      const validate = compiled.get(name)!;
      expect(validate(readJson(join(FIXTURE_DIR, fixture))), JSON.stringify(validate.errors)).toBe(
        true,
      );
    }
  });

  test("uses the strict Structured Outputs object subset throughout", () => {
    for (const path of Object.values(CODEX_ROLE_OUTPUT_SCHEMAS)) {
      const schema = readJson(path) as Record<string, unknown>;
      expect(schema.type).toBe("object");
      assertStructuredOutputSubset(schema);
    }
  });

  test("rejects missing required and extra root properties for every role", () => {
    const compiled = validators();
    for (const [name, fixture] of CASES) {
      const original = readJson(join(FIXTURE_DIR, fixture)) as Record<string, unknown>;
      const firstKey = Object.keys(original)[0]!;
      const missing = structuredClone(original);
      delete missing[firstKey];
      expect(compiled.get(name)!(missing), `${name} accepted missing ${firstKey}`).toBe(false);

      const extra = { ...original, unexpected: true };
      expect(compiled.get(name)!(extra), `${name} accepted an extra root property`).toBe(false);
    }
  });

  test("rejects wrong enums and malformed nested values", () => {
    const compiled = validators();
    const autopilot = readJson(join(FIXTURE_DIR, "autopilot.json")) as Record<string, unknown>;
    expect(compiled.get("autopilot")!({ ...autopilot, kind: "done" })).toBe(false);

    const planReview = readJson(join(FIXTURE_DIR, "plan-review.json")) as Record<string, unknown>;
    expect(compiled.get("planReview")!({ ...planReview, decision: "comment" })).toBe(false);

    const critic = readJson(join(FIXTURE_DIR, "critic.json")) as Record<string, unknown>;
    const criticFindings = structuredClone(critic.findings) as Record<string, unknown>[];
    criticFindings[0]!.severity = "warning";
    expect(compiled.get("critic")!({ ...critic, findings: criticFindings })).toBe(false);

    const recap = readJson(join(FIXTURE_DIR, "recap.json")) as Record<string, unknown>;
    const recapBlocks = structuredClone(recap.blocks) as Record<string, unknown>[];
    recapBlocks[0]!.markdown = 42;
    expect(compiled.get("recap")!({ ...recap, blocks: recapBlocks })).toBe(false);

    const merge = readJson(join(FIXTURE_DIR, "merge-intra.json")) as Record<string, unknown>;
    const groups = structuredClone(merge.groups) as Record<string, unknown>[];
    groups[0]!.memberIds = ["only-one"];
    expect(compiled.get("mergeIntra")!({ ...merge, groups })).toBe(false);
  });

  test("enforces prompt array bounds and visual content limits", () => {
    const compiled = validators();
    const distiller = readJson(join(FIXTURE_DIR, "distiller.json")) as Record<string, unknown>;
    expect(
      compiled.get("distiller")!({
        ...distiller,
        rules: Array.from({ length: 6 }, () => (distiller.rules as unknown[])[0]),
      }),
    ).toBe(false);

    const recap = readJson(join(FIXTURE_DIR, "recap.json")) as Record<string, unknown>;
    const blocks = structuredClone(recap.blocks) as Record<string, unknown>[];
    const mermaid = blocks.find((block) => block.type === "mermaid")!;
    mermaid.source = "x".repeat(8001);
    expect(compiled.get("recap")!({ ...recap, blocks })).toBe(false);
  });
});

describe("representative role output fixtures", () => {
  test("the recap fixture preserves inline prose and all twelve visual types", () => {
    const raw = readJson(join(FIXTURE_DIR, "recap.json"));
    const parsed = parseRecapVerdict(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.body).toBe(
      "**Fertig.** Die Zeile sagt: „Pfad `src\\core.ts` bleibt.\u201c\n\nNächster Absatz.",
    );
    expect(parsed!.blocks.map((block) => block.type)).toEqual([
      "rich-text",
      "callout",
      "file-tree",
      "diff",
      "code",
      "annotated-code",
      "data-model",
      "api-endpoint",
      "table",
      "checklist",
      "mermaid",
      "wireframe",
    ]);
  });

  test("the critic fixture preserves inline body and structured findings", () => {
    const raw = readJson(join(FIXTURE_DIR, "critic.json")) as Parameters<
      typeof buildVerdictCore
    >[0];
    const parsed = buildVerdictCore(raw, null, [], "patch", "schema-fixture");
    expect(parsed.body).toContain('The parser keeps "quoted" text and `C:\\\\tmp` paths.');
    expect(parsed.findings).toEqual([
      "src/parser.ts: Escaped input can bypass the boundary check.",
    ]);
    expect(parsed.findingsMeta).toHaveLength(2);
  });
});
