import { test, expect, describe } from "bun:test";
import { GithubForge } from "../../src/forge/github";

function fakeRunner(responses: Record<string, string>) {
  const run = async (args: string[]): Promise<string> => {
    const path = args.find((a) => a.startsWith("repos/")) ?? args.slice(0, 2).join(" ");
    if (responses[path] === undefined) throw new Error("gh: 404");
    return responses[path];
  };
  return { run };
}

describe("GithubForge epic reads", () => {
  test("listSubIssues → children in order with native state/labels/body", async () => {
    const { run } = fakeRunner({
      "repos/o/r/issues/327/sub_issues": JSON.stringify([
        {
          number: 320,
          title: "EFI",
          html_url: "u320",
          body: "b320",
          state: "closed",
          labels: [{ name: "shepherd:active" }],
        },
        { number: 326, title: "Ont", html_url: "u326", body: "", state: "open", labels: [] },
      ]),
    });
    expect(await new GithubForge("o/r", {} as never, run).listSubIssues!(327)).toEqual([
      {
        number: 320,
        title: "EFI",
        url: "u320",
        body: "b320",
        closed: true,
        labels: ["shepherd:active"],
      },
      { number: 326, title: "Ont", url: "u326", body: "", closed: false, labels: [] },
    ]);
  });

  test("listBlockedBy → numbers", async () => {
    const { run } = fakeRunner({
      "repos/o/r/issues/323/dependencies/blocked_by": JSON.stringify([
        { number: 320 },
        { number: 322 },
      ]),
    });
    expect(await new GithubForge("o/r", {} as never, run).listBlockedBy!(323)).toEqual([320, 322]);
  });

  test("404 → [] (no native links)", async () => {
    expect(await new GithubForge("o/r", {} as never, fakeRunner({}).run).listSubIssues!(1)).toEqual(
      [],
    );
  });
});
