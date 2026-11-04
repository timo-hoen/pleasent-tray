import { useEffect, useRef, useState } from "react";
import { EntryDetailView } from "@/components/EntryDetailView";
import { EntryEditor, type EditorState } from "@/components/EntryEditor";
import { FolderPane } from "@/components/FolderPane";
import { LoginView, type LoginValues } from "@/components/LoginView";
import { Sidebar } from "@/components/Sidebar";
import { readSidebarWidth, readTheme, saveSidebarWidth, saveTheme, clampSidebar } from "@/lib/preferences";
import { focusField, invoke, isAuthError, listen } from "@/lib/tauri";
import { findFolder, firstMatch, splitTerms } from "@/lib/tree";
import type { EntryDetail, EntryInput, EntrySummary, FolderNode, ServerInfo, Theme } from "@/types";

const ACTIVITY_REPORT_MS = 10 * 1000;
const EMPTY_LOGIN: LoginValues = { server: "", username: "", password: "", otp: "" };
const NEW_ENTRY_VALUES = { name: "", username: "", url: "", notes: "" };

interface SavedEntry {
  id: string;
  count: number;
  in_tree: boolean;
  cache_error?: string | null;
}

interface OpenEntry {
  detail: EntryDetail;
  name: string;
  path: string;
}

export default function App() {
  const [screen, setScreen] = useState<"loading" | "login" | "vault">("loading");
  const [login, setLogin] = useState<LoginValues>(EMPTY_LOGIN);
  const [otpProvider, setOtpProvider] = useState<string | null>(null);
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [tree, setTree] = useState<FolderNode | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState({ text: "", bad: false });
  const [reloading, setReloading] = useState(false);
  const [entry, setEntry] = useState<OpenEntry | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const entryCount = useRef(0);
  const lastActivity = useRef(0);

  const selected = tree && selectedId ? findFolder(tree, selectedId) : null;

  const report = (text: string, bad = false) => setStatus({ text, bad });

  const leaveEntry = () => {
    setEntry(null);
    setEditor(null);
    invoke("close_entry").catch((error) => report(String(error), true));
  };

  const focusQuery = () => {
    requestAnimationFrame(() => focusField("query", true));
  };

  /** The server refused the session, so the backend has to drop it as well. The "locked"
   *  event then updates the view. A running login form is left alone. */
  const resumeSession = async () => {
    if (latest.current.screen === "vault") await invoke("lock");
  };

  const handleFolderError = async (error: unknown) => {
    if (isAuthError(error)) await resumeSession();
    else report(String(error), true);
  };

  const showTree = async () => {
    const next = await invoke<FolderNode | null>("folder_tree");
    setTree(next);
    if (!next) return;
    setExpanded((previous) => new Set(previous).add(next.id));
    setSelectedId((previous) => (previous && findFolder(next, previous) ? previous : next.id));
  };

  const refresh = async () => {
    report(entryCount.current ? `${entryCount.current} Einträge · aktualisiere …` : "Lade Einträge …");
    setReloading(true);
    try {
      const result = await invoke<{ count: number; cache_error?: string | null }>("refresh_index");
      entryCount.current = result.count;
      if (result.cache_error) report(`Cache nicht gespeichert: ${result.cache_error}`, true);
      else report(`${result.count} Einträge`);
      await showTree();
    } catch (error) {
      await handleFolderError(error);
    } finally {
      setReloading(false);
    }
  };

  /** Only an empty cache reads from the server by itself, otherwise the reload button does. */
  const loadFolders = async () => {
    report("Lade Einträge …");
    try {
      const cached = await invoke<{ count: number; saved_at: number } | null>("load_cached");
      if (!cached) return await refresh();
      entryCount.current = cached.count;
      const age = new Date(cached.saved_at * 1000).toLocaleString("de-DE", {
        dateStyle: "short",
        timeStyle: "short",
      });
      report(`${cached.count} Einträge · Stand ${age}`);
      await showTree();
    } catch (error) {
      await handleFolderError(error);
    }
  };

  const loadServerInfo = async () => {
    const info = await invoke<ServerInfo>("server_info");
    setLogin((values) => ({
      ...values,
      server: values.server || info.url,
      username: values.username || info.username,
    }));
    setServer(info);
    return info;
  };

  const showLogin = (message = "") => {
    setScreen("login");
    setLoginError(message);
  };

  /** Nothing unlocks by itself: the password is asked for every time. */
  const showLockScreen = async () => {
    try {
      const info = await loadServerInfo();
      showLogin(info.warning || "");
    } catch (error) {
      showLogin(String(error));
    }
  };

  const wipeView = () => {
    entryCount.current = 0;
    setSettingsOpen(false);
    setQuery("");
    setFilter("");
    setTree(null);
    setSelectedId(null);
    setExpanded(new Set());
    report("");
    setOtpProvider(null);
    setLogin((values) => ({ ...values, password: "", otp: "" }));
  };

  const submitLogin = async () => {
    setLoginBusy(true);
    setLoginError("");
    try {
      const outcome = await invoke<{ status: string; provider?: string }>("login", {
        server: login.server,
        username: login.username,
        password: login.password,
        otp: otpProvider ? login.otp.trim() : null,
        provider: otpProvider,
      });
      if (outcome.status === "otp_required") {
        setOtpProvider(outcome.provider ?? null);
        setLogin((values) => ({ ...values, otp: "" }));
        requestAnimationFrame(() => focusField("otp"));
        return;
      }
      setOtpProvider(null);
      setLogin((values) => ({ ...values, password: "", otp: "" }));
      setScreen("vault");
      await loadServerInfo();
      focusQuery();
      await loadFolders();
    } catch (error) {
      setLoginError(String(error));
      if (otpProvider) focusField("otp", true);
    } finally {
      setLoginBusy(false);
    }
  };

  const closeEntry = () => {
    leaveEntry();
    focusQuery();
  };

  const selectFolder = (node: FolderNode) => {
    if (node.id !== selectedId) setFilter("");
    setSelectedId(node.id);
    setExpanded((previous) => new Set(previous).add(node.id));
    if (entry) closeEntry();
    else setEditor(null);
  };

  const toggleFolder = (id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  const openEntry = async (hit: Pick<EntrySummary, "id" | "name" | "path">) => {
    try {
      const detail = await invoke<EntryDetail>("open_entry", { id: hit.id });
      setEntry({ detail, name: detail.name || hit.name, path: hit.path });
    } catch (error) {
      if (isAuthError(error)) await resumeSession();
      else report(String(error), true);
    }
  };

  const saveEntry = async (input: EntryInput) => {
    if (!editor) return;
    const { id, path } = editor;
    try {
      const saved = id
        ? await invoke<SavedEntry>("update_entry", { id, input })
        : await invoke<SavedEntry>("create_entry", { groupId: selectedId, input });
      setEditor(null);
      if (saved.in_tree) {
        entryCount.current = saved.count;
        if (saved.cache_error) report(`Cache nicht gespeichert: ${saved.cache_error}`, true);
        await showTree();
      } else {
        await refresh();
      }
      await openEntry({ id: saved.id, name: input.name.trim(), path });
    } catch (error) {
      if (!isAuthError(error)) throw error;
      await resumeSession();
    }
  };

  const logout = async () => {
    try {
      await invoke("logout");
      leaveEntry();
      wipeView();
      showLogin();
    } catch (error) {
      report(String(error), true);
    }
  };

  const resizeSidebar = (width: number, persist: boolean) => {
    const clamped = clampSidebar(width, window.innerWidth);
    setSidebarWidth(clamped);
    if (persist) saveSidebarWidth(clamped);
  };

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    saveTheme(next);
  };

  /** Long-lived listeners read the newest render through this ref. */
  const latest = useRef({ screen, entry, editor, settingsOpen, otpProvider, closeEntry, leaveEntry, wipeView, showLockScreen });
  latest.current = { screen, entry, editor, settingsOpen, otpProvider, closeEntry, leaveEntry, wipeView, showLockScreen };

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    if (screen !== "login") return;
    focusField(otpProvider ? "otp" : login.username ? "password" : "username");
    // Only entering the screen moves the focus, not typing in the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const now = latest.current;
      if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (now.screen !== "vault" || now.editor) return;
        setSettingsOpen(false);
        focusField("query", true);
        return;
      }
      if (event.key !== "Escape" || now.settingsOpen) return;
      if (now.editor) setEditor(null);
      else if (now.entry) now.closeEntry();
    };
    // Capture runs before the menu closes itself, so Escape does not also close the entry.
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  useEffect(() => {
    const onActivity = () => {
      const time = Date.now();
      if (latest.current.screen !== "vault" || time - lastActivity.current < ACTIVITY_REPORT_MS) return;
      lastActivity.current = time;
      invoke("touch").catch((error) => report(String(error), true));
    };
    const types = ["pointerdown", "pointermove", "keydown", "wheel"];
    types.forEach((type) => document.addEventListener(type, onActivity, { passive: true, capture: true }));
    return () => types.forEach((type) => document.removeEventListener(type, onActivity, { capture: true }));
  }, []);

  useEffect(() => {
    const unlocked = listen("locked", () => {
      latest.current.leaveEntry();
      latest.current.wipeView();
      void latest.current.showLockScreen();
    });
    const shown = listen("popup-shown", () => {
      const now = latest.current;
      if (now.screen === "login") focusField(now.otpProvider ? "otp" : "password");
      else if (now.screen === "vault" && !now.entry && !now.editor) focusField("query", true);
    });
    void latest.current.showLockScreen();
    return () => {
      void unlocked.then((stop) => stop());
      void shown.then((stop) => stop());
    };
  }, []);

  if (screen === "loading") return null;

  if (screen === "login") {
    return (
      <LoginView
        values={login}
        onChange={setLogin}
        otpRequired={otpProvider !== null}
        error={loginError}
        busy={loginBusy}
        onSubmit={() => void submitLogin()}
      />
    );
  }

  const queryEnter = () => {
    const terms = splitTerms(query);
    const match = tree && terms.length ? firstMatch(tree, terms) : null;
    if (match) selectFolder(match);
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar
        width={sidebarWidth}
        onResize={resizeSidebar}
        query={query}
        onQueryChange={setQuery}
        onQueryEnter={queryEnter}
        tree={tree}
        selectedId={selected?.id ?? null}
        expanded={expanded}
        onToggle={toggleFolder}
        onSelect={selectFolder}
        status={status}
        reloading={reloading}
        onReload={() => void refresh()}
        server={server}
        theme={theme}
        onToggleTheme={toggleTheme}
        settingsOpen={settingsOpen}
        onSettingsOpenChange={setSettingsOpen}
        onLock={() => void invoke("lock")}
        onLogout={() => void logout()}
      />
      {editor ? (
        <EntryEditor editor={editor} onCancel={() => setEditor(null)} onSave={saveEntry} />
      ) : entry ? (
        <EntryDetailView
          entry={entry.detail}
          name={entry.name}
          path={entry.path}
          onBack={closeEntry}
          onAuthError={() => void resumeSession()}
          onEdit={() =>
            setEditor({
              id: entry.detail.id,
              title: "Eintrag bearbeiten",
              path: entry.path,
              values: entry.detail,
              passwordHint: "Leer lassen, um es nicht zu ändern",
              hasTotp: entry.detail.has_totp,
              canEditTotp: entry.detail.can_edit_totp,
            })
          }
        />
      ) : selected ? (
        <FolderPane
          folder={selected}
          filter={filter}
          onFilterChange={setFilter}
          onSelectFolder={selectFolder}
          onOpenEntry={(hit) => void openEntry(hit)}
          onNewEntry={() =>
            setEditor({
              id: null,
              title: "Neuer Eintrag",
              path: selected.path,
              values: NEW_ENTRY_VALUES,
              passwordHint: "",
              hasTotp: false,
              canEditTotp: true,
            })
          }
        />
      ) : (
        <main className="flex-1" />
      )}
    </div>
  );
}
