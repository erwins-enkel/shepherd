import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../../app.css";
import type { Session } from "$lib/types";

const openRepoBrowser = vi.fn().mockResolvedValue({ ok: true, url: "about:blank" });
vi.mock("$lib/api", async (orig) => ({
  ...(await orig<typeof import("$lib/api")>()),
  openRepoBrowser: (...a: unknown[]) => openRepoBrowser(...a),
}));

const { default: BrowserPanel } = await import("./BrowserPanel.svelte");

// A real (tiny) JPEG, so the <img> load — which triggers the ack — actually fires.
function jpeg(): string {
  const c = document.createElement("canvas");
  c.width = c.height = 4;
  return c.toDataURL("image/jpeg").split(",")[1]!;
}

class FakeWs {
  static last: FakeWs;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(public path: string) {
    FakeWs.last = this;
  }
  send(t: string) {
    this.sent.push(JSON.parse(t));
  }
  close() {}
  push(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  sentOf(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

const session = { id: "s1", repoPath: "/r/a" } as Session;
const makeWs = (p: string) => new FakeWs(p) as unknown as WebSocket;
const targets = (selected: string | null = "T1") => ({
  type: "targets",
  targets: [
    { id: "T1", title: "App", url: "http://localhost:5173/" },
    { id: "T2", title: "", url: "https://login.example/" },
  ],
  selected,
});

afterEach(() => {
  document.body.innerHTML = "";
  openRepoBrowser.mockClear();
});

describe("BrowserPanel", () => {
  it("connects to the session's view socket and shows connecting until tabs arrive", async () => {
    render(BrowserPanel, { session, makeWs });
    expect(FakeWs.last.path).toBe("/browser-view/s1");
    await expect.element(page.getByText(/connecting/i)).toBeVisible();
  });

  it("draws frames and acks each once painted", async () => {
    render(BrowserPanel, { session, makeWs });
    const ws = FakeWs.last;
    ws.push(targets());
    ws.push({ type: "frame", data: jpeg(), width: 1280, height: 720 });
    await vi.waitFor(() => expect(ws.sentOf("frameAck")).toHaveLength(1));
    expect(document.querySelector("img.bv-frame")).not.toBeNull();
    await expect
      .element(page.getByRole("textbox", { name: /address/i }))
      .toHaveValue("http://localhost:5173/");
  });

  it("acks an identical repeat frame and an undecodable one, so the stream never stalls", async () => {
    render(BrowserPanel, { session, makeWs });
    const ws = FakeWs.last;
    ws.push(targets());
    const data = jpeg();
    ws.push({ type: "frame", data, width: 1280, height: 720 });
    await vi.waitFor(() => expect(ws.sentOf("frameAck")).toHaveLength(1));
    ws.push({ type: "frame", data, width: 1280, height: 720 });
    await vi.waitFor(() => expect(ws.sentOf("frameAck")).toHaveLength(2));
    ws.push({ type: "frame", data: "bm90LWEtanBlZw==", width: 1280, height: 720 });
    await vi.waitFor(() => expect(ws.sentOf("frameAck")).toHaveLength(3));
  });

  it("sends pasted text and clears the field", async () => {
    render(BrowserPanel, { session, makeWs });
    const ws = FakeWs.last;
    ws.push(targets());
    const field = page.getByLabelText(/^paste$/i);
    await field.fill("hunter2");
    await page.getByRole("button", { name: /send/i }).click();
    expect(ws.sentOf("text")).toEqual([{ type: "text", text: "hunter2" }]);
    await expect.element(field).toHaveValue("");
  });

  it("keys typed into the view go to the page, not the HUD's shortcuts", async () => {
    render(BrowserPanel, { session, makeWs });
    const ws = FakeWs.last;
    ws.push(targets());
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    try {
      const surface = page.getByRole("application");
      await surface.click();
      await userEvent.keyboard("n");
      expect(ws.sentOf("key")).toEqual(
        expect.arrayContaining([expect.objectContaining({ action: "down", key: "n", text: "n" })]),
      );
      expect(onWindowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });

  it("switches tabs from the picker", async () => {
    render(BrowserPanel, { session, makeWs });
    const ws = FakeWs.last;
    ws.push(targets());
    await page.getByRole("combobox", { name: /browser tab/i }).selectOptions("T2");
    expect(ws.sentOf("select")).toEqual([{ type: "select", targetId: "T2" }]);
  });

  it("navigates to http(s) only", async () => {
    render(BrowserPanel, { session, makeWs });
    const ws = FakeWs.last;
    ws.push(targets());
    const address = page.getByRole("textbox", { name: /address/i });
    await address.fill("file:///etc/passwd");
    await page.getByRole("button", { name: /^go$/i }).click();
    expect(ws.sentOf("navigate")).toHaveLength(0);
    await expect.element(page.getByText(/only http\(s\)/i)).toBeVisible();
    await address.fill("localhost:3000/login");
    await page.getByRole("button", { name: /^go$/i }).click();
    expect(ws.sentOf("navigate")).toEqual([
      { type: "navigate", url: "http://localhost:3000/login" },
    ]);
  });

  it("no tab: offers Open tab for this session", async () => {
    render(BrowserPanel, { session, makeWs });
    FakeWs.last.push({ type: "targets", targets: [], selected: null });
    await expect.element(page.getByText(/no tab is open/i)).toBeVisible();
    await page
      .getByRole("button", { name: /open tab/i })
      .last()
      .click();
    expect(openRepoBrowser).toHaveBeenCalledWith("/r/a", "s1");
  });

  it("closed: explains the cap and reconnects on demand", async () => {
    render(BrowserPanel, { session, makeWs });
    const first = FakeWs.last;
    first.push(targets());
    first.onclose?.({ code: 1013, reason: "cap" });
    await expect.element(page.getByText(/too many shared browsers/i)).toBeVisible();
    await page.getByRole("button", { name: /reconnect/i }).click();
    expect(FakeWs.last).not.toBe(first);
    await expect.element(page.getByText(/connecting/i)).toBeVisible();
  });
});
