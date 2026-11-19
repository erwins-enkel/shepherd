// Local ESLint rule `shepherd/no-silent-catch` (issue #4076). Flags rejections and exceptions
// swallowed without a trace — the server's house rule is "fail closed":
//   • a `catch` clause with no statements (empty or comments only);
//   • a `.catch(handler)` whose handler has an empty body, or only yields null/undefined/void 0.
// A deliberate swallow passes only with a `best-effort: <why>` comment (colon + reason). Where it
// goes: inside the catch block / the `.catch(...)` call, trailing on the call's last line, or on
// its own line directly above `.catch`. Existing sites are baselined in eslint-suppressions.json.
//
// Plain ESM (not TS) so eslint.config.js — run by node — imports it without a build step.

const MARKER = /\bbest-effort:\s*\S/;

const isMarker = (comment) => MARKER.test(comment.value);

/** True when `node` is `null`, `undefined` or `void <literal>`. */
function isNullishSentinel(node) {
  if (node.type === "Literal") return node.value === null && node.raw === "null";
  if (node.type === "Identifier") return node.name === "undefined";
  return (
    node.type === "UnaryExpression" && node.operator === "void" && node.argument.type === "Literal"
  );
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow silently swallowed rejections and exceptions" },
    schema: [],
    messages: {
      emptyCatch:
        "Empty catch swallows the error. Log it, rethrow it, or mark it `// best-effort: <why>`.",
      emptyHandler:
        "Empty .catch() handler swallows the rejection. Log it, propagate it, or mark it `// best-effort: <why>`.",
      sentinel:
        ".catch() maps the rejection to null/undefined silently. Log it, propagate it, or mark it `// best-effort: <why>`.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;

    /** Marker for a `.catch(...)` call whose member is `property`. */
    function hasCallMarker(call, property) {
      const markers = sourceCode.getAllComments().filter(isMarker);
      const line = property.loc.start.line;
      return markers.some(
        (c) =>
          // Inside the call, from `catch` through `)`.
          (c.range[0] >= property.range[0] && c.range[1] <= call.range[1]) ||
          // Trailing on the call's last line.
          (c.range[0] >= call.range[1] && c.loc.start.line === call.loc.end.line) ||
          // Own line, directly above `catch`.
          (c.loc.end.line === line - 1 && startsOwnLine(c)),
      );
    }

    /** True when no code token precedes `comment` on its line. */
    function startsOwnLine(comment) {
      const before = sourceCode.getTokenBefore(comment, { includeComments: false });
      return !before || before.loc.end.line < comment.loc.start.line;
    }

    return {
      CatchClause(node) {
        if (node.body.body.length > 0) return;
        if (sourceCode.getCommentsInside(node.body).some(isMarker)) return;
        context.report({ node, messageId: "emptyCatch" });
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        if (callee.property.type !== "Identifier" || callee.property.name !== "catch") return;
        const handler = node.arguments[0];
        if (!handler) return;
        if (handler.type !== "ArrowFunctionExpression" && handler.type !== "FunctionExpression") {
          return;
        }
        let messageId;
        if (handler.body.type === "BlockStatement") {
          if (handler.body.body.length === 0) messageId = "emptyHandler";
        } else if (isNullishSentinel(handler.body)) {
          messageId = "sentinel";
        }
        if (!messageId || hasCallMarker(node, callee.property)) return;
        context.report({ node: callee.property, messageId });
      },
    };
  },
};

export default rule;
