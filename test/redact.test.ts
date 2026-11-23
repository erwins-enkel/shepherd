import { expect, test } from "bun:test";
import { redactSecretText } from "../src/redact";
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
