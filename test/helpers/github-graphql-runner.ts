import type { GhRunner } from "../../src/forge/github";
import type { IssuePullRequestReference } from "../../src/forge/types";

/** A `gh` runner that, like GitHub, rejects a `gh api graphql` document whose braces don't
 *  balance, failing the way `gh` does; a well-formed one gets `respond(args)`. Plain fakes answer
 *  any query text, so a malformed query never failed a test — the issue-reference query shipped
 *  one `}` short and every real read of it failed. */
export function graphqlSyntaxCheckedRunner(respond: (args: string[]) => string): GhRunner {
  return async (args) => {
    const query = args.find((a) => a.startsWith("query="))?.slice("query=".length);
    const at = args[0] === "api" && args[1] === "graphql" && query ? unbalancedAt(query) : null;
    if (at !== null) {
      const stderr = `gh: Expected NAME, actual: (none) ("") at [1, ${at}]`;
      throw Object.assign(new Error(`Command failed: gh ${args.join(" ")}\n${stderr}`), {
        stderr,
      });
    }
    return respond(args);
  };
}

/** 1-based column where the brace structure breaks, or null when it balances. */
function unbalancedAt(query: string): number | null {
  let depth = 0;
  for (let i = 0; i < query.length; i++) {
    if (query[i] === "{") depth++;
    else if (query[i] === "}" && --depth < 0) return i + 1;
  }
  return depth === 0 ? null : query.length + 1;
}

/** A complete (last) page of an issue's cross-reference timeline naming `prs`. */
export function referenceTimelinePage(prs: IssuePullRequestReference[]): string {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: prs.map((pr) => ({
              __typename: "CrossReferencedEvent",
              source: {
                __typename: "PullRequest",
                number: pr.number,
                url: pr.url,
                state: pr.state.toUpperCase(),
              },
            })),
          },
        },
      },
    },
  });
}
