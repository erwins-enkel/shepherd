import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// Demo builds (SHEPHERD_DEMO=1) write to a separate output dir so `build:demo`
// can never clobber the prod `build/` bundle.
const outDir = process.env.SHEPHERD_DEMO === "1" ? "build-demo" : "build";

// SvelteKit hashes its own bootstrap script, but not the inline <script>s we put in app.html
// (theme pre-paint, iOS Dynamic Type). Hash them from the file itself so editing app.html can't
// leave a stale hash that silently blocks them.
const appHtml = readFileSync(new URL("./src/app.html", import.meta.url), "utf8");
const inlineScriptHashes = [...appHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
  ([, body]) => `sha256-${createHash("sha256").update(body).digest("base64")}`,
);

export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ pages: outDir, assets: outDir, fallback: "index.html" }),
    // Backstop for agent/forge-authored markdown (see src/lib/agent-markdown.ts): even if a
    // passive-load carrier slipped past the sanitizer, `img-src`/`form-action` stop the beacon
    // and the phish. The app is prerendered, so SvelteKit emits this as a <meta> tag — header-only
    // directives (frame-ancestors, report-uri) would be ignored there and are not used.
    csp: {
      mode: "hash",
      directives: {
        "default-src": ["self"],
        // 'wasm-unsafe-eval': shiki's oniguruma wasm. No 'unsafe-eval'.
        "script-src": ["self", "wasm-unsafe-eval", ...inlineScriptHashes],
        // 'unsafe-inline': style="" attributes and the <style> tags xterm/mermaid inject.
        "style-src": ["self", "unsafe-inline", "https://fonts.googleapis.com"],
        "font-src": ["self", "data:", "https://fonts.gstatic.com"],
        "img-src": ["self", "data:", "blob:"],
        // ws:/wss: explicit — `'self'` matching of same-origin sockets is inconsistent in older
        // Safari. These are for the /events and /pty sockets.
        "connect-src": ["self", "ws:", "wss:"],
        // The preview pane frames the dev server on the same host but an arbitrary port; the
        // iframe is sandboxed (Viewport.svelte).
        "frame-src": ["self", "http:", "https:"],
        "worker-src": ["self", "blob:"],
        "media-src": ["self", "blob:"],
        "manifest-src": ["self"],
        "object-src": ["none"],
        "base-uri": ["self"],
        "form-action": ["self"],
      },
    },
  },
};
