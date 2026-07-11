#!/usr/bin/env bun
/**
 * Generates `src/generated/herdr-protocol.ts` — TS types for herdr's socket JSON-RPC schema —
 * from the vendored `src/generated/herdr-schema.json` (issue #1529 opportunity #5). Reads ONLY
 * the vendored file; never touches a live herdr. Pure compile-time codegen — no runtime/wire
 * behavior changes.
 *
 * Algorithm:
 *   A. Flatten. The vendored schema has 5 sections (`request`, `success_response`, `event`,
 *      `subscription_event`, `error_response`), each with its OWN `$defs`. Same simple names
 *      recur across sections (`AgentStatus`, `PaneInfo`, ...) and would collide if emitted flat,
 *      so every def is copied into one `{ $schema, $defs }` doc under a section-prefixed key
 *      (`request` → `Request<Name>`, etc.) and every `$ref` is rewritten to match. Defs whose
 *      flattened key starts with `Request` (params types) get `additionalProperties: false`
 *      (closed — Shepherd controls what it sends); every other def is left alone so
 *      json-schema-to-typescript emits an open `[k: string]: unknown` index signature (results/
 *      events stay forward-compatible with newer protocol-16 fields).
 *   B. Emit. json-schema-to-typescript's `compile()` turns the flattened doc into one named
 *      interface/type per def, including the discriminated result union
 *      (`SuccessResponseResponseResult`) and every `Request<Name>Params`.
 *   C. Append hand-built `HERDR_PROTOCOL` / `HerdrParams` / `HerdrMethod` /
 *      `HERDR_METHOD_RESULT` / `HerdrResult<M>` built by walking the schema (not jstt's output).
 *   D. Format the whole file with the repo's own prettier and write it.
 *
 * Determinism (gated later — see brief): running this twice must yield a byte-identical file.
 * Ordering is fixed everywhere: `$defs` are walked in the section order below, `HerdrParams` in
 * `request.oneOf` order, `HERDR_METHOD_RESULT` in the literal order below.
 *
 * Usage: bun run gen:herdr-types
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compile } from "json-schema-to-typescript";
import prettier from "prettier";

const REPO_ROOT = join(import.meta.dir, "..");
const SCHEMA_PATH = join(REPO_ROOT, "src", "generated", "herdr-schema.json");
const OUT_PATH = join(REPO_ROOT, "src", "generated", "herdr-protocol.ts");

/** Section → PascalCase prefix (brief §A). Order here also fixes the `$defs` walk order. */
const SECTION_PREFIXES = [
  ["request", "Request"],
  ["success_response", "SuccessResponse"],
  ["event", "Event"],
  ["subscription_event", "SubscriptionEvent"],
  ["error_response", "ErrorResponse"],
] as const satisfies readonly (readonly [string, string])[];

/** Curated method → result-`type` map (brief §C) — VERIFIED, do not add/remove entries. This
 *  literal order is preserved into the generated `HERDR_METHOD_RESULT`. Methods the driver calls
 *  but whose result it ignores (best-effort void: `agent.send`, `agent.rename`, `tab.close`,
 *  `tab.rename`, `pane.close`) are intentionally omitted — they fall back to the full union. */
const HERDR_METHOD_RESULT_ENTRIES: readonly { method: string; resultType: string; note: string }[] =
  [
    { method: "ping", resultType: "pong", note: "live-verified" },
    {
      method: "agent.list",
      resultType: "agent_list",
      note: "live-verified (parseAgents reads result.agents)",
    },
    {
      method: "agent.read",
      resultType: "pane_read",
      note: "parseReadText reads result.read.text; schema pane_read has `read`",
    },
    {
      method: "agent.start",
      resultType: "agent_started",
      note: "driver reads result.agent; schema agent_started has agent+argv",
    },
    {
      method: "pane.process_info",
      resultType: "pane_process_info",
      note: "live-verified (parseProcs reads result.process_info)",
    },
    {
      method: "tab.create",
      resultType: "tab_created",
      note: "driver reads result.tab/result.root_pane; schema tab_created matches",
    },
    {
      method: "workspace.list",
      resultType: "workspace_list",
      note: "live-verified (reads result.workspaces)",
    },
    {
      method: "workspace.create",
      resultType: "workspace_created",
      note: "schema workspace_created has workspace+tab+root_pane",
    },
  ];

