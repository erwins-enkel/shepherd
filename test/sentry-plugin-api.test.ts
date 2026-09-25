// Sentry plugin (#2464): response parsing + rate-limit backoff + the GET client.
// Fixtures under test/fixtures/sentry/recorded-*.json follow Sentry's documented response shape
// (org issues list, issue latest event, code mappings) with identifying values replaced.

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  apiUrl,
  nextBackoff,
  parseEvent,
  parseIssues,
  parseRegressedAt,
  sentryGet,
  type Fetch,
} from "../src/plugins/bundled/sentry/api";

const FIX = join(import.meta.dir, "fixtures/sentry");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIX, name), "utf8"));

describe("parsing", () => {
  test("parseIssues keeps well-formed issues and normalizes assignee/count", () => {
    const issues = parseIssues(fixture("recorded-issues.json"));
    expect(issues.map((i) => [i.shortId, i.assignee, i.count])).toEqual([
      ["FLOWAGENT-1A", null, 57],
      ["FLOWAGENT-1B", "user", 300],
      ["OTHER-9", null, 20],
    ]);
  });

  test("parseIssues drops malformed rows and never throws", () => {
    expect(parseIssues(null)).toEqual([]);
    expect(
      parseIssues([{ id: "x", shortId: "A-1", project: { slug: "p" } }, 3, { id: "1" }]),
    ).toEqual([]);
  });

  test("parseEvent extracts exceptions, breadcrumbs, tags, release", () => {
    const ev = parseEvent(fixture("recorded-event-latest.json"))!;
    expect(ev.release).toBe("flowagent@2.3.1");
    expect(ev.exceptions[0]!.type).toBe("TypeError");
    expect(ev.exceptions[0]!.frames.filter((f) => f.inApp)).toHaveLength(2);
    expect(ev.breadcrumbs).toHaveLength(2);
    expect(ev.tags.find((t) => t.key === "environment")?.value).toBe("production");
    expect(parseEvent("nope")).toBeNull();
  });
});

test("parseRegressedAt picks the newest set_regression activity; none → null", () => {
  expect(
    parseRegressedAt({
      activity: [
        { type: "set_regression", dateCreated: "2026-09-20T08:00:00Z" },
        { type: "set_resolved", dateCreated: "2026-09-24T08:00:00Z" },
        { type: "set_regression", dateCreated: "2026-09-25T08:00:00Z" },
        { type: "set_regression", dateCreated: "not a date" },
      ],
    }),
  ).toBe("2026-09-25T08:00:00.000Z");
  expect(
    parseRegressedAt({ activity: [{ type: "first_seen", dateCreated: "2026-09-20T08:00:00Z" }] }),
  ).toBeNull();
  expect(parseRegressedAt(null)).toBeNull();
});

describe("backoff", () => {
  const NOW = 1_700_000_000_000;
  const h = (o: Record<string, string>) => new Headers(o);
  const none = { until: 0, strikes: 0 };

  test("429 honors Retry-After first", () => {
    expect(nextBackoff(429, h({ "retry-after": "30" }), NOW, none)).toEqual({
      until: NOW + 30_000,
      strikes: 0,
    });
  });

  test("429 without Retry-After uses X-Sentry-Rate-Limit-Reset", () => {
    const reset = NOW / 1000 + 120;
    expect(nextBackoff(429, h({ "x-sentry-rate-limit-reset": String(reset) }), NOW, none)).toEqual({
      until: reset * 1000,
      strikes: 0,
    });
  });

  test("429 without headers backs off exponentially, capped at 60 min", () => {
    let b = nextBackoff(429, h({}), NOW, none);
    expect(b).toEqual({ until: NOW + 60_000, strikes: 1 });
    b = nextBackoff(429, h({}), NOW, b);
    expect(b).toEqual({ until: NOW + 120_000, strikes: 2 });
    expect(nextBackoff(429, h({}), NOW, { until: 0, strikes: 20 }).until).toBe(NOW + 3_600_000);
  });

  test("success with Remaining 0 waits for Reset; otherwise clears", () => {
    const reset = NOW / 1000 + 45;
    const headers = h({
      "x-sentry-rate-limit-remaining": "0",
      "x-sentry-rate-limit-reset": String(reset),
    });
    expect(nextBackoff(200, headers, NOW, { until: 0, strikes: 3 })).toEqual({
      until: reset * 1000,
      strikes: 0,
    });
    expect(nextBackoff(200, h({ "x-sentry-rate-limit-remaining": "5" }), NOW, none)).toEqual(none);
  });
});

describe("client", () => {
  test("apiUrl joins host, path and encodes the query", () => {
    expect(
      apiUrl("https://sentry.io/", "organizations/o/issues/", { query: "a b", project: "-1" }),
    ).toBe("https://sentry.io/api/0/organizations/o/issues/?query=a+b&project=-1");
  });

  test("sentryGet sends the bearer token and parses JSON", async () => {
    let seen: RequestInit | undefined;
    const fetch: Fetch = async (_url, init) => {
      seen = init;
      return new Response("[1]", { status: 200 });
    };
    const r = await sentryGet({ fetch, host: "https://s.io", token: "tok" }, "x/");
    expect(r).toMatchObject({ ok: true, data: [1] });
    expect((seen!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  test("sentryGet reports HTTP errors, network failures and oversize bodies without throwing", async () => {
    const c = (fetch: Fetch) => ({ fetch, host: "https://s.io", token: "tok" });
    expect(
      await sentryGet(
        c(async () => new Response("", { status: 429 })),
        "x/",
      ),
    ).toMatchObject({
      ok: false,
      status: 429,
    });
    const net = await sentryGet(
      c(async () => {
        throw new TypeError("boom tok");
      }),
      "x/",
    );
    expect(net.ok).toBe(false);
    expect(JSON.stringify(net)).not.toContain('tok"');
    const big = await sentryGet(
      c(async () => new Response("1", { headers: { "content-length": String(3 * 1024 * 1024) } })),
      "x/",
    );
    expect(big).toMatchObject({ ok: false, error: "response too large" });
  });
});
