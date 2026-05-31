// Deterministic placeholder app icon: a shepherd's-crook glyph on the app's
// dark panel, amber stroke. Replace the SVG below with brand art later.
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "static", "icons");
mkdirSync(outDir, { recursive: true });

const BG = "#0b0f0d";
const AMBER = "#e2a13c";

// 512-viewport SVG. Padding keeps the glyph inside the maskable safe zone (~80%).
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="${BG}"/>
  <g fill="none" stroke="${AMBER}" stroke-width="34" stroke-linecap="round" stroke-linejoin="round">
    <path d="M196 360 V210 a64 64 0 0 1 128 0 a36 36 0 0 1 -72 0"/>
  </g>
</svg>`;

writeFileSync(join(outDir, "icon.svg"), svg);
const buf = Buffer.from(svg);
await sharp(buf).resize(192, 192).png().toFile(join(outDir, "icon-192.png"));
await sharp(buf).resize(512, 512).png().toFile(join(outDir, "icon-512.png"));
await sharp(buf).resize(180, 180).png().toFile(join(outDir, "apple-touch-icon.png"));
console.log("icons written to", outDir);
