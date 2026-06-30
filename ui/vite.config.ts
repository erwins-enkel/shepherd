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

const backendPort = process.env.SHEPHERD_PORT ?? 7330;

export default defineConfig({
  define: {
    __GIT_SHA__: JSON.stringify(gitSha()),
    __APP_VERSION__: JSON.stringify(appVersion()),
    __RELEASE_DATES__: JSON.stringify(releaseDates()),
    __DEMO__: JSON.stringify(process.env.SHEPHERD_DEMO === "1"),
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
      "/api": `http://localhost:${backendPort}`,
      "/events": { target: `ws://localhost:${backendPort}`, ws: true },
      "/pty": { target: `ws://localhost:${backendPort}`, ws: true },
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
          // CI memory headroom (#1261 OOM, exit 137): on a many-core self-hosted
          // runner vitest defaults maxWorkers to nproc, so the browser project
          // spawns ~nproc concurrent chromium pages AND overlaps the full-parallel
          // node project — peak RSS hit ~8.9 GiB on a 32-core box and intermittently
          // OOM-killed the run. Cap browser file-parallelism to 2 and give it a
          // distinct sequence.groupOrder so it runs AFTER the node project instead
          // of concurrently (vitest requires unique groupOrder when projects differ
          // on maxWorkers). Together this ~halves peak RSS (~8.9→~4.8 GiB) with both
          // projects green. CI-only (GitHub Actions sets CI=true) so local
          // `bun run test` is unchanged. Note: a global `--maxWorkers` CLI flag does
          // NOT cap the browser pool — it must live in the project's test config.
          ...(process.env.CI ? { maxWorkers: 2, sequence: { groupOrder: 1 } } : {}),
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
