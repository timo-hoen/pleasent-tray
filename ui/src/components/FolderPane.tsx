import { ArrowDown, ArrowUp, Folder, Globe, KeyRound, Plus, X, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { folderContents, sortContents, splitTerms, type SortKey, type SortOrder } from "@/lib/tree";
import type { EntrySummary, FolderNode } from "@/types";

interface FolderPaneProps {
  folder: FolderNode;
  filter: string;
  onFilterChange: (filter: string) => void;
  onSelectFolder: (folder: FolderNode) => void;
  onOpenEntry: (entry: EntrySummary) => void;
  onNewEntry: () => void;
}

interface RowProps {
  title: string;
  detail: string;
  icon: LucideIcon;
  onOpen: () => void;
}

/** The row is the click target; the inner button gives keyboard users the same action. */
function ContentRow({ title, detail, icon: Icon, onOpen }: RowProps) {
  return (
    <TableRow className="cursor-pointer even:bg-muted/40 hover:bg-muted" onClick={onOpen}>
      <TableCell className="max-w-0 font-medium">
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{title}</span>
        </button>
      </TableCell>
      <TableCell className="max-w-0 truncate text-muted-foreground">{detail}</TableCell>
    </TableRow>
  );
}

interface SortHeadProps {
  label: string;
  column: SortKey;
  sort: SortOrder;
  onSort: (column: SortKey) => void;
}

function SortHead({ label, column, sort, onSort }: SortHeadProps) {
  const isActive = sort.key === column;
  const Arrow = sort.ascending ? ArrowUp : ArrowDown;
  const ariaSort = !isActive ? "none" : sort.ascending ? "ascending" : "descending";
  return (
    <TableHead aria-sort={ariaSort}>
      <button
        type="button"
        className="flex cursor-pointer items-center gap-1 rounded-sm outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onSort(column)}
      >
        {label}
        {isActive && <Arrow className="size-3.5" />}
      </button>
    </TableHead>
  );
}

export function FolderPane(props: FolderPaneProps) {
  const { folder, filter } = props;
  const terms = splitTerms(filter);
  const [sort, setSort] = useState<SortOrder>({ key: "name", ascending: true });
  const { folders, entries } = sortContents(folderContents(folder, terms), sort);
  const changeSort = (key: SortKey) =>
    setSort((previous) => ({ key, ascending: previous.key === key ? !previous.ascending : true }));
  const isEmpty = !folders.length && !entries.length;

  return (
    <main className="flex h-screen min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b p-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">{folder.name || "(ohne Namen)"}</h2>
          <p className="truncate text-sm text-muted-foreground">{folder.path}</p>
        </div>
        <div className="relative w-56 shrink-0">
          <Input
            id="f-filter"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="In diesem Ordner filtern …"
            aria-label="Ordnerinhalt filtern"
            className="pr-8"
            value={filter}
            onChange={(event) => props.onFilterChange(event.target.value)}
          />
          {filter && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="absolute top-1/2 right-1 -translate-y-1/2"
              aria-label="Filter löschen"
              title="Filter löschen"
              onClick={() => {
                props.onFilterChange("");
                document.getElementById("f-filter")?.focus();
              }}
            >
              <X />
            </Button>
          )}
        </div>
        <Button onClick={props.onNewEntry}>
          <Plus />
          Neuer Eintrag
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {isEmpty ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {terms.length ? "Nichts gefunden." : "Dieser Ordner ist leer."}
          </p>
        ) : (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <SortHead label="Titel" column="name" sort={sort} onSort={changeSort} />
                <SortHead label="Benutzername" column="username" sort={sort} onSort={changeSort} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {folders.map((child) => (
                <ContentRow
                  key={child.id}
                  icon={Folder}
                  title={child.name}
                  detail={`${child.children.length + child.entries.length} Elemente`}
                  onOpen={() => props.onSelectFolder(child)}
                />
              ))}
              {entries.map((entry) => (
                <ContentRow
                  key={entry.id}
                  icon={entry.url ? Globe : KeyRound}
                  title={entry.name || "(ohne Namen)"}
                  detail={entry.username}
                  onOpen={() => props.onOpenEntry(entry)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </main>
  );
}
