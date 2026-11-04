import { ArrowLeft } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { focusField } from "@/lib/tauri";
import type { EntryInput, EntryValues } from "@/types";

export interface EditorState {
  /** Null for a new entry. */
  id: string | null;
  title: string;
  path: string;
  values: EntryValues;
  passwordHint: string;
  hasTotp: boolean;
  canEditTotp: boolean;
}

interface EntryEditorProps {
  editor: EditorState;
  onCancel: () => void;
  onSave: (input: EntryInput) => Promise<void>;
}

/** The password stays empty, because it is only sent when the user types a new one. */
export function EntryEditor({ editor, onCancel, onSave }: EntryEditorProps) {
  const [values, setValues] = useState<EntryValues>({
    name: editor.values.name,
    username: editor.values.username,
    url: editor.values.url,
    notes: editor.values.notes,
  });
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [removeTotp, setRemoveTotp] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => focusField("e-name"), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const totpChange = removeTotp ? "" : totp.trim() || null;
      await onSave({ ...values, password: password || null, totp: totpChange });
    } catch (failure) {
      setError(String(failure));
      setSaving(false);
    }
  };
  const bind = (key: keyof EntryValues) => ({
    value: values[key],
    onChange: (event: { target: { value: string } }) =>
      setValues({ ...values, [key]: event.target.value }),
  });

  return (
    <main className="flex h-screen min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b p-4">
        <Button variant="ghost" size="icon" aria-label="Abbrechen" title="Abbrechen" onClick={onCancel}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">{editor.title}</h2>
          <p className="truncate text-sm text-muted-foreground">{editor.path}</p>
        </div>
      </header>
      <form className="grid max-w-2xl gap-4 overflow-auto p-4" autoComplete="off" onSubmit={submit}>
        <div className="grid gap-2">
          <Label htmlFor="e-name">Titel</Label>
          <Input id="e-name" spellCheck={false} required {...bind("name")} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="e-username">Benutzername</Label>
          <Input id="e-username" spellCheck={false} {...bind("username")} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="e-password">Passwort</Label>
          <Input
            id="e-password"
            type="password"
            autoComplete="new-password"
            placeholder={editor.passwordHint}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="e-totp">TOTP-Schlüssel oder otpauth-Link</Label>
          <Input
            id="e-totp"
            type="password"
            autoComplete="off"
            disabled={!editor.canEditTotp || removeTotp}
            placeholder={
              !editor.canEditTotp
                ? "Keine Berechtigung"
                : editor.hasTotp
                  ? "Leer lassen, um ihn nicht zu ändern"
                  : ""
            }
            value={totp}
            onChange={(event) => setTotp(event.target.value)}
          />
          {editor.hasTotp && editor.canEditTotp && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={removeTotp}
                onChange={(event) => setRemoveTotp(event.target.checked)}
              />
              TOTP entfernen
            </label>
          )}
        </div>
        <div className="grid gap-2">
          <Label htmlFor="e-url">URL</Label>
          <Input id="e-url" spellCheck={false} {...bind("url")} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="e-notes">Notizen</Label>
          <Textarea id="e-notes" rows={5} spellCheck={false} {...bind("notes")} />
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div>
          <Button type="submit" disabled={saving}>
            Speichern
          </Button>
        </div>
      </form>
    </main>
  );
}
