import { afterEach, describe, expect, it } from "vitest";
import "./app.css";

// The desktop shell is one viewport; +page.svelte toggles `html.fixed-shell` so the document
// never scrolls or rubber-bands under a trackpad gesture chained out of a list (#3794).
describe("html.fixed-shell", () => {
  const root = document.documentElement;
  afterEach(() => {
    root.classList.remove("fixed-shell");
    document.querySelector("[data-probe]")?.remove();
  });

  // Content positioned far below the shell, the way an absolute descendant escaping a list's
  // clip lands: an overflow:hidden root still scrolls to it under scrollIntoView or focus().
  function addFarProbe() {
    const holder = document.createElement("div");
    holder.dataset.probe = "";
    holder.style.position = "relative";
    const far = document.createElement("div");
    Object.assign(far.style, {
      position: "absolute",
      top: "5000px",
      width: "10px",
      height: "10px",
    });
    holder.append(far);
    document.body.append(holder);
  }

  it("locks document scroll and overscroll while set", () => {
    root.classList.add("fixed-shell");
    const style = getComputedStyle(root);
    expect(style.overflowY).toBe("hidden");
    expect(style.overscrollBehaviorY).toBe("none");
  });

  it("clips anything below the shell so nothing can grow the document while set", () => {
    root.classList.add("fixed-shell");
    addFarProbe();
    expect(getComputedStyle(document.body).overflowY).toBe("clip");
    expect(document.scrollingElement!.scrollHeight).toBeLessThanOrEqual(innerHeight);
  });

  it("leaves the document scrollable without it (other routes, phone list)", () => {
    const style = getComputedStyle(root);
    expect(style.overflowY).toBe("visible");
    expect(style.overscrollBehaviorY).toBe("auto");
    addFarProbe();
    expect(getComputedStyle(document.body).overflowY).toBe("visible");
    expect(document.scrollingElement!.scrollHeight).toBeGreaterThan(innerHeight);
  });
});
