import { describe, expect, it } from "bun:test";
import {
  autoFixCommandFor,
  GUIDANCE_ONLY,
  REMEDIATIONS,
  remediationsFor,
} from "../../src/remediations";
import type { DiagnosticsSnapshot } from "../../src/types";

describe("remediations catalog", () => {
  it("maps known fixable hintKeys to a single shell command", () => {
    expect(REMEDIATIONS.diagnostics_hint_bun_missing).toContain("bun.sh/install");
  });

  it("node remediation symlinks the new node onto the server's PATH (~/.local/bin), not just fnm's dir", () => {
    // Regression: a bare `fnm install` leaves node off PATH, so the re-probe never
    // sees it and the scenario can't reach green.
    expect(REMEDIATIONS.diagnostics_hint_node_outdated).toContain(".local/bin/node");
  });

  it("collects verbatim commands for non-ok checks that have one (skips prose-only and ok)", () => {
    const snap: DiagnosticsSnapshot = {
      checks: [
        { id: "bun", state: "error", hintKey: "diagnostics_hint_bun_missing" },
        { id: "gh", state: "error", hintKey: "diagnostics_hint_gh_not_authenticated" }, // prose-only → skipped
        { id: "git", state: "ok", hintKey: "diagnostics_hint_git_ok" }, // ok → skipped
      ],
      generatedAt: 1,
      overall: "error",
    };
    expect(remediationsFor(snap)).toEqual([REMEDIATIONS["diagnostics_hint_bun_missing"]!]);
  });

  it("autoFixCommandFor returns the command for an auto-fixable hintKey", () => {
    expect(autoFixCommandFor("diagnostics_hint_bun_missing")).toBe(
      REMEDIATIONS.diagnostics_hint_bun_missing,
    );
  });

  it("autoFixCommandFor gates guidance-only hints to undefined even when they have a REMEDIATIONS entry", () => {
    // tailscale has a verbatim install command but it never clears the check
    // (needs an interactive tailnet login), so it's guidance-only, not auto-fix.
    expect(REMEDIATIONS.diagnostics_hint_tailscale_missing).toBeDefined();
    expect(GUIDANCE_ONLY.has("diagnostics_hint_tailscale_missing")).toBe(true);
    expect(autoFixCommandFor("diagnostics_hint_tailscale_missing")).toBeUndefined();
  });

  it("git has a cross-distro verbatim install, gated guidance-only for the in-app surface", () => {
    const cmd = REMEDIATIONS.diagnostics_hint_git_missing;
    expect(cmd).toBeDefined();
    // covers the harness's distros (apt / apk / dnf / pacman) in one chain
    expect(cmd).toContain("apt-get install -y git");
    expect(cmd).toContain("apk add --no-cache git");
    expect(cmd).toContain("dnf install -y git");
    expect(cmd).toContain("pacman -Sy --noconfirm git");
    expect(cmd).not.toContain("sudo"); // harness runs as root; busybox alpine has no sudo
    // privileged system install ⇒ guidance-only in-app (the root harness still applies it)
    expect(GUIDANCE_ONLY.has("diagnostics_hint_git_missing")).toBe(true);
    expect(autoFixCommandFor("diagnostics_hint_git_missing")).toBeUndefined();
  });

  it("remediationsFor includes the git install for a git-error snapshot (harness applies it as root)", () => {
    const snap: DiagnosticsSnapshot = {
      checks: [{ id: "git", state: "error", hintKey: "diagnostics_hint_git_missing" }],
      generatedAt: 1,
      overall: "error",
    };
    expect(remediationsFor(snap)).toEqual([REMEDIATIONS.diagnostics_hint_git_missing!]);
  });
});
