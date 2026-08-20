import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  diffSchemas,
  recordShapeGate,
  type SchemaFinding,
} from "../scripts/herdr-compat/schema-diff";

/** Minimal synthetic schema in herdr's `api schema --json` shape. */
function makeSchema(overrides?: {
  protocol?: number;
  requestDefs?: Record<string, unknown>;
  requestOneOf?: unknown[];
  successDefs?: Record<string, unknown>;
  eventDefs?: Record<string, unknown>;
}) {
  return {
    protocol: overrides?.protocol ?? 17,
    schema_version: 1,
    schemas: {
      request: {
        $defs: overrides?.requestDefs ?? {
          TabCreateParams: {
            type: "object",
            properties: {
              cwd: { type: ["string", "null"] },
              label: { type: ["string", "null"] },
            },
          },
          AgentStatus: { enum: ["idle", "working", "blocked", "done", "unknown"] },
        },
        oneOf: overrides?.requestOneOf ?? [
          {
            properties: {
              method: { const: "tab.create", type: "string" },
              params: { $ref: "#/schemas/request/$defs/TabCreateParams" },
            },
            required: ["method", "params"],
            type: "object",
          },
        ],
      },
      success_response: {
        $defs: overrides?.successDefs ?? {
          ResponseResult: {
            oneOf: [
              {
                properties: {
                  type: { const: "tab_list", type: "string" },
                  tabs: { type: "array" },
                },
                required: ["type", "tabs"],
                type: "object",
              },
            ],
          },
          TabInfo: {
            properties: {
              tab_id: { type: "string" },
              label: { type: "string" },
              agent_status: { $ref: "#/schemas/success_response/$defs/AgentStatus" },
            },
            required: ["tab_id", "label", "agent_status"],
            type: "object",
          },
        },
      },
      event: {
        $defs: overrides?.eventDefs ?? {
          TabInfo: {
            properties: {
              tab_id: { type: "string" },
              label: { type: "string" },
            },
            required: ["tab_id", "label"],
            type: "object",
          },
        },
      },
    },
  };
}

function bySeverity(findings: SchemaFinding[], severity: string) {
  return findings.filter((f) => f.severity === severity);
}

describe("diffSchemas", () => {
  it("identical schemas yield no findings and record the protocols", () => {
    const res = diffSchemas(makeSchema(), makeSchema());
    expect(res.baseProtocol).toBe(17);
    expect(res.candidateProtocol).toBe(17);
    expect(res.findings).toEqual([]);
  });

  it("a protocol bump is a review finding, never a fail", () => {
    const res = diffSchemas(makeSchema(), makeSchema({ protocol: 19 }));
    expect(res.candidateProtocol).toBe(19);
    expect(bySeverity(res.findings, "fail")).toEqual([]);
    const protocolFindings = res.findings.filter((f) => f.area === "protocol");
    expect(protocolFindings).toHaveLength(1);
    expect(protocolFindings[0]?.severity).toBe("review");
  });

  it("an added method is info; a removed method is fail", () => {
    const extra = {
      properties: {
        method: { const: "workspace.move_block", type: "string" },
        params: { $ref: "#/schemas/request/$defs/TabCreateParams" },
      },
      required: ["method", "params"],
      type: "object",
    };
    const base = makeSchema();
    const grown = makeSchema({
      requestOneOf: [...(makeSchema().schemas.request.oneOf as unknown[]), extra],
    });
    const added = diffSchemas(base, grown).findings;
    expect(added.some((f) => f.kind === "method-added" && f.severity === "info")).toBe(true);
    expect(bySeverity(added, "fail")).toEqual([]);

    const removed = diffSchemas(grown, base).findings;
    const fails = bySeverity(removed, "fail");
    expect(fails).toHaveLength(1);
    expect(fails[0]?.kind).toBe("method-removed");
    expect(fails[0]?.detail).toContain("workspace.move_block");
  });

  it("a removed param property is fail; an added optional one is info", () => {
    const base = makeSchema();
    const narrowed = makeSchema({
      requestDefs: {
        TabCreateParams: {
          type: "object",
          properties: { cwd: { type: ["string", "null"] } },
        },
        AgentStatus: { enum: ["idle", "working", "blocked", "done", "unknown"] },
      },
    });
    const fails = bySeverity(diffSchemas(base, narrowed).findings, "fail");
    expect(fails).toHaveLength(1);
    expect(fails[0]?.area).toBe("params:tab.create");
    expect(fails[0]?.detail).toContain("label");

    const widened = diffSchemas(narrowed, base).findings;
    expect(bySeverity(widened, "fail")).toEqual([]);
    expect(widened.some((f) => f.kind === "param-added" && f.severity === "info")).toBe(true);
  });

  it("a param that becomes required is fail", () => {
    const base = makeSchema();
    const stricter = makeSchema({
      requestDefs: {
        TabCreateParams: {
          type: "object",
          properties: {
            cwd: { type: ["string", "null"] },
            label: { type: ["string", "null"] },
          },
          required: ["label"],
        },
        AgentStatus: { enum: ["idle", "working", "blocked", "done", "unknown"] },
      },
    });
    const fails = bySeverity(diffSchemas(base, stricter).findings, "fail");
    expect(fails).toHaveLength(1);
    expect(fails[0]?.kind).toBe("param-now-required");
    expect(fails[0]?.detail).toContain("label");
  });

  it("a removed result-variant property is fail; a removed variant is fail", () => {
    const base = makeSchema();
    const noTabs = makeSchema({
      successDefs: {
        ResponseResult: {
          oneOf: [
            {
              properties: { type: { const: "tab_list", type: "string" } },
              required: ["type"],
              type: "object",
            },
          ],
        },
        TabInfo: (makeSchema().schemas.success_response.$defs as Record<string, unknown>).TabInfo,
      },
    });
    const propFails = bySeverity(diffSchemas(base, noTabs).findings, "fail");
    expect(propFails.some((f) => f.area === "result:tab_list" && f.detail.includes("tabs"))).toBe(
      true,
    );

    const noVariant = makeSchema({
      successDefs: {
        ResponseResult: { oneOf: [] },
        TabInfo: (makeSchema().schemas.success_response.$defs as Record<string, unknown>).TabInfo,
      },
    });
    const variantFails = bySeverity(diffSchemas(base, noVariant).findings, "fail");
    expect(variantFails.some((f) => f.kind === "result-variant-removed")).toBe(true);
  });

  it("a widened enum is info; a narrowed enum is fail", () => {
    const base = makeSchema();
    const widened = makeSchema({
      requestDefs: {
        TabCreateParams: (makeSchema().schemas.request.$defs as Record<string, unknown>)
          .TabCreateParams,
        AgentStatus: { enum: ["idle", "working", "blocked", "done", "unknown", "paused"] },
      },
    });
    const grow = diffSchemas(base, widened).findings;
    expect(bySeverity(grow, "fail")).toEqual([]);
    expect(grow.some((f) => f.kind === "enum-widened")).toBe(true);

    const shrink = bySeverity(diffSchemas(widened, base).findings, "fail");
    expect(shrink).toHaveLength(1);
    expect(shrink[0]?.kind).toBe("enum-narrowed");
    expect(shrink[0]?.detail).toContain("paused");
  });

  it("the vendored schema diffed against itself yields zero findings", () => {
    const vendored = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "src", "generated", "herdr-schema.json"), "utf8"),
    ) as unknown;
    const res = diffSchemas(vendored, vendored);
    expect(res.findings).toEqual([]);
    expect(res.baseProtocol).toBe(res.candidateProtocol);
  });
});

