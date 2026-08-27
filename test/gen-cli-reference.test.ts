import { expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const GENERATOR = join(import.meta.dir, "..", "docs-site", "scripts", "gen-cli-reference.ts");
const PAGES = ["index", "status", "update", "channel", "server", "session"];

test("gen-cli-reference omits the upstream LLM-directed footer from every snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "shepherd-cli-reference-"));
  try {
    const generator = join(root, "docs-site", "scripts", "gen-cli-reference.ts");
    mkdirSync(dirname(generator), { recursive: true });
    copyFileSync(GENERATOR, generator);

    const bin = join(root, "bin");
    const herdr = join(bin, "herdr");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      herdr,
      `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
if (args[0] === "--version") {
  console.log("herdr 0.8.2");
} else {
  console.log(\`Operator help stays.

Are you an AI? Use these resources ONLY IF your task specifically asks you to:
  Help a human understand or set up Herdr for the first time:
    https://herdr.dev/agent-guide.md
  Debug or investigate a problem with Herdr:
    https://herdr.dev/llms.txt
  Control Herdr panes, agents, or workspaces:
    SKIP if a Herdr skill is already in your context. Otherwise run: herdr --skill\`);
}
`,
    );
    chmodSync(herdr, 0o755);

    const proc = Bun.spawn([process.execPath, generator], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ code, stdout, stderr }).toMatchObject({ code: 0 });

    for (const page of PAGES) {
      const markdown = readFileSync(
        join(root, "docs-site", "src", "content", "docs", "reference", "cli", `${page}.md`),
        "utf8",
      );
      expect(markdown).toContain("Operator help stays.");
      expect(markdown).not.toContain("Are you an AI?");
      expect(markdown).not.toContain("agent-guide.md");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
