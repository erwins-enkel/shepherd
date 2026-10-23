import { expect } from "vitest";

/**
 * WCAG contrast ratio of an element's text against its painted background, sampling the
 * actual CSS colors in the browser and compositing translucent ancestor backgrounds over
 * the page `--bg`. Browser tests only (needs a real canvas + computed styles).
 */
function contrast(element: HTMLElement, foreground = getComputedStyle(element).color): number {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.canvas.width = ctx.canvas.height = 1;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--bg");
  ctx.fillRect(0, 0, 1, 1);
  const ancestors: HTMLElement[] = [];
  for (let node: HTMLElement | null = element; node; node = node.parentElement)
    ancestors.unshift(node);
  for (const node of ancestors) {
    ctx.fillStyle = getComputedStyle(node).backgroundColor;
    ctx.fillRect(0, 0, 1, 1);
  }
  function luminance() {
    const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => {
      const n = v / 255;
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  }
  const bg = luminance();
  ctx.fillStyle = foreground;
  ctx.fillRect(0, 0, 1, 1);
  const fg = luminance();
  return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
}

/** Resolve a CSS color token (e.g. `--color-green`) to the computed `rgb(...)` string. */
export function tokenColor(token: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

/** The light/dark themes a small-text contrast guard runs under. */
export const THEMES = ["light", "dark"] as const;

/**
 * Assert a small "done/ok/parked" label reads in the quiet register at AA: ≥ 4.5:1 and
 * never green (green is reserved for actionable-complete — Four-Light Rule).
 */
export function expectQuietLegible(element: HTMLElement): void {
  expect(contrast(element)).toBeGreaterThanOrEqual(4.5);
  expect(getComputedStyle(element).color).not.toBe(tokenColor("--color-green"));
}
