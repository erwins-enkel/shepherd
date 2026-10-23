import { describe, expect, test } from "bun:test";
import {
  CAPABILITIES,
  type Capability,
  type CapabilityReport,
} from "../src/remote-instances/capabilities";
import {
  DEFAULT_PLATFORM_ORDER,
  type MachineView,
  type PlacementRequest,
  choiceDependsOn,
  decidePlacement,
  describeRefusal,
  fittingNow,
  localMachine,
  parsePlacementRecord,
  parsePlatformOrder,
  placementActive,
  readinessOf,
  remoteMachineViews,
  remoteUnfit,
  storedPlatformOrder,
} from "../src/remote-instances/placement";
import type { RemoteInstanceSummary } from "../src/remote-instances/service";

// Automatic machine choice (#2772): the pure decision over a view of every machine.

const LINUX_ID = "b1111111-1111-4111-8111-111111111111";
const MAC_ID = "a2222222-2222-4222-8222-222222222222";

function report(ok: Capability[], stale = false): CapabilityReport {
  return {
    vocabulary: 1,
    probedAt: 0,
    ageMs: stale ? 20 * 60_000 : 1_000,
    stale,
    checks: CAPABILITIES.map((id) =>
      ok.includes(id) ? { id, ok: true, reason: null } : { id, ok: false, reason: "not_installed" },
    ),
  };
}

function machine(
  id: string,
  name: string,
  platform: string,
  over: Partial<MachineView> = {},
): MachineView {
  return {
    host: { instanceId: id, name, platform },
    local: false,
    connected: true,
    status: "connected",
    reason: null,
    released: true,
    hasProject: true,
    report: report([`platform:${platform}` as Capability, "agent:claude"]),
    ...over,
  };
}

const linux = (over: Partial<MachineView> = {}) => machine(LINUX_ID, "moes-tavern", "linux", over);
const mac = (over: Partial<MachineView> = {}) =>
  machine(MAC_ID, "MacBook", "macos", {
    report: report(["platform:macos", "xcode", "sdk:macos", "agent:claude"]),
    ...over,
  });

function request(over: Partial<PlacementRequest> = {}): PlacementRequest {
  return {
    requirements: [],
    override: null,
    order: DEFAULT_PLATFORM_ORDER,
    by: { instanceId: LINUX_ID, name: "moes-tavern" },
    now: 42,
    ...over,
  };
}

function target(views: MachineView[], req: PlacementRequest): string | null {
  const d = decidePlacement(views, req);
  return d.ok ? d.placement.target.instanceId : null;
}

