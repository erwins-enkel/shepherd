import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ComponentProps } from "svelte";
import { render } from "vitest-browser-svelte";
import { cdp, page, userEvent } from "vitest/browser";
import { Terminal, type ILink, type ILinkProvider } from "@xterm/xterm";
import "../../app.css";
import { m } from "#lib/paraglide/messages.js";
import type { Session } from "#lib/types.js";
import type { connectPty } from "#lib/pty.js";

// One fake PTY per terminal, each with its OWN send, so two mounted Viewports can be told apart.
type Client = {
  id: string;
  send: ReturnType<typeof vi.fn>;
  receive: Parameters<typeof connectPty>[3];
  park: () => void;
};
const clients: Client[] = [];
vi.mock("#lib/pty.js", () => ({
  connectPty: vi.fn((...args: Parameters<typeof connectPty>) => {
    const send = vi.fn();
    clients.push({ id: args[0], send, receive: args[3], park: args[5]! });
    return { send, resize: vi.fn(), close: vi.fn(), poke: vi.fn(), takeover: vi.fn() };
  }),
}));
const { default: Viewport } = await import("./Viewport.svelte");
type Props = ComponentProps<typeof Viewport>;

// Every link provider any terminal registers (URL addon, command links, desig links), so a test
// can ask them for a line's links the way xterm does on hover.
const providers: ILinkProvider[] = [];
const register = Terminal.prototype.registerLinkProvider;
vi.spyOn(Terminal.prototype, "registerLinkProvider").mockImplementation(function (
  this: Terminal,
  provider: ILinkProvider,
) {
  providers.push(provider);
  return register.call(this, provider);
});
async function linksOn(line: number): Promise<ILink[]> {
  const found = await Promise.all(
    providers.map(
      (p) => new Promise<ILink[]>((resolve) => p.provideLinks(line, (l) => resolve(l ?? []))),
    ),
  );
  return found.flat();
}

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    desig: "TASK-01",
    name: "task one",
    prompt: "p",
    repoPath: "/repo/a",
    baseBranch: "main",
    branch: "feat/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "ha",
    claudeSessionId: "cs",
    model: null,
    status: "idle",
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    planGateEnabled: null,
    planPhase: null,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    auto: false,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
    epicAuthoring: false,
    issueNumber: null,
    lastState: "",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
    ...partial,
  };
}

const assistantRow = session({
  id: "oa",
  desig: "TASK-90",
  repoPath: "/home/op/.shepherd/assistant",
  branch: null,
  isolated: false,
  operatorAssistant: true,
});
const clientFor = (id: string) => clients.find((c) => c.id === id)!;
const sent = (c: Client) => c.send.mock.calls.map(([d]) => d as string);
const escapes = (c: Client) => sent(c).filter((d) => d === "\x1b").length;
const frames = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame);
};

async function mount(props: Partial<Props>, host: HTMLElement = document.body) {
  const target = document.createElement("div");
  target.style.cssText =
    "height: 600px; flex: 1; min-width: 0; display: flex; flex-direction: column";
  host.append(target);
  const all: Props = { session: assistantRow, variant: "assistant", ...props };
  const view = await render(Viewport, { target, props: all });
  await vi.waitFor(() => expect(clients.some((c) => c.id === all.session.id)).toBe(true));
  return { ...view, props: all };
}

