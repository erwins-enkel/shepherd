import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import SettingsAccessPanel from "./SettingsAccessPanel.svelte";
import type { AccessToken, Settings } from "$lib/types";

const DAY = 24 * 60 * 60 * 1000;

function token(over: Partial<AccessToken> = {}): AccessToken {
  return {
    id: "t1",
    name: "Asyar extension",
    hint: "a9Fz",
    createdAt: Date.now() - DAY,
    lastUsedAt: null,
    expiresAt: null,
    ...over,
  };
}

/** Only `envTokenActive` is read by this panel; the rest of Settings is irrelevant here. */
const payload = (envTokenActive: boolean) => ({ envTokenActive }) as Settings;

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Stub the three routes the panel talks to. `mint` receives the parsed POST body and returns the
 * payload (plus an optional status) that `POST /api/access-tokens` would answer with.
 */
function stubApi(opts: {
  tokens?: AccessToken[];
  listStatus?: number;
  mint?: (body: { name: string; expiresInDays: number | null }) => {
    payload: unknown;
    status?: number;
  };
  revokeStatus?: number;
}) {
  const calls: { url: string; method: string; body: string }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? String(init.body) : "" });
    if (url.includes("/api/access-tokens")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          name: string;
          expiresInDays: number | null;
        };
        const mint = opts.mint ?? (() => ({ payload: {}, status: 201 }));
        const { payload: p, status = 201 } = mint(body);
        return jsonRes(p, status);
      }
      if (method === "DELETE") {
        const status = opts.revokeStatus ?? 200;
        return jsonRes(status === 200 ? { ok: true } : { error: "nope" }, status);
      }
      return jsonRes({ tokens: opts.tokens ?? [] }, opts.listStatus ?? 200);
    }
    return jsonRes({}, 404);
  });
  return calls;
}

