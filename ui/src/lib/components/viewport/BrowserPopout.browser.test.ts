import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import type { LoginRequest, Session } from "$lib/types";

const listSessions = vi.fn<() => Promise<Session[]>>();
const loginRequestStates = vi.fn<() => Promise<Record<string, LoginRequest>>>();
const resolveLoginRequest = vi.fn<() => Promise<void>>();
vi.mock("$lib/api", async (orig) => ({
  ...(await orig<typeof import("$lib/api")>()),
  listSessions: () => listSessions(),
  loginRequestStates: () => loginRequestStates(),
  resolveLoginRequest: () => resolveLoginRequest(),
}));

const { default: BrowserPopout } = await import("./BrowserPopout.svelte");

class FakeWs {
  static views: FakeWs[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public path = "/events") {}
  send() {}
  close() {}
}
const makeEventsWs = () => new FakeWs() as unknown as WebSocket;
const makeWs = (p: string) => {
  const ws = new FakeWs(p);
  FakeWs.views.push(ws);
  return ws as unknown as WebSocket;
};

const session = { id: "s1", name: "login task", repoPath: "/r/a" } as Session;

afterEach(() => {
  document.body.innerHTML = "";
  FakeWs.views = [];
  listSessions.mockReset();
  loginRequestStates.mockReset();
});

describe("BrowserPopout", () => {
  it("mounts the session's Browser View without the Pop out button, with its login request", async () => {
    listSessions.mockResolvedValue([session]);
    loginRequestStates.mockResolvedValue({
      s1: { id: "r1", url: "https://login.example/", reason: "need the dashboard", createdAt: 0 },
    } as unknown as Record<string, LoginRequest>);
    render(BrowserPopout, { sessionId: "s1", makeEventsWs, makeWs });
    await expect.element(page.getByText("need the dashboard")).toBeVisible();
    expect(FakeWs.views.map((w) => w.path)).toEqual(["/browser-view/s1"]);
    expect(page.getByRole("button", { name: /pop out/i }).elements()).toHaveLength(0);
    await vi.waitFor(() => expect(document.title).toBe("Browser · login task"));
  });

  it("shows a failed Login Request answer as a toast (the pop-out has no HUD)", async () => {
    listSessions.mockResolvedValue([session]);
    loginRequestStates.mockResolvedValue({
      s1: { id: "r1", url: "https://login.example/", reason: "need it", createdAt: 0 },
    } as unknown as Record<string, LoginRequest>);
    resolveLoginRequest.mockRejectedValue(new Error("offline"));
    render(BrowserPopout, { sessionId: "s1", makeEventsWs, makeWs });
    await page.getByRole("button", { name: /^done$/i }).click();
    await expect.element(page.getByText(/couldn't send your answer/i)).toBeVisible();
  });

  it("an unknown session shows not-found and opens no view", async () => {
    listSessions.mockResolvedValue([session]);
    loginRequestStates.mockResolvedValue({});
    render(BrowserPopout, { sessionId: "gone", makeEventsWs, makeWs });
    await expect.element(page.getByText(/has ended or has no browser view/i)).toBeVisible();
    expect(FakeWs.views).toHaveLength(0);
  });
});
