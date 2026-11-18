import { afterEach, expect, test, vi } from "vitest";
import { getRepoConfigProject, putRepoConfig, ApiError } from "./api";
afterEach(() => vi.unstubAllGlobals());
test("shared metadata/project reads encode the forge identity and write all three previously missing types", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({}));
  vi.stubGlobal("fetch", fetcher);
  await getRepoConfigProject("owner/repo");
  expect(fetcher.mock.calls[0][0]).toContain("remoteSlug=owner%2Frepo");
  await putRepoConfig("/a b", {
    draftMode: true,
    buildQueueEnabled: true,
    egressExtraHosts: ["example.com"],
  });
  expect(fetcher.mock.calls[1][0]).toBe("/api/repo-config?repo=%2Fa%20b");
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
    draftMode: true,
    buildQueueEnabled: true,
    egressExtraHosts: ["example.com"],
  });
});
test("rule push errors preserve their structured status/code", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ code: "repo_config_write_failed", error: "failure" }, { status: 502 }),
    ),
  );
  await expect(putRepoConfig("/r", { draftMode: true })).rejects.toMatchObject({
    status: 502,
    code: "repo_config_write_failed",
  } satisfies Partial<ApiError>);
});
