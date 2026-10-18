import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../../app.css";
import { m } from "#lib/paraglide/messages.js";
import { getLocale, setLocale } from "#lib/paraglide/runtime.js";
import type { JudgeConnectionStatus, Settings } from "#lib/types.js";
import {
  deleteJudgeConnection,
  getJudgeConnection,
  putJudgeConnection,
  verifyJudgeConnection,
} from "#lib/api.js";
import { matchCount, sectionSearchRows } from "#lib/settings-search.js";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    getJudgeConnection: vi.fn(),
    putJudgeConnection: vi.fn(),
    deleteJudgeConnection: vi.fn(),
    verifyJudgeConnection: vi.fn(),
    putJudgeEnabled: vi.fn(async (v: boolean) => ({ judgeEnabled: v })),
    putUpNextReadiness: vi.fn(async (v: boolean) => ({ upNextReadiness: v })),
    putBlockJudgeMode: vi.fn(async (v: string) => ({ blockJudgeMode: v })),
    putJudgeDailyUsd: vi.fn(async (v: number) => ({ judgeDailyUsd: v })),
  };
});

const { default: Panel } = await import("./SettingsDecisionModelPanel.svelte");

const KEY = "jev_live_0123456789abcdef";

function status(over: Partial<JudgeConnectionStatus> = {}): JudgeConnectionStatus {
  return {
    keySource: "none",
    keyLast4: null,
    keySavedAt: null,
    staleKeyHost: null,
    lastVerify: null,
    models: [],
    model: "jev-1.13.0",
    baseUrl: "https://api.typesafe.ai",
    timeoutMs: 8000,
    defaults: { model: "jev-1.13.0", baseUrl: "https://api.typesafe.ai", timeoutMs: 8000 },
    env: { key: false, model: false, baseUrl: false, timeoutMs: false },
    authFailure: null,
    lastOkAt: null,
    today: { day: "2026-10-18", calls: 0, usd: 0, ceilingUsd: 1 },
    ...over,
  };
}

const stored = (over: Partial<JudgeConnectionStatus> = {}) =>
  status({
    keySource: "stored",
    keyLast4: "cdef",
    keySavedAt: Date.now(),
    lastVerify: { result: "ok", at: Date.now(), status: null },
    ...over,
  });

function payload(over: Partial<Settings> = {}): Settings {
  return {
    judgeEnabled: false,
    judgeHasKey: false,
    judgeDailyUsd: 1,
    blockJudgeMode: "off",
    upNextReadiness: false,
    ...over,
  } as Settings;
}

// A password input has no ARIA role, so it is found by its accessible name.
const keyInput = () => page.getByLabelText(m.settings_dm_key_title(), { exact: true });
const exact = (text: string) => page.getByText(text, { exact: true });
const saveButton = () => page.getByRole("button", { name: m.settings_dm_key_save() });
const classifier = () => page.getByRole("switch", { name: m.settings_judge_enabled_label() });
const readiness = () => page.getByRole("switch", { name: m.settings_up_next_readiness_label() });

