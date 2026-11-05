import type { EntrySummary, FolderNode } from "@/types";

interface Mark {
  self: boolean;
  entry: boolean;
  childVisible: boolean;
}

export interface TreeRow {
  node: FolderNode;
  depth: number;
  isOpen: boolean;
}

export interface HighlightPart {
  text: string;
  match: boolean;
}

export const splitTerms = (text: string): string[] =>
  text.toLowerCase().split(/\s+/).filter(Boolean);

const includesAll = (text: string, terms: string[]): boolean => {
  const lower = text.toLowerCase();
  return terms.every((term) => lower.includes(term));
};

export function findFolder(node: FolderNode, id: string): FolderNode | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findFolder(child, id);
    if (found) return found;
  }
  return null;
}

/** Marks which folders stay visible for the search terms. The path contains the folder
 *  name, so every subfolder of a matching customer stays visible too. */
function markFolders(node: FolderNode, terms: string[], marks: Map<FolderNode, Mark>): boolean {
  const self = includesAll(`${node.name} ${node.path}`, terms);
  const entry = node.entries.some((e) =>
    includesAll(`${e.name} ${e.username} ${e.url} ${e.path}`, terms),
  );
  const childVisible = node.children
    .map((child) => markFolders(child, terms, marks))
    .some(Boolean);
  marks.set(node, { self, entry, childVisible });
  return self || entry || childVisible;
}

export function visibleRows(tree: FolderNode, terms: string[], expanded: Set<string>): TreeRow[] {
  const marks = new Map<FolderNode, Mark>();
  markFolders(tree, terms, marks);
  const walk = (node: FolderNode, depth: number): TreeRow[] => {
    const mark = marks.get(node);
    if (!mark || (!mark.self && !mark.entry && !mark.childVisible)) return [];
    const autoOpen = terms.length > 0 && !mark.self && mark.childVisible;
    const isOpen = autoOpen || expanded.has(node.id);
    const below = isOpen ? node.children.flatMap((child) => walk(child, depth + 1)) : [];
    return [{ node, depth, isOpen }, ...below];
  };
  // The root is only a container: its children form the top level of the tree.
  return tree.children.flatMap((child) => walk(child, 0));
}

export function firstMatch(tree: FolderNode, terms: string[]): FolderNode | null {
  const marks = new Map<FolderNode, Mark>();
  markFolders(tree, terms, marks);
  const walk = (node: FolderNode): FolderNode | null => {
    const mark = marks.get(node);
    if (mark?.self || mark?.entry) return node;
    for (const child of node.children) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(tree);
}

export function folderContents(
  node: FolderNode,
  terms: string[],
): { folders: FolderNode[]; entries: EntrySummary[] } {
  return {
    folders: node.children.filter((child) => includesAll(child.name, terms)),
    entries: node.entries.filter((e) => includesAll(`${e.name} ${e.username} ${e.url}`, terms)),
  };
}

export function highlightParts(text: string, terms: string[]): HighlightPart[] {
  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  if (!pattern) return [{ text, match: false }];
  return text
    .split(new RegExp(`(${pattern})`, "gi"))
    .filter(Boolean)
    .map((part) => ({ text: part, match: terms.includes(part.toLowerCase()) }));
}

export type SortKey = "name" | "username";

export interface SortOrder {
  key: SortKey;
  ascending: boolean;
}

const collator = new Intl.Collator("de", { numeric: true, sensitivity: "base" });

/** Folders stay above entries and are ordered by name; a username sort leaves them ascending. */
export function sortContents(
  contents: { folders: FolderNode[]; entries: EntrySummary[] },
  { key, ascending }: SortOrder,
): { folders: FolderNode[]; entries: EntrySummary[] } {
  const direction = ascending ? 1 : -1;
  const folderDirection = key === "name" ? direction : 1;
  return {
    folders: [...contents.folders].sort((a, b) => folderDirection * collator.compare(a.name, b.name)),
    entries: [...contents.entries].sort(
      (a, b) => direction * collator.compare(a[key], b[key]) || collator.compare(a.name, b.name),
    ),
  };
}

export type TreeAction = { select: FolderNode } | { toggle: string } | null;

/** Maps a navigation key to what it does on the visible rows. Unknown keys return null. */
export function treeKeyAction(rows: TreeRow[], currentId: string | null, key: string): TreeAction {
  if (!rows.length) return null;
  const index = rows.findIndex((row) => row.node.id === currentId);
  const current = rows[index];
  const pick = (row: TreeRow | undefined): TreeAction => (row ? { select: row.node } : null);
  switch (key) {
    case "ArrowDown":
      return pick(rows[index + 1]);
    case "ArrowUp":
      return pick(index < 0 ? rows[0] : rows[index - 1]);
    case "Home":
      return pick(rows[0]);
    case "End":
      return pick(rows[rows.length - 1]);
    case "Enter":
      return current?.node.children.length ? { toggle: current.node.id } : null;
    case "ArrowRight":
      if (!current?.node.children.length) return null;
      return current.isOpen ? pick(rows[index + 1]) : { toggle: current.node.id };
    case "ArrowLeft":
      if (!current) return null;
      if (current.isOpen && current.node.children.length) return { toggle: current.node.id };
      return pick(rows.slice(0, index).reverse().find((row) => row.depth < current.depth));
    default:
      return null;
  }
}

/** Finds the row whose name starts with the typed text. Repeating one letter cycles through
 *  the rows with that letter, unless a name really starts with the repeated letters. */
export function typeAheadMatch(rows: TreeRow[], typed: string, currentId: string | null): FolderNode | null {
  const text = typed.toLowerCase();
  const index = rows.findIndex((row) => row.node.id === currentId);
  const search = (prefix: string, start: number) => {
    const ordered = [...rows.slice(start), ...rows.slice(0, start)];
    return ordered.find((row) => row.node.name.toLowerCase().startsWith(prefix))?.node ?? null;
  };
  // A longer text refines the search, so the current row may stay the match.
  const exact = search(text, text.length > 1 ? Math.max(index, 0) : index + 1);
  if (exact) return exact;
  const isRepeated = [...text].every((char) => char === text[0]);
  return isRepeated ? search(text[0], index + 1) : null;
}
