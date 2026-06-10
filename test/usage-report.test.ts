import { test, expect } from "bun:test";
import { HEADERS, rowCells, totalsCells, type ReportRow } from "../scripts/usage-report";

const ROW: ReportRow = {
  desig: "TASK-001",
  name: "test-task",
  model: "sonnet",
  authTotal: 100000,
  authInput: 10000,
  authOutput: 5000,
  authCacheRead: 80000,
  authCacheWrite: 5000,
  authMsgs: 20,
  authCostUnits: 1.234,
  modelMix: "sonnet 100%",
  cacheReadRatio: 0.8,
  fullRecaches: 2,
  cacheWriteCostShare: 0.22,
  duration: "30m",
  ancCount: 1,
  ancProbe: 1,
  ancResumed: 0,
  ancUnknown: 0,
  ancTokens: 500,
  ancCostUnits: 0.01,
  satCount: 1,
  satTokens: 10000,
  satCostUnits: 0.5,
  satTags: "db×1",
  reviewMultiplier: 0.4,
};

test("rowCells length matches HEADERS", () => {
  expect(rowCells(ROW).length).toBe(HEADERS.length);
});

test("totalsCells length matches HEADERS", () => {
  expect(totalsCells([ROW]).length).toBe(HEADERS.length);
});
