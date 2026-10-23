import { describe, expect, it } from "vitest";
import { glossaryById, glossaryMessage } from "./glossary";

// GlossaryTerm resolves keys through a `gloss_*`-scoped glob (#3242); a key outside
// that family would exist in the catalogs yet render blank.
describe("glossary keys resolve through glossaryMessage", () => {
  it("every termKey/bodyKey resolves", () => {
    const missing = [...glossaryById.values()]
      .flatMap((t) => [t.termKey, t.bodyKey])
      .filter((k) => !glossaryMessage(k));
    expect(missing).toEqual([]);
  });
});
