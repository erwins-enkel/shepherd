import { test, describe, expect } from "bun:test";
import { parseServedPort, findServedPort, validatePreviewPortRange } from "../src/config";
import { originAllowed } from "../src/validate";

// ── parseServedPort ───────────────────────────────────────────────────────────

const SAMPLE_STATUS = `
# Tailscale Serve Status

https://backontop.chicken-beardie.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:7330

https://backontop.chicken-beardie.ts.net:5191 (tailnet only)
|-- / proxy http://127.0.0.1:5190

https://backontop.chicken-beardie.ts.net:5193 (tailnet only)
|-- / proxy http://127.0.0.1:5192
`;

test("parseServedPort: finds the port whose target matches localPort", () => {
  // 127.0.0.1:7330 is targeted by the https mapping on default 443
  // (the mapping without an explicit port in the URL)
  expect(parseServedPort(SAMPLE_STATUS, 7330)).toBe(443);
});

test("parseServedPort: finds explicit port mapping for a different local port", () => {
  // 5190 → served at :5191
  expect(parseServedPort(SAMPLE_STATUS, 5190)).toBe(5191);
  // 5192 → served at :5193
  expect(parseServedPort(SAMPLE_STATUS, 5192)).toBe(5193);
});

test("parseServedPort: returns null when no mapping targets the given local port", () => {
  expect(parseServedPort(SAMPLE_STATUS, 9999)).toBeNull();
});

test("parseServedPort: handles multiple mappings and returns the correct one", () => {
  const text = `
https://host.ts.net:8443 (tailnet only)
|-- / proxy http://127.0.0.1:8080

https://host.ts.net:9000 (tailnet only)
|-- / proxy http://127.0.0.1:3000
`;
  expect(parseServedPort(text, 8080)).toBe(8443);
  expect(parseServedPort(text, 3000)).toBe(9000);
});

test("parseServedPort: returns null for empty text", () => {
  expect(parseServedPort("", 7330)).toBeNull();
});

test("parseServedPort: handles missing port (443 implicit) in https URL", () => {
  const text = `
https://myhost.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:4000
`;
  expect(parseServedPort(text, 4000)).toBe(443);
});

test("parseServedPort: target without scheme (just 127.0.0.1:PORT) also matches", () => {
  const text = `
https://myhost.ts.net:7777 (tailnet only)
|-- / proxy 127.0.0.1:5555
`;
  expect(parseServedPort(text, 5555)).toBe(7777);
});

// ── findServedPort ────────────────────────────────────────────────────────────

// Full captured shape from tailscale serve status --json (1.96.4)
const SERVE_STATUS_JSON_FULL = JSON.stringify({
  TCP: { "5191": { HTTPS: true } },
  Web: {
    "backontop.chicken-beardie.ts.net:5191": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:5190" } },
    },
  },
  Services: {
    "svc:shepherd": {
      TCP: { "443": { HTTPS: true } },
      Web: {
        "shepherd.chicken-beardie.ts.net:443": {
          Handlers: { "/": { Proxy: "http://localhost:7330" } },
        },
      },
    },
  },
});

