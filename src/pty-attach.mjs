// src/pty-attach.mjs  — executed by Node, NOT Bun
import { spawn } from "node-pty";

const [terminalId, colsArg, rowsArg] = process.argv.slice(2);
const herdrBin = process.env.HERDR_BIN || "herdr";

const pty = spawn(herdrBin, ["agent", "attach", terminalId], {
  name: "xterm-color",
  cols: Number(colsArg) || 100,
  rows: Number(rowsArg) || 30,
  env: process.env,
});

pty.onData((d) => process.stdout.write(d));
pty.onExit(({ exitCode }) => process.exit(exitCode ?? 0));

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1 && buf.startsWith("\x00resize:")) {
    const frame = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    const [, c, r] = frame.split(":");
    pty.resize(Number(c) || 100, Number(r) || 30);
  }
  if (buf && !buf.startsWith("\x00")) {
    pty.write(buf);
    buf = "";
  }
});
