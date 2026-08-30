// Guards for the committed PWA icon set (see scripts/gen-icons.mjs).
//
// These assert PROPERTIES of the committed PNGs rather than byte-equality against a fresh sharp
// render: rasterisation is not stable across sharp/resvg versions, so a byte-compare drift guard
// would be flaky. The properties below are the ones that actually broke — a `purpose:"maskable"`
// icon with transparent corners, and icon paths spread across four files that a rename can miss.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
// From icons-version.mjs, NOT gen-icons.mjs: the generator writes files at import time, so pulling
// the constant from it would make this test rewrite the very assets it is checking.
// @ts-expect-error — plain .mjs module, no types
import { ICONS_VERSION } from "./icons-version.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const staticDir = join(here, "..", "static");

/** Resolve a manifest-style absolute path ("/icons/v2/x.png") to its file under static/. */
const staticPath = (p: string) => join(staticDir, p.replace(/^\//, ""));

const manifest = JSON.parse(readFileSync(join(staticDir, "manifest.webmanifest"), "utf8")) as {
  icons: { src: string; sizes: string; purpose: string }[];
};

/** Decode to raw RGBA so alpha and colour can be read per pixel. */
async function raw(file: string) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => {
    const i = (y * info.width + x) * info.channels;
    return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
  };
  return { data, info, at };
}

describe("icon set — maskable contract", () => {
  const maskable = manifest.icons.filter((i) => i.purpose === "maskable");

  it("declares at least one maskable icon", () => {
    expect(maskable.length).toBeGreaterThan(0);
  });

  // The exact defect this change fixes: a maskable icon must bleed opaque to every edge. Any
  // transparency composites onto the platform's own background layer (hardcoded #FFFFFF in a
  // WebAPK's adaptive icon) and shows as a white ring.
  it.each(maskable.map((i) => i.src))("%s is fully opaque edge to edge", async (src) => {
    const { info, at } = await raw(staticPath(src));
    const { width: w, height: h } = info;
    const probes: [number, number][] = [
      [0, 0],
      [w - 1, 0],
      [0, h - 1],
      [w - 1, h - 1],
      [(w / 2) | 0, 0],
      [(w / 2) | 0, h - 1],
      [0, (h / 2) | 0],
      [w - 1, (h / 2) | 0],
    ];
    for (const [x, y] of probes) expect(at(x, y).a, `alpha at ${x},${y}`).toBe(255);
  });

  // W3C safe zone: a centred circle of radius 0.4 x width. Anything outside it may be masked away,
  // so the glyph must fit inside — otherwise a future geometry tweak silently clips the sheep.
  it.each(maskable.map((i) => i.src))("%s keeps its glyph inside the safe zone", async (src) => {
    const { info, at } = await raw(staticPath(src));
    const { width: w, height: h } = info;
    const ground = at(0, 0);
    const cx = w / 2;
    const cy = h / 2;
    let worst = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = at(x, y);
        if (p.r === ground.r && p.g === ground.g && p.b === ground.b) continue;
        worst = Math.max(worst, Math.hypot(x - cx, y - cy));
      }
    }
    expect(worst).toBeGreaterThan(0); // a solid-ground image would trivially "pass"
    expect(worst).toBeLessThanOrEqual(0.4 * w);
  });
});

describe("icon set — manifest wiring", () => {
  it("points every declared icon at a file that exists", () => {
    for (const icon of manifest.icons) {
      expect(existsSync(staticPath(icon.src)), `missing ${icon.src}`).toBe(true);
    }
  });

  // One file serving both purposes is how the maskable defect shipped: the `any` art (self-rounded,
  // transparent corners) was declared maskable as well.
  it("never reuses one file for both `any` and `maskable`", () => {
    const any = new Set(manifest.icons.filter((i) => i.purpose === "any").map((i) => i.src));
    for (const m of manifest.icons.filter((i) => i.purpose === "maskable")) {
      expect(any.has(m.src), `${m.src} is declared both any and maskable`).toBe(false);
    }
  });

  it("matches each icon's declared size to the actual pixels", async () => {
    for (const icon of manifest.icons) {
      const meta = await sharp(staticPath(icon.src)).metadata();
      expect(`${meta.width}x${meta.height}`, icon.src).toBe(icon.sizes);
    }
  });
});

describe("icon set — cross-file path integrity", () => {
  // These paths live in four files. A rename that misses one ships a 404 that nothing else catches.
  const sw = readFileSync(join(staticDir, "sw.js"), "utf8");
  const appHtml = readFileSync(join(here, "..", "src", "app.html"), "utf8");

  const referenced = [
    ...(sw.match(/"\/icons\/[^"]+"/g) ?? []).map((s) => s.slice(1, -1)),
    ...(appHtml.match(/\/icons\/[^"]+/g) ?? []),
    ...manifest.icons.map((i) => i.src),
  ];

  it("finds icon references in every file that should carry them", () => {
    expect(sw).toContain("/icons/");
    expect(appHtml).toContain("/icons/");
    expect(referenced.length).toBeGreaterThanOrEqual(manifest.icons.length + 3);
  });

  it.each([...new Set(referenced)])("%s resolves and carries the version token", (src) => {
    expect(src).toContain(`/icons/${ICONS_VERSION}/`);
    expect(existsSync(staticPath(src)), `missing ${src}`).toBe(true);
  });
});

describe("icon set — notification badge", () => {
  const badgePath = join(staticDir, "icons", ICONS_VERSION, "badge-96.png");

  // Android alpha-masks the badge to a single flat colour, so anything but pure white on
  // transparent is wasted information — and a colour fill flattens to a blob.
  it("is pure white on transparent", async () => {
    const { data, info } = await raw(badgePath);
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i + 3] === 0) continue;
      expect([data[i], data[i + 1], data[i + 2]]).toEqual([255, 255, 255]);
    }
  });

  it("centres the silhouette in its canvas", async () => {
    const { info, at } = await raw(badgePath);
    const { width: w, height: h } = info;
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (at(x, y).a === 0) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    expect(maxX).toBeGreaterThan(-1);
    // Android insets the badge itself, so the source should be near-full-bleed and centred.
    expect(Math.abs((minX + maxX + 1) / 2 - w / 2)).toBeLessThanOrEqual(0.02 * w);
    expect(Math.abs((minY + maxY + 1) / 2 - h / 2)).toBeLessThanOrEqual(0.02 * h);
    expect(maxX - minX + 1).toBeGreaterThan(0.75 * w);
  });
});
