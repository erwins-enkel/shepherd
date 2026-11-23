import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_GH_APP_ID_ENV,
  AGENT_GH_APP_KEY_FILE_ENV,
  AGENT_GH_APP_PERMISSIONS,
  GithubAppConfigError,
  GithubAppTokenMinter,
  githubAppJwt,
  githubOriginRepo,
  loadGithubAppKey,
  makeAgentGhAppToken,
  parseGithubSlug,
} from "../src/agent-gh-app";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-gh-app-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const writeFile = (name: string, content: string, mode: number) => {
  const p = join(root, name);
  writeFileSync(p, content);
  chmodSync(p, mode);
  return p;
};

/** Decode a JWT and check its RS256 signature against the test key pair. */
function decodeJwt(jwt: string, key: KeyObject = publicKey) {
  const [h, p, sig] = jwt.split(".");
  const json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  const valid = verify("sha256", Buffer.from(`${h}.${p}`), key, Buffer.from(sig!, "base64url"));
  return { header: json(h!), payload: json(p!), valid };
}

const NOW = Date.parse("2026-11-23T12:00:00Z");
const MIN = 60_000;

describe("githubAppJwt", () => {
  test("RS256, iat = now-60s, exp = now+9min, iss = numeric app id, valid signature", () => {
    const jwt = githubAppJwt("12345", privateKey, NOW + 999); // sub-second part truncated
    const { header, payload, valid } = decodeJwt(jwt);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload).toEqual({ iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: 12345 });
    expect(valid).toBe(true);
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    expect(decodeJwt(jwt, other).valid).toBe(false);
  });
});

describe("loadGithubAppKey", () => {
  test("0600 RSA PEM -> key", async () => {
    const key = await loadGithubAppKey(writeFile("app.pem", pem, 0o600));
    expect(key.asymmetricKeyType).toBe("rsa");
  });

  test("insecure, missing, directory, junk or non-RSA -> throws without key material", async () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const cases: [string, string][] = [
      [writeFile("loose.pem", pem, 0o640), "chmod 600"],
      [join(root, "nope.pem"), "ENOENT"],
      [root, "not a regular file"],
      [
        writeFile("junk.pem", "-----BEGIN PRIVATE KEY-----\nnope\n", 0o600),
        "not a PEM private key",
      ],
      [writeFile("ec.pem", ec, 0o600), "not an RSA key"],
    ];
    for (const [path, reason] of cases) {
      const err = await loadGithubAppKey(path).then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.message).toContain(reason);
      expect(err?.message).not.toContain("BEGIN");
      expect(err).toBeInstanceOf(GithubAppConfigError);
    }
  });
});

describe("parseGithubSlug", () => {
  test("owner/name only, with GitHub's name alphabet", () => {
    expect(parseGithubSlug("Acme-1/my.repo_x")).toEqual({ owner: "Acme-1", name: "my.repo_x" });
    for (const bad of ["a", "a/b/c", "/b", "a/", "a b/c", "a/..", "a/b?x", "a%2F/b"]) {
      expect(parseGithubSlug(bad)).toBeNull();
    }
  });
});

