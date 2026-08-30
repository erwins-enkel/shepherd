// Shepherd's PWA icon set — the single source for the sheep brand mark.
//
// The mark used to be hand-duplicated across ui/static/favicon.svg, site/public/* and the
// checked-in extension PNGs, and that drift is exactly why the PWA was the last surface still
// carrying a placeholder glyph. This script now owns the geometry and emits favicon.svg too, so
// there is one definition to change.
//
// Outputs are written to static/icons/<ICONS_VERSION>/ — see ./icons-version.mjs for the bump
// procedure and why the URL has to change at all.
//
// NOTE: this module writes files at import time. Import ICONS_VERSION from ./icons-version.mjs, not
// from here, or merely importing the constant regenerates every asset.
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ICONS_VERSION } from "./icons-version.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const staticDir = join(here, "..", "static");

const outDir = join(staticDir, "icons", ICONS_VERSION);
mkdirSync(outDir, { recursive: true });

// Ground for the icon panel and the maskable field. Deliberately #0f1413 and NOT the manifest's
// #0b0f0d: the face (#0a0d0c) hangs below the wool, and against #0b0f0d that chin would vanish
// into the background and change the silhouette. #0f1413 keeps the mark reading as designed.
const GROUND = "#0f1413";
const BORDER = "#2c3835";
const WOOL = "#e9f1ec";
const DARK = "#0a0d0c";
const AMBER = "#e8a13a";
const MUZZLE = "#5d6c67";

// The sheep, authored in a 64-unit viewport. Every output scales this same geometry.
const WOOL_CIRCLES = `<circle cx="22" cy="24" r="9"/>
    <circle cx="32" cy="19" r="10"/>
    <circle cx="43" cy="24" r="9"/>
    <circle cx="20" cy="34" r="9"/>
    <circle cx="32" cy="36" r="11"/>
    <circle cx="44" cy="34" r="9"/>`;

/** Full-colour sheep: wool crown, knocked-out ears + face, amber eyes, muzzle. */
const sheep = () => `<g fill="${WOOL}">
    ${WOOL_CIRCLES}
  </g>
  <ellipse cx="20" cy="38" rx="4" ry="6" fill="${DARK}" transform="rotate(-22 20 38)"/>
  <ellipse cx="44" cy="38" rx="4" ry="6" fill="${DARK}" transform="rotate(22 44 38)"/>
  <ellipse cx="32" cy="41" rx="11" ry="12" fill="${DARK}"/>
  <circle cx="27.5" cy="39" r="2.1" fill="${AMBER}"/>
  <circle cx="36.5" cy="39" r="2.1" fill="${AMBER}"/>
  <ellipse cx="32" cy="47.5" rx="3.4" ry="2.6" fill="${MUZZLE}"/>`;

const svg64 = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 64 64">\n  ${body}\n</svg>\n`;

// --- favicon.svg -------------------------------------------------------------------------------
// Bordered panel; the one output that keeps its own 64x64 intrinsic size. Art is unchanged from the
// hand-written file this replaces.
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <title>Shepherd</title>
  <rect x="1.5" y="1.5" width="61" height="61" rx="14" fill="${GROUND}" stroke="${BORDER}" stroke-width="1.5"/>
  ${sheep()}
</svg>
`;

// --- purpose:"any" -----------------------------------------------------------------------------
// Self-rounded panel. Transparent corners are legal here — `any` icons are drawn unmasked (desktop
// task switchers, tab strips), where a hard square would look wrong.
const iconAny = svg64(`<rect width="64" height="64" rx="12" fill="${GROUND}"/>
  ${sheep()}`);

// --- purpose:"maskable" ------------------------------------------------------------------------
// Square, fully opaque, bleeding to all four edges — the OS supplies the shape. Any transparency
// here composites onto the WebAPK's hardcoded #FFFFFF adaptive-icon background layer and shows up
// as a white ring, which is the bug this file previously shipped (`rx` panel, nothing behind it,
// declared maskable in the manifest anyway).
//
// The glyph needs no rescaling to clear the W3C safe zone (a centred circle of radius 0.4 x width):
// its furthest point is the top of the wool at 184/512 px against a 204.8 px budget. Asserted in
// gen-icons.test.ts so a future geometry tweak cannot silently overflow it.
const iconMaskable = svg64(`<rect width="64" height="64" fill="${GROUND}"/>
  ${sheep()}`);

// --- Android notification badge ----------------------------------------------------------------
// Android alpha-masks the badge to one flat colour, so only the silhouette survives: a solid fill of
// the whole mark would flatten to a featureless blob. Instead the wool stays opaque, the ears and
// face are knocked out, and the eyes are punched back in — which still reads as a sheep head once
// flattened. Eyes are r=3.1 rather than the mark's 2.1: at 24px the smaller ones merge into the
// knockout and the face loses its features.
//
// The transform re-centres and enlarges the silhouette. Its natural bbox sits high in the viewport
// (the wool crown is taller than the exposed chin), so centred art would look bottom-padded once
// Android applies its own inset. Maps the art's bbox centre (32, 26) to the canvas centre and
// scales it to ~87% of the width.
const BADGE_SCALE = 56 / 42.6;
const badge = svg64(`<defs>
    <mask id="sheep">
      <g fill="#fff">
    ${WOOL_CIRCLES}
      </g>
      <ellipse cx="20" cy="38" rx="4" ry="6" fill="#000" transform="rotate(-22 20 38)"/>
      <ellipse cx="44" cy="38" rx="4" ry="6" fill="#000" transform="rotate(22 44 38)"/>
      <ellipse cx="32" cy="41" rx="11" ry="12" fill="#000"/>
      <circle cx="27.5" cy="39" r="3.1" fill="#fff"/>
      <circle cx="36.5" cy="39" r="3.1" fill="#fff"/>
    </mask>
  </defs>
  <g transform="translate(32,32) scale(${BADGE_SCALE.toFixed(4)}) translate(-32,-26)">
    <rect width="64" height="64" fill="#fff" mask="url(#sheep)"/>
  </g>`);

writeFileSync(join(staticDir, "favicon.svg"), favicon);
writeFileSync(join(outDir, "icon.svg"), iconAny);
writeFileSync(join(outDir, "icon-maskable.svg"), iconMaskable);
writeFileSync(join(outDir, "badge.svg"), badge);

const png = (svg, size, name) =>
  sharp(Buffer.from(svg)).resize(size, size).png().toFile(join(outDir, name));

await png(iconAny, 192, "icon-192.png");
await png(iconAny, 512, "icon-512.png");
await png(iconMaskable, 192, "icon-maskable-192.png");
await png(iconMaskable, 512, "icon-maskable-512.png");
// iOS applies its own squircle and honours no safe zone, so it gets the full-bleed art; the
// self-rounded panel would double-round.
await png(iconMaskable, 180, "apple-touch-icon.png");
await png(badge, 96, "badge-96.png");

console.log("icons written to", outDir);
