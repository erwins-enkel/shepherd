// src/pty-attach.mjs  — executed by Node, NOT Bun
import { spawn } from "node-pty";
import { createDemux } from "./pty-demux.mjs";

const [terminalId, colsArg, rowsArg] = process.argv.slice(2);
if (!/^[A-Za-z0-9_-]{1,64}$/.test(terminalId ?? "") || (terminalId ?? "").startsWith("-")) {
  process.exit(2);
}
const herdrBin = process.env.HERDR_BIN || "herdr";

// --takeover: a browser refresh (esp. on mobile after an app-switch) reconnects
// before herdr sees the old client drop, so the stale attach still holds the
// terminal. Takeover bumps it; newest tab always owns the terminal.
const pty = spawn(herdrBin, ["agent", "attach", terminalId, "--takeover"], {
  name: "xterm-color",
  cols: Number(colsArg) || 100,
  rows: Number(rowsArg) || 30,
  env: process.env,
});

pty.onData((d) => process.stdout.write(d));
pty.onExit(({ exitCode }) => process.exit(exitCode ?? 0));

const demux = createDemux({
  onInput: (data) => pty.write(data),
  onResize: (c, r) => pty.resize(c, r),
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => demux.feed(chunk));
