import { describe, expect, test } from "vitest";
import { classifyEgressHost } from "./egress-trust";

describe("classifyEgressHost", () => {
  test.each([
    ["10.0.0.1", "ip"],
    ["xn--80ak6aa92e.com", "idn"],
    ["api.xn--p1ai", "idn"],
    ["pastebin.com", "paste"],
    ["gist.github.com", "paste"],
    ["dl.dropboxusercontent.com", "paste"],
    ["abc123.ngrok.io", "tunnel"],
    ["x.trycloudflare.com", "tunnel"],
    ["webhook.site", "oast"],
    ["abc.oast.fun", "oast"],
    ["my-app.vercel.app", "hosting"],
    ["d1234.cloudfront.net", "hosting"],
    ["api.telegram.org", "chatbot"],
    ["someone.github.io", "subdomain"],
    ["bucket.s3.amazonaws.com", "subdomain"],
    ["storage.googleapis.com", "subdomain"],
  ])("%s is risky (%s)", (host, reason) => {
    expect(classifyEgressHost(host)).toEqual({ tier: "risky", reason });
  });

  test.each([
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    "pypi.org",
    "files.pythonhosted.org",
    "crates.io",
    "static.crates.io",
    "proxy.golang.org",
    "sum.golang.org",
    "api.nuget.org",
    "nodejs.org",
    "static.rust-lang.org",
    "ghcr.io",
    "registry-1.docker.io",
  ])("%s is trusted", (host) => {
    expect(classifyEgressHost(host)).toEqual({ tier: "trusted" });
  });

  test("normalizes case and whitespace", () => {
    expect(classifyEgressHost("  Registry.NPMJS.org ")).toEqual({ tier: "trusted" });
    expect(classifyEgressHost(" WEBHOOK.SITE")).toEqual({ tier: "risky", reason: "oast" });
  });

  test.each([
    "registry.npmjs.org.attacker.com",
    "evil.registry.npmjs.org",
    "notgithub.io",
    "api.example.com",
    "registry.corp.example",
    "test.pypi.org",
  ])("%s is normal (no lookalike or suffix trust)", (host) => {
    expect(classifyEgressHost(host)).toEqual({ tier: "normal" });
  });

  // #3923: classifies allowlist entries too — the port is ignored, a *. wildcard is risky.
  test.each([
    ["*.example.com", "wildcard"],
    ["*.corp.example:8443", "wildcard"],
    ["*.github.io", "subdomain"],
    ["*.pastebin.com", "paste"],
    ["10.0.0.1:22", "ip"],
  ])("entry %s is risky (%s)", (entry, reason) => {
    expect(classifyEgressHost(entry)).toEqual({ tier: "risky", reason });
  });

  test("a port entry keeps its host's tier", () => {
    expect(classifyEgressHost("registry.npmjs.org:8443")).toEqual({ tier: "trusted" });
    expect(classifyEgressHost("git.corp.example:2222")).toEqual({ tier: "normal" });
  });
});
