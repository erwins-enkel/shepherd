// Pure parsers for Linux host facts — a process's systemd unit, PSI pressure, `systemctl show`
// output. A leaf module (no imports) so the Operator Assistant's system_health (#1446) shares them
// with diagnostics.ts without pulling in diagnostics' import graph, which reaches service.ts.

/** Parse `/proc/self/cgroup`. cgroup v2 emits a single `0::<path>` line; we trust only that
 *  (v1's `N:ctrl:<path>` lines are ignored). Returns the leaf unit when it is a `*.service`
 *  (⇒ systemd-managed) and whether it lives under a `user@…` manager (⇒ `systemctl --user`). */
export function parseCgroupUnit(cgroup: string): { unit: string | null; userScope: boolean } {
  const line = cgroup.split("\n").find((l) => l.startsWith("0::"));
  if (!line) return { unit: null, userScope: false };
  const path = line.slice(3);
  const userScope = path.includes("/user@");
  const leaf = path.split("/").filter(Boolean).pop() ?? "";
  return { unit: leaf.endsWith(".service") ? leaf : null, userScope };
}

/** Parse `systemctl show` KEY=VALUE lines into a map. */
export function parseSystemctlShow(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const eq = raw.indexOf("=");
    if (eq <= 0) continue;
    out[raw.slice(0, eq)] = raw.slice(eq + 1).trim();
  }
  return out;
}

/** Parse a `/proc/pressure/<res>` file's `avg10=` value on its `some` line (the standard
 *  some-stalled indicator) or, with `line = "full"`, its all-stalled line; null when
 *  absent/unparseable. */
export function parsePsiAvg10(psi: string, line: "some" | "full" = "some"): number | null {
  const row = psi.split("\n").find((l) => l.startsWith(`${line} `));
  const m = row?.match(/avg10=(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/** Parse `/proc/meminfo`'s `MemAvailable:` (kB) into bytes, or null when absent/unparseable. */
export function parseMemAvailable(meminfo: string): number | null {
  const m = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  return m ? Number(m[1]) * 1024 : null;
}
