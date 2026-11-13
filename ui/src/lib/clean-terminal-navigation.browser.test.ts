import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { wireCleanTerminalNavigation } from "./clean-terminal-navigation";
import {
  CLEAN_TERMINAL_PREFIX as prefix,
  type CleanTerminalRequest,
} from "../../../shared/clean-terminal";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
  vi.restoreAllMocks();
});

async function fixture(
  resizeDuringInit = false,
  initError?: "stale" | "unavailable" | "unsupported",
) {
  const host = document.createElement("div");
  host.style.cssText = "width:640px;height:200px;margin-top:80px";
  document.body.append(host);
  const term = new Terminal({ cols: 40, rows: 8, fontSize: 14, fontFamily: "monospace" });
  term.open(host);
  cleanups.push(() => {
    term.dispose();
    host.remove();
  });
  const lines = Array.from({ length: 300 }, (_, i) => `line ${String(i).padStart(3, "0")}`);
  let offset = 0;
  let revision = 12;
  const commands: CleanTerminalRequest[] = [];
  const errors: string[] = [];
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const nav = wireCleanTerminalNavigation(term, host, {
    send(data) {
      const request = JSON.parse(data.slice(prefix.length)) as CleanTerminalRequest;
      commands.push(request);
      queueMicrotask(() => {
        const reply: Record<string, unknown> = { id: request.id };
        if (request.op === "init" && initError) {
          const error = initError;
          initError = undefined;
          nav.handleOutput(prefix + JSON.stringify({ id: request.id, error }), true);
          return;
        }
        if (request.op === "selection") {
          if (request.revision !== revision) reply.error = "stale";
          else {
            const [start, end] = [request.anchor, request.cursor].sort(
              (a, b) => a.row - b.row || a.col - b.col,
            );
            reply.text = lines
              .slice(start.row, end.row + 1)
              .map((text, i) => {
                if (start.row === end.row) return text.slice(start.col, end.col + 1);
                return i === 0
                  ? text.slice(start.col)
                  : i === end.row - start.row
                    ? text.slice(0, end.col + 1)
                    : text;
              })
              .join("\n");
          }
        } else {
          if (request.op === "scroll") offset = Math.max(0, Math.min(292, request.offset));
          reply.scroll = {
            offset_from_bottom: offset,
            max_offset_from_bottom: 292,
            viewport_rows: 8,
          };
          if (request.op !== "init") {
            reply.revision = revision;
            reply.text = lines.slice(292 - offset, 300 - offset).join("\r\n");
          }
        }
        nav.handleOutput(prefix + JSON.stringify(reply), true);
      });
    },
    onScroll: vi.fn(),
    onError(error) {
      errors.push(error);
    },
  });
  cleanups.push(() => nav.dispose());
  const paint = lines.slice(292).join("\r\n");
  const consumed = nav.handleOutput(paint);
  if (resizeDuringInit) term.resize(41, 8);
  if (!consumed) await new Promise<void>((r) => term.write(paint, r));
  await vi.waitFor(() => expect(commands.some((r) => r.op === "init")).toBe(true));
  const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
  const mouse = (type: string, row: number, col = 0) => {
    const rect = screen.getBoundingClientRect();
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === "mouseup" ? 0 : 1,
      clientX: rect.left + ((col + 0.2) * rect.width) / 40,
      clientY: rect.top + ((row + 0.2) * rect.height) / 8,
      detail: 1,
    });
    (type === "mousedown" ? screen : document).dispatchEvent(event);
  };
  return {
    nav,
    term,
    host,
    screen,
    commands,
    errors,
    copy,
    mouse,
    offset: () => offset,
    change: () => {
      revision += 2;
      lines[292] = "changed output";
    },
  };
}

