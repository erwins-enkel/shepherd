import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";

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

// Map each release tag to its date (`{ "1.20.0": "2026-06-09", … }`) so the
// What's-New drawer can show when an entry's `sinceVersion` shipped. Keyed
// without the leading `v` to match `FeatureAnnouncement.sinceVersion`. Empty
// map when git is unavailable — the drawer falls back to version-only.
function releaseDates(): Record<string, string> {
  try {
    const out = execFileSync(
      "git",
      ["tag", "--list", "v*.*.*", "--format=%(refname:short) %(creatordate:short)"],
      { encoding: "utf8" },
    );
    const map: Record<string, string> = {};
    for (const line of out.split("\n")) {
      const [tag, date] = line.trim().split(/\s+/);
      if (tag && date) map[tag.replace(/^v/, "")] = date;
    }
    return map;
  } catch {
    return {};
  }
}

export default defineConfig({
  define: {
    __GIT_SHA__: JSON.stringify(gitSha()),
    __APP_VERSION__: JSON.stringify(appVersion()),
    __RELEASE_DATES__: JSON.stringify(releaseDates()),
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
      // Backend port defaults to 7330; override with SHEPHERD_PORT — the same var the
      // backend reads (src/config.ts) — to point the dev UI at a worktree backend
      // (e.g. testing a branch without disturbing the main instance).
      "/api": `http://localhost:${process.env.SHEPHERD_PORT ?? 7330}`,
      "/events": { target: `ws://localhost:${process.env.SHEPHERD_PORT ?? 7330}`, ws: true },
      "/pty": { target: `ws://localhost:${process.env.SHEPHERD_PORT ?? 7330}`, ws: true },
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          // browser specs run in the browser project; everything else here
          exclude: [...configDefaults.exclude, "**/*.browser.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.ts"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
            // vitest's default browser server port (63315) has strictPort on by
            // default, causing a hard failure when a leftover/concurrent test
            // process holds the port. strictPort:false lets Vite auto-increment
            // to the next free port; vitest discovers the bound port and hands
            // it to the browser client, so a predictable port isn't needed. (#817)
            api: { strictPort: false },
          },
        },
      },
    ],
  },
});
