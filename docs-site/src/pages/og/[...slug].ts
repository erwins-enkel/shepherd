// Per-page Open Graph cards (1200×630 PNG) for link previews, rendered at build
// time with astro-og-canvas. src/routeData.ts points each page's og:image here.
//
// The ~1800 TypeDoc pages under api/** share ONE card (`api`) instead of one each:
// rendering a PNG per generated page would undo the build-time budget of #2027.
import { getCollection } from "astro:content";
import { OGImageRoute } from "astro-og-canvas";

const SITE_DESCRIPTION = "Documentation for Shepherd — interactive mission control for Claude Code agents.";

// Brand palette (mirrors --brand-* in src/styles/custom.css) as RGB tuples.
const BG: [number, number, number] = [10, 13, 12];
const BG_AMBER_TINT: [number, number, number] = [30, 24, 14];
const AMBER: [number, number, number] = [232, 161, 58];
const INK_BRIGHT: [number, number, number] = [238, 244, 240];
const INK: [number, number, number] = [196, 208, 203];

const FONTS = "./node_modules/@fontsource/space-grotesk/files/space-grotesk-latin";

const entries = await getCollection("docs", ({ id }) => !id.startsWith("api/"));
const pages: Record<string, { title: string; description?: string }> = Object.fromEntries(
  entries.map(({ id, data }) => [id, { title: data.title, description: data.description }]),
);
pages.api = {
  title: "API reference",
  description: "TypeScript reference for the Shepherd server, generated from source.",
};

export const { getStaticPaths, GET } = await OGImageRoute({
  pages,
  // Key verbatim + ".png" (the default strips anything after a dot in the id).
  getSlug: (id) => `${id}.png`,
  getImageOptions: (_id, page: (typeof pages)[string]) => ({
    title: page.title,
    description: page.description ?? SITE_DESCRIPTION,
    logo: { path: "./src/og/logo.png", size: [96] },
    bgGradient: [BG, BG_AMBER_TINT],
    border: { color: AMBER, width: 12, side: "inline-start" },
    padding: 80,
    fonts: [`${FONTS}-400-normal.woff`, `${FONTS}-700-normal.woff`],
    font: {
      title: { families: ["Space Grotesk"], weight: "Bold", color: INK_BRIGHT, size: 72, lineHeight: 1.1 },
      description: { families: ["Space Grotesk"], weight: "Normal", color: INK, size: 34, lineHeight: 1.35 },
    },
  }),
});
