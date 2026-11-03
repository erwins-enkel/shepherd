import { describe, expect, it } from "vitest";
import { m } from "#lib/paraglide/messages.js";
import type { UpdateCallRecord } from "#lib/types.js";
import { describeUserAgent, updateCallOrigin } from "./update-call.js";

const record = (over: Partial<UpdateCallRecord>): UpdateCallRecord => ({
  v: 1,
  requestId: null,
  at: 1,
  outcome: "applied",
  reason: null,
  from: "aaaaaaa",
  to: "bbbbbbb",
  discard: false,
  caller: { kind: "unknown" },
  session: null,
  machine: null,
  ...over,
});

describe("describeUserAgent", () => {
  it.each([
    ["Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", "Firefox · Linux"],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      "Safari · macOS",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      "Safari · iOS",
    ],
    [
      "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36",
      "Chrome · Android",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      "Edge · Windows",
    ],
  ])("%s", (ua, label) => expect(describeUserAgent(ua)).toBe(label));

  it("knows nothing about a client it cannot place", () => {
    expect(describeUserAgent("curl/8.0")).toBeNull();
    expect(describeUserAgent(null)).toBeNull();
  });
});

describe("updateCallOrigin", () => {
  const token = { kind: "token", name: "ci-box", ua: null } as const;

  it("names each kind of caller", () => {
    expect(updateCallOrigin(record({ caller: { kind: "surface", ua: null } }))).toBe(
      m.update_origin_surface(),
    );
    expect(
      updateCallOrigin(
        record({ caller: { kind: "surface", ua: "Mozilla/5.0 (X11; Linux) Firefox/140.0" } }),
      ),
    ).toBe(m.update_origin_surface_device({ device: "Firefox · Linux" }));
    expect(updateCallOrigin(record({ caller: { ...token, client: "other" } }))).toBe(
      m.update_origin_token({ name: "ci-box" }),
    );
    expect(updateCallOrigin(record({ caller: { ...token, client: "cli" } }))).toBe(
      m.update_origin_token_cli({ name: "ci-box" }),
    );
    expect(updateCallOrigin(record({ caller: { ...token, client: "relay" } }))).toBe(
      m.update_origin_token_relay({ name: "ci-box" }),
    );
    expect(
      updateCallOrigin(record({ caller: { kind: "env_token", client: "other", ua: null } })),
    ).toBe(m.update_origin_env_token());
    expect(updateCallOrigin(record({ caller: { kind: "script", tty: true } }))).toBe(
      m.update_origin_terminal(),
    );
    expect(updateCallOrigin(record({ caller: { kind: "script", tty: false } }))).toBe(
      m.update_origin_script(),
    );
    expect(updateCallOrigin(record({ caller: { kind: "app" } }))).toBe(m.update_origin_app());
    expect(updateCallOrigin(record({}))).toBe(m.update_origin_unknown());
  });

  it("puts the session in front and keeps the credential visible behind it", () => {
    const caller = { ...token, client: "other" } as const;
    const session = { id: "66666666-7777-4888-8999-000000000000", desig: "TASK-07" };
    expect(updateCallOrigin(record({ caller, session }))).toBe(
      m.update_origin_session({
        session: "TASK-07",
        caller: m.update_origin_token({ name: "ci-box" }),
      }),
    );
    expect(updateCallOrigin(record({ caller, session: { ...session, desig: null } }))).toBe(
      m.update_origin_session({
        session: "66666666",
        caller: m.update_origin_token({ name: "ci-box" }),
      }),
    );
  });
});
