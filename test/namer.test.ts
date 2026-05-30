import { test, expect } from "bun:test";
import { generateName, normalize } from "../src/namer";

test("normalize → lowercase kebab, max 4 words", () => {
  expect(normalize("Flatten-Repo-Button-Addition Extra")).toBe("flatten-repo-button-addition");
  expect(normalize("  Make a FAVICON!! ")).toBe("make-a-favicon");
});

test("generateName uses ollama response", async () => {
  const fake = async () => new Response(JSON.stringify({ response: "Repo Flatten Feature" }));
  expect(await generateName("flatten the repo", { fetchImpl: fake as any })).toBe(
    "repo-flatten-feature",
  );
});

test("generateName falls back to prompt on failure", async () => {
  const fake = async () => {
    throw new Error("ollama down");
  };
  expect(await generateName("Add status lights to cards", { fetchImpl: fake as any })).toBe(
    "add-status-lights-to",
  );
});
