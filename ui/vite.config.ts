import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function appVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "dev";
  } catch {
    return "dev";
  }
}

export default defineConfig({
  define: {
    __GIT_SHA__: JSON.stringify(gitSha()),
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
  plugins: [
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/lib/paraglide",
      strategy: ["localStorage", "preferredLanguage", "baseLocale"],
    }),
    tailwindcss(),
    sveltekit(),
  ],
  server: {
    port: 5174,
    strictPort: true,
    // Vite listens on localhost; `tailscale serve --https 5173 http://localhost:5173`
    // proxies the tailnet in front of it. allowedHosts must list the tailnet suffix
    // so Vite doesn't reject the forwarded Host header (*.ts.net).
    allowedHosts: [".ts.net"],
    proxy: {
      "/api": "http://localhost:7330",
      "/events": { target: "ws://localhost:7330", ws: true },
      "/pty": { target: "ws://localhost:7330", ws: true },
    },
  },
});
