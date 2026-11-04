"use strict";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const THEME_KEY = "theme";

function readTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("theme").textContent = theme === "light" ? "Dunkel" : "Hell";
}

const SIDEBAR_KEY = "sidebar";
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX_SHARE = 0.6;
const SIDEBAR_KEY_STEP = 20;

function setSidebar(width, persist) {
  const limit = Math.max(SIDEBAR_MIN, window.innerWidth * SIDEBAR_MAX_SHARE);
  const clamped = Math.round(Math.min(limit, Math.max(SIDEBAR_MIN, width)));
  document.documentElement.style.setProperty("--sidebar", `${clamped}px`);
  if (!persist) return;
  try {
    localStorage.setItem(SIDEBAR_KEY, String(clamped));
  } catch {
    // Without storage the width simply lasts until the app closes.
  }
}

function restoreSidebar() {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_KEY));
    if (saved > 0) setSidebar(saved, false);
  } catch {
    // The default width applies.
  }
}

function wireSplitter() {
  const splitter = $("splitter");
  splitter.addEventListener("pointerdown", (event) => {
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add("dragging");
    event.preventDefault();
  });
  splitter.addEventListener("pointermove", (event) => {
    if (splitter.classList.contains("dragging")) setSidebar(event.clientX, false);
  });
  const finish = (event) => {
    if (!splitter.classList.contains("dragging")) return;
    splitter.classList.remove("dragging");
    setSidebar(event.clientX, true);
  };
  splitter.addEventListener("pointerup", finish);
  splitter.addEventListener("pointercancel", finish);
  splitter.addEventListener("keydown", (event) => {
    const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!direction) return;
    const current = $("search-view").getBoundingClientRect().width;
    setSidebar(current + direction * SIDEBAR_KEY_STEP, true);
    event.preventDefault();
  });
}

function setSettingsOpen(isOpen) {
  $("settings-menu").hidden = !isOpen;
  $("settings").setAttribute("aria-expanded", String(isOpen));
}

$("settings").addEventListener("click", (event) => {
  event.stopPropagation();
  setSettingsOpen($("settings-menu").hidden);
});
document.addEventListener("click", (event) => {
  if (!$("settings-menu").contains(event.target) || event.target.closest("button")) {
    setSettingsOpen(false);
  }
});

restoreSidebar();
wireSplitter();
applyTheme(readTheme());
$("theme").addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Without storage the choice simply lasts until the app closes.
  }
});

let otpProvider = null;
let entryCount = 0;
let currentEntry = null;
let editing = null;
let lastActivityReport = 0;
const ACTIVITY_REPORT_MS = 10 * 1000;
let totpTimer = null;
let statusTimer = null;
let commentAction = null;
let tree = null;
let selectedFolder = null;
const expandedFolders = new Set();
const COPY_FEEDBACK_MS = 2500;
const COPY_ICON = "M9 9h11v11H9zM5 15H4V4h11v1";
const EYE_ICON = "M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z";
const MASK = "••••••••";
const REVEAL_MS = 30 * 1000;
const OPEN_ICON = "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6";

function leaveEntry() {
  hideEditor();
  currentEntry = null;
  clearInterval(totpTimer);
  $("fields").replaceChildren();
  $("detail-view").hidden = true;
  $("folder-pane").hidden = false;
  invoke("close_entry");
}

function showLogin(message = "") {
  leaveEntry();
  $("folder-pane").hidden = true;
  $("search-view").hidden = true;
  $("login-view").hidden = false;
  showLoginError(message);
  $($("username").value ? "password" : "username").focus();
}

function showLoginError(message) {
  $("login-error").textContent = message;
  $("login-error").hidden = !message;
}

function askForOtp(provider) {
  otpProvider = provider;
  leaveEntry();
  $("folder-pane").hidden = true;
  $("login-view").hidden = false;
  $("search-view").hidden = true;
  $("password-field").hidden = true;
  $("otp-field").hidden = false;
  $("otp").value = "";
  $("otp").focus();
}

