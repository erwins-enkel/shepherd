import { test, expect } from "bun:test";
import { generateName, normalize, slugifyManual } from "../src/namer";

test("normalize keeps the topical words, dropping common ones, up to 4", () => {
  // direct command: subject leads, every word is specific → kept in order
  expect(normalize("Add status lights to cards")).toBe("status-lights-cards");
  // five specific words → capped at four
  expect(normalize("Refactor parser tokenizer lexer evaluator")).toBe(
    "refactor-parser-tokenizer-lexer",
  );
});

test("normalize pulls the subject out of prose, ignoring leading filler", () => {
  // the subject ("export") sits late behind frame + common words ("wondering",
  // "maybe", "make", "button", "little", "more") — positional namers miss it
  expect(
    normalize("I was wondering if maybe we could make the export button a little more obvious"),
  ).toBe("export-obvious");
  // "weird thing where … top … every" are frame/common; the real subject survives
  expect(
    normalize(
      "There's a weird thing where the diff viewport scrolls to the top on every keystroke",
    ),
  ).toBe("diff-viewport-scrolls-keystroke");
});

test("normalize pulls the subject out of German prose", () => {
  // frame words (koenntest, warum, schauen, mal) drop; "vielleicht" is common
  expect(
    normalize("Könntest du vielleicht mal schauen warum die Benachrichtigungen doppelt ankommen?"),
  ).toBe("benachrichtigungen-doppelt-ankommen");
  // "geht", "ansicht", "irgendwie", "mehr" are common and yield to the specific words
  expect(
    normalize("Mist, das Scrollen mit dem Mausrad geht in der Diff-Ansicht irgendwie nicht mehr"),
  ).toBe("scrollen-mausrad-diff");
});

test("normalize transliterates umlauts before slugging", () => {
  expect(normalize("Größe ändern")).toBe("groesse-aendern");
  // "würde"→"wuerde" matches the ascii stopword and drops; "gerne" is a stopword too
  expect(normalize("Ich würde gerne scrollen")).toBe("scrollen");
});

test("normalize drops common filler but keeps the specific subject", () => {
  // "geht" is now a common word, so it yields to the two specific nouns
  expect(normalize("Mist. Scrollen mit dem Mausrad geht nicht")).toBe("scrollen-mausrad");
});

test("normalize keeps common words only when nothing more specific remains", () => {
  // every survivor is common → keep them rather than emit nothing
  expect(normalize("Make the button nice")).toBe("button-nice");
});

test("normalize falls back to raw words when all words are stopwords", () => {
  expect(normalize("und der die")).toBe("und-der-die");
});

test("normalize returns empty string for symbol-only input", () => {
  expect(normalize("!!! ??? ...")).toBe("");
});

test("generateName slugs the prompt, defaulting to 'task' when empty", () => {
  expect(generateName("Flatten the repo")).toBe("flatten-repo");
  expect(generateName("!!!")).toBe("task");
});

test("slugifyManual keeps every word the user typed (no stopword stripping)", () => {
  expect(slugifyManual("Fix the login bug")).toBe("fix-the-login-bug");
  expect(slugifyManual("My Cool Name")).toBe("my-cool-name");
});

test("slugifyManual transliterates accents and collapses separators", () => {
  expect(slugifyManual("Größe ändern")).toBe("groesse-aendern");
  expect(slugifyManual("  spaced   __  out  ")).toBe("spaced-out");
});

test("slugifyManual falls back to 'task' for symbol-only input", () => {
  expect(slugifyManual("!!! ??? ...")).toBe("task");
});

test("slugifyManual caps length without a trailing dash", () => {
  const s = slugifyManual("a ".repeat(80));
  expect(s.length).toBeLessThanOrEqual(60);
  expect(s.endsWith("-")).toBe(false);
});

// --- Command-prefix strip tests ---

test("normalize strips leading 'pruefe ob' boilerplate but keeps topical words", () => {
  // 'Prüfe, ob …' — [,\s]+ in COMMAND_PREFIX_RE now matches the comma form too.
  // Pipeline: transliterate → lowercase → prefix strip ('pruefe, ob ' consumed) →
  // tokenize → drop stopwords (dieses, ist, und, ob, die, noch) →
  // meaningful: [issue, relevant, pr, aktuell]; #201's 4-word cap keeps all four.
  expect(
    normalize("Prüfe, ob dieses Issue noch relevant ist und ob die PR noch aktuell ist."),
  ).toBe("issue-relevant-pr-aktuell");
});

test("normalize strips leading 'pruefe ob' (no comma) and returns only topical words", () => {
  // No comma → COMMAND_PREFIX_RE matches 'pruefe ob' → stripped entirely
  // Pipeline: transliterate → lowercase → prefix strip ('pruefe ob ' consumed) →
  // tokenize → drop stopwords (dieses) → meaningful: [issue, relevant]
  expect(normalize("Pruefe ob dieses Issue relevant")).toBe("issue-relevant");
});

test("normalize prefix strip is anchored at the START — a later 'gib' survives", () => {
  // 'gib mir' at start → COMMAND_PREFIX_RE matches → stripped to "".
  // In contrast, 'gib' appearing mid-sentence is never stripped.
  expect(normalize("gib mir einen Überblick über das System")).toBe("ueberblick-system");
  // Mid-sentence 'gib' is not a stopword, so it contributes to the slug.
  // 'Endpoint kann nicht gib mir status': no prefix at start → no strip;
  // stopwords dropped (kann, nicht, mir); meaningful: [endpoint, gib, status]
  expect(normalize("Endpoint kann nicht gib mir status")).toBe("endpoint-gib-status");
});

test("generateName falls back to 'task' when the prompt is only a command prefix", () => {
  // 'Gib mir' → lowercase 'gib mir' → prefix matched, consumed entirely → ''
  // normalize('') → '' → generateName returns 'task'
  expect(generateName("Gib mir")).toBe("task");
});

test("normalize drops new stopwords ob, bis, denn", () => {
  // 'läuft das bis morgen denn'
  // transliterate: 'laeuft das bis morgen denn'
  // no prefix strip; tokenize → [laeuft, das, bis, morgen, denn]
  // drop stopwords (das, bis, denn); meaningful: [laeuft, morgen]
  expect(normalize("läuft das bis morgen denn")).toBe("laeuft-morgen");
});