describe("githubOriginRepo", () => {
  const repoWith = (remotes: Record<string, string>) => {
    const dir = join(root, `repo-${Object.keys(remotes).join("-") || "none"}`);
    mkdirSync(dir);
    spawnSync("git", ["init", "-q", dir]);
    for (const [name, url] of Object.entries(remotes)) {
      spawnSync("git", ["-C", dir, "remote", "add", name, url]);
    }
    return dir;
  };

  test("github.com origin (scp or https) -> owner/name; fork mode -> the fork", () => {
    expect(githubOriginRepo(repoWith({ origin: "git@github.com:Acme/widget.git" }))).toEqual({
      owner: "Acme",
      name: "widget",
    });
    const fork = repoWith({
      origin: "https://github.com/me/widget.git",
      upstream: "https://github.com/acme/widget.git",
    });
    expect(githubOriginRepo(fork)).toEqual({ owner: "me", name: "widget" });
  });

  test("gitea/other host, no origin, or not a repo -> null", () => {
    expect(githubOriginRepo(repoWith({ origin: "https://git.example.com/o/r.git" }))).toBeNull();
    expect(githubOriginRepo(repoWith({}))).toBeNull();
    expect(githubOriginRepo(join(root, "missing"))).toBeNull();
  });
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch stub answering by `METHOD path`; records every request. */
function fakeGithub(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const route = routes[`${method} ${url.replace("https://api.github.com", "")}`];
    if (!route) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return route();
  }) as typeof fetch;
  return { calls, fetchFn };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const minted = (token: string, expiresAt: number) => () =>
  json(201, { token, expires_at: new Date(expiresAt).toISOString() });

const repo = { owner: "acme", name: "widget" };

describe("GithubAppTokenMinter", () => {
  const minter = (fetchFn: typeof fetch, clock: { now: number }, timeoutMs?: number) =>
    new GithubAppTokenMinter({
      appId: "12345",
      loadKey: async () => privateKey,
      fetch: fetchFn,
      now: () => clock.now,
      timeoutMs,
    });

  test("looks up the installation, mints a token for that repo only, with the App JWT", async () => {
    const gh = fakeGithub({
      "GET /repos/acme/widget/installation": () => json(200, { id: 42 }),
      "POST /app/installations/42/access_tokens": minted("ghs_abc123", NOW + 60 * MIN),
    });
    expect((await minter(gh.fetchFn, { now: NOW }).token(repo)).token).toBe("ghs_abc123");

    expect(gh.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/widget/installation",
      "POST https://api.github.com/app/installations/42/access_tokens",
    ]);
    for (const c of gh.calls) {
      expect(c.headers.Accept).toBe("application/vnd.github+json");
      expect(c.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
      const [scheme, jwt] = c.headers.Authorization!.split(" ");
      expect(scheme).toBe("Bearer");
      const { payload, valid } = decodeJwt(jwt!);
      expect(valid).toBe(true);
      expect(payload.iss).toBe(12345);
    }
    expect(gh.calls[1]!.body).toEqual({
      repositories: ["widget"],
      permissions: {
        contents: "write",
        pull_requests: "write",
        issues: "write",
        metadata: "read",
        checks: "read",
        statuses: "read",
        actions: "read",
      },
    });
    expect(gh.calls[1]!.body).toEqual({
      repositories: ["widget"],
      permissions: AGENT_GH_APP_PERMISSIONS,
    });
  });

  test("reuses the token until 20 min before expiry, then re-mints without a new lookup", async () => {
    let n = 0;
    const gh = fakeGithub({
      "GET /repos/acme/widget/installation": () => json(200, { id: 42 }),
      "POST /app/installations/42/access_tokens": () =>
        json(201, {
          token: `ghs_t${++n}`,
          expires_at: new Date(NOW + (n === 1 ? 60 : 120) * MIN).toISOString(),
        }),
    });
    const clock = { now: NOW };
    const m = minter(gh.fetchFn, clock);
    expect((await m.token(repo)).token).toBe("ghs_t1");
    clock.now = NOW + 39 * MIN; // 21 min left: reuse
    expect((await m.token({ owner: "ACME", name: "Widget" })).token).toBe("ghs_t1");
    expect(gh.calls).toHaveLength(2);
    clock.now = NOW + 41 * MIN; // 19 min left: re-mint, installation still cached
    expect((await m.token(repo)).token).toBe("ghs_t2");
    expect(gh.calls.map((c) => c.method)).toEqual(["GET", "POST", "POST"]);
  });

  test("concurrent callers for one repo share a single lookup + mint", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gh = fakeGithub({
      "GET /repos/acme/widget/installation": async () => (await gate, json(200, { id: 42 })),
      "POST /app/installations/42/access_tokens": minted("ghs_once", NOW + 60 * MIN),
    });
    const m = minter(gh.fetchFn, { now: NOW });
    const all = Promise.all([m.token(repo), m.token(repo), m.token(repo)]);
    await Bun.sleep(0);
    release();
    expect((await all).map((t) => t.token)).toEqual(["ghs_once", "ghs_once", "ghs_once"]);
    expect(gh.calls).toHaveLength(2);
  });

  test("caches installations per owner/repo and tokens per installation + repo", async () => {
    const gh = fakeGithub({
      "GET /repos/acme/widget/installation": () => json(200, { id: 42 }),
      "GET /repos/acme/gadget/installation": () => json(200, { id: 42 }),
      "POST /app/installations/42/access_tokens": minted("ghs_x", NOW + 60 * MIN),
    });
    const m = minter(gh.fetchFn, { now: NOW });
    await m.token(repo);
    await m.token({ owner: "acme", name: "gadget" });
    await m.token({ owner: "acme", name: "gadget" });
    expect(
      gh.calls.map((c) => `${c.method} ${c.url.replace("https://api.github.com", "")}`),
    ).toEqual([
      "GET /repos/acme/widget/installation",
      "POST /app/installations/42/access_tokens",
      "GET /repos/acme/gadget/installation",
      "POST /app/installations/42/access_tokens",
    ]);
    expect(gh.calls[3]!.body).toMatchObject({ repositories: ["gadget"] });
  });

  /** The rejection of `p`, asserting it leaks neither the JWT nor a token. */
  async function rejection(p: Promise<unknown>): Promise<Error> {
    const err = await p.then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toMatch(/eyJ|ghs_/);
    return err!;
  }
  const failure = async (p: Promise<unknown>) => (await rejection(p)).message;

  test("no installation (404), API errors, malformed bodies -> throws naming the reason", async () => {
    const cases: [Record<string, () => Response>, string][] = [
      [{}, "not installed on acme/widget (HTTP 404)"],
      [
        { "GET /repos/acme/widget/installation": () => json(500, { message: "boom" }) },
        "installation lookup for acme/widget: HTTP 500 (boom)",
      ],
      [{ "GET /repos/acme/widget/installation": () => json(200, { id: "42" }) }, "malformed"],
      [
        {
          "GET /repos/acme/widget/installation": () => json(200, { id: 42 }),
          "POST /app/installations/42/access_tokens": () =>
            json(422, {
              message: "The permissions requested are not granted to this installation.",
            }),
        },
        "token mint for acme/widget: HTTP 422 (The permissions requested are not granted",
      ],
      [
        {
          "GET /repos/acme/widget/installation": () => json(200, { id: 42 }),
          "POST /app/installations/42/access_tokens": () => json(201, { token: "ghs_x" }),
        },
        "token mint for acme/widget: malformed response",
      ],
      [
        {
          "GET /repos/acme/widget/installation": () => json(200, { id: 42 }),
          "POST /app/installations/42/access_tokens": () => new Response("<html>", { status: 502 }),
        },
        "HTTP 502",
      ],
    ];
    for (const [routes, reason] of cases) {
      const gh = fakeGithub(routes);
      expect(await failure(minter(gh.fetchFn, { now: NOW }).token(repo))).toContain(reason);
    }
  });

  test("App refused (401/404/422) or key unusable -> GithubAppConfigError; else transient", async () => {
    const lookup = (status: number) => ({
      "GET /repos/acme/widget/installation": () => json(status, { message: "x" }),
    });
    const mint = (status: number, body: unknown = { message: "x" }) => ({
      "GET /repos/acme/widget/installation": () => json(200, { id: 42 }),
      "POST /app/installations/42/access_tokens": () => json(status, body),
    });
    const cases: [Record<string, () => Response>, boolean][] = [
      [lookup(404), true],
      [lookup(401), true],
      [mint(404), true],
      [mint(401), true],
      [mint(422), true],
      [lookup(500), false],
      [mint(502), false],
      [mint(403), false], // secondary rate limit
      [mint(429), false],
      [mint(201, { token: "ghs_x" }), false], // malformed
    ];
    for (const [routes, config] of cases) {
      const err = await rejection(minter(fakeGithub(routes).fetchFn, { now: NOW }).token(repo));
      expect([err.message, err instanceof GithubAppConfigError]).toEqual([err.message, config]);
    }
    const down = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await rejection(minter(down, { now: NOW }).token(repo))).not.toBeInstanceOf(
      GithubAppConfigError,
    );
    const badKey = new GithubAppTokenMinter({
      appId: "12345",
      loadKey: async () => {
        throw new Error("EACCES");
      },
      fetch: down,
    });
    expect(await rejection(badKey.token(repo))).toBeInstanceOf(GithubAppConfigError);
  });

  test("mint 404 (App reinstalled) drops the cached installation", async () => {
    let installed = 42;
    const gh = fakeGithub({
      "GET /repos/acme/widget/installation": () => json(200, { id: installed }),
      "POST /app/installations/77/access_tokens": minted("ghs_new", NOW + 60 * MIN),
    });
    const m = minter(gh.fetchFn, { now: NOW });
    expect(await failure(m.token(repo))).toContain("HTTP 404");
    installed = 77;
    expect((await m.token(repo)).token).toBe("ghs_new");
  });

  test("network error or timeout -> throws", async () => {
    const down = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await failure(minter(down, { now: NOW }).token(repo))).toContain(
      "installation lookup failed: connect ECONNREFUSED",
    );
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    expect(await failure(minter(hang, { now: NOW }, 20).token(repo))).toContain("timed out");
  });

  test("key unusable -> throws before any request, even with a cached token", async () => {
    const gh = fakeGithub({
      "GET /repos/acme/widget/installation": () => json(200, { id: 42 }),
      "POST /app/installations/42/access_tokens": minted("ghs_x", NOW + 60 * MIN),
    });
    let keyOk = true;
    const m = new GithubAppTokenMinter({
      appId: "12345",
      loadKey: async () => {
        if (!keyOk) throw new Error("app.pem is readable by group/other (chmod 600)");
        return privateKey;
      },
      fetch: gh.fetchFn,
      now: () => NOW,
    });
    await m.token(repo);
    keyOk = false;
    expect(await failure(m.token(repo))).toContain("chmod 600");
    expect(gh.calls).toHaveLength(2);
  });
});

