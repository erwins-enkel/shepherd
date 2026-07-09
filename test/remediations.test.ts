import { describe, expect, it } from "bun:test";
import { REMEDIATIONS, autoFixCommandFor, HERDR_SERVE } from "../src/remediations";

describe("herdr offline remediation (#1574)", () => {
  it("exposes a start command for the offline hint", () => {
    expect(REMEDIATIONS.diagnostics_hint_herdr_offline).toBe(HERDR_SERVE);
  });

  it("makes the offline fix auto-runnable in-app (not guidance-only)", () => {
    expect(autoFixCommandFor("diagnostics_hint_herdr_offline")).toBe(HERDR_SERVE);
  });

  it("starts the daemon detached, portably (macOS has no setsid)", () => {
    expect(HERDR_SERVE).toContain("setsid");
    expect(HERDR_SERVE).toContain("nohup");
  });

  it("is idempotent: a live daemon short-circuits before spawning a second", () => {
    expect(HERDR_SERVE.indexOf("herdr agent list")).toBeLessThan(
      HERDR_SERVE.indexOf("herdr server"),
    );
  });

  it("puts ~/.local/bin on PATH before invoking herdr", () => {
    expect(HERDR_SERVE.indexOf(".local/bin")).toBeLessThan(HERDR_SERVE.indexOf("herdr agent list"));
  });

  it("herdr_missing installs AND starts, so the single-apply preflight scenario reaches green", () => {
    const cmd = REMEDIATIONS.diagnostics_hint_herdr_missing!;
    expect(cmd).toContain("herdr.dev/install.sh");
    expect(cmd).toContain("herdr server");
  });
});
