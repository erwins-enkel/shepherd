import { expect, test } from "bun:test";
import { codexNoDaemonArgs } from "../src/codex-cli-capabilities";

test("codexNoDaemonArgs opts out of the shared server when the CLI supports it", () => {
  expect(
    codexNoDaemonArgs(() => "      --no-daemon\n          Run without the shared server\n"),
  ).toEqual(["--no-daemon"]);
});

test("codexNoDaemonArgs preserves older CLI compatibility", () => {
  expect(codexNoDaemonArgs(() => "      --no-alt-screen\n")).toEqual([]);
  expect(codexNoDaemonArgs(() => "      --no-daemon-extra\n")).toEqual([]);
});

test("codexNoDaemonArgs leaves startup to the CLI when the help probe fails", () => {
  expect(
    codexNoDaemonArgs(() => {
      throw new Error("binary unavailable");
    }),
  ).toEqual([]);
});
