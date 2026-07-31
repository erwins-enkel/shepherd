/**
 * Runtime-agnostic "is this binary on PATH?" probe for test skip-gates.
 *
 * Exists because the obvious spelling is a footgun. Node signals a failed spawn
 * with `status: null`, so a guard written as `spawnSync(bin, …).status !== null`
 * reads correctly — under Node. Bun leaves `status` **undefined** on ENOENT, so
 * that same guard fails OPEN: it reports the binary as present and the gated
 * suite runs anyway (#1977). CI never caught it because CI runners have the
 * binaries; it only bites contributors on a host that doesn't.
 */

import { spawnSync } from "node:child_process";

/**
 * True iff `bin` resolves on PATH and is executable.
 *
 * Checks `error` (set to an ENOENT — or EACCES for a present-but-not-executable
 * file — `Error` in BOTH runtimes) and treats `status` as non-null only via
 * `!= null`, which covers Bun's `undefined` alongside Node's `null`.
 *
 * The probe argv is a fixed `-v` purely to give the process something harmless
 * to do; the **exit code is deliberately not inspected**. `status != null` only
 * asserts "the process actually ran", so this stays honest for binaries whose
 * `-v` means something other than "print version" or exits non-zero.
 */
export function hasExecutable(bin: string): boolean {
  const probe = spawnSync(bin, ["-v"], { stdio: "ignore" });
  return !probe.error && probe.status != null;
}