describe("automatic placement", () => {
  test("a task without requirements goes to Linux, a task needing Xcode to the Mac — from either entry", () => {
    // Submitted at Linux: Linux is local. Submitted at the Mac: the Mac is local.
    const atLinux = [linux({ local: true }), mac()];
    const atMac = [mac({ local: true }), linux()];
    for (const views of [atLinux, atMac]) {
      expect(target(views, request())).toBe(LINUX_ID);
      expect(target(views, request({ requirements: ["xcode"] }))).toBe(MAC_ID);
    }
  });

  test("the reason says what decided", () => {
    const views = [linux({ local: true }), mac()];
    const none = decidePlacement(views, request());
    expect(none).toMatchObject({
      ok: true,
      placement: {
        mode: "auto",
        basis: "preference",
        preferred: "linux",
        requirements: [],
        by: { instanceId: LINUX_ID },
        decidedAt: 42,
      },
    });
    const xcode = decidePlacement(views, request({ requirements: ["platform:macos", "xcode"] }));
    expect(xcode).toMatchObject({
      ok: true,
      placement: {
        basis: "requirements",
        preferred: null,
        requirements: ["platform:macos", "xcode"],
      },
    });
    // Both platforms have Claude: the order decided among them.
    const claude = decidePlacement(views, request({ requirements: ["agent:claude"] }));
    expect(claude).toMatchObject({
      ok: true,
      placement: { basis: "preference", preferred: "linux" },
    });
    // Only this machine has the project.
    const alone = decidePlacement([linux({ local: true }), mac({ hasProject: false })], request());
    expect(alone).toMatchObject({
      ok: true,
      placement: { basis: "only_candidate", preferred: null },
    });
  });

  test("the platform order decides, then the instance ID", () => {
    const views = [linux({ local: true }), mac()];
    expect(target(views, request({ order: ["macos", "linux"] }))).toBe(MAC_ID);
    const other = machine("00000000-0000-4000-8000-000000000000", "box", "linux");
    expect(target([linux({ local: true }), other], request())).toBe(other.host.instanceId);
    expect(target([other, linux({ local: true })], request())).toBe(other.host.instanceId);
  });

  test("a connected machine's stale report verifies nothing", () => {
    const stale = mac({ report: report(["xcode"], true) });
    const d = decidePlacement(
      [linux({ local: true }), stale],
      request({ requirements: ["xcode"] }),
    );
    expect(d).toEqual({
      ok: false,
      refusal: { code: "no_suitable_machine", missing: ["xcode"], together: false, elsewhere: [] },
    });
    expect(target([linux({ local: true }), stale], request())).toBe(LINUX_ID);
  });

  test("unreleased platforms and machines without the project never run it", () => {
    const win = machine("00000000-0000-4000-8000-000000000001", "win", "windows", {
      released: false,
    });
    expect(target([mac({ local: true }), win], request())).toBe(MAC_ID);
    expect(target([mac({ local: true }), linux({ hasProject: false })], request())).toBe(MAC_ID);
  });

  test("an offline preferred machine is waited for, never replaced by the next one", () => {
    // Linux is preferred and asleep; the Mac fits too — it is offered, not used.
    const offline = linux({ connected: false, status: "unreachable", reason: "timeout" });
    const d = decidePlacement([mac({ local: true }), offline], request());
    expect(d).toEqual({
      ok: true,
      placement: {
        mode: "auto",
        target: offline.host,
        requirements: [],
        basis: "preference",
        preferred: "linux",
        by: { instanceId: LINUX_ID, name: "moes-tavern" },
        decidedAt: 42,
      },
      wait: { status: "timeout", alternatives: [mac().host] },
    });
    // Out of reach, a machine is judged on what it last reported — even a stale report.
    const sleeping = mac({
      connected: false,
      status: "unreachable",
      report: report(["xcode"], true),
    });
    const x = decidePlacement(
      [linux({ local: true }), sleeping],
      request({ requirements: ["xcode"] }),
    );
    expect(x).toMatchObject({
      ok: true,
      placement: { target: sleeping.host, basis: "requirements" },
      wait: { status: "unreachable", alternatives: [] },
    });
    // Connected, no wait.
    expect(decidePlacement([linux({ local: true }), mac()], request())).not.toHaveProperty("wait");
  });

  test("no fitting machine names what is missing", () => {
    const views = [linux({ local: true }), mac()];
    expect(decidePlacement(views, request({ requirements: ["android-sdk", "xcode"] }))).toEqual({
      ok: false,
      refusal: {
        code: "no_suitable_machine",
        missing: ["android-sdk"],
        together: false,
        elsewhere: [],
      },
    });
    // Each exists somewhere, never on one machine.
    const both = decidePlacement(views, request({ requirements: ["platform:linux", "xcode"] }));
    expect(both).toMatchObject({
      ok: false,
      refusal: { missing: ["platform:linux", "xcode"], together: true },
    });
    // The Mac has Xcode but not the project.
    const noCheckout = decidePlacement(
      [linux({ local: true }), mac({ hasProject: false })],
      request({ requirements: ["xcode"] }),
    );
    expect(noCheckout).toMatchObject({
      ok: false,
      refusal: { missing: ["xcode"], elsewhere: [mac().host] },
    });
  });
});

