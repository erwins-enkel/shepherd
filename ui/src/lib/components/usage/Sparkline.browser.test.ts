import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../../app.css";

const { default: Sparkline } = await import("./Sparkline.svelte");

const NOW = Date.now();
const MIN = 60_000;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Sparkline", () => {
  it("renders a polyline for ≥2 points", async () => {
    const points = [
      { t: NOW - 60 * MIN, v: 10 },
      { t: NOW - 30 * MIN, v: 30 },
      { t: NOW, v: 50 },
    ];
    render(Sparkline, { points, color: "var(--color-green)", ariaLabel: "test sparkline" });

    const polyline = document.querySelector("polyline");
    expect(polyline, "polyline should be rendered for ≥2 points").toBeTruthy();
  });

  it("does NOT render a polyline for 1 point — only a single circle marker", async () => {
    const points = [{ t: NOW, v: 42 }];
    render(Sparkline, { points, color: "var(--color-green)", ariaLabel: "single point" });

    const polyline = document.querySelector("polyline");
    expect(polyline, "no polyline for 1 point").toBeNull();

    const circle = document.querySelector("circle");
    expect(circle, "a dot marker should be rendered for 1 point").toBeTruthy();
  });

  it("renders nothing (empty stable svg) for 0 points without throwing", async () => {
    const points: { t: number; v: number }[] = [];
    // Should not throw
    expect(() =>
      render(Sparkline, { points, color: "var(--color-green)", ariaLabel: "empty sparkline" }),
    ).not.toThrow();

    const svg = document.querySelector("svg");
    expect(svg, "svg placeholder should exist for layout stability").toBeTruthy();

    const polyline = document.querySelector("polyline");
    expect(polyline, "no polyline for 0 points").toBeNull();

    const circle = document.querySelector("circle");
    expect(circle, "no markers for 0 points").toBeNull();
  });

  it("sets aria-label on the svg", async () => {
    const label = "5H usage trend";
    const points = [
      { t: NOW - 30 * MIN, v: 20 },
      { t: NOW, v: 40 },
    ];
    render(Sparkline, { points, color: "var(--color-blue)", ariaLabel: label });

    const svg = document.querySelector("svg");
    expect(svg, "svg element exists").toBeTruthy();
    expect(svg!.getAttribute("aria-label")).toBe(label);
    expect(svg!.getAttribute("role")).toBe("img");
  });

  it("renders a distinct live-last marker when liveLast is true", async () => {
    const points = [
      { t: NOW - 30 * MIN, v: 20 },
      { t: NOW, v: 55 },
    ];
    render(Sparkline, {
      points,
      color: "var(--color-blue)",
      ariaLabel: "live last test",
      liveLast: true,
    });

    const circles = document.querySelectorAll("circle");
    // One scrape marker + one live-last marker
    expect(circles.length).toBe(2);
  });
});
