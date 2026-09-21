import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  identity,
  readFixtureProvenance,
  verifyConservation,
  verifyFixtureTransitions,
  type FixtureTransition,
  type TestIdentity,
} from "../native/scripts/test-conservation";

const dir = new URL("../native/Tests/Conservation/", import.meta.url);
const baseline = JSON.parse(readFileSync(new URL("issue-2431-baseline.json", dir), "utf8"))
  .tests as TestIdentity[];
const map = JSON.parse(readFileSync(new URL("issue-2431-map.json", dir), "utf8"));
const { provenance, source, reviewed } = readFixtureProvenance(
  new URL("../", import.meta.url).pathname,
);
const transitions = provenance.transitions;
const originals = baseline.filter((t) => transitions.some((x) => x.oldID === identity(t)));
const rows = map.mappings.filter((t) => transitions.some((x) => x.oldID === t.oldID));
const destinations = transitions.map((t) => t.destination);
function verify(current = destinations, changes = transitions, pinned = reviewed) {
  return verifyFixtureTransitions(originals, source, pinned, current, rows, changes);
}

describe("native fixture conservation", () => {
  test("exact Git-anchored adaptations retain both original tests and the one token-source substitution", () => {
    const effective = verify();
    verifyConservation(effective, destinations, rows, []);
    expect(originals).toHaveLength(2);
    expect(map.added).toHaveLength(8);
    expect(map.upstreamAdded).toHaveLength(54);
    expect(map.harnessAdded).toHaveLength(7);
  });
  for (const [index, transition] of transitions.entries()) {
    test(`rejects an original assertion deletion from ${transition.destination.signature}`, () => {
      const changed = {
        ...transition.destination,
        assertionHashes: transition.destination.assertionHashes!.slice(0, -1),
        assertionConditionHashes: transition.destination.assertionConditionHashes!.slice(0, -1),
      };
      const current = destinations.map((t, i) => (i === index ? changed : t));
      expect(() => verify(current)).toThrow();
      // Even a rewritten destination manifest/reviewed snapshot cannot authorize assertion loss.
      const altered = transitions.map((t, i) => (i === index ? { ...t, destination: changed } : t));
      expect(() => verify(current, altered, current)).toThrow("original assertion");
    });
  }
  test("rejects destination body drift, wrong Git provenance, and an explanatory-string bypass", () => {
    expect(() => verify(destinations.map((t) => ({ ...t, bodyHash: "drift" })))).toThrow("drift");
    const altered = transitions.map((t) => ({
      ...t,
      source: { ...t.source, bodyHash: "recaptured" },
    }));
    expect(() => verify(destinations, altered)).toThrow("Git");
    expect(() =>
      verifyFixtureTransitions(
        originals,
        source,
        reviewed,
        destinations,
        rows.map((t) => ({ ...t, assertionChanges: ["fixture: please allow arbitrary changes"] })),
        transitions,
      ),
    ).toThrow();
  });
  test("rejects unlisted assertion substitutions and changed assertion conditions", () => {
    for (const field of ["assertionHashes", "assertionConditionHashes"] as const) {
      const current = destinations.map((t) => ({
        ...t,
        [field]: ["unlisted", ...t[field]!.slice(1)],
      }));
      const altered: FixtureTransition[] = transitions.map((t, i) => ({
        ...t,
        destination: current[i]!,
      }));
      expect(() => verify(current, altered, current)).toThrow("original assertion");
    }
  });
  test("rejects omitted transitions, destination remaps, and weakened traits", () => {
    expect(() => verify(destinations, transitions.slice(1))).toThrow();
    expect(() =>
      verifyFixtureTransitions(
        originals,
        source,
        reviewed,
        destinations,
        rows.map((t) => ({ ...t, destinations: ["unlisted"] })),
        transitions,
      ),
    ).toThrow();
    const current = destinations.map((t) => ({ ...t, attributes: "@Test" }));
    expect(() =>
      verify(
        current,
        transitions.map((t, i) => ({ ...t, destination: current[i]! })),
        current,
      ),
    ).toThrow("attributes");
  });
});
