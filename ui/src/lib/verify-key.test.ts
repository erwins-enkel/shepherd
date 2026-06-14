import { describe, it, expect } from "vitest";
import { verifyFailureMessage, type VerifyMessages } from "./verify-key";

// Stub resolvers so the mapping is testable without the Paraglide runtime.
const msgs: VerifyMessages = {
  notAuthenticated: () => "The key did not authenticate.",
  timeout: () => "Timed out waiting for a response.",
  generic: () => "Could not verify the key.",
};

describe("verifyFailureMessage", () => {
  it("maps not-authenticated to its message", () => {
    expect(verifyFailureMessage("not-authenticated", undefined, msgs)).toBe(
      "The key did not authenticate.",
    );
  });

  it("appends the verbatim detail to not-authenticated when present", () => {
    expect(verifyFailureMessage("not-authenticated", "invalid x-api-key", msgs)).toBe(
      "The key did not authenticate.: invalid x-api-key",
    );
  });

  it("maps timeout to its message", () => {
    expect(verifyFailureMessage("timeout", undefined, msgs)).toBe(
      "Timed out waiting for a response.",
    );
  });

  it("ignores detail on timeout (only not-authenticated carries it)", () => {
    expect(verifyFailureMessage("timeout", "ignored", msgs)).toBe(
      "Timed out waiting for a response.",
    );
  });

  it("falls back to generic for unknown/other reasons", () => {
    expect(verifyFailureMessage("spawn-failed", undefined, msgs)).toBe("Could not verify the key.");
    expect(verifyFailureMessage("not-configured", undefined, msgs)).toBe(
      "Could not verify the key.",
    );
  });

  it("falls back to generic for an undefined reason", () => {
    expect(verifyFailureMessage(undefined, undefined, msgs)).toBe("Could not verify the key.");
  });
});