/** Clipboard is unavailable in the test browser context — stub it so `copy()` resolves. */
function stubClipboard(): string[] {
  const written: string[] = [];
  vi.stubGlobal("navigator", {
    ...navigator,
    clipboard: {
      writeText: async (text: string) => {
        written.push(text);
      },
    },
  });
  return written;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SettingsAccessPanel", () => {
  it("reports whether an env-provisioned SHEPHERD_TOKEN is active", async () => {
    stubApi({});
    render(SettingsAccessPanel, { payload: payload(true) });
    await expect.element(page.getByText(/Active — provisioned by SHEPHERD_TOKEN/)).toBeVisible();
  });

  it("says so when no env token is set", async () => {
    stubApi({});
    render(SettingsAccessPanel, { payload: payload(false) });
    await expect.element(page.getByText(/SHEPHERD_TOKEN is empty/)).toBeVisible();
  });

  it("shows the empty state when there are no tokens", async () => {
    stubApi({ tokens: [] });
    render(SettingsAccessPanel, { payload: payload(false) });
    await expect.element(page.getByText("No tokens yet.")).toBeVisible();
  });

  it("lists a token by name and masked hint, never a full value", async () => {
    stubApi({ tokens: [token()] });
    render(SettingsAccessPanel, { payload: payload(false) });
    await expect.element(page.getByText("Asyar extension")).toBeVisible();
    await expect.element(page.getByText("shp_…a9Fz")).toBeVisible();
    await expect.element(page.getByText("Never used")).toBeVisible();
    await expect.element(page.getByText("Never expires")).toBeVisible();
  });

  it("badges an expired token and keeps its row", async () => {
    stubApi({ tokens: [token({ expiresAt: Date.now() - DAY })] });
    render(SettingsAccessPanel, { payload: payload(false) });
    await expect.element(page.getByText("Asyar extension")).toBeVisible();
    await expect.element(page.getByText("Expired")).toBeVisible();
  });

  it("shows the plaintext once after minting, then clears it on dismiss", async () => {
    const secret = "shp_a-freshly-minted-secret";
    stubApi({
      tokens: [],
      mint: () => ({ payload: { token: secret, entry: token({ name: "Raycast" }) } }),
    });
    render(SettingsAccessPanel, { payload: payload(false) });

    await page.getByPlaceholder("Asyar extension — MacBook").fill("Raycast");
    await page.getByRole("button", { name: "Create token" }).click();

    await expect.element(page.getByText(secret)).toBeVisible();
    await page.getByRole("button", { name: "Got it" }).click();
    // Gone from the DOM entirely — it is not recoverable, by design.
    await expect.element(page.getByText(secret)).not.toBeInTheDocument();
  });

  it("copies the plaintext to the clipboard", async () => {
    const secret = "shp_copy-me";
    const written = stubClipboard();
    stubApi({ mint: () => ({ payload: { token: secret, entry: token() } }) });
    render(SettingsAccessPanel, { payload: payload(false) });

    await page.getByPlaceholder("Asyar extension — MacBook").fill("Asyar");
    await page.getByRole("button", { name: "Create token" }).click();
    await page.getByRole("button", { name: "Copy" }).click();

    await expect.element(page.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(written).toEqual([secret]);
  });

  it("sends the chosen expiry preset, not the label", async () => {
    const calls = stubApi({ mint: () => ({ payload: { token: "shp_x", entry: token() } }) });
    render(SettingsAccessPanel, { payload: payload(false) });

    await page.getByPlaceholder("Asyar extension — MacBook").fill("cron job");
    await page.getByRole("combobox").selectOptions("90");
    await page.getByRole("button", { name: "Create token" }).click();

    await expect.element(page.getByText("shp_x")).toBeVisible();
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(post!.body)).toEqual({ name: "cron job", expiresInDays: 90 });
  });

  it("surfaces a mint failure instead of a fake reveal card", async () => {
    stubApi({ mint: () => ({ payload: { error: "nope" }, status: 400 }) });
    render(SettingsAccessPanel, { payload: payload(false) });

    await page.getByPlaceholder("Asyar extension — MacBook").fill("bad");
    await page.getByRole("button", { name: "Create token" }).click();

    await expect.element(page.getByText("Could not create the token. Try again.")).toBeVisible();
    await expect.element(page.getByText("Copy it now — shown once")).not.toBeInTheDocument();
  });

  it("revoking asks for confirmation, then drops the row", async () => {
    const calls = stubApi({ tokens: [token()] });
    render(SettingsAccessPanel, { payload: payload(false) });

    await page.getByRole("button", { name: "Revoke the token “Asyar extension”" }).click();
    await page.getByRole("button", { name: "Revoke it" }).click();

    await expect.element(page.getByText("No tokens yet.")).toBeVisible();
    expect(
      calls.some((c) => c.method === "DELETE" && c.url.endsWith("/api/access-tokens/t1")),
    ).toBe(true);
  });

  it("cancelling the confirm leaves the token alone", async () => {
    const calls = stubApi({ tokens: [token()] });
    render(SettingsAccessPanel, { payload: payload(false) });

    await page.getByRole("button", { name: "Revoke the token “Asyar extension”" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();

    await expect.element(page.getByText("Asyar extension")).toBeVisible();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("a failed revoke keeps the row and says so", async () => {
    stubApi({ tokens: [token()], revokeStatus: 500 });
    render(SettingsAccessPanel, { payload: payload(false) });

    await page.getByRole("button", { name: "Revoke the token “Asyar extension”" }).click();
    await page.getByRole("button", { name: "Revoke it" }).click();

    await expect.element(page.getByText("Could not revoke the token. Try again.")).toBeVisible();
    await expect.element(page.getByText("Asyar extension")).toBeVisible();
  });

  it("offers a retry when the list fails to load", async () => {
    stubApi({ listStatus: 500 });
    render(SettingsAccessPanel, { payload: payload(false) });
    await expect.element(page.getByText("Could not load the tokens.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});