// ── Minimal runtime shape guards for the vendored schema ──────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function expectRecord(v: unknown, ctx: string): Record<string, unknown> {
  if (!isRecord(v)) throw new Error(`gen-herdr-types: expected object at ${ctx}, got ${typeof v}`);
  return v;
}

function expectArray(v: unknown, ctx: string): unknown[] {
  if (!Array.isArray(v))
    throw new Error(`gen-herdr-types: expected array at ${ctx}, got ${typeof v}`);
  return v;
}

function expectString(v: unknown, ctx: string): string {
  if (typeof v !== "string")
    throw new Error(`gen-herdr-types: expected string at ${ctx}, got ${typeof v}`);
  return v;
}

// ── A. Flatten ──────────────────────────────────────────────────────────────────────────────

const REF_PATTERN = /^#\/schemas\/([^/]+)\/\$defs\/(.+)$/;

function sectionPrefix(section: string): string {
  const found = SECTION_PREFIXES.find(([s]) => s === section);
  if (!found) throw new Error(`gen-herdr-types: unknown schema section "${section}"`);
  return found[1];
}

/** Deep-clones `node`, rewriting every `#/schemas/<section>/$defs/<Name>` `$ref` string to
 *  `#/$defs/<Prefix><Name>`. Never mutates the input. */
function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (isRecord(node)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") {
        const m = REF_PATTERN.exec(value);
        if (m) {
          const [, section, name] = m;
          out[key] = `#/$defs/${sectionPrefix(section!)}${name}`;
          continue;
        }
      }
      out[key] = rewriteRefs(value);
    }
    return out;
  }
  return node;
}

/** Builds the single flattened `{ $schema, $defs }` doc fed to json-schema-to-typescript. */
function flattenSchema(raw: Record<string, unknown>): Record<string, unknown> {
  const schemas = expectRecord(raw.schemas, "schemas");
  const flatDefs: Record<string, unknown> = {};

  for (const [section, prefix] of SECTION_PREFIXES) {
    const sectionDoc = expectRecord(schemas[section], `schemas.${section}`);
    const defs = expectRecord(sectionDoc.$defs, `schemas.${section}.$defs`);
    for (const [name, def] of Object.entries(defs)) {
      const key = `${prefix}${name}`;
      const rewritten = expectRecord(
        rewriteRefs(def),
        `schemas.${section}.$defs.${name} (rewritten)`,
      );
      if (key.startsWith("Request")) rewritten.additionalProperties = false;
      flatDefs[key] = rewritten;
    }
  }

  return { $schema: expectString(raw.$schema, "$schema"), $defs: flatDefs };
}

// ── C. Hand-built maps/types — walked from the raw (pre-flatten) schema ───────────────────────

/** One `{ method, paramsName }` per `request.oneOf` variant, in schema order. */
function collectRequestMethods(
  raw: Record<string, unknown>,
): { method: string; paramsName: string }[] {
  const schemas = expectRecord(raw.schemas, "schemas");
  const request = expectRecord(schemas.request, "schemas.request");
  const oneOf = expectArray(request.oneOf, "schemas.request.oneOf");

  return oneOf.map((variant, i) => {
    const v = expectRecord(variant, `schemas.request.oneOf[${i}]`);
    const properties = expectRecord(v.properties, `schemas.request.oneOf[${i}].properties`);
    const methodConst = expectRecord(
      properties.method,
      `schemas.request.oneOf[${i}].properties.method`,
    );
    const method = expectString(
      methodConst.const,
      `schemas.request.oneOf[${i}].properties.method.const`,
    );
    const paramsSchema = expectRecord(
      properties.params,
      `schemas.request.oneOf[${i}].properties.params`,
    );
    const ref = expectString(
      paramsSchema.$ref,
      `schemas.request.oneOf[${i}].properties.params.$ref`,
    );
    const m = REF_PATTERN.exec(ref);
    if (!m) throw new Error(`gen-herdr-types: unexpected params $ref shape "${ref}"`);
    const [, refSection, refName] = m;
    return { method, paramsName: `${sectionPrefix(refSection!)}${refName}` };
  });
}

