import { describe, it, expect } from "vitest";
import { diagnosticsPip, withSteeringPip } from "./gear-pip";

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

describe("withSteeringPip", () => {
  it("shows info for an unread weekly digest when nothing stronger is lit", () => {
    expect(withSteeringPip(null, true)).toBe("info");
    expect(withSteeringPip(null, false)).toBeNull();
  });
  it("never overrides a stronger tier", () => {
    expect(withSteeringPip("red", true)).toBe("red");
    expect(withSteeringPip("yellow", true)).toBe("yellow");
    expect(withSteeringPip("info", false)).toBe("info");
  });
});
