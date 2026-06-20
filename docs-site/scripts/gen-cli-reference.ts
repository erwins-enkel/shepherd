// Generator: render a CLI reference for the operator-facing `herdr` commands from
// herdr's own live `--help` output, so the pages match the tool's actual surface.
//
// WHY this is a committed artifact (NOT generated at astro build time, unlike the
// TypeDoc API reference and scripts/sync-docs.mjs): `herdr` is an external binary
// (herdr.dev — the interactive-pane manager Shepherd is built on) that is NOT present
// in GitHub Actions or on Vercel. Running it during `astro build` would break the
// build, so instead we run THIS script on demand (`bun run gen:cli`) on a
// herdr-bearing machine, commit the resulting `.md`, and let Starlight render the
// committed pages with no herdr dependency at build time. See #880 / epic #875.
//
// IMPORTANT: these pages are a point-in-time SNAPSHOT. They can silently rot when
// herdr changes until someone re-runs this script. Automated drift detection is the
// job of the regenerate-on-merge gate (#881), which must run on a herdr-bearing
// runner (e.g. the self-hosted CI_RUNNER) to invoke `herdr --help`.
//
// Output is deterministic: a pinned herdr version, a non-TTY capture with fixed
// COLUMNS / no-color / no-ANSI, the machine-variant footer stripped, and $HOME
// normalized — so re-running against the pinned version yields byte-identical files.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// Canonical herdr release these pages are generated against. herdr's `--help` text
// changes between versions, so reproducibility is conditional on a single pinned
// version: the script fails if the installed herdr differs. Bump deliberately (a
// reviewed change) when upgrading herdr — the regenerated diff is the drift signal.
const EXPECTED_HERDR_VERSION = "0.7.0";