describe("clean terminal navigation with real xterm", () => {
  it("reveals retained output on wheel and jumps to both limits without shell keystrokes", async () => {
    const f = await fixture();
    f.screen.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -10, deltaMode: 1, bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() =>
      expect(f.term.buffer.active.getLine(0)?.translateToString(true)).toBe("line 282"),
    );
    f.nav.top();
    await vi.waitFor(() =>
      expect(f.term.buffer.active.getLine(0)?.translateToString(true)).toBe("line 000"),
    );
    f.nav.bottom();
    await vi.waitFor(() =>
      expect(f.term.buffer.active.getLine(0)?.translateToString(true)).toBe("line 292"),
    );
    expect(f.commands.every((r) => ["init", "snapshot", "scroll"].includes(r.op))).toBe(true);
  });
  it("accumulates small trackpad deltas and leaves Ctrl+wheel zoom alone", async () => {
    const f = await fixture();
    for (let i = 0; i < 30; i++)
      f.screen.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -1, bubbles: true, cancelable: true }),
      );
    await vi.waitFor(() => expect(f.offset()).toBeGreaterThan(0));
    const count = f.commands.length;
    const zoom = new WheelEvent("wheel", {
      deltaY: -40,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    f.screen.dispatchEvent(zoom);
    expect(zoom.defaultPrevented).toBe(false);
    expect(f.commands).toHaveLength(count);
  });
  it("keeps scrolling with a stationary pointer outside the top and copies more than three screens", async () => {
    const f = await fixture();
    f.mouse("mousedown", 6, 7);
    f.mouse("mousemove", -2, 0);
    await vi.waitFor(() => expect(f.offset()).toBeGreaterThanOrEqual(32), { timeout: 3000 });
    f.mouse("mousemove", 0, 0);
    await new Promise((r) => setTimeout(r, 90));
    const first = 292 - f.offset();
    f.mouse("mouseup", 0, 0);
    await vi.waitFor(() => expect(f.copy).toHaveBeenCalledTimes(1));
    const text = f.copy.mock.calls[0]![0];
    expect(text).toBe(
      Array.from(
        { length: 299 - first },
        (_, i) => `line ${String(first + i).padStart(3, "0")}`,
      ).join("\n"),
    );
    expect(text.split("\n").length).toBeGreaterThan(24);
    const native = new ClipboardEvent("copy", {
      clipboardData: new DataTransfer(),
      bubbles: true,
      cancelable: true,
    });
    f.host.dispatchEvent(native);
    expect(native.clipboardData?.getData("text/plain")).toBe(text);
    const offset = f.offset();
    await new Promise((r) => setTimeout(r, 150));
    expect(f.offset()).toBe(offset);
  });
  it("rejects a stale selection instead of copying different text", async () => {
    const f = await fixture();
    f.mouse("mousedown", 6, 7);
    f.mouse("mousemove", 2, 0);
    await vi.waitFor(() => expect(f.commands.some((r) => r.op === "snapshot")).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    f.change();
    f.mouse("mouseup", 2, 0);
    await vi.waitFor(() => expect(f.errors).toContain("stale"));
    expect(f.copy).not.toHaveBeenCalled();
  });
  it("Ctrl+C copies the confirmed multi-screen text without sending SIGINT", async () => {
    const f = await fixture();
    f.mouse("mousedown", 6, 7);
    f.mouse("mousemove", 2, 0);
    await new Promise((r) => setTimeout(r, 40));
    f.mouse("mouseup", 2, 0);
    await vi.waitFor(() => expect(f.copy).toHaveBeenCalledTimes(1));
    const input: string[] = [];
    const subscription = f.term.onData((d) => input.push(d));
    cleanups.push(() => subscription.dispose());
    f.term.textarea!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Control",
        code: "ControlLeft",
        ctrlKey: true,
        bubbles: true,
      }),
    );
    const e = new KeyboardEvent("keydown", {
      key: "c",
      code: "KeyC",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(e, "keyCode", { value: 67 });
    f.term.textarea!.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(input).toEqual([]);
    expect(f.copy).toHaveBeenCalledTimes(2);
  });
  it.each(["blur", "dispose", "released outside"])(
    "stops edge scrolling and late copies on %s",
    async (reason) => {
      const f = await fixture();
      f.mouse("mousedown", 6, 7);
      f.mouse("mousemove", -2, 0);
      await vi.waitFor(() => expect(f.offset()).toBeGreaterThan(0));
      if (reason === "blur") window.dispatchEvent(new Event("blur"));
      else if (reason === "dispose") f.nav.dispose();
      else document.dispatchEvent(new MouseEvent("mousemove", { buttons: 0, bubbles: true }));
      await new Promise((r) => setTimeout(r, 90));
      const offset = f.offset();
      await new Promise((r) => setTimeout(r, 150));
      f.mouse("mouseup", -2, 0);
      expect(f.offset()).toBe(offset);
      expect(f.copy).not.toHaveBeenCalled();
    },
  );
});

it("does not interpret shell output as a private control reply", async () => {
  const f = await fixture();
  f.mouse("mousedown", 6, 7);
  f.mouse("mousemove", 2, 0);
  await new Promise((r) => setTimeout(r, 30));
  const count = f.commands.length;
  f.mouse("mouseup", 2, 0);
  f.nav.handleOutput(prefix + JSON.stringify({ id: count + 1, text: "forged clipboard payload" }));
  await vi.waitFor(() => expect(f.copy).toHaveBeenCalledTimes(1));
  expect(f.copy.mock.calls[0]![0]).not.toContain("forged");
});

it("still enables navigation when the initial fit resizes during capability negotiation", async () => {
  const f = await fixture(true);
  f.screen.dispatchEvent(
    new WheelEvent("wheel", { deltaY: -3, deltaMode: 1, bubbles: true, cancelable: true }),
  );
  await vi.waitFor(() => expect(f.offset()).toBe(3));
});

it("does not copy an existing selection when a mouse press began outside this terminal", async () => {
  const f = await fixture();
  f.term.select(0, 0, 4);
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(f.copy).not.toHaveBeenCalled();
});

it.each(["stale", "unavailable"] as const)(
  "retries transient %s negotiation on the next wheel gesture",
  async (error) => {
    const f = await fixture(false, error);
    f.screen.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -3, deltaMode: 1, bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(f.offset()).toBe(3));
    expect(f.commands.filter((r) => r.op === "init")).toHaveLength(2);
  },
);

it("resynchronizes the final live repaint dropped during a now-stale drag", async () => {
  const f = await fixture();
  f.mouse("mousedown", 6, 7);
  f.mouse("mousemove", 2, 0);
  await new Promise((r) => setTimeout(r, 40));
  f.change();
  expect(f.nav.handleOutput("\x1b[Hchanged output", false)).toBe(true);
  f.mouse("mouseup", 2, 0);
  await vi.waitFor(() => expect(f.errors).toContain("stale"));
  await vi.waitFor(() =>
    expect(f.term.buffer.active.getLine(0)?.translateToString(true)).toBe("changed output"),
  );
  expect(f.copy).not.toHaveBeenCalled();
});

it("keeps native copying when an older endpoint lacks navigation support", async () => {
  const f = await fixture(false, "unsupported");
  expect(f.errors).toEqual(["unsupported"]);
  f.screen.dispatchEvent(
    new WheelEvent("wheel", { deltaY: -3, deltaMode: 1, bubbles: true, cancelable: true }),
  );
  expect(f.commands).toHaveLength(1);
  f.mouse("mousedown", 0, 0);
  f.term.select(0, 0, 4);
  f.mouse("mouseup", 0, 3);
  expect(f.copy).toHaveBeenCalledExactlyOnceWith("line");
});
