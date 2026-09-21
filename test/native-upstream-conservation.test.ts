import { expect, test } from "bun:test";
import {
  identity,
  verifyConservation,
  verifyUpstreamTransitions,
  type TestIdentity,
  type UpstreamTransition,
} from "../native/scripts/test-conservation";

const old: TestIdentity = {
  target: "ShepherdTests",
  path: "Fixture.swift",
  suite: "Fixture",
  signature: "manualStart()",
  line: 1,
  attributes: "@Test",
  condition: "",
  bodyHash: "original",
  assertionHashes: ["old"],
  assertionConditionHashes: ["old-condition"],
};
const source: TestIdentity = {
  ...old,
  signature: "automaticStart()",
  bodyHash: "upstream",
  assertionHashes: ["new"],
  assertionConditionHashes: ["new-condition"],
};
const destination = { ...source, path: "Moved.swift" };
const row = {
  oldID: identity(old),
  destinations: [identity(destination)],
  reason: "upstream rename",
  assertionChanges: [],
};
const transition: UpstreamTransition = {
  original: old,
  upstream: source,
  destination,
  reason: "Pinned upstream changes successful install to automatic start",
};
function verify(
  transitions = [transition],
  current = [destination],
  upstream = [source],
  added: string[] = [],
) {
  return verifyUpstreamTransitions([old], upstream, current, [row], transitions, added);
}
test("upstream successor preserves the immutable original and verifies its exact destination", () => {
  const effective = verify();
  expect(old.bodyHash).toBe("original");
  expect(effective[0]!.bodyHash).toBe("upstream");
  verifyConservation(effective, [destination], [row], []);
});
test("upstream omission and duplicate provenance fail closed", () => {
  expect(() => verify([])).toThrow();
  expect(() => verify([transition, transition])).toThrow();
});
test("neither original nor upstream snapshot can be recaptured to excuse a change", () => {
  expect(() => verify([{ ...transition, original: { ...old, bodyHash: "recaptured" } }])).toThrow();
  expect(() =>
    verify([{ ...transition, upstream: { ...source, bodyHash: "invented" } }]),
  ).toThrow();
});
test("destination body drift is rejected even with unchanged assertions", () => {
  expect(() => verify([transition], [{ ...destination, bodyHash: "changed" }])).toThrow();
});
test("rewriting destination provenance cannot hide assertion or trait loss", () => {
  for (const change of [
    { assertionConditionHashes: [] },
    { attributes: "" },
    { condition: "#if NEVER" },
  ]) {
    const changed = { ...destination, ...change };
    expect(() => verify([{ ...transition, destination: changed }], [changed])).toThrow();
  }
});
test("upstream additions are distinct from original successors and require exact accounting", () => {
  const extra = { ...source, signature: "newRecovery()" };
  const addition = {
    original: null,
    upstream: extra,
    destination: extra,
    reason: "New upstream recovery case",
  };
  expect(() => verify([transition, addition], [destination, extra], [source, extra])).toThrow();
  verify([transition, addition], [destination, extra], [source, extra], [identity(extra)]);
  expect(() => verify([{ ...transition, original: null }])).toThrow();
});

test("an unrelated upstream addition cannot substitute for a still-existing original", () => {
  expect(() => verify([transition], [destination], [old, source])).toThrow();
});
