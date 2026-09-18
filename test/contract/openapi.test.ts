import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  coverage,
  declaredEvents,
  declaredOperations,
  loadContract,
  startContractServer,
  validateResponse,
  type ContractServer,
} from "./harness";

let s: ContractServer;
beforeAll(() => {
  s = startContractServer();
});
afterAll(() => s.stop());

describe("health", () => {
  test("GET /api/health is public and matches the contract", async () => {
    const res = await fetch(`${s.baseUrl}/api/health`);
    const body = (await validateResponse("GET", "/api/health", res)) as {
      ok: boolean;
      version: string;
    };
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("declaredOperations ignores path-level parameters", () => {
    const c = loadContract();
    const before = declaredOperations().length;
    (c.paths["/api/health"] as Record<string, unknown>).parameters = [{ name: "x", in: "query" }];
    try {
      expect(declaredOperations().length).toBe(before);
    } finally {
      delete (c.paths["/api/health"] as Record<string, unknown>).parameters;
    }
  });
});

// The coverage gate stays the LAST describe in this file for the whole plan; every later
// contract area adds its describe above it.
describe("coverage gate", () => {
  test("every declared operation and event was exercised", () => {
    const { operations, events } = coverage();
    const missingOps = declaredOperations().filter((o) => !operations.has(o));
    const missingEvents = declaredEvents().filter((e) => !events.has(e));
    expect(missingOps).toEqual([]);
    expect(missingEvents).toEqual([]);
  });
});
