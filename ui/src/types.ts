export interface EntrySummary {
  id: string;
  name: string;
  username: string;
  url: string;
  path: string;
}

export interface FolderNode {
  id: string;
  name: string;
  path: string;
  children: FolderNode[];
  entries: EntrySummary[];
}

export interface EntryField {
  key: string;
  value: string;
  secret: boolean;
}

export interface EntryDetail {
  id: string;
  name: string;
  username: string;
  url: string;
  notes: string;
  fields: EntryField[];
  has_totp: boolean;
  can_edit_totp: boolean;
  comment_required: boolean;
}

export interface EntryValues {
  name: string;
  username: string;
  url: string;
  notes: string;
}

export interface EntryInput extends EntryValues {
  password: string | null;
  /** Null keeps the stored TOTP, an empty text removes it. */
  totp: string | null;
}

export interface ServerInfo {
  url: string;
  username: string;
  label: string;
  warning?: string | null;
}

export type Theme = "light" | "dark";
