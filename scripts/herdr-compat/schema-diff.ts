/**
 * Static half of the herdr compatibility check (SOP: .claude/rules/herdr-version-bump.md).
 *
 * Pure functions over two `herdr api schema --json` documents — no I/O, no live herdr — so the
 * classification rules are unit-testable offline (test/herdr-compat-schema-diff.test.ts):
 *
 *  - `diffSchemas` — the general wire-protocol diff: methods added/removed, request-param
 *    property removals / newly-required params, result-variant property removals, enum
 *    narrowing/widening, protocol-number movement.
 *  - `recordShapeGate` — the #2032 gate: required/optional and nullability drift on the record
 *    types the husk reapers consume (`TabInfo`, `PaneInfo`, `AgentInfo`), in BOTH the
 *    success_response and event sections. This exact bug class silently killed four reapers
 *    twice (#721, #2029), so any loosening is a hard FAIL, never a silent regeneration.
 *
 * Severity contract (consumed by report.ts): "fail" = the bump must stop until code addresses
 * it; "review" = a human/agent must look but the run proceeds; "info" = recorded for the report.
 */

export type Severity = "fail" | "review" | "info";

export interface SchemaFinding {
  /** Where the finding lives, e.g. "protocol", "method", "params:tab.create",
   *  "result:tab_list", "enum:request.AgentStatus", "record:event.TabInfo". */
  area: string;
  kind: string;
  detail: string;
  severity: Severity;
}

export interface SchemaDiffResult {
  baseProtocol: number;
  candidateProtocol: number;
  findings: SchemaFinding[];
}

/** The record types the reapers' assumptions ride on (#2032), per schema section. */
const GATED_RECORDS = ["TabInfo", "PaneInfo", "AgentInfo"] as const;
const GATED_SECTIONS = ["success_response", "event"] as const;

interface JsonObject {
  [key: string]: unknown;
}

function asObject(v: unknown): JsonObject {
  return typeof v === "object" && v !== null ? (v as JsonObject) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function section(doc: unknown, name: string): JsonObject {
  return asObject(asObject(asObject(doc).schemas)[name]);
}

function defs(doc: unknown, sectionName: string): JsonObject {
  return asObject(section(doc, sectionName).$defs);
}

function protocolOf(doc: unknown): number {
  const p = asObject(doc).protocol;
  return typeof p === "number" ? p : -1;
}

/** Map request method name → its variant object, keyed off `properties.method.const`. */
function requestVariants(doc: unknown): Map<string, JsonObject> {
  const out = new Map<string, JsonObject>();
  for (const raw of asArray(section(doc, "request").oneOf)) {
    const variant = asObject(raw);
    const method = asObject(asObject(asObject(variant.properties).method)).const;
    if (typeof method === "string") out.set(method, variant);
  }
  return out;
}

/** Resolve a variant's `params.$ref` to its def name (last path segment), or null. */
function paramsDefName(variant: JsonObject): string | null {
  const ref = asObject(asObject(asObject(variant.properties).params)).$ref;
  if (typeof ref !== "string") return null;
  const name = ref.split("/").at(-1);
  return name || null;
}

/** Map result-variant type name → its variant object, keyed off `properties.type.const`. */
function resultVariants(doc: unknown): Map<string, JsonObject> {
  const out = new Map<string, JsonObject>();
  const oneOf = asArray(asObject(defs(doc, "success_response").ResponseResult).oneOf);
  for (const raw of oneOf) {
    const variant = asObject(raw);
    const type = asObject(asObject(asObject(variant.properties).type)).const;
    if (typeof type === "string") out.set(type, variant);
  }
  return out;
}

function propertyNames(def: JsonObject): string[] {
  return Object.keys(asObject(def.properties));
}

function requiredSet(def: JsonObject): Set<string> {
  return new Set(asArray(def.required).filter((r): r is string => typeof r === "string"));
}

/** Nullable = `type` array containing "null", or an `anyOf` arm of `{type: "null"}`. */
function isNullable(prop: unknown): boolean {
  const p = asObject(prop);
  if (Array.isArray(p.type) && p.type.includes("null")) return true;
  return asArray(p.anyOf).some((arm) => asObject(arm).type === "null");
}

/** All enum defs across every schema section, keyed "section.DefName". */
function enumDefs(doc: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const sectionName of Object.keys(asObject(asObject(doc).schemas))) {
    for (const [name, raw] of Object.entries(defs(doc, sectionName))) {
      const values = asObject(raw).enum;
      if (Array.isArray(values)) out.set(`${sectionName}.${name}`, values.map(String));
    }
  }
  return out;
}

