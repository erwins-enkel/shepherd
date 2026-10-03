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
    scope: "full",
    repoPaths: null,
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
  mint?: (body: { name: string; expiresInDays: number | null; scope: string }) => {
    payload: unknown;
    status?: number;
  };
  revokeStatus?: number;
  repoStatus?: number;
  patchStatus?: number;
}) {
  const calls: { url: string; method: string; body: string }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? String(init.body) : "" });
    if (url === "/api/repos")
      return jsonRes(
        {
          repos: [{ name: "alpha", path: "/repos/a", realPath: "/repos/a", display: "/repos/a" }],
          recentWindowDays: 7,
        },
        opts.repoStatus ?? 200,
      );
    if (url.includes("/api/access-tokens")) {
      if (method === "PATCH")
        return jsonRes(
          { entry: token({ repoPaths: JSON.parse(String(init?.body)).repoPaths }) },
          opts.patchStatus ?? 200,
        );
      if (method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          name: string;
          expiresInDays: number | null;
          scope: string;
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
    await page.getByLabelText("All repositories (including future ones)").click();
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
    await page.getByLabelText("All repositories (including future ones)").click();
    await page.getByRole("button", { name: "Create token" }).click();
    await page.getByRole("button", { name: "Copy", exact: true }).click();

    await expect.element(page.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(written).toEqual([secret]);
  });

  it("sends the chosen expiry preset, not the label", async () => {
    const calls = stubApi({ mint: () => ({ payload: { token: "shp_x", entry: token() } }) });
    render(SettingsAccessPanel, { payload: payload(false) });

    await page.getByPlaceholder("Asyar extension — MacBook").fill("cron job");
    await page.getByLabelText("Expires").selectOptions("90");
    await page.getByLabelText("All repositories (including future ones)").click();
    await page.getByRole("button", { name: "Create token" }).click();

    await expect.element(page.getByText("shp_x")).toBeVisible();
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(post!.body)).toEqual({
      name: "cron job",
      expiresInDays: 90,
      scope: "read",
      repoPaths: null,
    });
  });

  // ── scopes (#2083) ───────────────────────────────────────────────────────

  it("mints at the narrowest scope by default — read, not full", async () => {
    // Least privilege is what an operator gets by clicking through. The SERVER defaults an absent
    // scope to `full` for #2082-era callers, so the form must always send its own choice.
    const calls = stubApi({ mint: () => ({ payload: { token: "shp_x", entry: token() } }) });
    render(SettingsAccessPanel, { payload: payload(false) });

    await page.getByPlaceholder("Asyar extension — MacBook").fill("launcher");
    await page.getByLabelText("All repositories (including future ones)").click();
    await page.getByRole("button", { name: "Create token" }).click();

    await expect.element(page.getByText("shp_x")).toBeVisible();
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(post!.body)).toMatchObject({ scope: "read" });
  });

  it("sends the picked scope, and describes it before minting", async () => {
    const calls = stubApi({ mint: () => ({ payload: { token: "shp_x", entry: token() } }) });
    render(SettingsAccessPanel, { payload: payload(false) });

    // The hint tracks the selection, so the consequence is readable before the token exists.
    await expect
      .element(page.getByText(/Cannot start work, and cannot reach a terminal/))
      .toBeVisible();
    await page.getByLabelText("Scope").selectOptions("full");
    await expect.element(page.getByText(/the live terminal included/)).toBeVisible();

    await page.getByPlaceholder("Asyar extension — MacBook").fill("cron");
    await page.getByLabelText("All repositories (including future ones)").click();
    await page.getByRole("button", { name: "Create token" }).click();

    await expect.element(page.getByText("shp_x")).toBeVisible();
    expect(JSON.parse(calls.find((c) => c.method === "POST")!.body)).toMatchObject({
      scope: "full",
    });
  });

  it("shows each token's scope in the list, and offers no way to change it", async () => {
    stubApi({
      tokens: [
        token({ id: "t1", name: "launcher", scope: "read" }),
        token({ id: "t2", name: "capture", scope: "submit" }),
        token({ id: "t3", name: "cron", scope: "full" }),
      ],
    });
    render(SettingsAccessPanel, { payload: payload(false) });

    for (const [name, label] of [
      ["launcher", "Read"],
      ["capture", "Submit"],
      ["cron", "Full"],
    ] as const) {
      await expect.element(page.getByText(name, { exact: true })).toBeVisible();
      // The badge is a read-only micro-label, never a control — a button here would be an
      // editable scope, which the audit story deliberately refuses.
      await expect.element(page.getByRole("button", { name: label })).not.toBeInTheDocument();
    }
    // Three rows, three badges — asserted through the class the rows share.
    expect(document.querySelectorAll(".tokens .scope-badge")).toHaveLength(3);
  });

  it("labels an unrecognized stored scope as unknown with no access", async () => {
    // SQLite can carry a scope outside the declared union; the API preserves it.
    stubApi({ tokens: [token({ scope: "wat" as unknown as AccessToken["scope"] })] });
    render(SettingsAccessPanel, { payload: payload(false) });

    await expect.element(page.getByText("Asyar extension", { exact: true })).toBeVisible();
    const badge = document.querySelector(".tokens .scope-badge");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).not.toBe("Full");
    expect(badge!.textContent).toBe("Unknown — no access");
  });

  it("colours a full-scope badge apart from a narrower one", async () => {
    // Regression lock for a CSS-ordering trap: `.badge` and `.scope-badge` are both single-class
    // selectors, so only source order separates them. With `.scope-badge` above `.badge`, every
    // scope inherits `.badge`'s amber and the column stops distinguishing anything — while still
    // rendering, still passing every other assertion here.
    stubApi({
      tokens: [
        token({ id: "t1", name: "launcher", scope: "read" }),
        token({ id: "t2", name: "cron", scope: "full" }),
      ],
    });
    render(SettingsAccessPanel, { payload: payload(false) });
    await expect.element(page.getByText("launcher", { exact: true })).toBeVisible();

    const badges = [...document.querySelectorAll(".tokens .scope-badge")];
    expect(badges).toHaveLength(2);
    const colour = (el: Element) => getComputedStyle(el).color;
    expect(colour(badges[0]!)).not.toBe(colour(badges[1]!));
  });

  it("surfaces a mint failure instead of a fake reveal card", async () => {
    stubApi({ mint: () => ({ payload: { error: "nope" }, status: 400 }) });
    render(SettingsAccessPanel, { payload: payload(false) });

    await page.getByPlaceholder("Asyar extension — MacBook").fill("bad");
    await page.getByLabelText("All repositories (including future ones)").click();
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

describe("repository grants and agent instructions", () => {
  it("requires a deliberate grant and sends selected repositories", async () => {
    const calls = stubApi({
      mint: () => ({
        payload: {
          token: "shp_selected",
          entry: token({ repoPaths: ["/repos/a"], scope: "submit" }),
        },
      }),
    });
    render(SettingsAccessPanel, { payload: payload(false) });
    await page.getByPlaceholder("Asyar extension — MacBook").fill("remote");
    await expect.element(page.getByRole("button", { name: "Create token" })).toBeDisabled();
    await page.getByLabelText("alpha /repos/a").click();
    await page.getByLabelText("Scope").selectOptions("submit");
    await page.getByRole("button", { name: "Create token" }).click();
    await expect.element(page.getByText("shp_selected", { exact: true })).toBeVisible();
    expect(JSON.parse(calls.find((c) => c.method === "POST")!.body)).toMatchObject({
      repoPaths: ["/repos/a"],
      scope: "submit",
    });
  });

  it("edits repositories on the existing token and preserves the form on failure", async () => {
    const calls = stubApi({ tokens: [token()], patchStatus: 500 });
    render(SettingsAccessPanel, { payload: payload(false) });
    await page.getByRole("button", { name: "Edit repositories" }).click();
    const editor = page.getByRole("group", { name: "Repositories for Asyar extension" });
    await editor.getByLabelText("Selected repositories").click();
    await editor.getByLabelText("alpha /repos/a").click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .element(page.getByText("Could not save repository access. Try again."))
      .toBeVisible();
    await expect.element(editor.getByLabelText("alpha /repos/a")).toBeChecked();
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body)).toEqual({
      repoPaths: ["/repos/a"],
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.element(editor).not.toBeInTheDocument();
  });

  it("copies minted permissions after the form resets and provides a selectable fallback", async () => {
    const written = stubClipboard();
    stubApi({
      mint: () => ({
        payload: {
          token: "shp_instructions",
          entry: token({ scope: "full", repoPaths: ["/repos/a"] }),
        },
      }),
    });
    render(SettingsAccessPanel, { payload: payload(false) });
    await page.getByPlaceholder("Asyar extension — MacBook").fill("remote");
    await page.getByLabelText("alpha /repos/a").click();
    await page.getByLabelText("Scope").selectOptions("full");
    await page.getByRole("button", { name: "Create token" }).click();
    await page.getByLabelText("Shepherd server address").fill("https://shepherd.example.ts.net");
    await page.getByRole("button", { name: "Copy agent instructions" }).click();
    expect(written[0]).toContain("shp_instructions");
    expect(written[0]).toContain('"repoPaths": [');
    expect(written[0]).toContain("/reply");
    expect(written[0]).toContain("/repos/a");
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    await page.getByRole("button", { name: "Instructions copied" }).click();
    await expect
      .element(page.getByText("Clipboard unavailable. Select and copy the text below."))
      .toBeVisible();
    await expect.element(page.getByLabelText("Agent instructions")).toBeVisible();
    await page.getByRole("button", { name: "Got it" }).click();
    await expect.element(page.getByLabelText("Agent instructions")).not.toBeInTheDocument();
  });

  it("removes every grant and updates an open instruction preview without losing the token", async () => {
    const calls = stubApi({
      mint: () => ({ payload: { token: "shp_edit", entry: token({ repoPaths: ["/repos/a"] }) } }),
    });
    render(SettingsAccessPanel, { payload: payload(false) });
    await page.getByPlaceholder("Asyar extension — MacBook").fill("remote");
    await page.getByLabelText("alpha /repos/a").click();
    await page.getByRole("button", { name: "Create token" }).click();
    await page.getByLabelText("Shepherd server address").fill("https://shepherd.example.ts.net");
    await page.getByRole("button", { name: "Edit repositories" }).click();
    const editor = page.getByRole("group", { name: "Repositories for Asyar extension" });
    await editor.getByLabelText("alpha /repos/a").click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.element(page.getByText("No repository access", { exact: true })).toBeVisible();
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body)).toEqual({ repoPaths: [] });
    await page.getByText("Preview and copy manually", { exact: true }).click();
    await expect
      .element(page.getByLabelText("Agent instructions"))
      .toHaveValue(expect.stringContaining('"repoPaths": []'));
    await expect.element(page.getByText("shp_edit", { exact: true })).toBeVisible();
  });

  it("does not turn a failed repository load into an unrestricted grant", async () => {
    stubApi({ repoStatus: 500 });
    render(SettingsAccessPanel, { payload: payload(false) });
    await page.getByPlaceholder("Asyar extension — MacBook").fill("remote");
    await expect.element(page.getByText("Could not load repositories.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Create token" })).toBeDisabled();
  });
});

for (const theme of ["dark", "light"]) {
  it(`keeps repository access and the reveal within a narrow ${theme} viewport`, async () => {
    await page.viewport(390, 844);
    document.documentElement.dataset.theme = theme;
    try {
      stubApi({
        mint: () => ({
          payload: {
            token: "shp_preview_only",
            entry: token({ repoPaths: ["/repos/" + "a".repeat(100)] }),
          },
        }),
      });
      render(SettingsAccessPanel, { payload: payload(false) });
      await page.getByPlaceholder("Asyar extension — MacBook").fill("remote");
      await page.getByLabelText("alpha /repos/a").click();
      await page.getByRole("button", { name: "Create token" }).click();
      await page.getByLabelText("Shepherd server address").fill("https://shepherd.example.ts.net");
      await page.getByText("Preview and copy manually", { exact: true }).click();
      await expect.element(page.getByLabelText("Agent instructions")).toBeVisible();
      for (const selector of [".reveal", ".tok", ".instruction-text", ".repo-field"]) {
        for (const el of document.querySelectorAll<HTMLElement>(selector)) {
          expect(el.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
          expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth + 1);
        }
      }
    } finally {
      delete document.documentElement.dataset.theme;
      await page.viewport(1280, 900);
    }
  });
}
