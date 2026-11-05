import { Download, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { invoke } from "@/lib/tauri";
import type { UpdateInfo } from "@/types";

/** Checks once at start. The backend logs failures, so a failed check simply shows nothing. */
export function UpdateNotice() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    invoke<UpdateInfo | null>("check_update").then(setUpdate, (reason) => setError(String(reason)));
  }, []);

  if (!update) return null;

  const download = () => {
    setError("");
    invoke("open_url", { url: update.setup_url }).catch((reason) => setError(String(reason)));
  };

  return (
    <aside
      role="status"
      className="fixed right-4 bottom-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">Version {update.version} ist verfügbar</p>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      <Button size="sm" onClick={download}>
        <Download />
        Setup herunterladen
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Hinweis schließen"
        title="Hinweis schließen"
        onClick={() => setUpdate(null)}
      >
        <X />
      </Button>
    </aside>
  );
}
