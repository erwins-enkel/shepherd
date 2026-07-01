import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// Demo builds (SHEPHERD_DEMO=1) write to a separate output dir so `build:demo`
// can never clobber the prod `build/` bundle.
const outDir = process.env.SHEPHERD_DEMO ? "build-demo" : "build";

export default {
  preprocess: vitePreprocess(),
  kit: { adapter: adapter({ pages: outDir, assets: outDir, fallback: "index.html" }) },
};
