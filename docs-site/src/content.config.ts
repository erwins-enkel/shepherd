import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

// Astro 6 Content Layer API — Starlight loads its pages from the `docs`
// collection via docsLoader(); docsSchema() validates each page's frontmatter.
// (The legacy glob-based src/content/config.ts is gone as of Astro 6.)
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
