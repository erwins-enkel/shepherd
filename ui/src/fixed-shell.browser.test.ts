import { afterEach, describe, expect, it } from "vitest";
import "./app.css";

// The desktop shell is one viewport; +page.svelte toggles `html.fixed-shell` so the document
// never scrolls or rubber-bands under a trackpad gesture chained out of a list (#3794).
describe("html.fixed-shell", () => {
  const root = document.documentElement;
  afterEach(() => root.classList.remove("fixed-shell"));

  it("locks document scroll and overscroll while set", () => {
    root.classList.add("fixed-shell");
    const style = getComputedStyle(root);
    expect(style.overflowY).toBe("hidden");
    expect(style.overscrollBehaviorY).toBe("none");
  });

  it("leaves the document scrollable without it (other routes, phone list)", () => {
    const style = getComputedStyle(root);
    expect(style.overflowY).toBe("visible");
    expect(style.overscrollBehaviorY).toBe("auto");
  });
});