describe("findServedPort", () => {
  test("Service-fronted HUD (Services svc:shepherd → localhost:7330) returns 443", () => {
    expect(findServedPort(SERVE_STATUS_JSON_FULL, 7330)).toBe(443);
  });

  test("direct-serve mapping (top-level Web :5191 → 127.0.0.1:5190) returns 5191", () => {
    expect(findServedPort(SERVE_STATUS_JSON_FULL, 5190)).toBe(5191);
  });

  test("negative: web map present but no Proxy targeting the given localPort returns null", () => {
    expect(findServedPort(SERVE_STATUS_JSON_FULL, 9999)).toBeNull();
  });

  test("negative: malformed JSON returns null", () => {
    expect(findServedPort("not json", 7330)).toBeNull();
  });

  test("negative: empty string returns null", () => {
    expect(findServedPort("", 7330)).toBeNull();
  });

  test("negative: empty object JSON returns null", () => {
    expect(findServedPort("{}", 7330)).toBeNull();
  });

  test("key without explicit :PORT defaults public port to 443", () => {
    const json = JSON.stringify({
      Web: {
        "shepherd.example.ts.net": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:7330" } },
        },
      },
    });
    expect(findServedPort(json, 7330)).toBe(443);
  });

  test("negative: array-valued top-level Web does not produce a false match", () => {
    // Arrays satisfy typeof === "object"; must be rejected so a malformed payload
    // doesn't masquerade as "served" (fail-closed contract).
    expect(
      findServedPort(
        JSON.stringify({ Web: [{ Handlers: { "/": { Proxy: "http://127.0.0.1:7330" } } }] }),
        7330,
      ),
    ).toBeNull();
  });

  test("negative: array-valued Services does not produce a false match", () => {
    expect(
      findServedPort(
        JSON.stringify({
          Services: [
            { Web: { "host:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7330" } } } } },
          ],
        }),
        7330,
      ),
    ).toBeNull();
  });

  test("multiple services: returns first match", () => {
    const json = JSON.stringify({
      Services: {
        "svc:a": {
          Web: {
            "a.ts.net:8000": { Handlers: { "/": { Proxy: "http://localhost:3000" } } },
          },
        },
        "svc:b": {
          Web: {
            "b.ts.net:9000": { Handlers: { "/": { Proxy: "http://localhost:4000" } } },
          },
        },
      },
    });
    expect(findServedPort(json, 3000)).toBe(8000);
    expect(findServedPort(json, 4000)).toBe(9000);
  });
});

// ── validatePreviewPortRange ──────────────────────────────────────────────────

test("validatePreviewPortRange: clean range (8001–8016) vs HUD 7330/443 passes", () => {
  expect(() =>
    validatePreviewPortRange({
      previewPortBase: 8001,
      previewPortCount: 16,
      localPort: 7330,
      servedPort: 443,
    }),
  ).not.toThrow();
});

test("validatePreviewPortRange: throws when range includes the local listen port", () => {
  // range 7320–7335 includes 7330
  expect(() =>
    validatePreviewPortRange({
      previewPortBase: 7320,
      previewPortCount: 16,
      localPort: 7330,
      servedPort: 443,
    }),
  ).toThrow(/local.*port|port.*7330|overlap/i);
});

test("validatePreviewPortRange: throws when range includes the served (public) port 443", () => {
  // range 440–455 includes 443
  expect(() =>
    validatePreviewPortRange({
      previewPortBase: 440,
      previewPortCount: 16,
      localPort: 7330,
      servedPort: 443,
    }),
  ).toThrow(/served.*port|port.*443|overlap/i);
});

test("validatePreviewPortRange: throws when range includes a non-standard served port", () => {
  // served at 5191, range 5185–5200 overlaps
  expect(() =>
    validatePreviewPortRange({
      previewPortBase: 5185,
      previewPortCount: 16,
      localPort: 7330,
      servedPort: 5191,
    }),
  ).toThrow(/served.*port|port.*5191|overlap/i);
});

test("validatePreviewPortRange: port at exclusive range end (base+count=8017) passes for localPort", () => {
  // range [8001, 8017); localPort=8017 is outside → no overlap
  expect(() =>
    validatePreviewPortRange({
      previewPortBase: 8001,
      previewPortCount: 16,
      localPort: 8017,
      servedPort: 443,
    }),
  ).not.toThrow();
});

test("validatePreviewPortRange: port at exclusive range end (base+count=8017) passes for servedPort", () => {
  // range [8001, 8017); servedPort=8017 is outside → no overlap
  expect(() =>
    validatePreviewPortRange({
      previewPortBase: 8001,
      previewPortCount: 16,
      localPort: 7330,
      servedPort: 8017,
    }),
  ).not.toThrow();
});

test("validatePreviewPortRange: last in-range localPort (base+count-1=8016) throws", () => {
  // range [8001, 8017); localPort=8016 is inside → overlap
  expect(() =>
    validatePreviewPortRange({
      previewPortBase: 8001,
      previewPortCount: 16,
      localPort: 8016,
      servedPort: 443,
    }),
  ).toThrow();
});

test("validatePreviewPortRange: last in-range servedPort (base+count-1=8016) throws", () => {
  // range [8001, 8017); servedPort=8016 is inside → overlap
  expect(() =>
    validatePreviewPortRange({
      previewPortBase: 8001,
      previewPortCount: 16,
      localPort: 7330,
      servedPort: 8016,
    }),
  ).toThrow();
});