/** Every `type` const declared by `success_response.$defs.ResponseResult.oneOf`. */
function collectResultTypes(raw: Record<string, unknown>): Set<string> {
  const schemas = expectRecord(raw.schemas, "schemas");
  const successResponse = expectRecord(schemas.success_response, "schemas.success_response");
  const defs = expectRecord(successResponse.$defs, "schemas.success_response.$defs");
  const responseResult = expectRecord(
    defs.ResponseResult,
    "schemas.success_response.$defs.ResponseResult",
  );
  const oneOf = expectArray(
    responseResult.oneOf,
    "schemas.success_response.$defs.ResponseResult.oneOf",
  );

  return new Set(
    oneOf.map((variant, i) => {
      const v = expectRecord(variant, `ResponseResult.oneOf[${i}]`);
      const properties = expectRecord(v.properties, `ResponseResult.oneOf[${i}].properties`);
      const typeConst = expectRecord(properties.type, `ResponseResult.oneOf[${i}].properties.type`);
      return expectString(typeConst.const, `ResponseResult.oneOf[${i}].properties.type.const`);
    }),
  );
}

function buildHerdrParamsSource(entries: { method: string; paramsName: string }[]): string {
  const lines = entries.map((e) => `  ${JSON.stringify(e.method)}: ${e.paramsName};`);
  return `export interface HerdrParams {\n${lines.join("\n")}\n}`;
}

function buildMethodResultSource(): string {
  const lines = HERDR_METHOD_RESULT_ENTRIES.map(
    (e) => `  ${JSON.stringify(e.method)}: ${JSON.stringify(e.resultType)}, // ${e.note}`,
  );
  return `export const HERDR_METHOD_RESULT = {\n${lines.join("\n")}\n} as const;`;
}

function buildAppendedSource(raw: Record<string, unknown>): string {
  const protocol = raw.protocol;
  if (typeof protocol !== "number")
    throw new Error("gen-herdr-types: schema.protocol is not a number");

  const requestMethods = collectRequestMethods(raw);
  const methodSet = new Set(requestMethods.map((e) => e.method));
  const resultTypeSet = collectResultTypes(raw);

  // Fail loudly if the schema moved out from under the curated map.
  for (const entry of HERDR_METHOD_RESULT_ENTRIES) {
    if (!methodSet.has(entry.method)) {
      throw new Error(
        `gen-herdr-types: HERDR_METHOD_RESULT key "${entry.method}" is not a method in request.oneOf`,
      );
    }
    if (!resultTypeSet.has(entry.resultType)) {
      throw new Error(
        `gen-herdr-types: HERDR_METHOD_RESULT["${entry.method}"] = "${entry.resultType}" is not a ` +
          `type const in ResponseResult.oneOf`,
      );
    }
  }

  return [
    `export const HERDR_PROTOCOL = ${protocol} as const;`,
    "",
    buildHerdrParamsSource(requestMethods),
    "",
    "export type HerdrMethod = keyof HerdrParams;",
    "",
    buildMethodResultSource(),
    "",
    "export type HerdrResult<M extends HerdrMethod> = M extends keyof typeof HERDR_METHOD_RESULT",
    "  ? Extract<SuccessResponseResponseResult, { type: (typeof HERDR_METHOD_RESULT)[M] }>",
    "  : SuccessResponseResponseResult;",
  ].join("\n");
}

// ── D. Format + header + write ─────────────────────────────────────────────────────────────

const HEADER = [
  "/* eslint-disable */",
  "// DO NOT EDIT — generated by scripts/gen-herdr-types.ts from src/generated/herdr-schema.json",
  "// Regenerate: bun run gen:herdr-types",
  "",
].join("\n");

async function main() {
  const raw = expectRecord(JSON.parse(await readFile(SCHEMA_PATH, "utf8")), "<root>");
  const flattened = flattenSchema(raw);

  const jsttOutput = await compile(flattened as Parameters<typeof compile>[0], "HerdrProtocol", {
    format: false,
    unreachableDefinitions: true,
    declareExternallyReferenced: true,
    bannerComment: "",
    additionalProperties: true,
  });

  const appended = buildAppendedSource(raw);
  const unformatted = HEADER + jsttOutput + "\n" + appended + "\n";

  const cfg = await prettier.resolveConfig(OUT_PATH);
  const formatted = await prettier.format(unformatted, { ...cfg, parser: "typescript" });

  await writeFile(OUT_PATH, formatted);
  console.log(`Wrote ${OUT_PATH}`);
}

await main();