function resetLoginForm() {
  otpProvider = null;
  $("password").value = "";
  $("otp").value = "";
  $("otp-field").hidden = true;
  $("password-field").hidden = false;
}

async function enterSearch() {
  resetLoginForm();
  $("login-view").hidden = true;
  $("search-view").hidden = false;
  $("folder-pane").hidden = false;
  await loadServerInfo();
  $("query").focus();
  await loadFolders();
}

/** Only an empty cache reads from the server by itself, otherwise the reload button does. */
async function loadFolders() {
  setStatus("Lade Einträge …");
  try {
    const cached = await invoke("load_cached");
    if (!cached) return await refresh();
    entryCount = cached.count;
    const age = new Date(cached.saved_at * 1000).toLocaleString("de-DE", {
      dateStyle: "short",
      timeStyle: "short",
    });
    setStatus(`${entryCount} Einträge · Stand ${age}`);
    await showTree();
  } catch (error) {
    await handleFolderError(error);
  }
}

async function refresh() {
  setStatus(entryCount ? `${entryCount} Einträge · aktualisiere …` : "Lade Einträge …");
  $("reload").disabled = true;
  try {
    const result = await invoke("refresh_index");
    entryCount = result.count;
    if (result.cache_error) setStatus(`Cache nicht gespeichert: ${result.cache_error}`, true);
    else setStatus(`${entryCount} Einträge`);
    await showTree();
  } catch (error) {
    await handleFolderError(error);
  } finally {
    $("reload").disabled = false;
  }
}

async function showTree() {
  await loadTree();
  renderTree();
}

async function handleFolderError(error) {
  if (error === "AUTH") await resumeSession();
  else setStatus(String(error), true);
}

$("reload").addEventListener("click", refresh);

function setStatus(text, isBad = false) {
  $("status").textContent = text;
  $("status").classList.toggle("bad", isBad);
}

/** Builds text nodes only, so server data can never inject markup. */
function highlight(text, terms) {
  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  if (!pattern) return [text];
  return text.split(new RegExp(`(${pattern})`, "gi")).filter(Boolean).map((part) => {
    if (!terms.includes(part.toLowerCase())) return part;
    const mark = document.createElement("mark");
    mark.textContent = part;
    return mark;
  });
}

function queryTerms() {
  return $("query").value.toLowerCase().split(/\s+/).filter(Boolean);
}

async function loadTree() {
  tree = await invoke("folder_tree");
  if (!tree) return;
  const selectedId = selectedFolder?.id;
  selectedFolder = (selectedId && findFolder(tree, selectedId)) || tree;
  expandedFolders.add(tree.id);
  renderFolder();
}

function findFolder(node, id) {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findFolder(child, id);
    if (found) return found;
  }
  return null;
}

/** Marks which folders stay visible for the search terms. The path contains the folder
 *  name, so every subfolder of a matching customer stays visible too. */
function matchFolders(node, terms, marks) {
  const haystack = `${node.name} ${node.path}`.toLowerCase();
  const self = terms.every((t) => haystack.includes(t));
  const entry = node.entries.some((e) => {
    const text = `${e.name} ${e.username} ${e.url} ${e.path}`.toLowerCase();
    return terms.every((t) => text.includes(t));
  });
  let childVisible = false;
  node.children.forEach((child) => {
    if (matchFolders(child, terms, marks)) childVisible = true;
  });
  marks.set(node, { self, entry, childVisible });
  return self || entry || childVisible;
}

function renderTree() {
  $("query-clear").hidden = !$("query").value;
  if (!tree) return;
  const terms = queryTerms();
  const marks = new Map();
  matchFolders(tree, terms, marks);
  const rows = [];
  appendFolderRows(tree, 0, terms, marks, rows);
  $("tree").replaceChildren(...rows);
}

