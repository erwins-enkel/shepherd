import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { m } from "$lib/paraglide/messages";
import type { ApnsStatus, PushDevice } from "$lib/types";
import {
  ApiError,
  getApnsConfig,
  putApnsConfig,
  listPushDevices,
  testPushDevice,
  deletePushDevice,
  updatePushDevice,
} from "$lib/api";

vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    getApnsConfig: vi.fn(),
    putApnsConfig: vi.fn(),
    deleteApnsConfig: vi.fn(),
    listPushDevices: vi.fn(),
    updatePushDevice: vi.fn(async (_id, categories) => ({ categories })),
    deletePushDevice: vi.fn(async () => {}),
    testPushDevice: vi.fn(),
  };
});

// No navigator.serviceWorker in these tests: this browser reads as unsupported.
vi.mock("$lib/push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/push")>();
  return {
    ...actual,
    pushState: vi.fn(async () => ({
      supported: false,
      permission: "unsupported" as const,
      subscribed: false,
    })),
    currentDeviceId: vi.fn(async () => null),
  };
});

const { default: Panel } = await import("./SettingsNotificationsPanel.svelte");

function status(over: Partial<ApnsStatus> = {}): ApnsStatus {
  return {
    state: "unconfigured",
    hasKey: false,
    keyId: null,
    teamId: null,
    topic: "run.shepherd.ios",
    keySavedAt: null,
    env: { key: false, keyId: false, teamId: false, topic: false },
    keyError: null,
    lastError: null,
    lastDeliveredAt: null,
    ...over,
  };
}

const iphone: PushDevice = {
  id: "0123456789abcdef",
  kind: "ios",
  environment: "production",
  userAgent: "Shepherd/1 CFNetwork Darwin",
  locale: "de",
  createdAt: 1_700_000_000_000,
  registeredAt: 1_700_000_000_000,
  categories: { agent: true, reviews: true, ci: true },
};

const PEM = "-----BEGIN PRIVATE KEY-----\nMIGH\n-----END PRIVATE KEY-----";

beforeEach(() => {
  vi.mocked(getApnsConfig).mockResolvedValue(status());
  vi.mocked(listPushDevices).mockResolvedValue({ devices: [] });
});
afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

const switchEl = () => page.getByRole("switch", { name: m.settings_reduced_push_title() });

