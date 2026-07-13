import { describe, it, expect } from "vitest";
import { findCommandLinks } from "./slashLinks";

const names = (
  line: string,
  known: Set<string> = new Set(),
  provider: "claude" | "codex" = "claude",
) => findCommandLinks(line, known, provider).map((l) => l.name);

describe("findCommandLinks", () => {
  describe("hits — boundary chars", () => {
    it("at line start", () => {
      expect(findCommandLinks("/squad", new Set())).toEqual([{ start: 0, end: 6, name: "squad" }]);
    });
    it("after whitespace", () => {
      expect(findCommandLinks("via /squad", new Set())).toEqual([
        { start: 4, end: 10, name: "squad" },
      ]);
    });
    it("inline-code (backticks), parens, quotes, brackets", () => {
      expect(names("`/squad`")).toEqual(["squad"]);
      expect(names("(/squad)")).toEqual(["squad"]);
      expect(names('"/squad"')).toEqual(["squad"]);
      expect(names("[/squad]")).toEqual(["squad"]);
    });
  });

  describe("hits — trailing punctuation (not part of the token)", () => {
    it("sentence-final period", () => {
      expect(findCommandLinks("run /squad.", new Set())).toEqual([
        { start: 4, end: 10, name: "squad" },
      ]);
    });
    it("closing paren / backtick / comma", () => {
      expect(names("/gsd-quick)")).toEqual(["gsd-quick"]);
      expect(names("/squad`")).toEqual(["squad"]);
      expect(names("/squad,")).toEqual(["squad"]);
    });
  });

  describe("hits — namespaced + two on one line", () => {
    it("colon namespace via (B)", () => {
      expect(names("/gsd:quick")).toEqual(["gsd:quick"]);
    });
    it("two suggested commands", () => {
      expect(names("either /squad or /gsd-quick")).toEqual(["squad", "gsd-quick"]);
    });
  });

  describe("hits — branch (A) case-insensitive incl. _ / mixed case", () => {
    const known = new Set(["my_skill", "reviewpr"]);
    it("uppercase/underscore name matches a known command", () => {
      expect(names("/My_Skill", known)).toEqual(["My_Skill"]);
      expect(names("/ReviewPR", known)).toEqual(["ReviewPR"]);
    });
    it("same name without a known entry does NOT match (not canonical for B)", () => {
      expect(names("/My_Skill")).toEqual([]);
    });
  });

  describe("no match — paths", () => {
    it("multi-segment path (followed by /)", () => {
      expect(names("/home/moe/projects")).toEqual([]);
      expect(names("/usr/bin")).toEqual([]);
    });
    it("enumerated single-segment path prefixes", () => {
      expect(names("/tmp")).toEqual([]);
      expect(names("/etc")).toEqual([]);
      expect(names("/usr")).toEqual([]);
    });
    it("file with extension", () => {
      expect(names("/foo.txt")).toEqual([]);
      expect(names("/a.md")).toEqual([]);
    });
  });

  describe("no match — URLs and mid-word slashes", () => {
    it("URL", () => {
      expect(names("see http://example.com/squad")).toEqual([]);
    });
    it("mid-word slash", () => {
      expect(names("a/foo")).toEqual([]);
      expect(names("and/or")).toEqual([]);
    });
    it("fraction-like 24/7 (digit after slash)", () => {
      expect(names("24/7")).toEqual([]);
    });
  });

  describe("graceful degradation — empty known set", () => {
    it("canonical command still matches via (B); path prefix does not", () => {
      expect(names("/squad", new Set())).toEqual(["squad"]);
      expect(names("/tmp", new Set())).toEqual([]);
    });
  });

  describe("known command overrides path-prefix denylist", () => {
    it('"/dev" linkifies when it is an installed command', () => {
      expect(names("/dev", new Set(["dev"]))).toEqual(["dev"]);
    });
  });

  describe("codex provider", () => {
    it("does not speculatively link arbitrary slash names", () => {
      expect(names("try /review", new Set(), "codex")).toEqual([]);
    });

    it("does not make slash paste targets for known codex skills", () => {
      expect(names("use /github:yeet", new Set(["github:yeet"]), "codex")).toEqual([]);
    });
  });
});
