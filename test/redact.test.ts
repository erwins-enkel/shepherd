import { expect, test } from "bun:test";
import { redactKnownSecretValues, redactSecretText, setKnownSecretValues } from "../src/redact";
import { CURRENT_GHS_TOKEN } from "./helpers/gh-token-shapes";

test("redactSecretText: a current-format App installation token is redacted whole", () => {
  expect(redactSecretText(`push failed with ${CURRENT_GHS_TOKEN} as auth`)).toBe(
    "push failed with <redacted> as auth",
  );
});

test("redactSecretText: classic gh tokens still redacted; trailing sentence dot survives", () => {
  expect(redactSecretText("leaked ghp_abcdefghijklmnop.")).toBe("leaked <redacted>.");
  expect(redactSecretText("gho_ABCDEFGHIJKLMNOPQRSTUV and sk-proj_abcdefgh12")).toBe(
    "<redacted> and <redacted>",
  );
});

test("redactKnownSecretValues: registered values redacted longest-first; short ones ignored", () => {
  setKnownSecretValues(["abcd1234", "abcd1234-TAIL", "xyz"]);
  try {
    expect(redactKnownSecretValues("a abcd1234-TAIL b abcd1234 c xyz")).toBe(
      "a <redacted> b <redacted> c xyz",
    );
    expect(redactSecretText("out: s3cr3t abcd1234")).toBe("out: s3cr3t <redacted>");
  } finally {
    setKnownSecretValues([]);
  }
  expect(redactKnownSecretValues("abcd1234")).toBe("abcd1234");
});
