import { describe, expect, it } from "vitest";
import { basename } from "./basename";

describe("basename", () => {
  it("takes the last path segment", () => expect(basename("/home/u/acme")).toBe("acme"));
  it("tolerates trailing slash", () => expect(basename("/home/u/acme/")).toBe("acme"));
});
