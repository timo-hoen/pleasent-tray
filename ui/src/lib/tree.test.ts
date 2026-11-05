import { describe, expect, it } from "vitest";
import type { FolderNode } from "@/types";
import {
  findFolder,
  firstMatch,
  folderContents,
  highlightParts,
  sortContents,
  splitTerms,
  treeKeyAction,
  typeAheadMatch,
  visibleRows,
} from "./tree";

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
    expect(ids("", ["a"])).toEqual(["a", "a1", "b"]);
    expect(ids("", [])).toEqual(["a", "b"]);
  });

  it("hides the root and starts the top level at depth zero", () => {
    expect(visibleRows(tree, [], new Set())[0]).toMatchObject({ depth: 0, node: { id: "a" } });
  });

  it("opens the way to an entry match and hides the rest", () => {
    expect(ids("router", [])).toEqual(["b"]);
  });

  it("keeps subfolders of a matching folder visible through their path", () => {
    expect(ids("alpha", ["a"])).toEqual(["a", "a1"]);
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

describe("treeKeyAction", () => {
  const rows = visibleRows(tree, [], new Set(["a"]));
  const collapsed = visibleRows(tree, [], new Set());
  const selected = (id: string | null, key: string, from = rows) => {
    const action = treeKeyAction(from, id, key);
    return action && "select" in action ? action.select.id : action;
  };

  it("moves through the visible rows and stops at the ends", () => {
    expect(selected(null, "ArrowDown")).toBe("a");
    expect(selected("a", "ArrowDown")).toBe("a1");
    expect(selected("b", "ArrowDown")).toBeNull();
    expect(selected("a1", "ArrowUp")).toBe("a");
    expect(selected("a", "ArrowUp")).toBeNull();
    expect(selected("a1", "Home")).toBe("a");
    expect(selected("a", "End")).toBe("b");
  });

  it("opens with right, then enters the first child", () => {
    expect(treeKeyAction(collapsed, "a", "ArrowRight")).toEqual({ toggle: "a" });
    expect(selected("a", "ArrowRight")).toBe("a1");
    expect(treeKeyAction(rows, "b", "ArrowRight")).toBeNull();
  });

  it("closes with left, then goes to the parent but never to the hidden root", () => {
    expect(treeKeyAction(rows, "a", "ArrowLeft")).toEqual({ toggle: "a" });
    expect(selected("a1", "ArrowLeft")).toBe("a");
    expect(selected("b", "ArrowLeft")).toBeNull();
  });

  it("toggles with enter and ignores other keys", () => {
    expect(treeKeyAction(rows, "a", "Enter")).toEqual({ toggle: "a" });
    expect(treeKeyAction(rows, "b", "Enter")).toBeNull();
    expect(treeKeyAction(rows, "a", "x")).toBeNull();
  });
});

describe("typeAheadMatch", () => {
  const folder = (id: string, name: string): FolderNode => ({ id, name, path: name, entries: [], children: [] });
  const rows = ["Adler", "Bio", "Bimmer", "Bosch"].map((name, index) => ({
    node: folder(String(index), name),
    depth: 0,
    isOpen: false,
  }));
  const match = (typed: string, current: string | null) => typeAheadMatch(rows, typed, current)?.name;

  it("jumps to the first name starting with the typed letters", () => {
    expect(match("b", null)).toBe("Bio");
    expect(match("bim", null)).toBe("Bimmer");
    expect(match("BI", null)).toBe("Bio");
  });

  it("keeps the current row while further letters still fit", () => {
    expect(match("bi", "1")).toBe("Bio");
  });

  it("cycles through rows when one letter is repeated and wraps around", () => {
    expect(match("bb", "1")).toBe("Bimmer");
    expect(match("b", "3")).toBe("Bio");
  });

  it("returns nothing when no name fits", () => {
    expect(match("xy", null)).toBeUndefined();
  });
});

describe("sortContents", () => {
  const item = (id: string, name: string, username: string) => ({ id, name, username, url: "", path: "" });
  const entries = [item("1", "Zeta", "anna"), item("2", "Äpfel", "zoe"), item("3", "Konto 10", ""), item("4", "Konto 2", "anna")];
  const contents = { folders: tree.children, entries };
  const order = (key: "name" | "username", ascending: boolean) =>
    sortContents(contents, { key, ascending }).entries.map((e) => e.id);

  it("sorts names in German order with numbers by value", () => {
    expect(order("name", true)).toEqual(["2", "4", "3", "1"]);
    expect(order("name", false)).toEqual(["1", "3", "4", "2"]);
  });

  it("sorts by username and breaks ties by name", () => {
    expect(order("username", true)).toEqual(["3", "4", "1", "2"]);
  });

  it("does not change its input and orders folders by name", () => {
    expect(entries[0].id).toBe("1");
    const ids = (ascending: boolean, key: "name" | "username") =>
      sortContents(contents, { key, ascending }).folders.map((f) => f.id);
    expect(ids(false, "name")).toEqual(["b", "a"]);
    expect(ids(false, "username")).toEqual(["a", "b"]);
  });
});
