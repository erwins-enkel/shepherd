#!/usr/bin/env node
// fake herdr for the two-process machines test: `herdr agent attach <id> --takeover` becomes an
// echo terminal — it greets with the attached id, then answers every input line with `echo: <line>`.
// Exits when its terminal closes, and after two minutes at the latest so a test that dies mid-run
// never leaves it behind.
const id = process.argv[4] ?? "?";
process.stdout.write(`fake-herdr attached ${id}\r\n`);
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  const lines = pending.split(/[\r\n]/);
  pending = lines.pop() ?? "";
  for (const line of lines) if (line) process.stdout.write(`echo: ${line}\r\n`);
});
process.stdin.on("end", () => process.exit(0));
setTimeout(() => process.exit(0), 120_000);
