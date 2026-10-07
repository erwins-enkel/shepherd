import { describe, expect, it } from "vitest";
import {
  containRect,
  keyMessage,
  modifiersOf,
  mouseButton,
  navigableUrl,
  toPageCoords,
} from "./browserView";

const key = (k: string, extra: Partial<Record<string, unknown>> = {}) => ({
  key: k,
  code: `Key${k.toUpperCase()}`,
  keyCode: k.toUpperCase().charCodeAt(0),
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...extra,
});

describe("browserView", () => {
  it("containRect letterboxes a wide image in a tall box", () => {
    expect(containRect(100, 200, 200, 100)).toEqual({ x: 0, y: 75, w: 100, h: 50 });
    expect(containRect(0, 10, 10, 10)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it("toPageCoords maps into page CSS px and rejects the letterbox", () => {
    const box = { width: 100, height: 200 };
    const natural = { width: 1000, height: 500 }; // JPEG pixels (scaled)
    const page = { width: 1280, height: 640 }; // CSS px
    expect(toPageCoords(50, 100, box, natural, page)).toEqual({ x: 640, y: 320 });
    expect(toPageCoords(0, 75, box, natural, page)).toEqual({ x: 0, y: 0 });
    expect(toPageCoords(50, 10, box, natural, page)).toBeNull();
  });

  it("modifiersOf uses the CDP bitmask", () => {
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
    expect(modifiersOf({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: true })).toBe(8);
  });

  it("mouseButton maps DOM buttons", () => {
    expect(mouseButton(0)).toBe("left");
    expect(mouseButton(2)).toBe("right");
    expect(mouseButton(9)).toBe("none");
  });

  it("keyMessage: printable carries text on keydown only; Enter is \\r; chords are raw", () => {
    expect(keyMessage(key("a"), "down")).toMatchObject({ key: "a", text: "a", modifiers: 0 });
    expect(keyMessage(key("a"), "up")).not.toHaveProperty("text");
    expect(keyMessage(key("Enter", { code: "Enter", keyCode: 13 }), "down")).toMatchObject({
      text: "\r",
      keyCode: 13,
    });
    expect(keyMessage(key("Backspace", { keyCode: 8 }), "down")).not.toHaveProperty("text");
    expect(keyMessage(key("a", { ctrlKey: true }), "down")).toMatchObject({ modifiers: 2 });
    expect(keyMessage(key("a", { ctrlKey: true }), "down")).not.toHaveProperty("text");
  });

  it("keyMessage leaves the paste chord to the paste event", () => {
    expect(keyMessage(key("v", { ctrlKey: true }), "down")).toBeNull();
    expect(keyMessage(key("V", { metaKey: true }), "down")).toBeNull();
  });

  it("navigableUrl accepts http(s), adds https to bare hosts, refuses other schemes", () => {
    expect(navigableUrl("http://localhost:5173/login")).toBe("http://localhost:5173/login");
    expect(navigableUrl(" example.com ")).toBe("https://example.com/");
    expect(navigableUrl("localhost:5173/x")).toBe("http://localhost:5173/x");
    expect(navigableUrl("file:///etc/passwd")).toBeNull();
    expect(navigableUrl("javascript:alert(1)")).toBeNull();
    expect(navigableUrl("")).toBeNull();
  });
});
