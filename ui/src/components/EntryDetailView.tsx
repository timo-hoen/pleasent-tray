import { ArrowLeft, Copy, ExternalLink, Eye, EyeOff, Pencil } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { focusField, invoke, isAuthError } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { EntryDetail } from "@/types";

const MASK = "••••••••";
const REVEAL_MS = 30 * 1000;
const COPY_FEEDBACK_MS = 2500;
const TOTP_TICK_MS = 1000;

interface DetailStatus {
  text: string;
  kind: "" | "good" | "bad";
}

type CommentAction = (comment: string) => void;

interface EntryDetailViewProps {
  entry: EntryDetail;
  name: string;
  path: string;
  onBack: () => void;
  onEdit: () => void;
  onAuthError: () => void;
}

interface FieldActions {
  copy: (label: string, action: () => Promise<unknown>, sensitive: boolean) => void;
  fail: (error: unknown) => void;
}

function IconAction(props: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={props.label} title={props.label} onClick={props.onClick}>
      {props.children}
    </Button>
  );
}

function FieldRow(props: { label: string; value: string; className?: string; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2 border-b py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <small className="block text-xs text-muted-foreground">{props.label}</small>
        <span className={cn("block text-sm break-words", props.className)}>{props.value}</span>
      </div>
      {props.children}
    </li>
  );
}

