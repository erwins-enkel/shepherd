import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import RepoMark from "./RepoMark.svelte";
import { projectIcons } from "#lib/projectIcons.svelte.js";

function mark(props: { path: string; name: string; favicon?: string | null }) {
  render(RepoMark, props);
  return document.body.querySelector<HTMLElement>(".repo-mark")!;
}

const AVATAR =
  "data:image/svg+xml," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');

describe("RepoMark", () => {
  afterEach(() => {
    projectIcons.apply({});
    document.body.innerHTML = "";
  });

  it("shows the monogram without emoji or favicon", () => {
    const container = mark({ path: "/r/alpha", name: "alpha" });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent?.trim()).toBe("A");
  });

  it("shows the favicon over the monogram", () => {
    const container = mark({ path: "/r/alpha", name: "alpha", favicon: AVATAR });
    expect(container.querySelector("img")?.getAttribute("src")).toBe(AVATAR);
    expect(container.textContent?.trim()).toBe("");
  });

  it("prefers the project emoji over the favicon", () => {
    projectIcons.apply({ "/r/alpha": "🐑" });
    const container = mark({ path: "/r/alpha", name: "alpha", favicon: AVATAR });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent?.trim()).toBe("🐑");
  });

  it("falls back to the monogram when the favicon fails to load", async () => {
    const container = mark({
      path: "/r/alpha",
      name: "alpha",
      favicon: "data:image/png;base64,broken",
    });
    await expect.poll(() => container.querySelector("img")).toBeNull();
    expect(container.textContent?.trim()).toBe("A");
  });
});
