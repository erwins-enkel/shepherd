import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { ApiError, deleteRepoSecret, listRepoSecrets, putRepoSecret } from "#lib/api.js";
import { m } from "#lib/paraglide/messages.js";
import { toasts } from "#lib/toasts.svelte.js";
import type { RepoSecret } from "#lib/types.js";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    listRepoSecrets: vi.fn(),
    putRepoSecret: vi.fn(),
    deleteRepoSecret: vi.fn(),
  };
});

const { default: AgentSecrets } = await import("./AgentSecrets.svelte");
const mockList = vi.mocked(listRepoSecrets);
const mockPut = vi.mocked(putRepoSecret);
const mockDelete = vi.mocked(deleteRepoSecret);

const REPO = "/repo/secrets";
const SECRET_VALUE = "ghp_superSecretValue123";

let stored: RepoSecret[] = [];

const nameInput = () => page.getByRole("textbox", { name: m.automation_secrets_name_label() });
const valueInput = () =>
  document.querySelector<HTMLInputElement>(
    `input[aria-label="${m.automation_secrets_value_label()}"]`,
  )!;
const addSave = () =>
  page
    .getByRole("form", { name: m.automation_secrets_add_label() })
    .getByRole("button", { name: m.automation_secrets_save() });

/** No input value, attribute or text node anywhere in the document carries the secret. */
function domHoldsValue(): boolean {
  if (document.body.outerHTML.includes(SECRET_VALUE)) return true;
  return [...document.querySelectorAll("input")].some((i) => i.value.includes(SECRET_VALUE));
}

beforeEach(() => {
  stored = [
    { name: "GITHUB_PACKAGES_TOKEN", updatedAt: Date.now() - 3_600_000, lastInjectedAt: null },
    { name: "NPM_TOKEN", updatedAt: Date.now() - 60_000, lastInjectedAt: Date.now() - 30_000 },
  ];
  mockList.mockReset();
  mockPut.mockReset();
  mockDelete.mockReset();
  mockList.mockImplementation(async () => stored.map((s) => ({ ...s })));
  mockPut.mockImplementation(async (_repo, name) => {
    const updatedAt = Date.now();
    stored = [...stored.filter((s) => s.name !== name), { name, updatedAt, lastInjectedAt: null }];
    return { name, updatedAt };
  });
  mockDelete.mockImplementation(async (_repo, name) => {
    stored = stored.filter((s) => s.name !== name);
    return { deleted: true };
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AgentSecrets", () => {
  it("lists names with their timestamps, never values", async () => {
    render(AgentSecrets, { repoPath: REPO });
    await expect.element(page.getByText("GITHUB_PACKAGES_TOKEN", { exact: true })).toBeVisible();
    await expect.element(page.getByText("NPM_TOKEN", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText(m.automation_secrets_never_injected(), { exact: false }))
      .toBeVisible();
    expect(mockList).toHaveBeenCalledWith(REPO);
  });

  it("shows the empty note when the repo has none", async () => {
    stored = [];
    render(AgentSecrets, { repoPath: REPO });
    await expect.element(page.getByText(m.automation_secrets_empty())).toBeVisible();
  });

  it("adds a secret, clears both inputs and keeps the value out of the DOM", async () => {
    render(AgentSecrets, { repoPath: REPO });
    await nameInput().fill("MY_TOKEN");
    await page.elementLocator(valueInput()).fill(SECRET_VALUE);
    expect(valueInput().type).toBe("password");
    expect(valueInput().autocomplete).toBe("off");
    await addSave().click();

    expect(mockPut).toHaveBeenCalledWith(REPO, "MY_TOKEN", SECRET_VALUE);
    await expect.element(page.getByText("MY_TOKEN", { exact: true })).toBeVisible();
    await expect.element(nameInput()).toHaveValue("");
    expect(valueInput().value).toBe("");
    expect(domHoldsValue()).toBe(false);
  });

  it("refuses an invalid or existing name client-side", async () => {
    render(AgentSecrets, { repoPath: REPO });
    await nameInput().fill("1BAD-NAME");
    await page.elementLocator(valueInput()).fill(SECRET_VALUE);
    await addSave().click();
    await expect.element(page.getByText(m.automation_secrets_err_name())).toBeVisible();

    await nameInput().fill("NPM_TOKEN");
    await addSave().click();
    await expect.element(page.getByText(m.automation_secrets_err_exists())).toBeVisible();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("toasts the server's refusal and keeps the inputs", async () => {
    mockPut.mockRejectedValue(new ApiError(400, "reserved-name", "reserved-name", true));
    const toast = vi.spyOn(toasts, "info");
    render(AgentSecrets, { repoPath: REPO });
    await nameInput().fill("CLAUDE_X");
    await page.elementLocator(valueInput()).fill(SECRET_VALUE);
    await addSave().click();
    await expect
      .poll(() => toast.mock.calls.at(-1))
      .toEqual([m.automation_secrets_err_reserved({ name: "CLAUDE_X" }), { alert: true }]);
    toast.mockRestore();
    await expect.element(nameInput()).toHaveValue("CLAUDE_X");
  });

  it("replaces a value inline and clears it after saving", async () => {
    render(AgentSecrets, { repoPath: REPO });
    await page
      .getByRole("button", { name: m.automation_secrets_replace_name({ name: "NPM_TOKEN" }) })
      .click();
    const input = page.getByLabelText(m.automation_secrets_replace_value({ name: "NPM_TOKEN" }));
    expect((input.element() as HTMLInputElement).type).toBe("password");
    await input.fill(SECRET_VALUE);
    await page
      .getByRole("form", { name: m.automation_secrets_replace_name({ name: "NPM_TOKEN" }) })
      .getByRole("button", { name: m.automation_secrets_save() })
      .click();

    expect(mockPut).toHaveBeenCalledWith(REPO, "NPM_TOKEN", SECRET_VALUE);
    await expect.element(input).not.toBeInTheDocument();
    expect(domHoldsValue()).toBe(false);
  });

  it("deletes only after the inline confirm; Cancel writes nothing", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    render(AgentSecrets, { repoPath: REPO });
    const del = page.getByRole("button", {
      name: m.automation_secrets_delete_name({ name: "NPM_TOKEN" }),
    });

    await del.click();
    await expect
      .element(page.getByText(m.automation_secrets_delete_confirm({ name: "NPM_TOKEN" })))
      .toBeVisible();
    await page.getByRole("button", { name: m.common_cancel() }).click();
    expect(mockDelete).not.toHaveBeenCalled();

    await del.click();
    await page.getByRole("button", { name: m.automation_secrets_delete_yes() }).click();
    expect(mockDelete).toHaveBeenCalledWith(REPO, "NPM_TOKEN");
    await expect.element(page.getByText("NPM_TOKEN", { exact: true })).not.toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("shows the egress hint only on Autonomous", async () => {
    const view = await render(AgentSecrets, { repoPath: REPO, autonomous: false });
    await expect.element(page.getByText("NPM_TOKEN", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain(m.automation_secrets_egress_hint());
    await view.unmount();
    render(AgentSecrets, { repoPath: REPO, autonomous: true });
    await expect.element(page.getByText(m.automation_secrets_egress_hint())).toBeVisible();
  });
});
