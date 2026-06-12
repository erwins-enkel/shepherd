#!/usr/bin/env node
// Register the i18n catalog union merge driver in this clone's git config.
//
// .gitattributes can *name* a merge driver (`merge=i18n-union`) but git refuses
// to run one unless `merge.i18n-union.driver` is defined in config — and config
// is not checked in. So every clone must self-register. This runs from the root
// `prepare` script (husky), i.e. on every `bun install`, covering dev clones,
// CI, and the merge-train server. Worktrees share the common config, so one
// registration covers them all. It's idempotent.
//
// See scripts/json-union-merge.mjs and .gitattributes.

import { execFileSync } from "node:child_process";

// Git runs merge drivers from the worktree root, so a repo-relative path resolves
// correctly in every worktree — and unlike an absolute path it doesn't go stale
// when a worktree is relocated or pruned (Shepherd spins worktrees up and down).
// %O = ancestor, %A = ours/output, %B = theirs, %P = pathname (for messages).
const command = "node scripts/json-union-merge.mjs %O %A %B %P";

function gitConfig(key, value) {
  execFileSync("git", ["config", key, value], { stdio: "ignore" });
}

try {
  gitConfig("merge.i18n-union.name", "union merge for flat i18n catalogs");
  gitConfig("merge.i18n-union.driver", command);
  process.stdout.write("✓ registered i18n-union merge driver\n");
} catch (err) {
  // Not fatal — a missing driver just means catalog conflicts resolve the old
  // (manual) way. Don't break `bun install` outside a git checkout (e.g. tarball).
  process.stderr.write(`i18n-union: could not register merge driver (${err?.message ?? err})\n`);
}
