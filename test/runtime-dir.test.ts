import { test, expect, afterEach } from "bun:test";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { shepherdRuntimeDir } from "../src/runtime-dir";

const savedXdg = process.env.XDG_RUNTIME_DIR;
const savedHome = process.env.HOME;

afterEach(() => {
  // Restore both env vars so a case cannot leak into the next.
  if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = savedXdg;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

test("uses $XDG_RUNTIME_DIR/shepherd when set", () => {
  process.env.XDG_RUNTIME_DIR = "/run/user/4242";
  expect(shepherdRuntimeDir("egress", "sess-1")).toBe(
    join("/run/user/4242", "shepherd", "egress", "sess-1"),
  );
  // Base with no sub-path.
  expect(shepherdRuntimeDir()).toBe(join("/run/user/4242", "shepherd"));
});

test("falls back to ~/.shepherd/run when XDG_RUNTIME_DIR is unset", () => {
  delete process.env.XDG_RUNTIME_DIR;
  process.env.HOME = "/home/tester";
  expect(shepherdRuntimeDir("shepherd-update.log")).toBe(
    join("/home/tester", ".shepherd", "run", "shepherd-update.log"),
  );
});

test("treats a blank XDG_RUNTIME_DIR as unset (fallback)", () => {
  process.env.XDG_RUNTIME_DIR = "   ";
  process.env.HOME = "/home/tester";
  expect(shepherdRuntimeDir("egress")).toBe(join("/home/tester", ".shepherd", "run", "egress"));
});

test("fallback base stays absolute when HOME is unset or relative", () => {
  delete process.env.XDG_RUNTIME_DIR;
  // Unset HOME → os.homedir() (always absolute), never a cwd-relative base.
  delete process.env.HOME;
  const unset = shepherdRuntimeDir("egress");
  expect(isAbsolute(unset)).toBe(true);
  expect(unset).toBe(join(homedir(), ".shepherd", "run", "egress"));
  // A relative HOME is rejected in favour of the absolute os.homedir().
  process.env.HOME = "relative/home";
  const relative = shepherdRuntimeDir("egress");
  expect(isAbsolute(relative)).toBe(true);
  expect(relative).toBe(join(homedir(), ".shepherd", "run", "egress"));
});
