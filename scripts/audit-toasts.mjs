#!/usr/bin/env node
// Toast inventory + lifetime-policy gate.
//
// Enumerates every `toasts.info(` call site in the UI (excluding tests) using a
// balanced-paren scan of each call's own argument list — a fixed-window grep bleeds
// option flags between adjacent calls, so this parses each call in isolation.
//
// For each site it reports the signal flags (sticky / alert / action / key / finite
// duration) and the resulting lifetime bucket under the unified policy:
//   - sticky:true          -> PERSIST (never auto-dismiss)
//   - alert:true (no dur)  -> FAILURE (12s auto-dismiss)
//   - explicit duration    -> that duration
//   - otherwise            -> SUCCESS/NOTICE (4s)
//
// Gate mode (default): fails if any product `toasts.info(` still passes
// `duration: null` (removed from the API in favor of `sticky: true`). Pass
// `--list` to print the full inventory table instead.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const UI_SRC = join(ROOT, "ui/src");

/** Recursively collect .svelte/.ts files under a dir, skipping test files. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(svelte|ts)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

/** Line number (1-based) of a byte offset in src. */
function lineOf(src, pos) {
  let n = 1;
  for (let i = 0; i < pos; i++) if (src[i] === "\n") n++;
  return n;
}

/** Extract the balanced `(...)` argument text starting at `openIdx` (the "("). */
function balanced(src, openIdx) {
  let depth = 0;
  let inStr = null;
  let prev = "";
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === inStr && prev !== "\\") inStr = null;
      prev = c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      prev = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
    prev = c;
  }
  return src.slice(openIdx);
}

const sites = [];
for (const file of walk(UI_SRC)) {
  const src = readFileSync(file, "utf8");
  const re = /toasts\.info\(/g;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf("(", m.index);
    const call = balanced(src, open);
    const flags = {
      sticky: /\bsticky:\s*true/.test(call),
      null: /duration:\s*null/.test(call),
      durNum: /duration:\s*\d/.test(call),
      alert: /\balert:\s*true/.test(call),
      // action:/key: matches can appear inside a key STRING (e.g. `plugin-action:`);
      // require the token at an option-key position (preceded by `{`, `,` or newline).
      action: /[{,\n]\s*action:/.test(call),
      key: /[{,\n]\s*key\b\s*[:,]/.test(call),
    };
    let bucket;
    if (flags.sticky || flags.null) bucket = "PERSIST";
    else if (flags.durNum) bucket = "EXPLICIT";
    else if (flags.alert) bucket = "FAILURE-12s";
    else bucket = "SUCCESS/NOTICE-4s";
    sites.push({ file: relative(ROOT, file), line: lineOf(src, m.index), flags, bucket });
  }
}

sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

const list = process.argv.includes("--list");
if (list) {
  const fl = (f) =>
    [
      f.sticky && "sticky",
      f.null && "duration:null",
      f.durNum && "duration:N",
      f.alert && "alert",
      f.action && "action",
      f.key && "key",
    ]
      .filter(Boolean)
      .join(" ") || "(bare)";
  for (const s of sites) console.log(`${s.file}:${s.line}\t${s.bucket}\t${fl(s.flags)}`);
}

const counts = sites.reduce((a, s) => ((a[s.bucket] = (a[s.bucket] ?? 0) + 1), a), {});
console.error(`\ntoasts.info sites: ${sites.length}`);
for (const [k, v] of Object.entries(counts)) console.error(`  ${k}: ${v}`);

const legacy = sites.filter((s) => s.flags.null);
if (legacy.length) {
  console.error(
    `\nERROR: ${legacy.length} site(s) still pass duration:null (use sticky:true for persistence):`,
  );
  for (const s of legacy) console.error(`  ${s.file}:${s.line}`);
  process.exit(1);
}
