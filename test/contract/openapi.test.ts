import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  coverage,
  declaredEvents,
  declaredOperations,
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
    const body = (await validateResponse("GET", "/api/health", res)) as { ok: boolean };
    expect(body.ok).toBe(true);
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
