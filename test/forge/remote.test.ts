import { test, expect } from "bun:test";
import { parseRemote } from "../../src/forge/remote";

test("parseRemote: https github → host + slug", () => {
  expect(parseRemote("https://github.com/o/r.git")).toEqual({ host: "github.com", slug: "o/r" });
});

test("parseRemote: https without .git suffix", () => {
  expect(parseRemote("https://github.com/o/r")).toEqual({ host: "github.com", slug: "o/r" });
});

test("parseRemote: ssh scp-style github → host + slug", () => {
  expect(parseRemote("git@github.com:o2/r2.git")).toEqual({ host: "github.com", slug: "o2/r2" });
});

test("parseRemote: self-hosted gitea https", () => {
  expect(parseRemote("https://git.example.com/team/proj.git")).toEqual({
    host: "git.example.com",
    slug: "team/proj",
  });
});

test("parseRemote: ssh:// url form with port", () => {
  expect(parseRemote("ssh://git@git.example.com:2222/team/proj.git")).toEqual({
    host: "git.example.com",
    slug: "team/proj",
  });
});

test("parseRemote: https with port", () => {
  expect(parseRemote("https://git.example.com:3000/team/proj.git")).toEqual({
    host: "git.example.com",
    slug: "team/proj",
  });
});

test("parseRemote: trailing slash tolerated", () => {
  expect(parseRemote("https://github.com/o/r/")).toEqual({ host: "github.com", slug: "o/r" });
});

test("parseRemote: garbage → null", () => {
  expect(parseRemote("not a url")).toBeNull();
  expect(parseRemote("")).toBeNull();
});