function appendFolderRows(node, depth, terms, marks, rows) {
  const mark = marks.get(node);
  if (!mark.self && !mark.entry && !mark.childVisible) return;
  const autoOpen = terms.length > 0 && !mark.self && mark.childVisible;
  const isOpen = autoOpen || expandedFolders.has(node.id);
  rows.push(folderRow(node, depth, terms, isOpen));
  if (isOpen) node.children.forEach((c) => appendFolderRows(c, depth + 1, terms, marks, rows));
}

function folderRow(node, depth, terms, isOpen) {
  const item = document.createElement("li");
  item.style.paddingLeft = `${6 + depth * 16}px`;
  item.classList.toggle("selected", node === selectedFolder);
  const chevron = document.createElement("button");
  chevron.type = "button";
  chevron.className = "chevron";
  chevron.tabIndex = -1;
  chevron.textContent = node.children.length ? (isOpen ? "▾" : "▸") : "";
  chevron.addEventListener("click", (event) => {
    event.stopPropagation();
    if (expandedFolders.has(node.id)) expandedFolders.delete(node.id);
    else expandedFolders.add(node.id);
    renderTree();
  });
  const label = document.createElement("span");
  label.className = "label";
  label.title = node.name;
  label.append(...highlight(node.name || "(ohne Namen)", terms));
  item.append(chevron, label);
  item.addEventListener("click", () => selectFolder(node));
  return item;
}

function selectFolder(node) {
  if (node !== selectedFolder) $("f-filter").value = "";
  selectedFolder = node;
  expandedFolders.add(node.id);
  if (editing && !currentEntry) cancelEdit();
  if (currentEntry) closeEntry();
  renderTree();
  renderFolder();
}

function folderContentRows(node, terms) {
  const matches = (...parts) => {
    const text = parts.join(" ").toLowerCase();
    return terms.every((t) => text.includes(t));
  };
  const folders = node.children.filter((c) => matches(c.name)).map((child) =>
    tableRow(child.name, `${child.children.length + child.entries.length} Elemente`, "folder",
      () => selectFolder(child)));
  const entries = node.entries.filter((e) => matches(e.name, e.username, e.url)).map((entry) =>
    tableRow(entry.name || "(ohne Namen)", entry.username, "", () => openEntry(entry)));
  return [...folders, ...entries];
}

function tableHead() {
  const head = document.createElement("div");
  head.className = "f-head";
  const title = document.createElement("span");
  title.textContent = "Titel";
  const user = document.createElement("span");
  user.textContent = "Benutzername";
  head.append(title, user);
  return head;
}

function renderFolder() {
  $("filter-clear").hidden = !$("f-filter").value;
  const node = selectedFolder;
  if (!node) return;
  $("f-name").textContent = node.name || "(ohne Namen)";
  $("f-path").textContent = node.path;
  const terms = $("f-filter").value.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = folderContentRows(node, terms);
  if (rows.length) {
    $("f-table").replaceChildren(tableHead(), ...rows);
    return;
  }
  const empty = document.createElement("p");
  empty.className = "f-empty";
  empty.textContent = terms.length ? "Nichts gefunden." : "Dieser Ordner ist leer.";
  $("f-table").replaceChildren(empty);
}

function tableRow(title, sub, titleClass, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "f-row";
  const name = document.createElement("span");
  name.className = titleClass;
  name.textContent = title;
  const detail = document.createElement("span");
  detail.className = "sub";
  detail.textContent = sub;
  button.append(name, detail);
  button.addEventListener("click", onClick);
  return button;
}

