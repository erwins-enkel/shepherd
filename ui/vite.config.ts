import { execFileSync } from "node:child_process";
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

export default defineConfig({
  define: {
    __GIT_SHA__: JSON.stringify(gitSha()),
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
    proxy: {
      "/api": "http://localhost:7330",
      "/events": { target: "ws://localhost:7330", ws: true },
      "/pty": { target: "ws://localhost:7330", ws: true },
    },
  },
});
