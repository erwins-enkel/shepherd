import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";

const { default: RepoLink } = await import("./RepoLink.svelte");

afterEach(() => {
  document.body.innerHTML = "";
});

describe("RepoLink", () => {
  it("renders <a class='repo-link'> wrapping the slug plus a .sep when webUrl is present", async () => {
    render(RepoLink, { slug: "owner/repo", webUrl: "https://github.com/owner/repo" });

    const sep = document.querySelector(".sep");
    expect(sep, ".sep present").not.toBeNull();
    expect(sep!.textContent).toBe("·");

    const link = document.querySelector(".repo-link") as HTMLAnchorElement | null;
    expect(link, ".repo-link present").not.toBeNull();
    expect(link!.href).toBe("https://github.com/owner/repo");
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.textContent?.trim()).toBe("owner/repo");
  });

  it("renders slug as plain text with a .sep but no anchor when webUrl is null", async () => {
    render(RepoLink, { slug: "owner/repo", webUrl: null });

    const sep = document.querySelector(".sep");
    expect(sep, ".sep present").not.toBeNull();

    const link = document.querySelector(".repo-link");
    expect(link, "no .repo-link anchor").toBeNull();

    expect(document.body.textContent).toContain("owner/repo");
  });

  it("renders nothing at all when slug is null", async () => {
    render(RepoLink, { slug: null, webUrl: null });

    expect(document.querySelector(".sep"), "no .sep").toBeNull();
    expect(document.querySelector(".repo-link"), "no .repo-link").toBeNull();
  });
});