describe("manual placement", () => {
  const views = [linux({ local: true }), mac()];

  test("a fitting choice is kept and recorded as manual", () => {
    const d = decidePlacement(views, request({ override: MAC_ID }));
    expect(d).toMatchObject({
      ok: true,
      placement: { mode: "manual", basis: "manual", preferred: null, target: mac().host },
    });
    expect(target(views, request({ override: LINUX_ID }))).toBe(LINUX_ID);
  });

  test("a machine that does not fit is refused with the reason", () => {
    expect(
      decidePlacement(views, request({ override: LINUX_ID, requirements: ["xcode"] })),
    ).toEqual({
      ok: false,
      refusal: {
        code: "missing_capabilities",
        host: linux().host,
        missing: [{ capability: "xcode", reason: "not_installed" }],
      },
    });
    const offline = [linux({ local: true }), mac({ connected: false, status: "unreachable" })];
    expect(decidePlacement(offline, request({ override: MAC_ID }))).toMatchObject({
      ok: false,
      refusal: { code: "remote_target_unavailable", reason: "unreachable" },
    });
    expect(
      decidePlacement(
        [linux({ local: true }), mac({ released: false })],
        request({ override: MAC_ID }),
      ),
    ).toMatchObject({ ok: false, refusal: { code: "remote_target_unreleased", reason: "macos" } });
    expect(
      decidePlacement(
        [linux({ local: true }), mac({ hasProject: false })],
        request({ override: MAC_ID }),
      ),
    ).toMatchObject({ ok: false, refusal: { code: "remote_project_missing" } });
    expect(decidePlacement(views, request({ override: "nope" }))).toMatchObject({
      ok: false,
      refusal: { code: "remote_target_unknown", host: null },
    });
    expect(
      decidePlacement(
        [linux({ local: true }), mac({ report: null })],
        request({ override: MAC_ID, requirements: ["xcode"] }),
      ),
    ).toMatchObject({
      ok: false,
      refusal: {
        code: "missing_capabilities",
        missing: [{ capability: "xcode", reason: "not_verified" }],
      },
    });
  });
});

describe("rules", () => {
  test("placement is active with any machine that could run a task", () => {
    expect(placementActive([])).toBe(false);
    expect(placementActive([{ released: false, info: { platform: "windows" } as never }])).toBe(
      false,
    );
    expect(placementActive([{ released: false, info: null }])).toBe(true);
    expect(placementActive([{ released: true, info: { platform: "macos" } as never }])).toBe(true);
  });

  test("the platform order is a permutation of the released platforms", () => {
    expect(parsePlatformOrder(["macos", "linux"])).toEqual(["macos", "linux"]);
    expect(parsePlatformOrder(["linux", "linux"])).toBeNull();
    expect(parsePlatformOrder(["linux"])).toBeNull();
    expect(parsePlatformOrder(["linux", "windows"])).toBeNull();
    expect(parsePlatformOrder("linux,macos")).toBeNull();
    expect(storedPlatformOrder(null)).toEqual(["linux", "macos"]);
    expect(storedPlatformOrder('["macos","linux"]')).toEqual(["macos", "linux"]);
    expect(storedPlatformOrder("garbage")).toEqual(["linux", "macos"]);
  });

  test("the dispatcher's pre-flight", () => {
    const base = {
      status: "connected" as const,
      reason: null,
      released: true,
      info: { platform: "macos" } as never,
      projects: ["acme/app"],
    };
    expect(remoteUnfit(base, "acme/app")).toBeNull();
    expect(remoteUnfit({ ...base, status: "unreachable", reason: "timeout" }, "acme/app")).toEqual({
      code: "remote_target_unavailable",
      reason: "timeout",
    });
    expect(remoteUnfit({ ...base, released: false }, "acme/app")).toEqual({
      code: "remote_target_unreleased",
      reason: "macos",
    });
    expect(remoteUnfit(base, "acme/other")).toEqual({
      code: "remote_project_missing",
      reason: null,
    });
  });

  test("refusals read as sentences", () => {
    expect(
      describeRefusal({
        code: "no_suitable_machine",
        missing: ["xcode"],
        together: false,
        elsewhere: [],
      }),
    ).toBe("no connected machine has xcode; nothing was started");
    expect(
      describeRefusal({
        code: "no_suitable_machine",
        missing: ["xcode"],
        together: false,
        elsewhere: [mac().host],
      }),
    ).toBe(
      "no connected machine has xcode; MacBook would, but has no checkout of this project; nothing was started",
    );
    expect(
      describeRefusal({
        code: "missing_capabilities",
        host: linux().host,
        missing: [{ capability: "xcode", reason: "other_platform" }],
      }),
    ).toBe("moes-tavern is missing capabilities: xcode (other_platform)");
  });

  test("a placement record from a coordinator is rebuilt field by field", () => {
    const record = {
      mode: "auto",
      target: { instanceId: MAC_ID, name: "MacBook", platform: "macos" },
      requirements: ["xcode", "platform:macos", "xcode"],
      basis: "requirements",
      preferred: null,
      by: { instanceId: LINUX_ID, name: "moes-tavern", extra: 1 },
      decidedAt: 7,
      extra: true,
    };
    expect(parsePlacementRecord(undefined)).toBeUndefined();
    expect(parsePlacementRecord(record)).toEqual({
      mode: "auto",
      target: { instanceId: MAC_ID, name: "MacBook", platform: "macos" },
      requirements: ["platform:macos", "xcode"],
      basis: "requirements",
      preferred: null,
      by: { instanceId: LINUX_ID, name: "moes-tavern" },
      decidedAt: 7,
    });
    for (const bad of [
      null,
      { ...record, mode: "auto-ish" },
      { ...record, basis: "luck" },
      { ...record, requirements: ["arch:x64"] },
      { ...record, target: { instanceId: "x" } },
      { ...record, preferred: 3 },
      { ...record, decidedAt: "now" },
    ]) {
      expect(parsePlacementRecord(bad)).toEqual({ error: "placement must be a placement record" });
    }
  });
});