describe("SettingsNotificationsPanel reduced-notifications switch", () => {
  it("reflects reducedPushMode", async () => {
    render(Panel, { reducedPushMode: true });
    await expect.element(switchEl()).toHaveAttribute("aria-checked", "true");
  });

  it("calls onToggleReducedPush when clicked", async () => {
    const spy = vi.fn();
    render(Panel, { reducedPushMode: false, onToggleReducedPush: spy });
    await switchEl().click();
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe("SettingsNotificationsPanel iOS push setup", () => {
  it("prefills the key ID from the AuthKey file name and shows a refusal in plain words", async () => {
    vi.mocked(putApnsConfig).mockResolvedValue({ error: "team_id_invalid", field: "teamId" });
    render(Panel, {});
    await expect
      .element(page.getByText(m.settings_notify_state_unconfigured()))
      .toBeInTheDocument();

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const dt = new DataTransfer();
    dt.items.add(new File([PEM], "AuthKey_ABC1234567.p8", { type: "text/plain" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const keyId = page.getByRole("textbox", { name: m.settings_notify_key_id_label() });
    await expect.element(keyId).toHaveValue("ABC1234567");
    await expect
      .element(page.getByText(m.settings_notify_file_loaded({ name: "AuthKey_ABC1234567.p8" })))
      .toBeInTheDocument();

    await page.getByRole("textbox", { name: m.settings_notify_team_id_label() }).fill("x");
    await page.getByRole("button", { name: m.settings_notify_save() }).click();
    expect(putApnsConfig).toHaveBeenCalledWith({
      key: PEM,
      keyId: "ABC1234567",
      teamId: "x",
      topic: "",
    });
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(m.settings_notify_err_team_id());
  });

  it("after saving shows only that a key is on file, never the key", async () => {
    vi.mocked(putApnsConfig).mockResolvedValue(
      status({
        state: "configured",
        hasKey: true,
        keyId: "ABC1234567",
        teamId: "TEAM123456",
        keySavedAt: 1_700_000_000_000,
      }),
    );
    render(Panel, {});
    await page.getByRole("textbox", { name: m.settings_notify_paste_label() }).fill(PEM);
    await page.getByRole("textbox", { name: m.settings_notify_key_id_label() }).fill("ABC1234567");
    await page.getByRole("textbox", { name: m.settings_notify_team_id_label() }).fill("TEAM123456");
    await page.getByRole("button", { name: m.settings_notify_save() }).click();

    await expect.element(page.getByText(m.settings_notify_state_configured())).toBeInTheDocument();
    await expect.element(page.getByText("TEAM123456")).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: m.settings_notify_remove() }))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toContain("BEGIN PRIVATE KEY");
  });

  it("locks fields the environment sets and does not send them", async () => {
    vi.mocked(getApnsConfig).mockResolvedValue(
      status({ hasKey: true, env: { key: true, keyId: false, teamId: true, topic: false } }),
    );
    vi.mocked(putApnsConfig).mockResolvedValue(status({ state: "configured", hasKey: true }));
    render(Panel, {});
    await page.getByRole("button", { name: m.settings_notify_replace() }).click();
    await expect
      .element(page.getByText(m.settings_notify_env_locked({ name: "SHEPHERD_APNS_KEY" })))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("textbox", { name: m.settings_notify_team_id_label() }))
      .toBeDisabled();
    await page.getByRole("textbox", { name: m.settings_notify_key_id_label() }).fill("KEY1234567");
    await page.getByRole("button", { name: m.settings_notify_save() }).click();
    expect(putApnsConfig).toHaveBeenCalledWith({ keyId: "KEY1234567", topic: "" });
  });

  it("names the last APNs refusal", async () => {
    vi.mocked(getApnsConfig).mockResolvedValue(
      status({
        state: "error",
        hasKey: true,
        keySavedAt: 1,
        lastError: { status: 403, reason: "InvalidProviderToken", at: 1_700_000_000_000 },
      }),
    );
    render(Panel, {});
    await expect.element(page.getByText(/InvalidProviderToken/)).toBeInTheDocument();
    await expect.element(page.getByText(m.settings_notify_state_error())).toBeInTheDocument();
  });

  it("says an operator login is needed when the server refuses a token", async () => {
    vi.mocked(getApnsConfig).mockRejectedValue(new ApiError(403, "operator_session_required"));
    render(Panel, {});
    await expect.element(page.getByText(m.settings_notify_session_required())).toBeInTheDocument();
  });
});

describe("SettingsNotificationsPanel devices", () => {
  it("lists a device, edits its categories, tests it and removes it", async () => {
    vi.mocked(listPushDevices).mockResolvedValue({ devices: [iphone] });
    vi.mocked(testPushDevice).mockResolvedValue({
      delivered: false,
      status: 400,
      reason: "BadDeviceToken",
    });
    render(Panel, {});
    await expect
      .element(page.getByText(m.settings_notify_kind_ios(), { exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByText(m.settings_notify_env_production())).toBeInTheDocument();

    await page.getByRole("checkbox", { name: m.settings_push_cat_ci() }).click();
    expect(updatePushDevice).toHaveBeenCalledWith(iphone.id, {
      agent: true,
      reviews: true,
      ci: false,
    });

    await page.getByRole("button", { name: m.settings_notify_test() }).click();
    expect(testPushDevice).toHaveBeenCalledWith(iphone.id);
    await expect
      .element(page.getByText(m.settings_notify_test_refused({ reason: "BadDeviceToken" })))
      .toBeInTheDocument();

    await page
      .getByRole("button", {
        name: m.settings_notify_device_remove_aria({ name: m.settings_notify_kind_ios() }),
      })
      .click();
    await page.getByRole("button", { name: m.settings_notify_device_remove_yes() }).click();
    expect(deletePushDevice).toHaveBeenCalledWith(iphone.id);
    await expect.element(page.getByText(m.settings_notify_devices_empty())).toBeInTheDocument();
  });
});
