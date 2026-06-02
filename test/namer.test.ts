import { test, expect } from "bun:test";
import { generateName, normalize, slugifyManual } from "../src/namer";

test("normalize → lowercase kebab, max 3 topical words", () => {
  expect(normalize("Flatten-Repo-Button-Addition Extra")).toBe("flatten-repo-button");
  expect(normalize("Add status lights to cards")).toBe("status-lights-cards");
});

test("normalize transliterates umlauts before slugging", () => {
  // umlauts in topical words survive as readable ascii ("w-rde" would be the bug)
  expect(normalize("Größe ändern")).toBe("groesse-aendern");
  // transliteration runs BEFORE the stopword lookup: "würde" → "wuerde" matches
  // the ascii stopword and is dropped, leaving the one topical word.
  expect(normalize("Ich würde gerne scrollen")).toBe("scrollen");
});

test("normalize drops filler words and German exclamations", () => {
  expect(normalize("Mist. Scrollen mit dem Mausrad geht nicht")).toBe("scrollen-mausrad-geht");
});

test("normalize falls back to raw words when all words are stopwords", () => {
  // every token is a stopword → keep the raw first three rather than ""
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
  // unlike normalize(), an intentional name keeps fillers — "the"/"my" stay
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
  const s = slugifyManual("a ".repeat(80)); // 80 single-letter words → long dashed run
  expect(s.length).toBeLessThanOrEqual(60);
  expect(s.endsWith("-")).toBe(false);
});

// --- Command-prefix strip tests ---

test("normalize strips leading 'pruefe ob' boilerplate but keeps topical words", () => {
  // 'Prüfe, ob …' — [,\s]+ in COMMAND_PREFIX_RE now matches the comma form too.
  // Pipeline: transliterate → lowercase → prefix strip ('pruefe, ob ' consumed) →
  // tokenize → drop stopwords (dieses, ist, und, ob, die, noch, aktuell) →
  // first 3 meaningful: [issue, relevant, pr]
  expect(
    normalize("Prüfe, ob dieses Issue noch relevant ist und ob die PR noch aktuell ist."),
  ).toBe("issue-relevant-pr");
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
