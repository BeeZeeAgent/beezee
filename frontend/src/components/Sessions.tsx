import { useEffect, useState, useCallback } from "react";
import { Plus, Inbox } from "lucide-react";
import { api, subscribeEvents, type Session } from "@/api";
import { SessionCard } from "@/components/SessionCard";
import { NewSessionDialog } from "@/components/NewSessionDialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "@/hooks/use-toast";

interface SessionsProps {
  launchDir: string;
}

export function Sessions({ launchDir }: SessionsProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Load sessions on mount
  useEffect(() => {
    api.getSessions().then(setSessions).catch(() => {});
  }, []);

  // Subscribe to SSE updates
  useEffect(() => {
    const unsub = subscribeEvents((data: unknown) => {
      const event = data as { type: string; session?: Session; id?: number };
      if (event.type === "session_update" && event.session) {
        setSessions(prev => {
          const idx = prev.findIndex(s => s.id === event.session!.id);
          if (idx === -1) return [event.session!, ...prev];
          const next = [...prev];
          next[idx] = event.session!;
          return next;
        });
        // Toast when URL appears
        if (event.session.url && !sessions.find(s => s.id === event.session!.id)?.url) {
          toast({ title: `${event.session.name} is ready`, description: "Tap to open the session." });
        }
      }
      if (event.type === "session_removed" && event.id != null) {
        setSessions(prev => prev.filter(s => s.id !== event.id));
      }
    });
    return unsub;
  }, []);

  const handleStart = useCallback(async (tool: string, cwd: string, name?: string) => {
    const session = await api.startSession(tool, cwd, name);
    setSessions(prev => {
      const withoutExisting = prev.filter(s => s.id !== session.id);
      return [session, ...withoutExisting];
    });
  }, []);

  const handleRemove = useCallback((id: number) => {
    setSessions(prev => prev.filter(s => s.id !== id));
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <span className="text-sm font-medium text-muted-foreground">
          {sessions.length === 0 ? "No sessions" : `${sessions.length} session${sessions.length !== 1 ? "s" : ""}`}
        </span>
        <Button size="sm" className="gap-1.5" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4" />
          New session
        </Button>
      </div>

      {/* List */}
      <ScrollArea className="flex-1">
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted-foreground">
            <Inbox className="h-10 w-10 opacity-30" />
            <div className="text-center">
              <p className="text-sm font-medium">No sessions yet</p>
              <p className="text-xs mt-0.5">Browse to a folder and tap Launch here, or tap New session</p>
            </div>
          </div>
        ) : (
          <div className="p-3 space-y-3">
            {sessions.map(s => (
              <SessionCard key={s.id} session={s} onRemove={handleRemove} />
            ))}
          </div>
        )}
      </ScrollArea>

      <NewSessionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        defaultDir={launchDir}
        onStart={handleStart}
      />
    </div>
  );
}
