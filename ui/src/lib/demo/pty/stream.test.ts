import { describe, it, expect } from "vitest";
import { ptyStream } from "./stream";

describe("ptyStream", () => {
  it("delivers pushed bytes to subscribers of the same id only", () => {
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = ptyStream.subscribe("coupon", (bytes) => a.push(bytes));
    const unsubB = ptyStream.subscribe("neon", (bytes) => b.push(bytes));

    ptyStream.push("coupon", "hi");
    expect(a).toEqual(["hi"]);
    expect(b).toEqual([]); // wrong id — not delivered

    ptyStream.push("neon", "yo");
    expect(a).toEqual(["hi"]);
    expect(b).toEqual(["yo"]);

    unsubA();
    unsubB();
  });

  it("stops delivering after unsubscribe", () => {
    const got: string[] = [];
    const unsub = ptyStream.subscribe("coupon", (bytes) => got.push(bytes));
    ptyStream.push("coupon", "one");
    unsub();
    ptyStream.push("coupon", "two");
    expect(got).toEqual(["one"]);
  });

  it("push to an id with no subscribers is a silent no-op", () => {
    expect(() => ptyStream.push("nobody", "x")).not.toThrow();
  });

  it("fans out to multiple subscribers of the same id", () => {
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = ptyStream.subscribe("coupon", (x) => a.push(x));
    const unsubB = ptyStream.subscribe("coupon", (x) => b.push(x));
    ptyStream.push("coupon", "z");
    expect(a).toEqual(["z"]);
    expect(b).toEqual(["z"]);
    unsubA();
    unsubB();
  });
});