describe("makeAgentGhAppToken", () => {
  const noRepoLookup = () => {
    throw new Error("repo must not be resolved");
  };
  const noFetch = (async () => {
    throw new Error("no request expected");
  }) as unknown as typeof fetch;

  test("App mode not configured -> null, repo never resolved", async () => {
    expect(await makeAgentGhAppToken({ env: {}, githubRepo: noRepoLookup })("/r")).toBeNull();
    const blank = { [AGENT_GH_APP_ID_ENV]: " ", [AGENT_GH_APP_KEY_FILE_ENV]: "" };
    expect(await makeAgentGhAppToken({ env: blank, githubRepo: noRepoLookup })("/r")).toBeNull();
  });

  test("half-configured, non-numeric id, or non-GitHub repo -> throws", async () => {
    const key = writeFile("app.pem", pem, 0o600);
    const cases: [NodeJS.ProcessEnv, string][] = [
      [{ [AGENT_GH_APP_ID_ENV]: "12345" }, "needs both"],
      [{ [AGENT_GH_APP_KEY_FILE_ENV]: key }, "needs both"],
      [{ [AGENT_GH_APP_ID_ENV]: "Iv1.abc", [AGENT_GH_APP_KEY_FILE_ENV]: key }, "numeric App ID"],
      [
        { [AGENT_GH_APP_ID_ENV]: "12345", [AGENT_GH_APP_KEY_FILE_ENV]: key },
        "no github.com origin",
      ],
    ];
    for (const [env, reason] of cases) {
      const tokenFor = makeAgentGhAppToken({ env, githubRepo: () => null, fetch: noFetch });
      await expect(tokenFor("/r")).rejects.toThrow(reason);
      await expect(tokenFor("/r")).rejects.toBeInstanceOf(GithubAppConfigError);
    }
  });

  test("configured -> mints for the repo's GitHub origin; caches across calls", async () => {
    const env = {
      [AGENT_GH_APP_ID_ENV]: "12345",
      [AGENT_GH_APP_KEY_FILE_ENV]: writeFile("app.pem", pem, 0o600),
    };
    const gh = fakeGithub({
      "GET /repos/acme/widget/installation": () => json(200, { id: 42 }),
      "POST /app/installations/42/access_tokens": minted("ghs_scoped", NOW + 60 * MIN),
    });
    const seen: string[] = [];
    const tokenFor = makeAgentGhAppToken({
      env,
      fetch: gh.fetchFn,
      now: () => NOW,
      githubRepo: (p) => (seen.push(p), repo),
    });
    expect(await tokenFor("/repos/widget")).toEqual({
      token: "ghs_scoped",
      expiresAt: NOW + 60 * MIN,
    });
    expect((await tokenFor("/repos/widget"))?.token).toBe("ghs_scoped");
    expect(seen).toEqual(["/repos/widget", "/repos/widget"]);
    expect(gh.calls).toHaveLength(2);
  });

  test("insecure key file -> throws, no request", async () => {
    const env = {
      [AGENT_GH_APP_ID_ENV]: "12345",
      [AGENT_GH_APP_KEY_FILE_ENV]: writeFile("app.pem", pem, 0o644),
    };
    const tokenFor = makeAgentGhAppToken({ env, fetch: noFetch, githubRepo: () => repo });
    await expect(tokenFor("/r")).rejects.toThrow("chmod 600");
  });
});