test("validatePreviewPortRange: localPort equals previewPortBase throws", () => {
  expect(() =>
    validatePreviewPortRange({
      previewPortBase: 7330,
      previewPortCount: 4,
      localPort: 7330,
      servedPort: 443,
    }),
  ).toThrow();
});

test("validatePreviewPortRange: NaN previewPortBase throws with clear error", () => {
  // Simulates a corrupted SHEPHERD_PREVIEW_PORT_BASE env (Number("") → NaN)
  expect(() =>
    validatePreviewPortRange({
      previewPortBase: NaN,
      previewPortCount: 16,
      localPort: 7330,
      servedPort: 443,
    }),
  ).toThrow(/finite|invalid/i);
});

test("validatePreviewPortRange: NaN previewPortCount throws with clear error", () => {
  expect(() =>
    validatePreviewPortRange({
      previewPortBase: 8001,
      previewPortCount: NaN,
      localPort: 7330,
      servedPort: 443,
    }),
  ).toThrow(/finite|invalid/i);
});

test("validatePreviewPortRange: Infinity previewPortBase throws with clear error", () => {
  expect(() =>
    validatePreviewPortRange({
      previewPortBase: Infinity,
      previewPortCount: 16,
      localPort: 7330,
      servedPort: 443,
    }),
  ).toThrow(/finite|invalid/i);
});

// ── originAllowed with preview-port range ─────────────────────────────────────

test("originAllowed: preview-port origin rejected for POST even when hostname is allowlisted", () => {
  const allowedHosts = ["host.ts.net", "localhost"];
  const previewRange = { base: 8001, count: 16 };

  // Origin with a port in the preview range (8005 ∈ [8001, 8017))
  const result = originAllowed("https://host.ts.net:8005", allowedHosts, previewRange);
  expect(result).toBe(false);
});

test("originAllowed: normal HUD origin (no port = 443) passes", () => {
  const allowedHosts = ["host.ts.net", "localhost"];
  const previewRange = { base: 8001, count: 16 };

  expect(originAllowed("https://host.ts.net", allowedHosts, previewRange)).toBe(true);
});

test("originAllowed: no-Origin (CLI/curl) passes", () => {
  const allowedHosts = ["host.ts.net", "localhost"];
  const previewRange = { base: 8001, count: 16 };

  expect(originAllowed(null, allowedHosts, previewRange)).toBe(true);
  expect(originAllowed(undefined, allowedHosts, previewRange)).toBe(true);
});

test("originAllowed: port just below preview range is NOT rejected", () => {
  const allowedHosts = ["host.ts.net"];
  const previewRange = { base: 8001, count: 16 };

  // 8000 is outside [8001, 8017) — passes (allowed host, non-preview port)
  expect(originAllowed("https://host.ts.net:8000", allowedHosts, previewRange)).toBe(true);
});

test("originAllowed: port at upper boundary of preview range is rejected", () => {
  const allowedHosts = ["host.ts.net"];
  const previewRange = { base: 8001, count: 16 };

  // 8016 = 8001 + 16 - 1 ∈ [8001, 8017) → rejected
  expect(originAllowed("https://host.ts.net:8016", allowedHosts, previewRange)).toBe(false);
});

test("originAllowed: port just past preview range is NOT rejected", () => {
  const allowedHosts = ["host.ts.net"];
  const previewRange = { base: 8001, count: 16 };

  // 8017 = 8001 + 16 — outside the range → allowed (host is allowlisted)
  expect(originAllowed("https://host.ts.net:8017", allowedHosts, previewRange)).toBe(true);
});

test("originAllowed: preview-port origin on non-allowlisted host is still rejected", () => {
  const allowedHosts = ["good.ts.net"];
  const previewRange = { base: 8001, count: 16 };

  // Both bad hostname AND preview port → rejected (hostname check rejects it anyway)
  expect(originAllowed("https://evil.com:8005", allowedHosts, previewRange)).toBe(false);
});

test("originAllowed: without range arg behaves as before (no preview rejection)", () => {
  const allowedHosts = ["host.ts.net"];

  // Old call-style with no range — should still work for backward compat
  expect(originAllowed("https://host.ts.net:8005", allowedHosts)).toBe(true);
  expect(originAllowed("https://host.ts.net", allowedHosts)).toBe(true);
});
