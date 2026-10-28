import { expect, test } from "bun:test";
import { parseUpNextQuickStartsPatch, storedUpNextQuickStarts } from "../src/upnext-quick-starts";

const codex = { enabled: true, model: "gpt-6.1-sol", effort: "medium" };
const claude = { enabled: true, model: "claude-opus-5-5", effort: "high" };

test("accepts entries, defaults omitted model/effort to null and merges per CLI", () => {
  const first = parseUpNextQuickStartsPatch({ codex }, {});
  expect(first).toEqual({ ok: true, value: { codex } });
  const second = parseUpNextQuickStartsPatch(
    { claude: { enabled: false } },
    first.ok ? first.value : {},
  );
  expect(second).toEqual({
    ok: true,
    value: { claude: { enabled: false, model: null, effort: null }, codex },
  });
});

test("replaces a named CLI as a whole entry", () => {
  const r = parseUpNextQuickStartsPatch({ claude: { enabled: true } }, { claude });
  expect(r).toEqual({ ok: true, value: { claude: { enabled: true, model: null, effort: null } } });
});

test.each([
  [{}, "non-empty"],
  [null, "non-empty"],
  ["claude", "non-empty"],
  [{ gemini: claude }, "upnextQuickStarts.gemini"],
  [{ claude: "x" }, "upnextQuickStarts.claude must be an object"],
  [{ claude: { enabled: "yes" } }, "claude.enabled"],
  [{ claude: { model: "opus" } }, "claude.enabled"],
  [{ claude: { enabled: true, colour: 1 } }, "claude.colour"],
  [{ claude: { enabled: true, model: "gpt-6.1-sol" } }, "claude.model"],
  [{ codex: { enabled: true, model: "opus" } }, "codex.model"],
  [{ codex: { enabled: true, model: "gpt-99" } }, "codex.model"],
  [{ codex: { enabled: true, model: "default" } }, "codex.model"],
  [{ claude: { enabled: true, effort: "ultra" } }, "claude.effort"],
  [{ codex: { enabled: true, effort: "turbo" } }, "codex.effort"],
  [{ codex: { enabled: true, effort: 3 } }, "codex.effort"],
])("refuses %j", (body, fragment) => {
  const r = parseUpNextQuickStartsPatch(body, {});
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain(fragment);
});

test("an effort Codex offers is accepted", () => {
  expect(parseUpNextQuickStartsPatch({ codex: { enabled: true, effort: "ultra" } }, {}).ok).toBe(
    true,
  );
});

test("stored reader: missing and corrupt rows read {}, stale entries drop", () => {
  expect(storedUpNextQuickStarts(null)).toEqual({});
  expect(storedUpNextQuickStarts("not json")).toEqual({});
  expect(storedUpNextQuickStarts("[1]")).toEqual({});
  const stale = JSON.stringify({ claude, codex: { enabled: true, model: "gone", effort: null } });
  expect(storedUpNextQuickStarts(stale)).toEqual({ claude });
});
