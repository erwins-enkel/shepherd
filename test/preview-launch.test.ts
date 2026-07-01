import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { ensurePreviewStartScript } from "../src/preview-launch";

test("ensurePreviewStartScript: generated package dev wrapper installs deps and picks a free port", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-preview-launch-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });

    const scriptPath = await ensurePreviewStartScript(dir, "cd ui && bun run dev");
    expect(scriptPath).not.toBeNull();
    expect(scriptPath!.startsWith(join(dir, ".git", "shepherd"))).toBe(true);
    execFileSync("bash", ["-n", scriptPath!]);

    const body = readFileSync(scriptPath!, "utf8");
    expect(body).toContain("install_if_needed");
    expect(body).toContain("bun install");
    expect(body).toContain("pick_port");
    expect(body).toContain(`printf '%s\\n' "$port" > "$WORKTREE_ROOT/.shepherd-preview"`);
    expect(body).toContain(`exec bun run dev -- --port "$port"`);
    expect(body).toContain(`run_package_dev "\${BASH_REMATCH[1]}" "\${BASH_REMATCH[2]}"`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensurePreviewStartScript: package wrapper runs dev command with selected port", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-preview-launch-run-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "ui", "node_modules"), { recursive: true });
    writeFileSync(
      join(dir, "ui", "package.json"),
      JSON.stringify({ scripts: { dev: "vite dev" } }),
    );

    const fakeBin = join(dir, "bin");
    const fakeBunOut = join(dir, "fake-bun.out");
    mkdirSync(fakeBin);
    const fakeBun = join(fakeBin, "bun");
    writeFileSync(
      fakeBun,
      `#!/usr/bin/env bash
{
  printf 'cwd=%s\\n' "$PWD"
  printf 'args=%s\\n' "$*"
  printf 'PORT=%s\\n' "$PORT"
} > "$FAKE_BUN_OUT"
`,
    );
    chmodSync(fakeBun, 0o700);

    const scriptPath = await ensurePreviewStartScript(dir, "cd ui && bun run dev");
    expect(scriptPath).not.toBeNull();

    execFileSync(scriptPath!, {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FAKE_BUN_OUT: fakeBunOut,
        SHEPHERD_WORKTREE_PATH: dir,
        SHEPHERD_PREVIEW_PORT: "45678",
      },
    });

    const output = readFileSync(fakeBunOut, "utf8");
    expect(output).toContain(`cwd=${join(dir, "ui")}`);
    expect(output).toContain("args=run dev -- --port 45678");
    expect(output).toContain("PORT=45678");
    expect(readFileSync(join(dir, ".shepherd-preview"), "utf8")).toBe("45678\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