describe("waiting tasks (#2775)", () => {
  test("the machines a waiting task could run on now: connected, fitting, best first", () => {
    const views = [
      mac({ local: true }),
      linux(),
      machine("00000000-0000-4000-8000-000000000002", "box", "linux", { connected: false }),
    ];
    expect(fittingNow(views, [], DEFAULT_PLATFORM_ORDER)).toEqual([linux().host, mac().host]);
    expect(fittingNow(views, [], DEFAULT_PLATFORM_ORDER, LINUX_ID)).toEqual([mac().host]);
    expect(fittingNow(views, ["xcode"], DEFAULT_PLATFORM_ORDER, MAC_ID)).toEqual([]);
  });

  function summary(over: Partial<RemoteInstanceSummary> = {}): RemoteInstanceSummary {
    return {
      instanceId: MAC_ID,
      name: "MacBook",
      label: null,
      reportedName: "MacBook",
      url: "https://mac.example",
      tokenHint: null,
      createdAt: 0,
      status: "connected",
      reason: null,
      checkedAt: 1,
      lastSeenAt: 1,
      info: { version: "2.2.0", federationApi: 2, platform: "macos", arch: "arm64" },
      projects: ["acme/app"],
      capabilities: report(["platform:macos", "xcode"]),
      released: true,
      ...over,
    };
  }

  test("readiness names what keeps the machine from taking the task", () => {
    expect(readinessOf(summary(), "acme/app", ["xcode"])).toEqual({ state: "ready" });
    expect(
      readinessOf(summary({ status: "unreachable", reason: "timeout" }), "acme/app", ["xcode"]),
    ).toEqual({ state: "offline", status: "timeout" });
    expect(readinessOf(summary({ status: "unauthorized" }), "acme/app", [])).toEqual({
      state: "offline",
      status: "unauthorized",
    });
    expect(readinessOf(summary({ released: false }), "acme/app", [])).toEqual({
      state: "unreleased",
    });
    expect(readinessOf(summary(), "acme/other", [])).toEqual({ state: "project_missing" });
    expect(readinessOf(summary(), "acme/app", ["xcode", "sdk:ios"])).toEqual({
      state: "missing_capabilities",
      missing: [{ capability: "sdk:ios", reason: "not_installed" }],
    });
    // A stale report — or none — verifies nothing.
    expect(
      readinessOf(summary({ capabilities: report(["xcode"], true) }), "acme/app", ["xcode"]),
    ).toEqual({
      state: "missing_capabilities",
      missing: [{ capability: "xcode", reason: "not_verified" }],
    });
    expect(readinessOf(summary({ capabilities: null }), "acme/app", [])).toEqual({
      state: "ready",
    });
  });

  test("this Shepherd and its machines as the choice sees them", () => {
    const here = localMachine(
      { instanceId: LINUX_ID, name: "moes-tavern", platform: "linux" },
      report(["platform:linux"]),
    );
    expect(here).toMatchObject({
      host: { instanceId: LINUX_ID, name: "moes-tavern", platform: "linux" },
      local: true,
      connected: true,
      released: true,
      hasProject: true,
    });
    const [m] = remoteMachineViews([summary({ status: "unreachable" })], "acme/app");
    expect(m).toMatchObject({
      host: { instanceId: MAC_ID, name: "MacBook", platform: "macos" },
      local: false,
      connected: false,
      released: true,
      hasProject: true,
    });
    expect(remoteMachineViews([summary()], undefined)[0]!.hasProject).toBe(false);
  });
});

