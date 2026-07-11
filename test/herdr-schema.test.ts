import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { HERDR_SOCKET_SUPPORTED_PROTOCOLS } from "../src/config";
import { HERDR_METHOD_RESULT, HERDR_PROTOCOL } from "../src/generated/herdr-protocol";

// Offline gate: everything below reads committed files only (vendored schema + sanitized
// response manifest). No live herdr, no socket, no spawning.

interface RequestVariant {
  properties: { method: { const: string } };
}

interface ResponseResultVariant {
  properties: { type: { const: string }; [key: string]: unknown };
}

interface HerdrSchema {
  protocol: number;
  schemas: {
    request: { oneOf: RequestVariant[] };
    success_response: {
      $defs: { ResponseResult: { oneOf: ResponseResultVariant[] } };
    };
  };
}

interface ManifestEntry {
  type: string;
  resultKeys: string[];
}

const schema = JSON.parse(
  readFileSync(join(import.meta.dir, "../src/generated/herdr-schema.json"), "utf8"),
) as HerdrSchema;

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures/herdr-responses/manifest.json"), "utf8"),
) as Record<string, ManifestEntry>;

const methodSet = new Set(schema.schemas.request.oneOf.map((v) => v.properties.method.const));

const responseVariants = schema.schemas.success_response.$defs.ResponseResult.oneOf;

const variantTypeSet = new Set(responseVariants.map((v) => v.properties.type.const));

const variantByType = new Map<string, string[]>(
  responseVariants.map((v) => [v.properties.type.const, Object.keys(v.properties)]),
);

describe("herdr protocol gate", () => {
  it("vendored protocol is supported and HERDR_PROTOCOL agrees", () => {
    expect(HERDR_SOCKET_SUPPORTED_PROTOCOLS.has(schema.protocol)).toBe(true);
    expect(schema.protocol).toBe(HERDR_PROTOCOL);
  });
});

describe("HERDR_METHOD_RESULT curated entries are structurally real", () => {
  for (const [method, type] of Object.entries(HERDR_METHOD_RESULT)) {
    it(`${method} -> ${type}`, () => {
      expect(methodSet.has(method)).toBe(true);
      expect(variantTypeSet.has(type)).toBe(true);
    });
  }
});

describe("HERDR_METHOD_RESULT matches real captured responses", () => {
  for (const [method, entry] of Object.entries(manifest)) {
    it(`${method} carried type "${entry.type}"`, () => {
      // toHaveProperty splits on "." (nested-path syntax), which mangles dotted method
      // names like "agent.list" — use a direct own-property check instead.
      expect(Object.prototype.hasOwnProperty.call(HERDR_METHOD_RESULT, method)).toBe(true);
      expect((HERDR_METHOD_RESULT as Record<string, string>)[method]).toBe(entry.type);
      const fields = variantByType.get(entry.type);
      for (const key of entry.resultKeys) {
        expect(fields).toContain(key);
      }
    });
  }
});