function firstMatch(node, terms) {
  const marks = new Map();
  matchFolders(node, terms, marks);
  const walk = (n) => {
    const m = marks.get(n);
    if (m.self || m.entry) return n;
    for (const child of n.children) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(node);
}

async function loadServerInfo() {
  const info = await invoke("server_info");
  if (!$("server").value) $("server").value = info.url;
  if (!$("username").value) $("username").value = info.username;
  $("server-label").textContent = `Server: ${info.label}`;
  $("server-label").title = info.url;
  return info;
}

/** Nothing unlocks by itself: the password is asked for every time. */
async function showLockScreen() {
  try {
    const info = await loadServerInfo();
    showLogin(info.warning || "");
  } catch (error) {
    showLogin(String(error));
  }
}

/** The server refused the session, so the backend has to drop it as well. The "locked"
 *  event then updates the view. A running login form is left alone. */
async function resumeSession() {
  if (!$("search-view").hidden) await invoke("lock");
}

function wipeView() {
  entryCount = 0;
  commentAction = null;
  setSettingsOpen(false);
  $("query").value = "";
  $("f-filter").value = "";
  $("comment").value = "";
  tree = null;
  selectedFolder = null;
  $("tree").replaceChildren();
  $("f-table").replaceChildren();
  ["f-name", "f-path", "d-name", "d-path", "totp-value", "d-status", "status"].forEach((id) => {
    $(id).textContent = "";
  });
  resetLoginForm();
}

function reportActivity() {
  const now = Date.now();
  if ($("search-view").hidden || now - lastActivityReport < ACTIVITY_REPORT_MS) return;
  lastActivityReport = now;
  invoke("touch");
}

["pointerdown", "pointermove", "keydown", "wheel"].forEach((type) =>
  document.addEventListener(type, reportActivity, { passive: true, capture: true }));

listen("locked", () => {
  leaveEntry();
  wipeView();
  showLockScreen();
});

$("lock").addEventListener("click", () => invoke("lock"));

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("login-button");
  button.disabled = true;
  showLoginError("");
  try {
    const outcome = await invoke("login", {
      server: $("server").value,
      username: $("username").value,
      password: $("password").value,
      otp: otpProvider ? $("otp").value.trim() : null,
      provider: otpProvider,
    });
    if (outcome.status === "otp_required") askForOtp(outcome.provider);
    else await enterSearch();
  } catch (error) {
    showLoginError(String(error));
    if (otpProvider) $("otp").select();
  } finally {
    button.disabled = false;
  }
});

$("query").addEventListener("input", renderTree);
$("f-filter").addEventListener("input", renderFolder);

function wireClear(buttonId, inputId, render) {
  $(buttonId).addEventListener("click", () => {
    $(inputId).value = "";
    render();
    $(inputId).focus();
  });
}
wireClear("query-clear", "query", renderTree);
wireClear("filter-clear", "f-filter", renderFolder);

$("logout").addEventListener("click", async () => {
  try {
    await invoke("logout");
    wipeView();
    showLogin();
  } catch (error) {
    setStatus(String(error), true);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if ($("search-view").hidden || editing) return;
    setSettingsOpen(false);
    $("query").focus();
    $("query").select();
    return;
  }
  if (event.key !== "Escape") return;
  if (!$("settings-menu").hidden) setSettingsOpen(false);
  else if (editing) cancelEdit();
  else if (currentEntry) closeEntry();
});

$("query").addEventListener("keydown", (event) => {
  const terms = queryTerms();
  const match = event.key === "Enter" && tree && terms.length ? firstMatch(tree, terms) : null;
  if (match) selectFolder(match);
});

async function openEntry(hit) {
  try {
    const detail = await invoke("open_entry", { id: hit.id });
    currentEntry = detail;
    $("folder-pane").hidden = true;
    $("detail-view").hidden = false;
    $("d-name").textContent = detail.name || hit.name;
    $("d-path").textContent = hit.path;
    $("comment-form").hidden = true;
    setDetailStatus("");
    renderFields(detail);
    startTotp(detail.has_totp);
    $("back").focus();
  } catch (error) {
    if (error === "AUTH") await resumeSession();
    else setStatus(String(error), true);
  }
}

async function closeEntry() {
  leaveEntry();
  $("search-view").hidden = false;
  $("query").focus();
  $("query").select();
}

