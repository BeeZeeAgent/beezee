import { useState } from "react";
import { Cloud, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { api } from "@/api";

interface Props {
  code: string;
  relayUrl: string;
  onDone: () => void;
}

export function PairDialog({ code, relayUrl, onDone }: Props) {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  const connect = async () => {
    setStatus("loading");
    try {
      const result = await api.relayPair(code, relayUrl);
      setStatus("success");
      setMessage(result.instanceName);
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Pairing failed");
    }
  };

  const relayHost = (() => { try { return new URL(relayUrl).hostname; } catch { return relayUrl; } })();

  return (
    <Dialog open onOpenChange={open => { if (!open) onDone(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="h-5 w-5" />
            Connect to cloud relay
          </DialogTitle>
          <DialogDescription>
            This will link this Launchpad to <strong>{relayHost}</strong> so you can access it remotely.
          </DialogDescription>
        </DialogHeader>

        {status === "success" ? (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="text-green-600 font-semibold">Connected as "{message}"</div>
            <p className="text-sm text-muted-foreground text-center">
              Launchpad is now reachable through the relay. You can close this dialog.
            </p>
            <Button onClick={onDone}>Done</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4 py-2">
            <div className="rounded-lg bg-muted p-3 text-center">
              <div className="text-xs text-muted-foreground mb-1">Pairing code</div>
              <div className="font-mono text-2xl font-bold tracking-widest">{code}</div>
            </div>
            {status === "error" && (
              <p className="text-sm text-destructive">{message}</p>
            )}
            <div className="flex gap-2">
              <Button onClick={connect} disabled={status === "loading"} className="flex-1">
                {status === "loading" && <Loader2 className="h-4 w-4 animate-spin" />}
                Connect
              </Button>
              <Button variant="outline" onClick={onDone}>Cancel</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
