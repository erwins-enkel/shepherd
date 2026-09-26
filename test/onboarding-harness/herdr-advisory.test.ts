import { describe, expect, it } from "bun:test";
import { advisoryLine, checkHerdrCeiling } from "../../ci/onboarding-harness/herdr-advisory";

describe("checkHerdrCeiling", () => {
  it("flags ahead when latest exceeds the ceiling", async () => {
    expect(await checkHerdrCeiling(async () => ({ version: "v0.10.0" }), "0.9.1")).toEqual({
      latest: "0.10.0",
      ceiling: "0.9.1",
      ahead: true,
    });
  });

  it("is not ahead when latest equals or trails the ceiling", async () => {
    expect((await checkHerdrCeiling(async () => ({ version: "0.9.1" }), "0.9.1"))?.ahead).toBe(
      false,
    );
    expect((await checkHerdrCeiling(async () => ({ version: "0.8.0" }), "0.9.1"))?.ahead).toBe(
      false,
    );
  });

  it("returns null (unknown) on a malformed payload", async () => {
    expect(await checkHerdrCeiling(async () => ({ version: "nope" }), "0.9.1")).toBeNull();
    expect(await checkHerdrCeiling(async () => ({ version: 7 }), "0.9.1")).toBeNull();
    expect(await checkHerdrCeiling(async () => null, "0.9.1")).toBeNull();
  });

  it("returns null (unknown) on a fetch failure", async () => {
    const failing = async (): Promise<unknown> => {
      throw new Error("offline");
    };
    expect(await checkHerdrCeiling(failing, "0.9.1")).toBeNull();
  });
});

describe("advisoryLine", () => {
  it("names both versions", () => {
    const line = advisoryLine({ latest: "0.10.0", ceiling: "0.9.1", ahead: true });
    expect(line).toContain("0.10.0");
    expect(line).toContain("0.9.1");
  });
});