export function diffSchemas(base: unknown, candidate: unknown): SchemaDiffResult {
  const findings: SchemaFinding[] = [];
  const baseProtocol = protocolOf(base);
  const candidateProtocol = protocolOf(candidate);

  if (baseProtocol !== candidateProtocol) {
    findings.push({
      area: "protocol",
      kind: "protocol-changed",
      detail: `protocol ${baseProtocol} -> ${candidateProtocol}: extend HERDR_SOCKET_SUPPORTED_PROTOCOLS (src/config.ts) by name — it is an explicit allowlist, not a floor`,
      severity: "review",
    });
  }

  // Request methods + their param shapes.
  const baseMethods = requestVariants(base);
  const candMethods = requestVariants(candidate);
  for (const method of baseMethods.keys()) {
    if (!candMethods.has(method)) {
      findings.push({
        area: "method",
        kind: "method-removed",
        detail: `request method removed: ${method}`,
        severity: "fail",
      });
    }
  }
  for (const method of candMethods.keys()) {
    if (!baseMethods.has(method)) {
      findings.push({
        area: "method",
        kind: "method-added",
        detail: `request method added: ${method}`,
        severity: "info",
      });
    }
  }

  const baseDefs = defs(base, "request");
  const candDefs = defs(candidate, "request");
  for (const [method, baseVariant] of baseMethods) {
    const candVariant = candMethods.get(method);
    if (!candVariant) continue;
    const baseDefName = paramsDefName(baseVariant);
    const candDefName = paramsDefName(candVariant);
    const baseParams = baseDefName ? asObject(baseDefs[baseDefName]) : {};
    const candParams = candDefName ? asObject(candDefs[candDefName]) : {};
    const baseProps = propertyNames(baseParams);
    const candProps = new Set(propertyNames(candParams));
    for (const prop of baseProps) {
      if (!candProps.has(prop)) {
        findings.push({
          area: `params:${method}`,
          kind: "param-removed",
          detail: `param property removed: ${prop}`,
          severity: "fail",
        });
      }
    }
    for (const prop of candProps) {
      if (!baseProps.includes(prop)) {
        findings.push({
          area: `params:${method}`,
          kind: "param-added",
          detail: `param property added: ${prop}`,
          severity: "info",
        });
      }
    }
    const baseRequired = requiredSet(baseParams);
    for (const prop of requiredSet(candParams)) {
      if (!baseRequired.has(prop)) {
        findings.push({
          area: `params:${method}`,
          kind: "param-now-required",
          detail: `param newly required: ${prop} (an unchanged caller stops satisfying the schema)`,
          severity: "fail",
        });
      }
    }
  }

  // Result variants.
  const baseResults = resultVariants(base);
  const candResults = resultVariants(candidate);
  for (const [type, baseVariant] of baseResults) {
    const candVariant = candResults.get(type);
    if (!candVariant) {
      findings.push({
        area: `result:${type}`,
        kind: "result-variant-removed",
        detail: `result variant removed: ${type}`,
        severity: "fail",
      });
      continue;
    }
    const candProps = new Set(propertyNames(candVariant));
    for (const prop of propertyNames(baseVariant)) {
      if (!candProps.has(prop)) {
        findings.push({
          area: `result:${type}`,
          kind: "result-property-removed",
          detail: `result property removed: ${prop}`,
          severity: "fail",
        });
      }
    }
    const baseRequired = requiredSet(baseVariant);
    for (const prop of baseRequired) {
      if (candProps.has(prop) && !requiredSet(candVariant).has(prop)) {
        findings.push({
          area: `result:${type}`,
          kind: "result-required-to-optional",
          detail: `result property no longer required: ${prop} (readers may start seeing it absent — the record gate covers TabInfo/PaneInfo/AgentInfo; triage any other type by hand)`,
          severity: "review",
        });
      }
    }
  }
  for (const type of candResults.keys()) {
    if (!baseResults.has(type)) {
      findings.push({
        area: `result:${type}`,
        kind: "result-variant-added",
        detail: `result variant added: ${type}`,
        severity: "info",
      });
    }
  }

  // Enums, across all sections.
  const baseEnums = enumDefs(base);
  const candEnums = enumDefs(candidate);
  for (const [key, baseValues] of baseEnums) {
    const candValues = candEnums.get(key);
    if (!candValues) {
      findings.push({
        area: `enum:${key}`,
        kind: "enum-removed",
        detail: `enum def gone: ${key}`,
        severity: "review",
      });
      continue;
    }
    const removed = baseValues.filter((v) => !candValues.includes(v));
    const added = candValues.filter((v) => !baseValues.includes(v));
    if (removed.length > 0) {
      findings.push({
        area: `enum:${key}`,
        kind: "enum-narrowed",
        detail: `enum values removed: ${removed.join(", ")}`,
        severity: "fail",
      });
    }
    if (added.length > 0) {
      findings.push({
        area: `enum:${key}`,
        kind: "enum-widened",
        detail: `enum values added: ${added.join(", ")}`,
        severity: "info",
      });
    }
  }

  return { baseProtocol, candidateProtocol, findings };
}

