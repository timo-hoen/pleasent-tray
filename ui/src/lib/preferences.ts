import type { Theme } from "@/types";

const THEME_KEY = "theme";
const SIDEBAR_KEY = "sidebar";
const SIDEBAR_DEFAULT = 280;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX_SHARE = 0.6;

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Without storage the choice simply lasts until the app closes.
  }
};

export const readTheme = (): Theme => (read(THEME_KEY) === "light" ? "light" : "dark");
export const saveTheme = (theme: Theme): void => write(THEME_KEY, theme);

export const clampSidebar = (width: number, windowWidth: number): number => {
  const limit = Math.max(SIDEBAR_MIN, windowWidth * SIDEBAR_MAX_SHARE);
  return Math.round(Math.min(limit, Math.max(SIDEBAR_MIN, width)));
};

export const readSidebarWidth = (): number => {
  const saved = Number(read(SIDEBAR_KEY));
  return saved > 0 ? clampSidebar(saved, window.innerWidth) : SIDEBAR_DEFAULT;
};

export const saveSidebarWidth = (width: number): void => write(SIDEBAR_KEY, String(width));
