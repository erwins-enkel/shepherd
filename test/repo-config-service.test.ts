import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { RepoConfigService } from "../src/repo-config-service";

function harness() {
  const store = new SessionStore(":memory:");
  const svc = new RepoConfigService(store, () => "standard");
  return { store, svc };
}

test("read: returns the stored config plus automation-metadata flags", async () => {
  const { svc } = harness();
  const view = svc.read("/r");
  expect(view.criticEnabled).toBeDefined();
  expect(view.previewOpenMode).toBe("ask");
  expect(view.automationConfirmed).toBe(false);
  expect(view.automationRowExists).toBe(false);
});

test("patch: merges defined fields, persists, returns fresh view", async () => {
  const { store, svc } = harness();
  const r = await svc.patch("/r", { criticEnabled: false, maxAuto: 3 });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("expected ok");
  expect(r.config.criticEnabled).toBe(false);
  expect(r.config.maxAuto).toBe(3);
  // Persisted, not just echoed.
  expect(store.getRepoConfig("/r").maxAuto).toBe(3);
});

test("patch: persists previewOpenMode", async () => {
  const { store, svc } = harness();
  const r = await svc.patch("/r", { previewOpenMode: "tab" });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("expected ok");
  expect(r.config.previewOpenMode).toBe("tab");
  expect(store.getRepoConfig("/r").previewOpenMode).toBe("tab");
});

test("patch: undefined fields leave the current value untouched", async () => {
  const { svc } = harness();
  await svc.patch("/r", { maxAuto: 7 });
  const r = await svc.patch("/r", { criticEnabled: false }); // maxAuto omitted
  expect(r.ok && r.config.maxAuto).toBe(7);
});

test("patch: rejects draftMode + autoMergeEnabled (mutually exclusive), no write", async () => {
  const { store, svc } = harness();
  const r = await svc.patch("/r", { draftMode: true, autoMergeEnabled: true });
  expect(r).toEqual({
    ok: false,
    error: "draftMode and autoMergeEnabled are mutually exclusive",
  });
  expect(store.getRepoConfig("/r").draftMode).toBe(false); // unchanged
});

test("patch: rejects draftMode without critic when signoffAuthority isn't human", async () => {
  const { svc } = harness();
  const r = await svc.patch("/r", {
    draftMode: true,
    criticEnabled: false,
    signoffAuthority: "critic",
  });
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("expected rejection");
  expect(r.error).toContain("requires criticEnabled");
});

test("patch: draftMode with critic enabled is allowed", async () => {
  const { svc } = harness();
  const r = await svc.patch("/r", {
    draftMode: true,
    criticEnabled: true,
    signoffAuthority: "critic",
  });
  expect(r.ok).toBe(true);
});

test("patch: automationConfirmed flag marks the row confirmed", async () => {
  const { store, svc } = harness();
  expect(store.isAutomationConfirmed("/r")).toBe(false);
  const r = await svc.patch("/r", { criticEnabled: true }, { automationConfirmed: true });
  expect(r.ok).toBe(true);
  expect(store.isAutomationConfirmed("/r")).toBe(true);
  expect(svc.read("/r").automationConfirmed).toBe(true);
});

test("patch: without the automationConfirmed flag, confirmation stays untouched", async () => {
  const { store, svc } = harness();
  await svc.patch("/r", { criticEnabled: true });
  expect(store.isAutomationConfirmed("/r")).toBe(false);
});

test("patch: hidden survives a later unrelated patch (no read-modify-write clobber)", async () => {
  const { store, svc } = harness();
  // Hide the repo, then toggle an unrelated field. If `hidden` were missing from
  // getRepoConfig's SELECT, the merge would silently rewrite hidden=false here.
  expect((await svc.patch("/r", { hidden: true })).ok).toBe(true);
  const r = await svc.patch("/r", { criticEnabled: false });
  expect(r.ok && r.config.hidden).toBe(true);
  expect(store.getRepoConfig("/r").hidden).toBe(true);
});

test("patch: previewOpenMode survives a later unrelated patch", async () => {
  const { store, svc } = harness();
  expect((await svc.patch("/r", { previewOpenMode: "inline" })).ok).toBe(true);
  const r = await svc.patch("/r", { criticEnabled: false });
  expect(r.ok && r.config.previewOpenMode).toBe("inline");
  expect(store.getRepoConfig("/r").previewOpenMode).toBe("inline");
});

test("patch: pinned round-trips and survives a later unrelated patch", async () => {
  const { store, svc } = harness();
  expect(store.getRepoConfig("/r").pinned).toBe(false);
  expect((await svc.patch("/r", { pinned: true })).ok).toBe(true);
  const r = await svc.patch("/r", { criticEnabled: false });
  expect(r.ok && r.config.pinned).toBe(true);
  expect(store.getRepoConfig("/r").pinned).toBe(true);
  expect((await svc.patch("/r", { pinned: false })).ok).toBe(true);
  expect(store.getRepoConfig("/r").pinned).toBe(false);
});

test("pinnedRepoPaths: returns exactly the repos flagged pinned", async () => {
  const { store, svc } = harness();
  expect(store.pinnedRepoPaths()).toEqual(new Set());
  await svc.patch("/a", { pinned: true });
  await svc.patch("/b", { hidden: true }); // hidden, not pinned
  await svc.patch("/c", { pinned: true });
  expect(store.pinnedRepoPaths()).toEqual(new Set(["/a", "/c"]));
  await svc.patch("/a", { pinned: false });
  expect(store.pinnedRepoPaths()).toEqual(new Set(["/c"]));
});

test("hiddenRepoPaths: returns exactly the repos flagged hidden", async () => {
  const { store, svc } = harness();
  expect(store.hiddenRepoPaths()).toEqual(new Set());
  await svc.patch("/a", { hidden: true });
  await svc.patch("/b", { criticEnabled: false }); // not hidden
  await svc.patch("/c", { hidden: true });
  expect(store.hiddenRepoPaths()).toEqual(new Set(["/a", "/c"]));
  // Unhiding drops it from the set.
  await svc.patch("/a", { hidden: false });
  expect(store.hiddenRepoPaths()).toEqual(new Set(["/c"]));
});

test("read: exposes the global default an inherit setting resolves to (#2100)", async () => {
  const store = new SessionStore(":memory:");
  const svc = new RepoConfigService(store, () => "standard");
  const view = svc.read("/new");
  expect(view.sandboxProfile).toBe("inherit");
  expect(view.sandboxDefaultProfile).toBe("standard");
});

test("patch: accepts sandboxProfile inherit and persists it (#2100)", async () => {
  const store = new SessionStore(":memory:");
  const svc = new RepoConfigService(store, () => "trusted");
  await svc.patch("/r", { sandboxProfile: "standard" });
  const r = await svc.patch("/r", { sandboxProfile: "inherit" });
  expect(r.ok && r.config.sandboxProfile).toBe("inherit");
  expect(store.getRepoConfig("/r").sandboxProfile).toBe("inherit");
});
