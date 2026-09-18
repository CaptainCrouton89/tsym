export interface ContainerMember {
  key: string;
  container: string | null;
  line: number;
  col: number;
}

/** Direct members use the source-position order printed by outline. */
export function directMembers<T extends ContainerMember>(items: readonly T[], container: string): T[] {
  return items.filter((item) => item.container === container).sort(bySourcePosition);
}

export function membersByContainer<T extends ContainerMember>(items: readonly T[]): ReadonlyMap<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) if (item.container) groups.set(item.container, [...(groups.get(item.container) ?? []), item]);
  return new Map([...groups].map(([container, members]) => [container, members.sort(bySourcePosition)]));
}

function bySourcePosition(a: ContainerMember, b: ContainerMember): number { return a.line - b.line || a.col - b.col; }
