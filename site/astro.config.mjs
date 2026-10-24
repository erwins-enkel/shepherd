// @ts-check
import { defineConfig, fontProviders } from "astro/config";

// Static marketing site for shepherd.run.
// - `output: "static"` is Astro's default; set explicitly for clarity.
// - No SSR adapter: a fully static `dist/` is auto-detected by Vercel
//   (Vercel ships first-class Astro support; static output needs no adapter).
// - Self-hosted fonts via the local font provider, which reads the installed
//   `@fontsource/*` packages, emits subsetted woff2 with `font-display: swap`,
//   generates optimized fallbacks, and lets us preload the primary weights
//   (see <Font/> usage in src/layouts/Base.astro).
// https://astro.build/config
export default defineConfig({
  output: "static",
  fonts: [
    {
      name: "Space Grotesk",
      cssVariable: "--font-space-grotesk",
      provider: fontProviders.local(),
      options: {
        variants: [
          { weight: 400, style: "normal", src: ["@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff2"] },
          { weight: 500, style: "normal", src: ["@fontsource/space-grotesk/files/space-grotesk-latin-500-normal.woff2"] },
          { weight: 700, style: "normal", src: ["@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2"] }
        ],
      },
      weights: [400, 500, 700],
      styles: ["normal"],
      subsets: ["latin"],
      fallbacks: ["system-ui", "sans-serif"],
    },
    {
      name: "JetBrains Mono",
      cssVariable: "--font-jetbrains-mono",
      provider: fontProviders.local(),
      options: {
        variants: [
          { weight: 400, style: "normal", src: ["@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2"] },
          { weight: 500, style: "normal", src: ["@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2"] }
        ],
      },
      weights: [400, 500],
      styles: ["normal"],
      subsets: ["latin"],
      fallbacks: ["ui-monospace", "monospace"],
    },
  ],
});
