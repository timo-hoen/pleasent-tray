import { ChevronDown, ChevronRight, RefreshCw, Search, Settings, X } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { highlightParts, splitTerms, treeKeyAction, typeAheadMatch, visibleRows } from "@/lib/tree";
import { cn } from "@/lib/utils";
import type { FolderNode, ServerInfo, Theme } from "@/types";

const KEY_STEP = 20;
const TYPE_AHEAD_RESET_MS = 800;
const NAVIGATION_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Enter"];
const rowDomId = (id: string) => `folder-${id}`;

interface SidebarProps {
  width: number;
  onResize: (width: number, persist: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  onQueryEnter: () => void;
  tree: FolderNode | null;
  selectedId: string | null;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (node: FolderNode) => void;
  /** Keyboard selection: shows the folder without opening it. */
  onNavigate: (node: FolderNode) => void;
  status: { text: string; bad: boolean };
  reloading: boolean;
  onReload: () => void;
  server: ServerInfo | null;
  theme: Theme;
  onToggleTheme: () => void;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  onLock: () => void;
  onLogout: () => void;
}

function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  return highlightParts(text, terms).map((part, index) =>
    part.match ? (
      <mark key={index} className="rounded-sm bg-primary/20 text-foreground">
        {part.text}
      </mark>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
}

function Splitter({ width, onResize }: Pick<SidebarProps, "width" | "onResize">) {
  const dragging = useRef(false);
  const start = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = true;
    event.preventDefault();
  };
  const finish = (event: PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    onResize(event.clientX, true);
  };
  const keyboard = (event: KeyboardEvent) => {
    const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!direction) return;
    onResize(width + direction * KEY_STEP, true);
    event.preventDefault();
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Breite der Ordnerleiste"
      tabIndex={0}
      className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize outline-none hover:bg-border focus-visible:bg-ring"
      onPointerDown={start}
      onPointerMove={(event) => dragging.current && onResize(event.clientX, false)}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={keyboard}
    />
  );
}

export function Sidebar(props: SidebarProps) {
  const { tree, query, selectedId, expanded, status, server } = props;
  const terms = splitTerms(query);
  const rows = tree ? visibleRows(tree, terms, expanded) : [];
  const treeRef = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const hasSelectedRow = rows.some((row) => row.node.id === selectedId);

  useEffect(() => {
    if (selectedId) document.getElementById(rowDomId(selectedId))?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const typeAhead = (key: string) => {
    const now = Date.now();
    const previous = now - typed.current.at < TYPE_AHEAD_RESET_MS ? typed.current.text : "";
    // A space only belongs to a name that is already being typed.
    if (key === " " && !previous) return;
    const text = previous + key;
    typed.current = { text, at: now };
    const match = typeAheadMatch(rows, text, selectedId);
    if (match) props.onNavigate(match);
  };

  const onTreeKey = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key.length === 1) {
      event.preventDefault();
      typeAhead(event.key);
      return;
    }
    if (!NAVIGATION_KEYS.includes(event.key)) return;
    event.preventDefault();
    const action = treeKeyAction(rows, selectedId, event.key);
    if (!action) return;
    if ("select" in action) props.onNavigate(action.select);
    else props.onToggle(action.toggle);
  };

  return (
    <aside
      className="relative flex h-screen shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground"
      style={{ width: props.width }}
    >
      <div className="relative border-b p-2">
        <Search className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id="query"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="Alle Ordner durchsuchen …"
          aria-label="Suche"
          className="px-8"
          value={query}
          onChange={(event) => props.onQueryChange(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && props.onQueryEnter()}
        />
        {query && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="absolute top-1/2 right-3 -translate-y-1/2"
            aria-label="Suche löschen"
            title="Suche löschen"
            onClick={() => {
              props.onQueryChange("");
              document.getElementById("query")?.focus();
            }}
          >
            <X />
          </Button>
        )}
      </div>

      <ul
        ref={treeRef}
        role="tree"
        tabIndex={0}
        aria-label="Ordner"
        aria-activedescendant={hasSelectedRow && selectedId ? rowDomId(selectedId) : undefined}
        className="group/tree min-h-0 flex-1 overflow-auto p-2 outline-none"
        onKeyDown={onTreeKey}
        onClick={() => treeRef.current?.focus()}
      >
        {rows.map(({ node, depth, isOpen }) => (
          <li
            key={node.id}
            id={rowDomId(node.id)}
            role="treeitem"
            aria-selected={node.id === selectedId}
            aria-expanded={node.children.length ? isOpen : undefined}
            aria-level={depth + 1}
            className={cn(
              "flex items-center rounded-md text-sm hover:bg-sidebar-accent",
              node.id === selectedId &&
                "bg-sidebar-accent font-medium group-focus/tree:ring-2 group-focus/tree:ring-ring group-focus/tree:ring-inset",
            )}
            style={{ paddingLeft: depth * 16 }}
          >
            <Button
              variant="ghost"
              size="icon-xs"
              tabIndex={-1}
              aria-label={isOpen ? "Zuklappen" : "Aufklappen"}
              className={cn(!node.children.length && "invisible")}
              onClick={() => props.onToggle(node.id)}
            >
              {isOpen ? <ChevronDown /> : <ChevronRight />}
            </Button>
            <button
              type="button"
              tabIndex={-1}
              title={node.name}
              className="min-w-0 flex-1 cursor-pointer truncate rounded-md py-1.5 pr-2 pl-1 text-left outline-none"
              onClick={() => props.onSelect(node)}
            >
              <Highlighted text={node.name || "(ohne Namen)"} terms={terms} />
            </button>
          </li>
        ))}
      </ul>

      <footer className="flex items-center gap-1 border-t p-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Ordner neu einlesen"
          title="Ordner neu einlesen"
          disabled={props.reloading}
          onClick={props.onReload}
        >
          <RefreshCw className={cn(props.reloading && "animate-spin")} />
        </Button>
        <span
          role="status"
          title={status.text}
          className={cn(
            "min-w-0 flex-1 truncate text-xs text-muted-foreground",
            status.bad && "text-destructive",
          )}
        >
          {status.text}
        </span>
        <DropdownMenu modal={false} open={props.settingsOpen} onOpenChange={props.onSettingsOpenChange}>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label="Einstellungen" title="Einstellungen" />}
          >
            <Settings />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="w-64">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="truncate" title={server?.url}>
                Server: {server?.label}
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={props.onToggleTheme}>
              {props.theme === "light" ? "Dunkel" : "Hell"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={props.onLock}>Sperren</DropdownMenuItem>
            <DropdownMenuItem onClick={props.onLogout}>Abmelden</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </footer>
      <Splitter width={props.width} onResize={props.onResize} />
    </aside>
  );
}
