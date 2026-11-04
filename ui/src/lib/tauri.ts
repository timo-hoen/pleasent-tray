interface TauriGlobal {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen(event: string, handler: () => void): Promise<() => void> };
}

const tauri = (window as unknown as { __TAURI__: TauriGlobal }).__TAURI__;

export const invoke = <T = void>(command: string, args?: Record<string, unknown>): Promise<T> =>
  tauri.core.invoke<T>(command, args);

export const listen = (event: string, handler: () => void): Promise<() => void> =>
  tauri.event.listen(event, handler);

/** The backend reports a rejected session with this exact error value. */
export const isAuthError = (error: unknown): boolean => error === "AUTH";

export const focusField = (id: string, select = false): void => {
  const field = document.getElementById(id) as HTMLInputElement | null;
  field?.focus();
  if (select) field?.select();
};
