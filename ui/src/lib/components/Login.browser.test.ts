import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import Login from "./Login.svelte";
import { m } from "#lib/paraglide/messages.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function respond(status: number, body: unknown) {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

async function submit() {
  await userEvent.fill(page.getByLabelText(m.login_password_label()), "secret");
  await page.getByRole("button", { name: m.login_submit() }).click();
}

describe("Login", () => {
  it("a spent attempt budget (429) says so instead of 'incorrect password' (#2105)", async () => {
    respond(429, { error: "login_rate_limited" });
    render(Login);
    await submit();
    await expect.element(page.getByRole("alert")).toHaveTextContent(m.login_rate_limited());
  });

  it("a wrong password (401) still reads as incorrect", async () => {
    respond(401, { error: "invalid password" });
    render(Login);
    await submit();
    await expect.element(page.getByRole("alert")).toHaveTextContent(m.login_error());
  });
});
