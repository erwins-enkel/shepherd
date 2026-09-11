import { describe, expect, it } from "vitest";
import config from "../../vite.config";

describe("vite config browser project", () => {
  const projects = (config.test as { projects?: unknown[] })?.projects ?? [];
  const browserProject = projects.find(
    (p) => (p as { test?: { name?: string } })?.test?.name === "browser",
  ) as { test?: { api?: { strictPort?: boolean } } } | undefined;

  it("has a project named browser", () => {
    expect(browserProject).toBeDefined();
  });

  it("sets api.strictPort = false to avoid port 63315 collision (#817)", () => {
    // vitest browser mode defaults its server to port 63315 with strictPort on;
    // without this, concurrent test runs hard-fail. strictPort:false lets Vite
    // pick the next free port and hand it to the browser client. vitest 5 moved
    // this option off `browser.api` onto the project's `test.api`.
    expect(browserProject?.test?.api?.strictPort).toBe(false);
  });
});
