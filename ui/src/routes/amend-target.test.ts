import { describe, expect, it } from "vitest";
import { amendTargetState } from "./amend-target";

const rows = [{ id: "a" }, { id: "b" }];

describe("amendTargetState", () => {
  it("resolves the live row for an open dialog", () => {
    expect(amendTargetState("b", rows)).toEqual({ target: { id: "b" }, stale: false });
  });

  it("no id → nothing open, nothing to clear", () => {
    expect(amendTargetState(null, rows)).toEqual({ target: null, stale: false });
  });

  it("a row that left the herd unmounts the dialog AND marks the id stale", () => {
    // Both halves matter: `target` drives the mount, and the overlay gate must follow it — a gate
    // keyed on the raw id stays true forever and wedges every global shortcut until a reload.
    // `stale` is what lets the caller drop the id, so a `restore` of the same id cannot silently
    // re-open the dialog.
    expect(amendTargetState("gone", rows)).toEqual({ target: null, stale: true });
  });

  it("an empty herd marks any held id stale", () => {
    expect(amendTargetState("a", [])).toEqual({ target: null, stale: true });
  });
});
