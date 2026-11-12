import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  settingsSource,
  settingsSourceErrorText,
  steerRepoNamesFor,
} from "./settings-source.svelte";
import { repos } from "./repos.svelte";
import { steers } from "./steers.svelte";
import { ApiError, getProjectIcons, getSteers, putSettingsSource, putSteers } from "./api";
import { m } from "#lib/paraglide/messages.js";
import type { SettingsSource, Steer } from "./types";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    getSettingsSource: vi.fn(),
    putSettingsSource: vi.fn(),
    getSteers: vi.fn(async () => []),
    putSteers: vi.fn(),
    getProjectIcons: vi.fn(async () => ({})),
  };
});

const core: SettingsSource = {
  instanceId: "core",
  name: "core-box",
  reachable: true,
  repos: [
    {
      name: "shepherd",
      path: "/a/shepherd",
      realPath: "/a/shepherd",
      remoteSlug: "erwins-enkel/shepherd",
    },
  ],
};
const steer = (id: string): Steer => ({
  id,
  label: id,
  text: `do ${id}`,
  inSteerBar: true,
  onIssues: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  settingsSource.source = null;
  settingsSource.loaded = false;
  steers.list = [];
  repos.entries = [
    {
      name: "shep",
      path: "/b/shep",
      realPath: "/b/shep",
      display: "~/shep",
      remoteSlug: "Erwins-Enkel/Shepherd",
    },
  ];
});

describe("steerRepoNamesFor", () => {
  it("is the local name without a source", () => {
    expect(steerRepoNamesFor("/b/shep")).toBe("shep");
    expect(steerRepoNamesFor("/nowhere")).toBeNull();
  });

  it("with a source, maps a local checkout by slug and a mirrored path by the source's own", () => {
    settingsSource.source = core;
    expect(steerRepoNamesFor("/b/shep")).toEqual(["shepherd"]);
    expect(steerRepoNamesFor("/a/shepherd")).toEqual(["shepherd"]);
    expect(steerRepoNamesFor("/nowhere")).toEqual([]);
  });
});

describe("settingsSource", () => {
  it("is read-only only while a set source is out of reach", () => {
    expect(settingsSource.readOnly).toBe(false);
    settingsSource.source = core;
    expect(settingsSource.readOnly).toBe(false);
    settingsSource.source = { ...core, reachable: false };
    expect(settingsSource.readOnly).toBe(true);
  });

  it("re-reads steers and emojis when the source changes or comes back, not on every update", () => {
    settingsSource.apply(core);
    expect(getSteers).toHaveBeenCalledTimes(1);
    expect(getProjectIcons).toHaveBeenCalledTimes(1);
    settingsSource.apply({ ...core, reachable: false });
    expect(getSteers).toHaveBeenCalledTimes(1);
    settingsSource.apply(core);
    expect(getSteers).toHaveBeenCalledTimes(2);
    settingsSource.apply(null);
    expect(getSteers).toHaveBeenCalledTimes(3);
  });

  it("set() adopts the server's answer and propagates a refusal", async () => {
    vi.mocked(putSettingsSource).mockResolvedValueOnce(core);
    await settingsSource.set("core");
    expect(settingsSource.source).toEqual(core);
    vi.mocked(putSettingsSource).mockRejectedValueOnce(
      new ApiError(403, "operator_session_required"),
    );
    await expect(settingsSource.set(null)).rejects.toThrow("operator_session_required");
    expect(settingsSource.source).toEqual(core);
  });
});

describe("steers.apply", () => {
  it("adopts a pushed list, but not over a save in flight", async () => {
    steers.apply([steer("a")]);
    expect(steers.list.map((s) => s.id)).toEqual(["a"]);

    let finish!: (v: Steer[]) => void;
    vi.mocked(putSteers).mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const saving = steers.save([steer("mine")]);
    steers.apply([steer("theirs")]);
    expect(steers.list.map((s) => s.id)).toEqual(["a"]);
    finish([steer("mine")]);
    await saving;
    expect(steers.list.map((s) => s.id)).toEqual(["mine"]);
  });
});

describe("settingsSourceErrorText", () => {
  it("words the settings-source refusals by code and passes anything else through", () => {
    const err = (code: string) => new ApiError(503, "english", code, true);
    expect(settingsSourceErrorText(err("settings_source_unreachable"))).toBe(
      m.settings_source_err_unreachable(),
    );
    expect(settingsSourceErrorText(err("settings_source_failed"))).toBe(
      m.settings_source_err_failed(),
    );
    expect(settingsSourceErrorText(err("settings_source_no_repo"))).toBe(
      m.settings_source_err_no_repo(),
    );
    expect(settingsSourceErrorText(new Error("boom"))).toBe("boom");
  });
});
