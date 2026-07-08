export function normalizeEpicCollapse(
  orderedKeys: readonly string[],
  collapsed: ReadonlySet<string>,
  touched: ReadonlySet<string>,
): { collapsed: Set<string>; touched: Set<string> } {
  const live = new Set(orderedKeys);
  const nextTouched = new Set([...touched].filter((key) => live.has(key)));
  const nextCollapsed = new Set([...collapsed].filter((key) => live.has(key)));

  orderedKeys.forEach((key, index) => {
    if (nextTouched.has(key)) return;
    if (index === 0) nextCollapsed.delete(key);
    else nextCollapsed.add(key);
  });

  return { collapsed: nextCollapsed, touched: nextTouched };
}
