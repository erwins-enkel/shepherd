import { describe, it, expect } from "vitest";
import { accessCase, ghFixApplies, looksLikeGithubUrl } from "./clone-access";
import type { GithubAccess } from "$lib/api";

function access(gh: GithubAccess["gh"], extra: Partial<GithubAccess> = {}): GithubAccess {
  return {
    repo: "acme/widget",
    protocol: "https",
    git: { kind: "store", usesGh: false },
    gh,
    ...extra,
  };
}

describe("accessCase", () => {
  it("gh may read, git may not → mismatch", () => {
    expect(accessCase(access({ state: "ok", login: "o", pull: true, push: false }))).toBe(
      "mismatch",
    );
  });
  it("gh signed in without access → denied", () => {
    expect(accessCase(access({ state: "ok", login: "o", pull: false, push: false }))).toBe(
      "denied",
    );
  });
  it("gh missing or signed out → nogh", () => {
    expect(accessCase(access({ state: "missing" }))).toBe("nogh");
    expect(accessCase(access({ state: "logged_out" }))).toBe("nogh");
  });
  it("the gh check failing → gherror", () => {
    expect(accessCase(access({ state: "error", detail: "x" }))).toBe("gherror");
  });
});

describe("ghFixApplies", () => {
  const ok = { state: "ok", login: "o", pull: true, push: true } as const;
  it("only for an https clone whose git isn't on gh yet", () => {
    expect(ghFixApplies(access(ok))).toBe(true);
    expect(ghFixApplies(access(ok, { protocol: "ssh" }))).toBe(false);
    expect(ghFixApplies(access(ok, { git: { kind: "gh", usesGh: true } }))).toBe(false);
  });
});

describe("looksLikeGithubUrl", () => {
  it("matches https, scp-style and ssh:// github.com URLs", () => {
    expect(looksLikeGithubUrl("https://github.com/acme/widget.git")).toBe(true);
    expect(looksLikeGithubUrl("git@github.com:acme/widget.git")).toBe(true);
    expect(looksLikeGithubUrl("ssh://git@github.com/acme/widget")).toBe(true);
  });
  it("rejects other hosts and look-alikes", () => {
    expect(looksLikeGithubUrl("https://gitlab.com/acme/widget.git")).toBe(false);
    expect(looksLikeGithubUrl("https://notgithub.com/acme/widget")).toBe(false);
  });
});
