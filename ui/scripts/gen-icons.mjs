// Deterministic app icon: a solid bell glyph on the app's dark panel, amber
// fill. Replace the SVG below with brand art later.
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "static", "icons");
mkdirSync(outDir, { recursive: true });

const BG = "#0b0f0d";
const AMBER = "#e2a13c";

// Bell silhouette, 512 viewport. Filled (not stroked) so it stays legible when
// the OS shrinks/masks it. Padding keeps it inside the maskable safe zone (~80%).
const BELL = `<path d="M256 96a28 28 0 0 1 28 28v10a92 92 0 0 1 64 88v52l26 44a14 14 0 0 1-12 21H146a14 14 0 0 1-12-21l26-44v-52a92 92 0 0 1 64-88v-10a28 28 0 0 1 28-28z"/>
    <path d="M212 374h88a44 44 0 0 1-88 0z"/>`;

// App icon: amber bell on the dark rounded panel.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="${BG}"/>
  <g fill="${AMBER}">
    ${BELL}
  </g>
</svg>`;

// Notification badge: white bell on transparent. Android renders the badge as a
// flat monochrome mask, so a solid single-color glyph is required (a colored or
// stroked icon degrades to a blob). No panel/background.
const badge = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <g fill="#fff">
    ${BELL}
  </g>
</svg>`;

writeFileSync(join(outDir, "icon.svg"), svg);
const buf = Buffer.from(svg);
await sharp(buf).resize(192, 192).png().toFile(join(outDir, "icon-192.png"));
await sharp(buf).resize(512, 512).png().toFile(join(outDir, "icon-512.png"));
await sharp(buf).resize(180, 180).png().toFile(join(outDir, "apple-touch-icon.png"));

writeFileSync(join(outDir, "badge.svg"), badge);
const badgeBuf = Buffer.from(badge);
await sharp(badgeBuf).resize(96, 96).png().toFile(join(outDir, "badge-96.png"));
console.log("icons written to", outDir);
