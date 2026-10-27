import type { GeotabGroup } from "../types";

/** Selected group ids plus every descendant. */
export function expandGroups(selected: string[], groupsById: Map<string, GeotabGroup>): Set<string> {
  const out = new Set<string>();
  const stack = [...selected];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    const g = groupsById.get(id);
    for (const c of g?.children ?? []) stack.push(c.id);
  }
  return out;
}

export function groupNames(ids: Array<{ id: string }> | undefined, groupsById: Map<string, GeotabGroup>): string {
  return (ids ?? [])
    .map((g) => groupsById.get(g.id)?.name ?? "")
    .filter((n) => n && n !== "Company Group" && n !== "Entire Organization")
    .join(", ");
}
