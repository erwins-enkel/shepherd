import { test, expect } from "bun:test";
import { generateName, normalize } from "../src/namer";

test("normalize → lowercase kebab, keeps first 2 meaningful words", () => {
  expect(normalize("Flatten-Repo-Button-Addition Extra")).toBe("flatten-repo");
  expect(normalize("  Make a FAVICON!! ")).toBe("favicon"); // "make"/"a" are filler
});

test("normalize drops filler and keeps the topic", () => {
  // the motivating case: a conversational German prompt → its core, not its opening
  expect(normalize("Mist. Scrollen mit dem Mausrad im Terminal geht nicht")).toBe(
    "scrollen-mausrad",
  );
});

test("normalize transliterates umlauts instead of destroying them", () => {
  expect(normalize("Türgriffe übernehmen")).toBe("tuergriffe-uebernehmen");
  expect(normalize("Größe anpassen")).toBe("groesse-anpassen");
});

test("normalize falls back to raw words when everything is filler", () => {
  // all stopwords → keep the raw words rather than returning ""
  expect(normalize("ich würde mich")).toBe("ich-wuerde");
});

test("generateName uses ollama response and marks it ai", async () => {
  const fake = async () => new Response(JSON.stringify({ response: "Repo Flatten Feature" }));
  expect(await generateName("flatten the repo", { fetchImpl: fake as any })).toEqual({
    name: "repo-flatten",
    source: "ai",
  });
});

test("generateName falls back to prompt heuristic on failure", async () => {
  const fake = async () => {
    throw new Error("ollama down");
  };
  expect(await generateName("Add status lights to cards", { fetchImpl: fake as any })).toEqual({
    name: "status-lights",
    source: "fallback",
  });
});

test("generateName falls back when the model is missing (404 / error payload)", async () => {
  const missing = async () =>
    new Response(JSON.stringify({ error: "model 'x' not found" }), { status: 404 });
  expect(await generateName("Add a screenshot paste", { fetchImpl: missing as any })).toEqual({
    name: "screenshot-paste",
    source: "fallback",
  });
});
