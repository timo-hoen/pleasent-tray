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
  return walk(tree, 0);
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
