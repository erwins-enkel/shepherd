import { describe, it, expect } from "vitest";
import { diagnosticsPip } from "./gear-pip";

describe("diagnosticsPip", () => {
  it("maps diagnostics error/warning to red/yellow", () => {
    expect(diagnosticsPip("error")).toBe("red");
    expect(diagnosticsPip("warning")).toBe("yellow");
  });
  it("stays dark when diagnostics are fine", () => {
    expect(diagnosticsPip("ok")).toBeNull();
    expect(diagnosticsPip("optional")).toBeNull();
  });
});