export function recordShapeGate(base: unknown, candidate: unknown): SchemaFinding[] {
  const findings: SchemaFinding[] = [];
  for (const sectionName of GATED_SECTIONS) {
    const baseDefs = defs(base, sectionName);
    const candDefs = defs(candidate, sectionName);
    for (const record of GATED_RECORDS) {
      const baseDef = baseDefs[record];
      if (baseDef === undefined) continue; // not every section carries every record (event has no AgentInfo)
      const area = `record:${sectionName}.${record}`;
      const candDef = candDefs[record];
      if (candDef === undefined) {
        findings.push({
          area,
          kind: "record-removed",
          detail: `${record} vanished from the ${sectionName} section`,
          severity: "fail",
        });
        continue;
      }
      const baseObj = asObject(baseDef);
      const candObj = asObject(candDef);
      const baseProps = asObject(baseObj.properties);
      const candProps = asObject(candObj.properties);
      const baseRequired = requiredSet(baseObj);
      const candRequired = requiredSet(candObj);
      for (const field of Object.keys(baseProps)) {
        if (!(field in candProps)) {
          findings.push({
            area,
            kind: "field-removed",
            detail: `field removed: ${field}`,
            severity: "fail",
          });
          continue;
        }
        if (baseRequired.has(field) && !candRequired.has(field)) {
          findings.push({
            area,
            kind: "required-to-optional",
            detail: `field moved required -> optional: ${field} (the #2029 bug class)`,
            severity: "fail",
          });
        }
        if (!isNullable(baseProps[field]) && isNullable(candProps[field])) {
          findings.push({
            area,
            kind: "nullable-added",
            detail: `field turned nullable: ${field}`,
            severity: "fail",
          });
        }
      }
      for (const field of Object.keys(candProps)) {
        if (!(field in baseProps)) {
          findings.push({
            area,
            kind: "field-added",
            detail: `field added: ${field}`,
            severity: "info",
          });
        }
      }
    }
  }
  return findings;
}
