import { describe, expect, test } from "bun:test";
import { CleanTerminalControl } from "../src/clean-terminal-control";
import type { HerdrSocketClient } from "../src/herdr-socket-client";

const prefix = "\x00clean-terminal:";
const frame = (value: object) => prefix + JSON.stringify(value);

function fixture() {
  let offset = 0;
  let revision = 12;
  let allowed = true;
  let fail = false;
  let changeOnRead = false;
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const replies: Record<string, any>[] = [];
  const client = {
    async request(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      if (fail) throw new Error("herdr unavailable");
      const scroll = { offset_from_bottom: offset, max_offset_from_bottom: 270, viewport_rows: 30 };
      if (method === "pane.scroll") {
        offset = Math.min(270, Number(params.offset_from_bottom));
        return { type: "pane_info", pane: { scroll: { ...scroll, offset_from_bottom: offset } } };
      }
      if (method === "pane.get") return { type: "pane_info", pane: { scroll } };
      if (method === "pane.copy_motion")
        return { type: "pane_copy_motion", content_revision: revision };
      if (method === "pane.read") {
        if (changeOnRead) revision += 2;
        return { type: "pane_read", read: { text: "row\r\nnext", revision: 0 } };
      }
      if (method === "pane.selection.read") {
        if (params.content_revision !== revision)
          throw Object.assign(new Error(), { code: "stale_content" });
        return { type: "pane_selection", text: "line 1\nline 2\nline 3" };
      }
      throw new Error(`unexpected ${method}`);
    },
  } as Pick<HerdrSocketClient, "request">;
  const control = new CleanTerminalControl(
    "w1:p1",
    client,
    () => allowed,
    (data) => {
      replies.push(JSON.parse(data.slice(prefix.length)));
    },
  );
  const request = async (value: object) => {
    control.handle(frame(value));
    await Bun.sleep(5);
    return replies.at(-1)!;
  };
  return {
    control,
    calls,
    replies,
    request,
    revoke: () => {
      allowed = false;
    },
    change: () => {
      revision += 2;
    },
    changeOnRead: () => {
      changeOnRead = true;
    },
    fail: () => {
      fail = true;
    },
  };
}

describe("clean terminal endpoint history", () => {
  test("requires opt-in, binds the pane server-side and clamps scroll to the retained history", async () => {
    const f = fixture();
    expect(f.control.handle("echo hello\r")).toBe(false);
    await f.request({ id: 1, op: "scroll", offset: 999 });
    expect(f.calls).toHaveLength(0);
    await f.request({ id: 2, op: "init", pane_id: "evil:pane" });
    const state = await f.request({ id: 3, op: "scroll", offset: 999 });
    expect(state.scroll.offset_from_bottom).toBe(270);
    expect(state.text).toBe("row\r\nnext");
    expect(state.revision).toBe(12); // pane.read's revision=0 is NOT the content revision
    expect(f.calls.every(({ params }) => params.pane_id === "w1:p1")).toBe(true);
  });

  test("reads the full absolute selection, guarded by the content revision", async () => {
    const f = fixture();
    await f.request({ id: 1, op: "init" });
    const result = await f.request({
      id: 2,
      op: "selection",
      revision: 12,
      anchor: { row: 290, col: 8 },
      cursor: { row: 1, col: 0 },
    });
    expect(result.text).toBe("line 1\nline 2\nline 3");
    expect(f.calls.at(-1)).toEqual({
      method: "pane.selection.read",
      params: {
        pane_id: "w1:p1",
        content_revision: 12,
        anchor: { row: 290, col: 8 },
        cursor: { row: 1, col: 0 },
      },
    });
    f.change();
    expect(
      (
        await f.request({
          id: 3,
          op: "selection",
          revision: 12,
          anchor: { row: 1, col: 0 },
          cursor: { row: 3, col: 8 },
        })
      ).error,
    ).toBe("stale");
  });

  test("swallows malformed controls and rejects invalid coordinates without calling herdr", async () => {
    const f = fixture();
    expect(f.control.handle(prefix + "not json")).toBe(true);
    await f.request({ id: 1, op: "init" });
    f.calls.length = 0;
    for (const bad of [
      { id: 2, op: "scroll", offset: -1 },
      { id: 3, op: "scroll", offset: 1.5 },
      {
        id: 4,
        op: "selection",
        revision: 12,
        anchor: { row: -1, col: 0 },
        cursor: { row: 0, col: 0 },
      },
      { id: 5, op: "input", text: "rm -rf /" },
    ])
      expect(f.control.handle(frame(bad))).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  test("no work or late response after revocation or disposal", async () => {
    const f = fixture();
    f.control.handle(frame({ id: 1, op: "init" }));
    f.revoke();
    await Bun.sleep(5);
    expect(f.replies).toHaveLength(0);
    const count = f.calls.length;
    await f.request({ id: 2, op: "snapshot" });
    expect(f.calls).toHaveLength(count);
    f.control.close();
    await f.request({ id: 3, op: "init" });
    expect(f.replies).toHaveLength(0);
  });

  test("reports an unavailable endpoint without leaking its errors", async () => {
    const f = fixture();
    f.fail();
    const response = await f.request({ id: 1, op: "init" });
    expect(response).toEqual({ id: 1, error: "unavailable" });
  });
});

test("does not present a snapshot assembled across content revisions", async () => {
  const f = fixture();
  await f.request({ id: 1, op: "init" });
  f.changeOnRead();
  expect(await f.request({ id: 2, op: "snapshot" })).toEqual({ id: 2, error: "stale" });
});

test("bounds outstanding endpoint work when a client floods scroll requests", async () => {
  const f = fixture();
  await f.request({ id: 1, op: "init" });
  f.calls.length = 0;
  f.replies.length = 0;
  for (let id = 2; id < 50; id++) f.control.handle(frame({ id, op: "scroll", offset: 10 }));
  await Bun.sleep(10);
  expect(f.calls.filter(({ method }) => method === "pane.scroll")).toHaveLength(1);
  expect(f.replies.filter(({ error }) => error === "unavailable")).toHaveLength(47);
});