function renderFields(detail) {
  const rows = [];
  if (detail.username) rows.push(textRow("Benutzername", detail.username, false));
  rows.push(passwordRow(detail));
  detail.fields.forEach((f) => rows.push(textRow(f.key, f.value, f.secret)));
  if (detail.url) rows.push(urlRow(detail.url));
  if (detail.notes) rows.push(textRow("Notizen", detail.notes, false, "notes"));
  $("fields").replaceChildren(...rows);
}

function iconButton(path, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon";
  button.setAttribute("aria-label", label);
  button.title = label;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  button.append(svg);
  button.addEventListener("click", onClick);
  return button;
}

function row(label, display, buttons, spanClass = "") {
  const item = document.createElement("li");
  const field = document.createElement("div");
  field.className = "field";
  const small = document.createElement("small");
  small.textContent = label;
  const span = document.createElement("span");
  span.textContent = display;
  span.className = spanClass;
  field.append(small, span);
  item.append(field, ...buttons);
  return item;
}

function textRow(label, value, secret, spanClass) {
  const copy = iconButton(COPY_ICON, `${label} kopieren`, () =>
    runCopy(label, () => invoke("copy_text", { text: value, sensitive: secret }), secret));
  const buttons = secret ? [revealButton(label, async () => value), copy] : [copy];
  return row(label, secret ? MASK : value, buttons, spanClass);
}

/** Shows a masked value on demand and masks it again after REVEAL_MS. */
function revealButton(label, fetchValue) {
  let timer = null;
  const button = iconButton(EYE_ICON, `${label} anzeigen`, async () => {
    const span = button.closest("li").querySelector(".field span");
    clearTimeout(timer);
    if (span.textContent !== MASK) {
      span.textContent = MASK;
      return;
    }
    try {
      const value = await fetchValue();
      if (value === null) return;
      span.textContent = value;
      timer = setTimeout(() => { span.textContent = MASK; }, REVEAL_MS);
    } catch (error) {
      if (error === "AUTH") await resumeSession();
      else setDetailStatus(String(error), "bad");
    }
  });
  return button;
}

function askForComment(action) {
  commentAction = action;
  $("comment-form").hidden = false;
  $("comment").focus();
}

function urlRow(url) {
  const copy = iconButton(COPY_ICON, "URL kopieren", () =>
    runCopy("URL", () => invoke("copy_text", { text: url, sensitive: false }), false));
  const open = iconButton(OPEN_ICON, "URL öffnen", () =>
    invoke("open_url", { url }).catch((e) => setDetailStatus(String(e), "bad")));
  return row("URL", url, [open, copy]);
}

function passwordRow(detail) {
  const copy = iconButton(COPY_ICON, "Passwort kopieren", () => {
    const copyWith = (comment) =>
      runCopy("Passwort", () => invoke("copy_password", { id: detail.id, comment }), true);
    if (detail.comment_required) askForComment(copyWith);
    else copyWith(null);
  });
  const show = (comment) => invoke("reveal_password", { id: detail.id, comment });
  const reveal = revealButton("Passwort", async () => {
    if (!detail.comment_required) return show(null);
    askForComment((comment) => {
      show(comment).then((value) => {
        const span = reveal.closest("li").querySelector(".field span");
        span.textContent = value;
        setTimeout(() => { span.textContent = MASK; }, REVEAL_MS);
      }).catch((error) => setDetailStatus(String(error), "bad"));
    });
    return null;
  });
  return row("Passwort", MASK, [reveal, copy]);
}

async function runCopy(label, action, sensitive) {
  try {
    await action();
    setDetailStatus(sensitive ? `${label} kopiert, wird nach 30 s gelöscht` : `${label} kopiert`, "good");
  } catch (error) {
    if (error === "AUTH") await resumeSession();
    else setDetailStatus(String(error), "bad");
  }
}

