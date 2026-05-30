#!/usr/bin/env node
// fake herdr for tests: prints its argv (the attach invocation) then exits
process.stdout.write("HERDR-ARGV:" + JSON.stringify(process.argv.slice(2)) + "\n");
setTimeout(() => process.exit(0), 30);
