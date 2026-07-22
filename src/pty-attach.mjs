// src/pty-attach.mjs  — executed by Node, NOT Bun
import { spawn } from "node-pty";
import { createDemux } from "./pty-demux.mjs";

const [terminalId, colsArg, rowsArg] = process.argv.slice(2);
// Accept a herdr terminal_id (≤0.7.4) or a pane_id `workspaceId:paneId` (the 0.7.5 attach
// target — #1890); mirrors isValidTerminalId in validate.ts.
if (
  !/^[A-Za-z0-9_-]{1,64}(:[A-Za-z0-9_-]{1,64})?$/.test(terminalId ?? "") ||
  (terminalId ?? "").startsWith("-")
) {
  process.exit(2);
}
const herdrBin = process.env.HERDR_BIN || "herdr";

// --takeover: a browser refresh (esp. on mobile after an app-switch) reconnects
// before herdr sees the old client drop, so the stale attach still holds the
// terminal. Takeover bumps it; newest tab always owns the terminal.
let pty;
try {
  pty = spawn(herdrBin, ["agent", "attach", terminalId, "--takeover"], {
    name: "xterm-color",
    cols: Number(colsArg) || 100,
    rows: Number(rowsArg) || 30,
    env: process.env,
  });
} catch (err) {
  // node-pty discards the errno and rethrows a generic "posix_spawnp failed." when
  // its macOS spawn-helper can't be exec'd — almost always a missing execute bit on
  // the prebuilt helper (node-pty ships it 0644; Bun preserves tarball perms). The
  // raw stack is a black box; replace it with an actionable line pointing at the fix.
  if (String(err && err.message).includes("posix_spawn")) {
    // The helper is either the prebuilt or the source-built one, depending on the
    // install; name both so the pointed-at path isn't misleading. The fix command
    // handles either.
    const arch = `${process.platform}-${process.arch}`;
    process.stderr.write(
      `pty-attach: node-pty could not launch its spawn-helper — likely a missing ` +
        `execute bit (EACCES) on node_modules/node-pty/{build/Release,prebuilds/${arch}}/spawn-helper. ` +
        `Fix: run \`bun scripts/fix-node-pty-perms.mjs\` or re-run deploy/provision.ts, then retry.\n`,
    );
    process.exit(1);
  }
  throw err;
}

pty.onData((d) => process.stdout.write(d));
pty.onExit(({ exitCode }) => process.exit(exitCode ?? 0));

// Guard write/resize: when the herdr attach pty is transiently gone (e.g. a
// takeover bumped this client between frames), node-pty throws EBADF. Letting
// that propagate crashes the helper → the WS closes → the client reconnects →
// on mobile, resize storms re-trigger it instantly: a visible jump loop. Swallow
// it; pty.onExit handles a genuine exit cleanly.
const demux = createDemux({
  onInput: (data) => {
    try {
      pty.write(data);
    } catch {
      /* pty gone; onExit will fire */
    }
  },
  onResize: (c, r) => {
    try {
      pty.resize(c, r);
    } catch {
      /* pty gone; onExit will fire */
    }
  },
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => demux.feed(chunk));
