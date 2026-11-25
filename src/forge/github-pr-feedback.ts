/**
 * GitHub PR review feedback (#4126): the one GraphQL query that reads a PR's review bodies,
 * inline review comments and conversation comments, and its null-safe normalizer. Pure apart from
 * the query text; the forge issues the call through its runner.
 */
import type { PrFeedback, PrFeedbackItem } from "./types";

/** Reviews, review threads (with their comments) and conversation comments of one PR. */
export const PR_FEEDBACK_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){" +
  "pullRequest(number:$number){author{login} " +
  "reviews(last:100){nodes{databaseId author{login __typename} state body submittedAt}} " +
  "reviewThreads(last:100){nodes{id isResolved path line comments(first:50){nodes{databaseId " +
  "author{login __typename} body createdAt pullRequestReview{databaseId}}}}} " +
  "comments(last:100){nodes{databaseId author{login __typename} body createdAt}}}}}";

/** Reply on a review thread, then resolve it (#4139). Fields of one mutation run in order. No
 *  `rateLimit` selection: it is a query-root field. */
export const REPLY_AND_RESOLVE_THREAD_MUTATION =
  "mutation($thread:ID!,$body:String!){" +
  "reply:addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body})" +
  "{comment{id}} " +
  "resolve:resolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}";

type GqlAuthor = { login?: string | null; __typename?: string | null } | null;

interface GqlReview {
  databaseId?: number | null;
  author?: GqlAuthor;
  state?: string | null;
  body?: string | null;
  submittedAt?: string | null;
}

interface GqlComment {
  databaseId?: number | null;
  author?: GqlAuthor;
  body?: string | null;
  createdAt?: string | null;
  pullRequestReview?: { databaseId?: number | null } | null;
}

interface GqlThread {
  id?: string | null;
  isResolved?: boolean | null;
  path?: string | null;
  line?: number | null;
  comments?: { nodes?: (GqlComment | null)[] | null } | null;
}

interface GqlPullRequest {
  author?: { login?: string | null } | null;
  reviews?: { nodes?: (GqlReview | null)[] | null } | null;
  reviewThreads?: { nodes?: (GqlThread | null)[] | null } | null;
  comments?: { nodes?: (GqlComment | null)[] | null } | null;
}

const REVIEW_STATES: Record<string, PrFeedbackItem["reviewState"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
};

type ItemBase = Pick<PrFeedbackItem, "author" | "isBot" | "body" | "createdAt">;

/** The shared fields of a node, or null when it lacks an id or a parseable date. */
function base(
  databaseId: number | null | undefined,
  author: GqlAuthor | undefined,
  body: string | null | undefined,
  at: string | null | undefined,
): ItemBase | null {
  if (typeof databaseId !== "number") return null;
  const createdAt = Date.parse(at ?? "");
  if (!Number.isFinite(createdAt)) return null;
  return {
    author: author?.login ?? "",
    isBot: author?.__typename === "Bot",
    body: body ?? "",
    createdAt,
  };
}

function nodes<T>(conn: { nodes?: (T | null)[] | null } | null | undefined): T[] {
  return (conn?.nodes ?? []).filter((n): n is T => !!n);
}

function reviewItem(r: GqlReview): PrFeedbackItem | null {
  const reviewState = REVIEW_STATES[r.state ?? ""];
  const b = reviewState ? base(r.databaseId, r.author, r.body, r.submittedAt) : null;
  return b ? { id: `review:${r.databaseId}`, kind: "review", ...b, reviewState } : null;
}

function threadItems(t: GqlThread): PrFeedbackItem[] {
  const out: PrFeedbackItem[] = [];
  for (const c of nodes(t.comments)) {
    const b = base(c.databaseId, c.author, c.body, c.createdAt);
    if (!b) continue;
    const parent = c.pullRequestReview?.databaseId;
    out.push({
      id: `rc:${c.databaseId}`,
      kind: "rc",
      ...b,
      path: t.path ?? undefined,
      line: t.line ?? null,
      parentReviewId: typeof parent === "number" ? `review:${parent}` : undefined,
      resolved: t.isResolved === true,
      threadId: t.id ?? undefined,
    });
  }
  return out;
}

function conversationItem(c: GqlComment): PrFeedbackItem | null {
  const b = base(c.databaseId, c.author, c.body, c.createdAt);
  return b ? { id: `ic:${c.databaseId}`, kind: "ic", ...b } : null;
}

/** Normalize a {@link PR_FEEDBACK_QUERY} response. A missing PR yields no items. Reviews keep
 *  only APPROVED / CHANGES_REQUESTED / COMMENTED; nodes without an id or a parseable date drop. */
export function parsePrFeedback(stdout: string): PrFeedback {
  const json = JSON.parse(stdout || "null") as {
    data?: { repository?: { pullRequest?: GqlPullRequest | null } | null } | null;
  } | null;
  const pr = json?.data?.repository?.pullRequest;
  const items = [
    ...nodes(pr?.reviews).map(reviewItem),
    ...nodes(pr?.reviewThreads).flatMap(threadItems),
    ...nodes(pr?.comments).map(conversationItem),
  ].filter((i): i is PrFeedbackItem => !!i);
  return { prAuthor: pr?.author?.login ?? "", items };
}
