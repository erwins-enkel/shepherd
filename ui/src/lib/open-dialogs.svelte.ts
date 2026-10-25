// How many `use:dialog` surfaces are mounted right now, kept by `a11yDialog.ts`. Lets a surface
// that opens on its own (the AskUserQuestion dialog) wait while the operator is in another dialog
// instead of pulling focus out from under their typing.
let count = $state(0);

export const openDialogs = {
  get count() {
    return count;
  },
  opened() {
    count++;
  },
  closed() {
    count = Math.max(0, count - 1);
  },
};