beforeEach(() => {
  vi.mocked(getJudgeConnection).mockResolvedValue(status());
});
afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("SettingsDecisionModelPanel — the key", () => {
  it("saves a pasted key through Save & verify, and the toggle unlocks without a restart", async () => {
    vi.mocked(putJudgeConnection).mockResolvedValue(stored());
    render(Panel, { payload: payload() });
    await expect.element(exact(m.settings_dm_state_not_connected())).toBeInTheDocument();
    await expect.element(classifier()).toBeDisabled();

    await userEvent.fill(keyInput(), KEY);
    await userEvent.click(saveButton());

    expect(putJudgeConnection).toHaveBeenCalledWith({ key: KEY });
    await expect.element(exact(m.settings_dm_key_masked({ last4: "cdef" }))).toBeInTheDocument();
    await expect.element(exact(m.settings_dm_state_ready())).toBeInTheDocument();
    await expect.element(classifier()).toBeEnabled();
    // The full key is nowhere on the page.
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it("explains a rejected key, keeps nothing, and clears the field", async () => {
    vi.mocked(putJudgeConnection).mockResolvedValue({
      error: "key_rejected",
      field: "key",
      status: 401,
    });
    render(Panel, { payload: payload() });
    await userEvent.fill(keyInput(), KEY);
    await userEvent.click(saveButton());

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(m.settings_dm_key_rejected({ status: "401" }));
    await expect.element(keyInput()).toHaveAttribute("aria-invalid", "true");
    await expect.element(keyInput()).toHaveValue("");
    await expect.element(exact(m.settings_dm_state_not_connected())).toBeInTheDocument();
  });

  it("shows an environment key locked, with how to change it and no field to paste into", async () => {
    vi.mocked(getJudgeConnection).mockResolvedValue(
      status({ keySource: "env", keyLast4: "cdef", env: { ...status().env, key: true } }),
    );
    render(Panel, { payload: payload({ judgeHasKey: true }) });
    await expect.element(page.getByText(m.settings_dm_key_env())).toBeInTheDocument();
    await expect.element(exact("JEV_API_KEY")).toBeInTheDocument();
    expect(keyInput().elements()).toHaveLength(0);
    expect(page.getByRole("button", { name: m.settings_dm_key_remove() }).elements()).toHaveLength(
      0,
    );
  });

  it("tests and removes a stored key", async () => {
    vi.mocked(getJudgeConnection).mockResolvedValue(stored());
    vi.mocked(verifyJudgeConnection).mockResolvedValue(
      stored({ lastVerify: { result: "rejected", at: Date.now(), status: 403 } }),
    );
    vi.mocked(deleteJudgeConnection).mockResolvedValue(status());
    render(Panel, { payload: payload({ judgeHasKey: true }) });

    await userEvent.click(page.getByRole("button", { name: m.settings_dm_key_test() }));
    await expect.element(exact(m.settings_dm_state_rejected())).toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: m.settings_dm_key_remove() }));
    await userEvent.click(page.getByRole("button", { name: m.settings_dm_key_remove_confirm() }));
    expect(deleteJudgeConnection).toHaveBeenCalledOnce();
    await expect.element(keyInput()).toBeInTheDocument();
  });
});

describe("SettingsDecisionModelPanel — dependencies", () => {
  it("disables Up Next readiness with its reason while the stop classifier is off", async () => {
    vi.mocked(getJudgeConnection).mockResolvedValue(stored());
    render(Panel, { payload: payload({ judgeHasKey: true }) });
    await expect.element(readiness()).toBeDisabled();
    await expect
      .element(page.getByText(m.settings_up_next_readiness_no_key_hint()))
      .toBeInTheDocument();
    await expect.element(page.getByText(m.settings_dm_chip_needs_classifier())).toBeInTheDocument();

    await userEvent.click(classifier());
    await expect.element(readiness()).toBeEnabled();
    await expect.element(exact(m.settings_dm_state_active())).toBeInTheDocument();
  });

  it("asks for the key again before moving the address away from a stored one", async () => {
    vi.mocked(getJudgeConnection).mockResolvedValue(stored());
    render(Panel, { payload: payload({ judgeHasKey: true }) });
    await userEvent.click(page.getByRole("button", { name: m.settings_dm_group_advanced() }));
    await userEvent.fill(
      page.getByRole("textbox", { name: m.settings_dm_base_url_title() }),
      "https://judge.example",
    );
    await expect
      .element(page.getByLabelText(m.settings_dm_base_url_key_label(), { exact: true }))
      .toBeInTheDocument();
    expect(putJudgeConnection).not.toHaveBeenCalled();
  });
});

describe("SettingsDecisionModelPanel — search", () => {
  const initial = getLocale();
  afterEach(() => setLocale(initial, { reload: false }));

  it("opens Advanced on a search hit inside it", async () => {
    render(Panel, { payload: payload(), query: "API address" });
    await expect
      .element(page.getByRole("button", { name: m.settings_dm_group_advanced() }))
      .toHaveAttribute("aria-expanded", "true");
  });

  it("is found by jev, typesafe and judge in German too", () => {
    setLocale("de", { reload: false });
    const rows = sectionSearchRows({}).decisionModel;
    expect(matchCount(rows, "schlüssel")).toBeGreaterThan(0); // the German catalog is in force
    for (const q of ["jev", "typesafe", "judge"]) expect(matchCount(rows, q), q).toBeGreaterThan(0);
  });
});
