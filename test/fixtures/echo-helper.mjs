// fake PTY helper for tests: ignores args, emits a marker, exits
process.stdout.write("PTY-BRIDGE-OK\n");
setTimeout(() => process.exit(0), 50);
