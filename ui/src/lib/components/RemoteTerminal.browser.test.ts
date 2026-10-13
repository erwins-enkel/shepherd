import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { connectPty } from "#lib/pty.js";
import type { MirroredSession } from "#lib/remote-sessions.js";
import { m } from "#lib/paraglide/messages.js";

// The terminal of a session on a connected machine (#2764). The PTY connection is a spy that
// records each attach and its callbacks, so a test can play the server's side: output, a
// takeover (parked), or the machine becoming unreachable.
type Args = Parameters<typeof connectPty>;
const pty = vi.hoisted(() => ({
  attaches: [] as { args: Args; conn: Record<string, ReturnType<typeof vi.fn>> }[],
}));
vi.mock("#lib/pty.js", () => ({
  connectPty: vi.fn((...args: Args) => {
    const conn = {
      send: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
      poke: vi.fn(),
      takeover: vi.fn(),
    };
    pty.attaches.push({ args, conn });
    return conn;
  }),
}));

const { default: RemoteTerminal } = await import("./RemoteTerminal.svelte");

const host = { instanceId: "m1", name: "MacBook", platform: "macos" };

function remote(over: Partial<MirroredSession> = {}): MirroredSession {
  return {
    id: "r1",
    desig: "TASK-07",
    name: "fix login redirect",
    status: "running",
    host,
    connection: { state: "connected", since: 100 },
    ...over,
  } as MirroredSession;
}

const last = () => pty.attaches.at(-1)!;

async function terminalTextarea(): Promise<HTMLTextAreaElement> {
  for (let i = 0; i < 100; i++) {
    const el = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    if (el) return el;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("xterm helper textarea never appeared");
}

/** xterm branches on the legacy keyCode, which the KeyboardEvent constructor never sets. */
function keydown(init: KeyboardEventInit, keyCode: number): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
  Object.defineProperty(ev, "keyCode", { value: keyCode });
  return ev;
}

beforeEach(() => {
  pty.attaches.length = 0;
  document.body.innerHTML = "";
});

describe("RemoteTerminal", () => {
  it("attaches to the session's /pty/:id; keys reach the agent, the app's chords do not", async () => {
    render(RemoteTerminal, { session: remote() });
    await expect
      .element(page.getByRole("region", { name: m.remote_terminal_aria({ machine: "MacBook" }) }))
      .toBeInTheDocument();
    await vi.waitFor(() => expect(pty.attaches).toHaveLength(1));
    expect(last().args[0]).toBe("r1");
    const ta = await terminalTextarea();
    ta.focus();

    ta.dispatchEvent(keydown({ key: "x", code: "KeyX" }, 88));
    await vi.waitFor(() =>
      expect(last().conn.send.mock.calls.some(([d]) => String(d).includes("x"))).toBe(true),
    );

    last().conn.send.mockClear();
    const newline = keydown({ key: "Enter", code: "Enter", shiftKey: true }, 13);
    ta.dispatchEvent(newline);
    expect(newline.defaultPrevented).toBe(true);
    expect(last().conn.send.mock.calls).toEqual([["\n"]]);

    last().conn.send.mockClear();
    const chord = keydown({ key: ",", code: "Comma", ctrlKey: true }, 188);
    ta.dispatchEvent(chord);
    expect(chord.defaultPrevented).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(last().conn.send).not.toHaveBeenCalled();
  });

  it("a takeover elsewhere parks it with the new holder named; tapping takes it back", async () => {
    render(RemoteTerminal, { session: remote(), owner: { kind: "mac-app", platform: "macos" } });
    await vi.waitFor(() => expect(pty.attaches).toHaveLength(1));
    const onParked = last().args[5]!;
    onParked();
    const parked = page.getByRole("button", { name: /Active in the Mac app/ });
    await expect.element(parked).toBeInTheDocument();
    await parked.click();
    expect(last().conn.takeover).toHaveBeenCalledTimes(1);
    expect(pty.attaches).toHaveLength(1);
  });

  it("an unreachable machine is named; Reconnect attaches afresh", async () => {
    render(RemoteTerminal, { session: remote() });
    await vi.waitFor(() => expect(pty.attaches).toHaveLength(1));
    last().args[6]!("machine");
    const reconnect = page.getByRole("button", {
      name: new RegExp(`${m.viewport_reconnect_title()}.*MacBook can't be reached`),
    });
    await expect.element(reconnect).toBeInTheDocument();
    await reconnect.click();
    await vi.waitFor(() => expect(pty.attaches).toHaveLength(2));
    expect(pty.attaches[0]!.conn.close).toHaveBeenCalled();
    await expect.element(reconnect).not.toBeInTheDocument();
  });

  it("re-attaches by itself once the machine's connection comes back, and only then", async () => {
    const view = await render(RemoteTerminal, { session: remote() });
    await vi.waitFor(() => expect(pty.attaches).toHaveLength(1));
    last().args[6]!("machine");
    // Same connection as when it ended: the machine never left the mirror's view, so no loop.
    await view.rerender({ session: remote() });
    await view.rerender({
      session: remote({ connection: { state: "disconnected", since: 200 } }),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(pty.attaches).toHaveLength(1);
    await view.rerender({ session: remote({ connection: { state: "connected", since: 300 } }) });
    await vi.waitFor(() => expect(pty.attaches).toHaveLength(2));
    // A fresh session object for the same session never rebuilds a live terminal.
    await view.rerender({ session: remote({ connection: { state: "connected", since: 300 } }) });
    await new Promise((r) => setTimeout(r, 50));
    expect(pty.attaches).toHaveLength(2);
  });
});
