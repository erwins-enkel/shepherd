// @ts-check
import { defineConfig, fontProviders } from "astro/config";

// Static marketing site for shepherd.run.
// - `output: "static"` is Astro's default; set explicitly for clarity.
// - No SSR adapter: a fully static `dist/` is auto-detected by Vercel
//   (Vercel ships first-class Astro support; static output needs no adapter).
// - Self-hosted fonts via the npm font provider, which consumes the installed
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
      provider: fontProviders.npm({ package: "@fontsource/space-grotesk" }),
      weights: [400, 500, 700],
      styles: ["normal"],
      subsets: ["latin"],
      fallbacks: ["system-ui", "sans-serif"],
    },
    {
      name: "JetBrains Mono",
      cssVariable: "--font-jetbrains-mono",
      provider: fontProviders.npm({ package: "@fontsource/jetbrains-mono" }),
      weights: [400, 500],
      styles: ["normal"],
      subsets: ["latin"],
      fallbacks: ["ui-monospace", "monospace"],
    },
  ],
});