describe("recordShapeGate", () => {
  it("identical records yield no findings", () => {
    expect(recordShapeGate(makeSchema(), makeSchema())).toEqual([]);
  });

  it("a removed field is fail", () => {
    const gone = makeSchema({
      eventDefs: {
        TabInfo: {
          properties: { tab_id: { type: "string" } },
          required: ["tab_id"],
          type: "object",
        },
      },
    });
    const findings = recordShapeGate(makeSchema(), gone);
    const fails = bySeverity(findings, "fail");
    expect(fails).toHaveLength(1);
    expect(fails[0]?.area).toBe("record:event.TabInfo");
    expect(fails[0]?.kind).toBe("field-removed");
    expect(fails[0]?.detail).toContain("label");
  });

  it("required→optional drift is fail (the #2029 bug class)", () => {
    const loosened = makeSchema({
      successDefs: {
        ResponseResult: (makeSchema().schemas.success_response.$defs as Record<string, unknown>)
          .ResponseResult,
        TabInfo: {
          properties: {
            tab_id: { type: "string" },
            label: { type: "string" },
            agent_status: { $ref: "#/schemas/success_response/$defs/AgentStatus" },
          },
          required: ["tab_id", "agent_status"],
          type: "object",
        },
      },
    });
    const fails = bySeverity(recordShapeGate(makeSchema(), loosened), "fail");
    expect(fails).toHaveLength(1);
    expect(fails[0]?.kind).toBe("required-to-optional");
    expect(fails[0]?.detail).toContain("label");
  });

  it("a non-nullable field turning nullable is fail", () => {
    const nullable = makeSchema({
      eventDefs: {
        TabInfo: {
          properties: {
            tab_id: { type: "string" },
            label: { type: ["string", "null"] },
          },
          required: ["tab_id", "label"],
          type: "object",
        },
      },
    });
    const fails = bySeverity(recordShapeGate(makeSchema(), nullable), "fail");
    expect(fails).toHaveLength(1);
    expect(fails[0]?.kind).toBe("nullable-added");
    expect(fails[0]?.detail).toContain("label");
  });

  it("an added field is info", () => {
    const grown = makeSchema({
      eventDefs: {
        TabInfo: {
          properties: {
            tab_id: { type: "string" },
            label: { type: "string" },
            pinned: { type: "boolean" },
          },
          required: ["tab_id", "label"],
          type: "object",
        },
      },
    });
    const findings = recordShapeGate(makeSchema(), grown);
    expect(bySeverity(findings, "fail")).toEqual([]);
    expect(findings.some((f) => f.kind === "field-added" && f.severity === "info")).toBe(true);
  });

  it("a record vanishing from a section entirely is fail", () => {
    const gone = makeSchema({ eventDefs: {} });
    const fails = bySeverity(recordShapeGate(makeSchema(), gone), "fail");
    expect(fails).toHaveLength(1);
    expect(fails[0]?.kind).toBe("record-removed");
    expect(fails[0]?.area).toBe("record:event.TabInfo");
  });

  it("the vendored schema gated against itself is clean", () => {
    const vendored = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "src", "generated", "herdr-schema.json"), "utf8"),
    ) as unknown;
    expect(recordShapeGate(vendored, vendored)).toEqual([]);
  });
});