describe("whether reading requirements from a task can change the choice (#2773)", () => {
  const DERIVABLE: Capability[] = ["xcode", "sdk:ios", "ios-simulator", "android-sdk"];
  const OTHER_LINUX = "c3333333-3333-4333-8333-333333333333";

  test("Linux and a Mac with Xcode: it can", () => {
    expect(choiceDependsOn([linux(), mac()], DERIVABLE)).toBe(true);
  });

  test("machines that verify the same of them: it cannot", () => {
    const twin = machine(OTHER_LINUX, "box", "linux");
    expect(choiceDependsOn([linux(), twin], DERIVABLE)).toBe(false);
    // They differ, but not in anything a description can call for.
    const codex = machine(OTHER_LINUX, "box", "linux", { report: report(["agent:codex"]) });
    expect(choiceDependsOn([linux(), codex], DERIVABLE)).toBe(false);
  });

  test("a single candidate: it cannot", () => {
    expect(choiceDependsOn([linux()], DERIVABLE)).toBe(false);
    expect(choiceDependsOn([], DERIVABLE)).toBe(false);
  });

  test("a machine without the project or on an unreleased platform is no candidate", () => {
    expect(choiceDependsOn([linux(), mac({ hasProject: false })], DERIVABLE)).toBe(false);
    expect(choiceDependsOn([linux(), mac({ released: false })], DERIVABLE)).toBe(false);
  });

  test("a Mac out of reach counts on its last report; a connected one's stale report verifies nothing", () => {
    const asleep = mac({
      connected: false,
      status: "unreachable",
      report: report(["xcode"], true),
    });
    expect(choiceDependsOn([linux(), asleep], DERIVABLE)).toBe(true);
    const stale = mac({ report: report(["xcode"], true) });
    expect(choiceDependsOn([linux(), stale], DERIVABLE)).toBe(false);
  });

  test("an Android box next to plain Linux: it can", () => {
    const android = machine(OTHER_LINUX, "box", "linux", { report: report(["android-sdk"]) });
    expect(choiceDependsOn([linux(), android], DERIVABLE)).toBe(true);
  });
});

const hostLoad = (ratio: number, over = {}) => ({
  sampledAt: 42,
  ageMs: 0,
  stale: false,
  load1: ratio * 8,
  cpuCount: 8,
  runningSessions: 3,
  ...over,
});

