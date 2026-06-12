#!/usr/bin/env node
// Git merge driver for flat i18n message catalogs (ui/ + extension/ messages/*.json).
//
// Why this exists: every feature PR appends keys to the tail of the same
// catalogs, so two concurrent branches collide on the identical hunk on every
// rebase onto main — a constant, content-free merge conflict. These clashes are
// almost always *additive* (branch A adds `foo`, branch B adds `bar`), which a
// line-based merge can't reconcile but a key-aware one can. This driver unions
// the keys: additive and one-sided edits auto-resolve, and only a genuine
// same-key-different-value clash falls through as a real conflict.
//
// Registered as `merge.i18n-union.driver` (see scripts/register-merge-driver.mjs,
// run from husky `prepare`) and bound to the catalogs in .gitattributes.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Three-way union of two flat string→string catalogs.
 *
 * @param {Record<string,unknown>} base   common ancestor (%O)
 * @param {Record<string,unknown>} ours   current branch (%A)
 * @param {Record<string,unknown>} theirs incoming branch (%B)
 * @returns {{ merged: Record<string,unknown>, conflicts: string[] }}
 *   `merged` preserves ours' key order, with theirs-only additions appended.
 *   `conflicts` lists keys both sides changed to different values (or one side
 *   edited while the other deleted) — these are left for manual resolution.
 */
export function mergeCatalogs(base, ours, theirs) {
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const conflicts = [];
  // Start from ours so base keys ours kept + ours-added keys retain their order.
  const merged = { ...ours };

  for (const k of Object.keys(theirs)) {
    if (!has(ours, k)) {
      if (!has(base, k)) {
        merged[k] = theirs[k]; // theirs added a brand-new key
      } else if (base[k] === theirs[k]) {
        // ours deleted it, theirs left it untouched → stay deleted
      } else {
        conflicts.push(k); // ours deleted, theirs edited → genuine conflict
      }
      continue;
    }
    if (ours[k] === theirs[k]) continue; // identical on both sides
    if (has(base, k) && base[k] === ours[k]) {
      merged[k] = theirs[k]; // only theirs changed it
    } else if (has(base, k) && base[k] === theirs[k]) {
      // only ours changed it → keep ours (already in `merged`)
    } else {
      conflicts.push(k); // both sides changed it differently
    }
  }

  // Keys theirs deleted: drop them when ours left them untouched, else conflict.
  for (const k of Object.keys(base)) {
    if (has(theirs, k) || !has(ours, k)) continue; // not deleted by theirs, or already gone from ours
    if (ours[k] === base[k]) {
      delete merged[k]; // theirs deleted, ours unchanged → honor the deletion
    } else {
      conflicts.push(k); // theirs deleted, ours edited → genuine conflict
    }
  }

  return { merged, conflicts };
}

/** Serialize a clean (conflict-free) merge in the catalogs' canonical format. */
function serializeClean(merged) {
  return JSON.stringify(merged, null, 2) + "\n";
}

/**
 * Serialize a conflicted merge with inline git markers for each conflicting key.
 * The output is deliberately not valid JSON — it must fail loudly downstream
 * (build, check:i18n) until a human resolves it, never look like a clean pass.
 */
function serializeConflicted(merged, conflicts, ours, theirs) {
  const conflictSet = new Set(conflicts);
  // Render every surviving key in order, plus the conflicting keys (which may
  // have been dropped from `merged`) so both sides' values stay visible.
  const order = [...new Set([...Object.keys(merged), ...conflicts])];
  const parts = order.map((k) => {
    if (!conflictSet.has(k)) {
      return `  ${JSON.stringify(k)}: ${JSON.stringify(merged[k])}`;
    }
    return (
      "<<<<<<< ours\n" +
      `  ${JSON.stringify(k)}: ${JSON.stringify(ours[k])}\n` +
      "=======\n" +
      `  ${JSON.stringify(k)}: ${JSON.stringify(theirs[k])}\n` +
      ">>>>>>> theirs"
    );
  });
  return "{\n" + parts.join(",\n") + "\n}\n";
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * CLI entry: `json-union-merge.mjs <base> <ours> <theirs> [path]`.
 * Git invokes it with %O %A %B %P; the merged result is written back to <ours>.
 * Exit 0 = clean, exit 1 = unresolved conflicts remain.
 */
function main(argv) {
  const [basePath, oursPath, theirsPath, label] = argv;
  const base = readJson(basePath);
  const ours = readJson(oursPath);
  const theirs = readJson(theirsPath);

  // If any side isn't parseable JSON, fall back to git's default text conflict
  // rather than risk mangling the file.
  if (base === null || ours === null || theirs === null) {
    process.stderr.write(
      `i18n-union: ${label ?? oursPath} not parseable as JSON — leaving for manual merge\n`,
    );
    return 1;
  }

  const { merged, conflicts } = mergeCatalogs(base, ours, theirs);
  if (conflicts.length === 0) {
    writeFileSync(oursPath, serializeClean(merged));
    return 0;
  }
  writeFileSync(oursPath, serializeConflicted(merged, conflicts, ours, theirs));
  process.stderr.write(
    `i18n-union: ${label ?? oursPath} has ${conflicts.length} conflicting key(s): ${conflicts.join(", ")}\n`,
  );
  return 1;
}

const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
