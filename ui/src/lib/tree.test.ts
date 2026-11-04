import { describe, expect, it } from "vitest";
import type { FolderNode } from "@/types";
import { findFolder, firstMatch, folderContents, highlightParts, splitTerms, visibleRows } from "./tree";

const entry = (id: string, name: string, path: string) => ({
  id,
  name,
  username: `${name}-user`,
  url: "",
  path,
});

const tree: FolderNode = {
  id: "root",
  name: "Root",
  path: "Root",
  entries: [],
  children: [
    {
      id: "a",
      name: "Alpha",
      path: "Root/Alpha",
      entries: [entry("e1", "Mail", "Root/Alpha")],
      children: [{ id: "a1", name: "Sub", path: "Root/Alpha/Sub", entries: [], children: [] }],
    },
    { id: "b", name: "Beta", path: "Root/Beta", entries: [entry("e2", "Router", "Root/Beta")], children: [] },
  ],
};

const ids = (terms: string, expanded: string[] = ["root"]) =>
  visibleRows(tree, splitTerms(terms), new Set(expanded)).map((row) => row.node.id);

describe("visibleRows", () => {
  it("shows only expanded folders without a search", () => {
    expect(ids("")).toEqual(["root", "a", "b"]);
    expect(ids("", [])).toEqual(["root"]);
  });

  it("opens the way to an entry match and hides the rest", () => {
    expect(ids("router", [])).toEqual(["root", "b"]);
  });

  it("keeps subfolders of a matching folder visible through their path", () => {
    expect(ids("alpha", ["root", "a"])).toEqual(["root", "a", "a1"]);
  });
});

describe("firstMatch", () => {
  it("returns the first folder holding a match", () => {
    expect(firstMatch(tree, ["router"])?.id).toBe("b");
    expect(firstMatch(tree, ["nothing"])).toBeNull();
  });
});

describe("folderContents", () => {
  it("filters folders by name and entries by their fields", () => {
    expect(folderContents(tree, ["alpha"]).folders.map((f) => f.id)).toEqual(["a"]);
    const alpha = findFolder(tree, "a") as FolderNode;
    expect(folderContents(alpha, ["mail-user"]).entries.map((e) => e.id)).toEqual(["e1"]);
  });
});

describe("highlightParts", () => {
  it("marks matches case-insensitively and treats terms as plain text", () => {
    expect(highlightParts("Alpha", ["ph"])).toEqual([
      { text: "Al", match: false },
      { text: "ph", match: true },
      { text: "a", match: false },
    ]);
    expect(highlightParts("a.b", ["."])[1]).toEqual({ text: ".", match: true });
    expect(highlightParts("Alpha", [])).toEqual([{ text: "Alpha", match: false }]);
  });
});
