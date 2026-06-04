import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { crx } from "@crxjs/vite-plugin";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/lib/paraglide",
      // popup/options pages have localStorage; fall back to browser lang.
      strategy: ["localStorage", "preferredLanguage", "baseLocale"],
    }),
    svelte(),
    tailwindcss(),
    crx({ manifest }),
  ],
  server: { port: 5180, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