describe("load-aware placement", () => {
  test("keeps preference until busy, then uses the first fitting host with reserve", () => {
    const preferred = linux({ local: true, load: hostLoad(1.2) });
    const spare = mac({ load: hostLoad(0.3) });
    for (const views of [
      [preferred, spare],
      [spare, preferred],
    ]) {
      const d = decidePlacement(views, request());
      expect(d).toMatchObject({
        ok: true,
        placement: {
          target: spare.host,
          basis: "load",
          preferred: null,
          load: {
            state: "diverted",
            preferredHost: preferred.host,
            preferredReport: preferred.load,
            selectedReport: spare.load,
          },
        },
      });
      if (d.ok) expect(parsePlacementRecord(d.placement)).toEqual(d.placement);
    }
    expect(
      target([linux({ load: hostLoad(0.5, { runningSessions: 50 }) }), spare], request()),
    ).toBe(LINUX_ID);
    expect(target([linux({ load: hostLoad(1) }), mac({ load: hostLoad(0.75) })], request())).toBe(
      MAC_ID,
    );
    expect(target([linux({ load: hostLoad(0.999) }), spare], request())).toBe(LINUX_ID);
    expect(target([preferred, mac({ load: hostLoad(0.751) })], request())).toBe(LINUX_ID);
    const secondLinux = machine("c333", "second", "linux", { load: hostLoad(0.7) });
    expect(target([spare, secondLinux, preferred], request())).toBe("c333");
  });

  test("busy without proven reserve starts on the preferred host with a warning", () => {
    for (const load of [
      hostLoad(1.1),
      hostLoad(0.1, { stale: true }),
      null,
      hostLoad(0.1, { sampledAt: 0 }),
    ]) {
      const d = decidePlacement(
        [linux({ load: hostLoad(1.2, { sampledAt: 20_000 }) }), mac({ load })],
        request({ now: 20_000 }),
      );
      expect(d).toMatchObject({
        ok: true,
        placement: { target: { instanceId: LINUX_ID }, load: { state: "busy" } },
      });
      expect(d).not.toHaveProperty("wait");
    }
    expect(
      decidePlacement([linux({ load: null }), mac({ load: hostLoad(0) })], request()),
    ).toMatchObject({
      ok: true,
      placement: { target: { instanceId: LINUX_ID }, load: { state: "unknown" } },
    });
  });

  test("requirements, explicit targets, project eligibility and offline waiting still win", () => {
    const busy = linux({ load: hostLoad(1.2) });
    const spare = mac({ load: hostLoad(0.2) });
    expect(target([busy, spare], request({ override: LINUX_ID }))).toBe(LINUX_ID);
    expect(target([busy, spare], request({ requirements: ["platform:linux"] }))).toBe(LINUX_ID);
    expect(target([busy, { ...spare, hasProject: false }], request())).toBe(LINUX_ID);
    expect(target([busy, { ...spare, released: false }], request())).toBe(LINUX_ID);
    expect(
      target(
        [busy, { ...spare, report: report(["xcode"], true) }],
        request({ requirements: ["xcode"] }),
      ),
    ).toBeNull();
    expect(
      target(
        [mac({ load: hostLoad(1.2) }), linux({ load: hostLoad(0) })],
        request({ requirements: ["xcode"] }),
      ),
    ).toBe(MAC_ID);
    const offline = decidePlacement(
      [{ ...busy, connected: false, status: "unreachable" }, spare],
      request(),
    );
    expect(offline).toMatchObject({
      ok: true,
      placement: { target: busy.host, basis: "preference" },
      wait: { status: "unreachable" },
    });
    if (offline.ok) expect(offline.placement.load).toBeUndefined();
  });

  test("the record captures stale observations as stale at selection time", () => {
    const d = decidePlacement(
      [linux({ load: hostLoad(0.5) }), mac({ load: null })],
      request({ now: 20_000 }),
    );
    expect(d).toMatchObject({
      ok: true,
      placement: { load: { state: "unknown", selectedReport: { stale: true, ageMs: 19_958 } } },
    });
  });

  test("placement parser preserves old records and rejects malformed load records", () => {
    const d = decidePlacement(
      [linux({ load: hostLoad(1.2) }), mac({ load: hostLoad(0.2) })],
      request(),
    );
    if (!d.ok) throw new Error("expected placement");
    for (const load of [
      null,
      {},
      { ...d.placement.load, state: "free" },
      { ...d.placement.load, state: ["diverted"] },
      { ...d.placement.load, selectedReport: { ...hostLoad(0), cpuCount: 0 } },
    ]) {
      expect(parsePlacementRecord({ ...d.placement, load })).toHaveProperty("error");
    }
    expect(parsePlacementRecord({ ...d.placement, load: undefined })).toHaveProperty("error");
    const old = { ...d.placement };
    delete old.load;
    expect(parsePlacementRecord({ ...old, basis: "preference" })).toEqual({
      ...old,
      basis: "preference",
    });
  });
});