/** Shows a value on demand and masks it again after REVEAL_MS. */
function useReveal() {
  const [value, setValue] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setValue(null);
  }, []);
  const show = useCallback((next: string) => {
    clearTimeout(timer.current);
    setValue(next);
    timer.current = setTimeout(() => setValue(null), REVEAL_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { value, show, hide };
}

function RevealToggle(props: { label: string; isShown: boolean; onClick: () => void }) {
  return (
    <IconAction label={`${props.label} ${props.isShown ? "verbergen" : "anzeigen"}`} onClick={props.onClick}>
      {props.isShown ? <EyeOff /> : <Eye />}
    </IconAction>
  );
}

function TextField(props: {
  label: string;
  value: string;
  secret: boolean;
  className?: string;
  actions: FieldActions;
}) {
  const { label, value, secret, actions } = props;
  const reveal = useReveal();
  const isShown = reveal.value !== null;
  return (
    <FieldRow label={label} value={secret ? (reveal.value ?? MASK) : value} className={props.className}>
      {secret && (
        <RevealToggle
          label={label}
          isShown={isShown}
          onClick={() => (isShown ? reveal.hide() : reveal.show(value))}
        />
      )}
      <IconAction
        label={`${label} kopieren`}
        onClick={() => actions.copy(label, () => invoke("copy_text", { text: value, sensitive: secret }), secret)}
      >
        <Copy />
      </IconAction>
    </FieldRow>
  );
}

function PasswordField(props: {
  entry: EntryDetail;
  actions: FieldActions;
  askForComment: (action: CommentAction) => void;
}) {
  const { entry, actions, askForComment } = props;
  const reveal = useReveal();
  const isShown = reveal.value !== null;
  const withComment = (action: (comment: string | null) => void) => {
    if (entry.comment_required) askForComment(action);
    else action(null);
  };
  const show = (comment: string | null) =>
    invoke<string>("reveal_password", { id: entry.id, comment }).then(reveal.show).catch(actions.fail);
  const copy = (comment: string | null) =>
    actions.copy("Passwort", () => invoke("copy_password", { id: entry.id, comment }), true);
  return (
    <FieldRow label="Passwort" value={reveal.value ?? MASK}>
      <RevealToggle
        label="Passwort"
        isShown={isShown}
        onClick={() => (isShown ? reveal.hide() : withComment(show))}
      />
      <IconAction label="Passwort kopieren" onClick={() => withComment(copy)}>
        <Copy />
      </IconAction>
    </FieldRow>
  );
}

function TotpCard(props: { actions: FieldActions }) {
  const { actions } = props;
  const [totp, setTotp] = useState<{ code: string; remaining: number; period: number } | null>(null);
  const fail = useRef(actions.fail);
  fail.current = actions.fail;

  useEffect(() => {
    const tick = () =>
      invoke<{ code: string; remaining: number; period: number }>("totp_code")
        .then(setTotp)
        .catch((error) => {
          clearInterval(timer);
          fail.current(error);
        });
    const timer = setInterval(tick, TOTP_TICK_MS);
    void tick();
    return () => clearInterval(timer);
  }, []);

  const middle = totp ? Math.ceil(totp.code.length / 2) : 0;
  return (
    <Card size="sm" className="mx-4 mt-4 shrink-0">
      <CardContent>
        <button
          type="button"
          aria-label="TOTP-Code kopieren"
          title="TOTP-Code kopieren"
          className="block w-full cursor-pointer rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => actions.copy("TOTP-Code", () => invoke("copy_totp"), true)}
        >
          <span className="block font-mono text-3xl font-semibold tracking-widest">
            {totp ? `${totp.code.slice(0, middle)} ${totp.code.slice(middle)}` : " "}
          </span>
          <Progress className="mt-3" value={totp ? (totp.remaining / totp.period) * 100 : 0} />
        </button>
      </CardContent>
    </Card>
  );
}

export function EntryDetailView(props: EntryDetailViewProps) {
  const { entry, onAuthError } = props;
  const [status, setStatus] = useState<DetailStatus>({ text: "", kind: "" });
  const [commentAction, setCommentAction] = useState<CommentAction | null>(null);
  const [comment, setComment] = useState("");
  const statusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => focusField("back"), []);
  useEffect(() => () => clearTimeout(statusTimer.current), []);

  const showStatus = (text: string, kind: DetailStatus["kind"]) => {
    clearTimeout(statusTimer.current);
    setStatus({ text, kind });
    if (kind === "good") {
      statusTimer.current = setTimeout(() => setStatus({ text: "", kind: "" }), COPY_FEEDBACK_MS);
    }
  };
  const fail = (error: unknown) => {
    if (isAuthError(error)) onAuthError();
    else showStatus(String(error), "bad");
  };
  const actions: FieldActions = {
    fail,
    copy: (label, action, sensitive) => {
      action()
        .then(() =>
          showStatus(sensitive ? `${label} kopiert, wird nach 30 s gelöscht` : `${label} kopiert`, "good"),
        )
        .catch(fail);
    },
  };
  const submitComment = (event: FormEvent) => {
    event.preventDefault();
    const text = comment.trim();
    if (!text) return;
    setComment("");
    setCommentAction(null);
    commentAction?.(text);
  };

  return (
    <main className="flex h-screen min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b p-4">
        <Button id="back" variant="ghost" size="icon" aria-label="Zurück" title="Zurück" onClick={props.onBack}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">{props.name}</h2>
          <p className="truncate text-sm text-muted-foreground">{props.path}</p>
        </div>
        <Button variant="outline" onClick={props.onEdit}>
          <Pencil />
          Bearbeiten
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {entry.has_totp && <TotpCard actions={actions} />}
        <ul className="px-4 py-1">
          {entry.username && (
            <TextField label="Benutzername" value={entry.username} secret={false} actions={actions} />
          )}
          <PasswordField
            entry={entry}
            actions={actions}
            askForComment={(action) => setCommentAction(() => action)}
          />
          {entry.fields.map((field) => (
            <TextField key={field.key} label={field.key} value={field.value} secret={field.secret} actions={actions} />
          ))}
          {entry.url && (
            <FieldRow label="URL" value={entry.url}>
              <IconAction
                label="URL öffnen"
                onClick={() => {
                  invoke("open_url", { url: entry.url }).catch((error) => showStatus(String(error), "bad"));
                }}
              >
                <ExternalLink />
              </IconAction>
              <IconAction
                label="URL kopieren"
                onClick={() => actions.copy("URL", () => invoke("copy_text", { text: entry.url, sensitive: false }), false)}
              >
                <Copy />
              </IconAction>
            </FieldRow>
          )}
          {entry.notes && (
            <TextField label="Notizen" value={entry.notes} secret={false} className="whitespace-pre-wrap" actions={actions} />
          )}
        </ul>
      </div>
      {commentAction && (
        <form className="flex items-end gap-2 border-t p-4" onSubmit={submitComment}>
          <div className="grid flex-1 gap-2">
            <Label htmlFor="comment">Nutzungskommentar</Label>
            <Input id="comment" required autoFocus value={comment} onChange={(event) => setComment(event.target.value)} />
          </div>
          <Button type="submit">Weiter</Button>
        </form>
      )}
      <footer
        role="status"
        className={cn(
          "min-h-9 border-t px-4 py-2 text-xs text-muted-foreground",
          status.kind === "bad" && "text-destructive",
          status.kind === "good" && "text-foreground",
        )}
      >
        {status.text}
      </footer>
    </main>
  );
}
