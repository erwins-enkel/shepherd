// Local ESLint rule `shepherd/no-detached-jsdoc` (issue #4130). Flags a `/** … */` block directly
// followed by another one. TypeScript and editors attach only the last block to the declaration,
// so the first documents nothing and misleads readers. It is usually refactor drift: a doc left
// behind when its function moved. "Directly" means only spaces/tabs and at most one newline
// between the two blocks; a blank line marks a module or section header and is exempt.
//
// Plain ESM (not TS) so eslint.config.js — run by node — imports it without a build step.

const isJsdoc = (comment) => comment.type === "Block" && comment.value.startsWith("*");

const ADJACENT_GAP = /^[ \t]*(?:\r?\n[ \t]*)?$/;

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow a JSDoc block directly followed by another JSDoc block" },
    schema: [],
    messages: {
      detached:
        "Detached JSDoc: only the last block attaches to the declaration. Move it to its owner, merge it, or delete it.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      Program() {
        const comments = sourceCode.getAllComments();
        for (let i = 0; i < comments.length - 1; i++) {
          const a = comments[i];
          const b = comments[i + 1];
          if (!isJsdoc(a) || !isJsdoc(b)) continue;
          if (!ADJACENT_GAP.test(sourceCode.text.slice(a.range[1], b.range[0]))) continue;
          context.report({ loc: a.loc, messageId: "detached" });
        }
      },
    };
  },
};

export default rule;
