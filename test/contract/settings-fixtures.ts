// test/contract/settings-fixtures.ts
import type { DiagnosticsSnapshot } from "../../src/types";
export const diagnostic: DiagnosticsSnapshot = {
  generatedAt: 123,
  overall: "warning",
  checks: [
    {
      id: "bun",
      state: "warning",
      hintKey: "diagnostics_hint_bun_missing",
      remediation: "fixture-only-command",
    },
  ],
};
