// Types for the perms fixer (scripts/fix-node-pty-perms.mjs). The script stays
// plain .mjs so `bun scripts/fix-node-pty-perms.mjs` runs it directly from the
// install paths; this declaration only exists so the TypeScript test
// (test/fix-node-pty-perms.test.ts) can import it with proper types.

/** `<repoRoot>/node_modules/node-pty`, resolved relative to the script (not cwd). */
export function resolveNodePtyDir(): string;

/**
 * chmod +x the spawn-helper node-pty loads for `platformArch`, if present and not
 * already owner-executable. Returns the paths it flipped. Idempotent no-op (no
 * throw) when the dir/files are absent; `log` is called once per actual flip.
 */
export function fixNodePtyPerms(
  nodePtyDir: string,
  platformArch: string,
  log?: (msg: string) => void,
): string[];
