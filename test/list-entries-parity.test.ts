import { expect, test } from "bun:test";
import {
  checkBrowserHost,
  checkEgressHost,
  PRIORITY_LABEL as UI_PRIORITY_LABEL,
} from "../ui/src/lib/list-entries";
import { validateBrowserAllowedHosts, validateEgressExtraHosts } from "../src/validate";
import { PRIORITY_LABEL } from "../src/drain-core";

// The repo settings' list fields check each entry client-side before the PUT (#3446). A client
// rule that drifts from the server's either refuses a host the server takes or lets one through
// that the PUT then rejects — so both run over the same inputs here.
const HOSTS = [
  "app.example.com",
  "App.Example.COM",
  "  padded.example.com ",
  "xn--bcher-kva.example",
  "a-b.example.com",
  "1.2.3.4",
  "localhost",
  "https://x.com",
  "x.com:443",
  "x.com:8443",
  "*.x.com:22",
  "x.com:",
  "x.com:0",
  "x.com:0443",
  "x.com:65536",
  "x.com:22:23",
  "x.com/a",
  "*.x.com",
  "*.X.Com",
  "*.com",
  "*x.com",
  "a.*.com",
  "*.*.x.com",
  "*.1.2.3.4",
  "1.2.3.4:22",
  "-x.com",
  "x-.com",
  "x..com",
  ".x.com",
  "a_b.com",
  "a b.com",
  "",
  "   ",
];

test.each(HOSTS)("egress host %j: client and server agree", (raw) => {
  const client = checkEgressHost(raw, []);
  const server = validateEgressExtraHosts([raw]);
  expect(client.ok).toBe(server.ok);
  if (client.ok && server.ok) expect([client.value]).toEqual(server.value);
});

test.each(HOSTS)("browser host %j: client and server agree", (raw) => {
  const client = checkBrowserHost(raw, []);
  const server = validateBrowserAllowedHosts([raw]);
  expect(client.ok).toBe(server.ok);
  if (client.ok && server.ok) expect([client.value]).toEqual(server.value);
});

test("the built-in priority label matches the drain's", () => {
  expect(UI_PRIORITY_LABEL).toBe(PRIORITY_LABEL);
});
