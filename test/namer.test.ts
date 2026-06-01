import { test, expect } from "bun:test";
import { generateName, normalize } from "../src/namer";

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