// Curated allowlist of OPERATOR-facing herdr commands (epic #875 / #880, Option B).
// Deliberately NOT auto-discovered: the herdr groups Shepherd shells out to
// (agent/tab/pane/workspace, see src/herdr.ts) are driven programmatically and never
// typed by an operator — documenting them would be plumbing noise. `herdr` (launch +
// global options) is the overview/index page; these are the per-command pages.
const OPERATOR_COMMANDS: { cmd: string; title: string; description: string }[] = [
  { cmd: "status", title: "herdr status", description: "Inspect the local client and the running herdr server." },
  { cmd: "update", title: "herdr update", description: "Download and install the latest herdr version." },
  { cmd: "channel", title: "herdr channel", description: "Choose the stable or preview herdr update channel." },
  { cmd: "server", title: "herdr server", description: "Control the herdr server lifecycle (stop, reload config)." },
  { cmd: "session", title: "herdr session", description: "Manage named persistent herdr sessions." },
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const docsSiteRoot = join(scriptDir, "..");
const outDir = join(docsSiteRoot, "src", "content", "docs", "reference", "cli");

const HERDR = Bun.which("herdr");
if (!HERDR) {
  console.error(
    "gen:cli: `herdr` not found on PATH. This script regenerates the CLI reference from the\n" +
      "live herdr binary and must run on a machine with herdr installed (herdr.dev). It is NOT\n" +
      "part of the docs-site build — the generated pages are committed.",
  );
  process.exit(1);
}

/** Run a herdr invocation over a NON-TTY pipe with a deterministic environment, so
 *  the captured text cannot vary with terminal width or color support. Asserts the
 *  output is free of ANSI escapes (which would make the committed pages
 *  non-reproducible). Returns trimmed stdout (stderr appended only if stdout empty,
 *  since some herdr help goes to stderr). */
async function capture(args: string[]): Promise<string> {
  const proc = Bun.spawn([HERDR!, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    // COLUMNS pins wrap width; NO_COLOR + TERM=dumb suppress ANSI styling. Pass a
    // clean, fixed env so host locale / terminal settings cannot leak into output.
    env: { ...process.env, COLUMNS: "80", NO_COLOR: "1", TERM: "dumb" },
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const text = (out.trim() ? out : err).replace(/\r\n/g, "\n");
  // eslint-disable-next-line no-control-regex
  if (/\x1b\[/.test(text)) {
    throw new Error(`gen:cli: ANSI escape sequences in \`herdr ${args.join(" ")}\` output — not reproducible.`);
  }
  return text;
}

/** Strip the machine-variant footer (the `Config:`/`Logs:`/`Env:`/`Home:` trailer)
 *  from the overview `--help`. Those lines print host- and OS-specific absolute paths
 *  (Linux ~/.config vs macOS app-support; HERDR_CONFIG_PATH/XDG can escape $HOME), so
 *  a single $HOME→~ substitution cannot make them byte-identical across machines. The
 *  footer is environment info, not command reference, so we drop it entirely. */
function stripFooter(help: string): string {
  const lines = help.split("\n");
  const footerStart = lines.findIndex((l) => /^Config:\s/.test(l));
  if (footerStart === -1) return help;
  // Also drop a single blank separator line immediately preceding the footer.
  const cut = footerStart > 0 && lines[footerStart - 1].trim() === "" ? footerStart - 1 : footerStart;
  return lines.slice(0, cut).join("\n");
}

/** Belt-and-suspenders: normalize any residual absolute home path to `~`, drop
 *  trailing whitespace per line, and force exactly one trailing newline (LF). */
function normalize(text: string): string {
  const home = homedir();
  const normalized = text
    .split("\n")
    .map((l) => (home ? l.split(home).join("~") : l).replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
  return normalized + "\n";
}

/** Compose a page: deterministic frontmatter + body. The help text is always inside a
 *  fenced code block, so no MDX/Markdown expansion can run on it. */
function page(title: string, description: string, intro: string, help: string): string {
  const fm = `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n`;
  const body = `${intro}\n\n\`\`\`text\n${normalize(help)}\`\`\`\n`;
  return fm + "\n" + body;
}

const GENERATED_NOTE =
  "_Generated from live `herdr --help` — do not edit by hand; run `bun run gen:cli` to regenerate._";

async function main() {
  const version = (await capture(["--version"])).trim();
  if (version !== `herdr ${EXPECTED_HERDR_VERSION}`) {
    console.error(
      `gen:cli: installed herdr is "${version}", expected "herdr ${EXPECTED_HERDR_VERSION}".\n` +
        `Reproducibility is pinned to one release. Bump EXPECTED_HERDR_VERSION in this script to\n` +
        `regenerate the CLI reference against a new herdr release (the diff is the drift signal).`,
    );
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  // Overview / index page from the top-level `herdr --help` (footer stripped).
  const overviewHelp = stripFooter(await capture(["--help"]));
  const overviewIntro =
    `Shepherd drives the [\`herdr\`](https://herdr.dev) interactive-pane manager for you, so most ` +
    `herdr commands are internal plumbing you never run by hand. This reference covers the ` +
    `**operator-facing** commands — the ones you might run directly when managing a Shepherd host. ` +
    `Each page below is the command's own \`--help\` output (command-level, not every leaf flag), ` +
    `pinned to herdr **${EXPECTED_HERDR_VERSION}**.\n\n${GENERATED_NOTE}`;
  writeFileSync(
    join(outDir, "index.md"),
    page("CLI reference", "Operator-facing herdr CLI commands, generated from live --help.", overviewIntro, overviewHelp),
  );

  // One page per allowlisted operator command. Fail loudly if any is missing/empty —
  // a renamed/removed command must not silently drop from the reference.
  for (const { cmd, title, description } of OPERATOR_COMMANDS) {
    const help = await capture([cmd, "--help"]);
    if (!help.trim()) {
      throw new Error(`gen:cli: \`herdr ${cmd} --help\` produced no output — allowlist out of date.`);
    }
    const intro = `${description}\n\n${GENERATED_NOTE} _(herdr ${EXPECTED_HERDR_VERSION}.)_`;
    writeFileSync(join(outDir, `${cmd}.md`), page(title, description, intro, help));
  }

  console.log(`gen:cli: wrote ${OPERATOR_COMMANDS.length + 1} pages to ${outDir} (herdr ${EXPECTED_HERDR_VERSION}).`);
}

await main();
