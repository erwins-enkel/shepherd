import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { RepoConfigService } from "../src/repo-config-service";

function harness() {
  const store = new SessionStore(":memory:");
  const svc = new RepoConfigService(store);
  return { store, svc };
}

test("read: returns the stored config plus automation-metadata flags", () => {
  const { svc } = harness();
  const view = svc.read("/r");
  expect(view.criticEnabled).toBeDefined();
  expect(view.previewOpenMode).toBe("ask");
  expect(view.automationConfirmed).toBe(false);
  expect(view.automationRowExists).toBe(false);
});

test("patch: merges defined fields, persists, returns fresh view", () => {
  const { store, svc } = harness();
  const r = svc.patch("/r", { criticEnabled: false, maxAuto: 3 });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("expected ok");
  expect(r.config.criticEnabled).toBe(false);
  expect(r.config.maxAuto).toBe(3);
  // Persisted, not just echoed.
  expect(store.getRepoConfig("/r").maxAuto).toBe(3);
});

test("patch: persists previewOpenMode", () => {
  const { store, svc } = harness();
  const r = svc.patch("/r", { previewOpenMode: "tab" });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("expected ok");
  expect(r.config.previewOpenMode).toBe("tab");
  expect(store.getRepoConfig("/r").previewOpenMode).toBe("tab");
});

test("patch: undefined fields leave the current value untouched", () => {
  const { svc } = harness();
  svc.patch("/r", { maxAuto: 7 });
  const r = svc.patch("/r", { criticEnabled: false }); // maxAuto omitted
  expect(r.ok && r.config.maxAuto).toBe(7);
});

test("patch: rejects draftMode + autoMergeEnabled (mutually exclusive), no write", () => {
  const { store, svc } = harness();
  const r = svc.patch("/r", { draftMode: true, autoMergeEnabled: true });
  expect(r).toEqual({
    ok: false,
    error: "draftMode and autoMergeEnabled are mutually exclusive",
  });
  expect(store.getRepoConfig("/r").draftMode).toBe(false); // unchanged
});

test("patch: rejects draftMode without critic when signoffAuthority isn't human", () => {
  const { svc } = harness();
  const r = svc.patch("/r", {
    draftMode: true,
    criticEnabled: false,
    signoffAuthority: "critic",
  });
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("expected rejection");
  expect(r.error).toContain("requires criticEnabled");
});

test("patch: draftMode with critic enabled is allowed", () => {
  const { svc } = harness();
  const r = svc.patch("/r", { draftMode: true, criticEnabled: true, signoffAuthority: "critic" });
  expect(r.ok).toBe(true);
});

test("patch: automationConfirmed flag marks the row confirmed", () => {
  const { store, svc } = harness();
  expect(store.isAutomationConfirmed("/r")).toBe(false);
  const r = svc.patch("/r", { criticEnabled: true }, { automationConfirmed: true });
  expect(r.ok).toBe(true);
  expect(store.isAutomationConfirmed("/r")).toBe(true);
  expect(svc.read("/r").automationConfirmed).toBe(true);
});

test("patch: without the automationConfirmed flag, confirmation stays untouched", () => {
  const { store, svc } = harness();
  svc.patch("/r", { criticEnabled: true });
  expect(store.isAutomationConfirmed("/r")).toBe(false);
});

test("patch: hidden survives a later unrelated patch (no read-modify-write clobber)", () => {
  const { store, svc } = harness();
  // Hide the repo, then toggle an unrelated field. If `hidden` were missing from
  // getRepoConfig's SELECT, the merge would silently rewrite hidden=false here.
  expect(svc.patch("/r", { hidden: true }).ok).toBe(true);
  const r = svc.patch("/r", { criticEnabled: false });
  expect(r.ok && r.config.hidden).toBe(true);
  expect(store.getRepoConfig("/r").hidden).toBe(true);
});

test("patch: previewOpenMode survives a later unrelated patch", () => {
  const { store, svc } = harness();
  expect(svc.patch("/r", { previewOpenMode: "inline" }).ok).toBe(true);
  const r = svc.patch("/r", { criticEnabled: false });
  expect(r.ok && r.config.previewOpenMode).toBe("inline");
  expect(store.getRepoConfig("/r").previewOpenMode).toBe("inline");
});

test("hiddenRepoPaths: returns exactly the repos flagged hidden", () => {
  const { store, svc } = harness();
  expect(store.hiddenRepoPaths()).toEqual(new Set());
  svc.patch("/a", { hidden: true });
  svc.patch("/b", { criticEnabled: false }); // not hidden
  svc.patch("/c", { hidden: true });
  expect(store.hiddenRepoPaths()).toEqual(new Set(["/a", "/c"]));
  // Unhiding drops it from the set.
  svc.patch("/a", { hidden: false });
  expect(store.hiddenRepoPaths()).toEqual(new Set(["/c"]));
});