function setDetailStatus(text, kind = "") {
  clearTimeout(statusTimer);
  $("d-status").textContent = text;
  $("d-status").className = kind;
  if (kind === "good") statusTimer = setTimeout(() => setDetailStatus(""), COPY_FEEDBACK_MS);
}

function startTotp(hasTotp) {
  clearInterval(totpTimer);
  $("totp").hidden = !hasTotp;
  if (!hasTotp) return;
  tickTotp();
  totpTimer = setInterval(tickTotp, 1000);
}

async function tickTotp() {
  try {
    const { code, remaining, period } = await invoke("totp_code");
    const middle = Math.ceil(code.length / 2);
    $("totp-value").textContent = `${code.slice(0, middle)} ${code.slice(middle)}`;
    $("totp-bar").style.transform = `scaleX(${remaining / period})`;
  } catch (error) {
    clearInterval(totpTimer);
    setDetailStatus(String(error), "bad");
  }
}

$("totp-copy").addEventListener("click", () => runCopy("TOTP-Code", () => invoke("copy_totp"), true));
$("back").addEventListener("click", closeEntry);
$("comment-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const comment = $("comment").value.trim();
  if (!comment) return;
  $("comment").value = "";
  $("comment-form").hidden = true;
  commentAction?.(comment);
});

/** `id` is null for a new entry. The password field stays empty, because the password
 *  is only sent when the user types a new one. */
function showEditor({ id, title, path, values, passwordHint }) {
  editing = { id, path };
  $("folder-pane").hidden = true;
  $("detail-view").hidden = true;
  $("edit-view").hidden = false;
  $("e-title").textContent = title;
  $("e-path").textContent = path;
  $("e-name").value = values.name;
  $("e-username").value = values.username;
  $("e-url").value = values.url;
  $("e-notes").value = values.notes;
  $("e-password").value = "";
  $("e-password").placeholder = passwordHint;
  showEditError("");
  $("e-name").focus();
}

function hideEditor() {
  editing = null;
  ["e-name", "e-username", "e-password", "e-url", "e-notes"].forEach((id) => {
    $(id).value = "";
  });
  $("edit-view").hidden = true;
}

function showEditError(message) {
  $("e-error").textContent = message;
  $("e-error").hidden = !message;
}

function cancelEdit() {
  hideEditor();
  $(currentEntry ? "detail-view" : "folder-pane").hidden = false;
}

async function saveEntry() {
  const { id, path } = editing;
  const input = {
    name: $("e-name").value,
    username: $("e-username").value,
    url: $("e-url").value,
    notes: $("e-notes").value,
    password: $("e-password").value || null,
  };
  const savedId = id
    ? await invoke("update_entry", { id, input }).then(() => id)
    : await invoke("create_entry", { groupId: selectedFolder.id, input });
  hideEditor();
  await refresh();
  await openEntry({ id: savedId, name: input.name.trim(), path });
}

$("edit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("e-save").disabled = true;
  showEditError("");
  try {
    await saveEntry();
  } catch (error) {
    if (error === "AUTH") await resumeSession();
    else showEditError(String(error));
  } finally {
    $("e-save").disabled = false;
  }
});

$("edit-cancel").addEventListener("click", cancelEdit);

$("new-entry").addEventListener("click", () => showEditor({
  id: null,
  title: "Neuer Eintrag",
  path: selectedFolder.path,
  values: { name: "", username: "", url: "", notes: "" },
  passwordHint: "",
}));

$("edit-entry").addEventListener("click", () => showEditor({
  id: currentEntry.id,
  title: "Eintrag bearbeiten",
  path: $("d-path").textContent,
  values: currentEntry,
  passwordHint: "Leer lassen, um es nicht zu ändern",
}));

listen("popup-shown", () => {
  if (!$("login-view").hidden) {
    $($("otp-field").hidden ? "password" : "otp").focus();
    return;
  }
  if ($("search-view").hidden || currentEntry || editing) return;
  $("query").focus();
  $("query").select();
});

showLockScreen();