beforeEach(async () => {
  clients.length = 0;
  providers.length = 0;
  await page.viewport(1280, 900);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Viewport — Operator Assistant variant", () => {
  it("renders only the terminal: no header, tabs, strips, status bar, steer bar or hints", async () => {
    const console_ = await mount({ variant: "session", session: session({ id: "s1" }) });
    expect(console_.container.querySelector(".vp-head")).not.toBeNull();
    expect(console_.container.querySelector("[role=tablist]")).not.toBeNull();
    document.body.innerHTML = "";

    const { container } = await mount({});
    expect(container.querySelector(".term-mount")).not.toBeNull();
    for (const sel of [".vp-head", "[role=tablist]", ".vp-git-strip", ".ssb", ".steer-row"]) {
      expect(container.querySelector(sel), sel).toBeNull();
    }
    expect(container.querySelector(".vp-foot")).toBeNull();
    // no dangling tabpanel labelled by a tab that isn't there
    expect(container.querySelector(".vp-body")?.getAttribute("role")).toBeNull();
    expect(container.querySelector(".vp-body")?.getAttribute("aria-labelledby")).toBeNull();
  });

  it("does not take the keyboard on mount", async () => {
    await mount({});
    await frames();
    expect(document.activeElement?.classList.contains("xterm-helper-textarea")).toBe(false);
  });

  it("types a request made before the terminal attached once it does, without Enter, once per tick", async () => {
    const ontyped = vi.fn();
    const view = await mount({ typeRequest: { text: "Why is TASK-31 stuck?", tick: 1 }, ontyped });
    const c = clientFor("oa");
    await frames();
    expect(sent(c)).toEqual([]); // nothing until the attach delivers output
    c.receive("> ");
    await vi.waitFor(() => expect(sent(c)).toContain("\x1b[200~Why is TASK-31 stuck?\x1b[201~"));
    expect(ontyped).toHaveBeenCalledExactlyOnceWith(1);
    expect(sent(c).join("")).not.toMatch(/[\r\n]/);
    expect(document.activeElement?.classList.contains("xterm-helper-textarea")).toBe(true);

    c.receive("more output");
    await view.rerender({ ...view.props, typeRequest: { text: "Why is TASK-31 stuck?", tick: 1 } });
    await frames();
    await view.rerender({ ...view.props, typeRequest: { text: "And TASK-07?", tick: 2 } });
    await vi.waitFor(() => expect(sent(c)).toContain("\x1b[200~And TASK-07?\x1b[201~"));
    expect(sent(c).filter((d) => d.startsWith("\x1b[200~"))).toHaveLength(2);
    expect(ontyped).toHaveBeenLastCalledWith(2);
  });

  it("holds a request while the terminal is parked and types it once it is live again", async () => {
    const view = await mount({});
    const c = clientFor("oa");
    c.receive("> ");
    c.park();
    await view.rerender({ ...view.props, typeRequest: { text: "Is the node healthy?", tick: 1 } });
    await frames();
    expect(sent(c).join("")).not.toContain("Is the node healthy?");
    c.receive("repaint after takeover");
    await vi.waitFor(() => expect(sent(c)).toEqual(["\x1b[200~Is the node healthy?\x1b[201~"]));
  });

  it("links the desig of a live herd session to onnavigate", async () => {
    const onnavigate = vi.fn();
    await mount({ onnavigate, herd: [session({ id: "s31", desig: "TASK-31" })] });
    clientFor("oa").receive("TASK-31 waits on its plan gate; TASK-99 is archived");
    const link = await vi.waitFor(async () => {
      const found = (await linksOn(1)).find((l) => l.text === "TASK-31");
      expect(found).toBeDefined();
      return found!;
    });
    expect((await linksOn(1)).map((l) => l.text)).not.toContain("TASK-99");
    link.activate(new MouseEvent("click"), link.text);
    expect(onnavigate).toHaveBeenCalledExactlyOnceWith("s31");
  });

  it("does not link desigs in a session terminal", async () => {
    await mount({
      variant: "session",
      session: session({ id: "s1" }),
      onnavigate: vi.fn(),
      herd: [session({ id: "s31", desig: "TASK-31" })],
    });
    clientFor("s1").receive("TASK-31 waits on its plan gate");
    await vi.waitFor(() => expect(providers.length).toBeGreaterThan(0));
    await frames();
    expect((await linksOn(1)).map((l) => l.text)).not.toContain("TASK-31");
  });

  it("keeps the touch key bar and an Esc key on a phone, and never swipe-pages", async () => {
    await page.viewport(390, 844);
    const onnavigate = vi.fn();
    const onback = vi.fn();
    const { container } = await mount({
      mobile: true,
      touch: true,
      onnavigate,
      onback,
      switchOrder: ["oa", "s2"],
    });
    expect(container.querySelector(".ctrl-row")).not.toBeNull();
    const c = clientFor("oa");
    c.receive("> ");
    const esc = page.getByRole("button", { name: m.controlkey_escape() });
    await expect.element(esc).toBeVisible();
    const box = esc.element().getBoundingClientRect();
    const input = cdp();
    await input.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.left + box.width / 2, y: box.top + box.height / 2 }],
    });
    await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    expect(escapes(c)).toBe(1);

    const mount_ = container.querySelector(".term-mount")!;
    for (const [type, x] of [
      ["touchstart", 300],
      ["touchmove", 0],
      ["touchend", 0],
    ] as const) {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, "touches", {
        value: type === "touchend" ? [] : [{ clientX: x, clientY: 100 }],
      });
      mount_.dispatchEvent(e);
    }
    expect(onnavigate).not.toHaveBeenCalled();
    expect(onback).not.toHaveBeenCalled();
  });

  it("sends Escape only to the terminal the operator is typing in when both are mounted", async () => {
    const row = document.createElement("div");
    row.style.cssText = "display: flex; height: 600px";
    document.body.append(row);
    const main = await mount({ variant: "session", session: session({ id: "main" }) }, row);
    const helper = await mount({}, row);
    await frames();
    // the session terminal auto-focuses on mount; the assistant beside it left it alone
    const textarea = (root: Element) =>
      root.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
    expect(document.activeElement).toBe(textarea(main.container));
    const [mc, ac] = [clientFor("main"), clientFor("oa")];

    textarea(helper.container).focus();
    await userEvent.keyboard("{Escape}");
    expect([escapes(mc), escapes(ac)]).toEqual([0, 1]);
    // focus drifts to <body>: the assistant was typed in last, so the Escape is still its own
    textarea(helper.container).blur();
    await userEvent.keyboard("{Escape}");
    expect([escapes(mc), escapes(ac)]).toEqual([0, 2]);

    textarea(main.container).focus();
    await userEvent.keyboard("{Escape}");
    textarea(main.container).blur();
    await userEvent.keyboard("{Escape}");
    expect([escapes(mc), escapes(ac)]).toEqual([2, 2]);
  });
});
