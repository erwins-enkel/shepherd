import type { InjectableRule } from "$lib/types";

/** Shared context bundle passed from LearningsDrawer to all leaf-card children.
 *  Must be built as $derived in the parent so editingScope/scopeDraft stay reactive
 *  (a plain object literal would be a one-time snapshot and break single-open). */
export type LearningsCtx = {
  // Prop callbacks mirrored from LearningsDrawer's own props
  onapprove: (id: string, rule: string) => void;
  ondismiss: (id: string) => void;
  ondistill: (repoPath: string) => void;
  onpromote: (id: string) => void;
  onoptimize: (id: string) => void;
  onoptimizeall: (repoPath: string) => void;
  onrestore: (id: string) => void;
  onseenretired: (repoPath: string) => void;
  onmerge: (suggestionId: string) => void;
  ondismissmerge: (suggestionId: string) => void;
  onpromoteglobal: (suggestionId: string) => void;
  onmergenow: (repoPath: string) => void;

  // Shared scope-editor state — kept in parent to preserve single-open semantics.
  // When editingScope === rule.id, that card's editor is open.
  editingScope: string | null;
  scopeDraft: string;
  onScopeOpen: (rule: InjectableRule) => void;
  onScopeInput: (v: string) => void;
  onScopeSave: (id: string) => void;
  onScopeCancel: () => void;
};
