import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HeldResult, Session } from "./types";
import { toasts } from "./toasts.svelte";
import { m } from "./paraglide/messages";
import { confirmBacklogQuickStart } from "./backlog-quick-start";

const session = (id: string) => ({ id }) as Session;
const held: HeldResult = { held: true, id: "h1", count: 1 };

describe("confirmBacklogQuickStart", () => {
  beforeEach(() => {
    toasts.items = [];
  });

  it("confirms a started session with an action that opens it", () => {
    const onopen = vi.fn();
    confirmBacklogQuickStart(session("s42"), 42, onopen);

    expect(toasts.items).toHaveLength(1);
    const t = toasts.items[0]!;
    expect(t.text).toBe(m.backlog_quick_started({ number: 42 }));
    expect(t.actionLabel).toBe(m.epic_run_open_session());
    toasts.act(t.id);
    expect(onopen).toHaveBeenCalledWith("s42");
  });

  it("says a held start waits for the usage reset, with no open action", () => {
    const onopen = vi.fn();
    confirmBacklogQuickStart(held, 42, onopen);

    expect(toasts.items.map((t) => t.text)).toEqual([m.upnext_held({ count: 1 })]);
    expect(toasts.items[0]!.actionLabel).toBeUndefined();
    expect(onopen).not.toHaveBeenCalled();
  });

  it("keeps one toast per start, each opening its own session", () => {
    const onopen = vi.fn();
    confirmBacklogQuickStart(session("a"), 1, onopen);
    confirmBacklogQuickStart(session("b"), 2, onopen);

    expect(toasts.items).toHaveLength(2);
    toasts.act(toasts.items[0]!.id);
    expect(onopen).toHaveBeenLastCalledWith("a");
  });
});
