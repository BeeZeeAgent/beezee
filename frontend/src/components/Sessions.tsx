import { useEffect, useState, useCallback } from "react";
import { Plus, Inbox, RefreshCw } from "lucide-react";
import { api, subscribeEvents, type AgentSession, type Session, type SessionSyncStatus } from "@/api";
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
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([]);
  const [syncStatus, setSyncStatus] = useState<SessionSyncStatus | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Load sessions on mount
  const loadStoredSessions = useCallback(() => {
    Promise.all([api.getAgentSessions(), api.getSessionSync()])
      .then(([sessionResult, sync]) => {
        setAgentSessions(sessionResult.sessions);
        setSyncStatus(sync);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    api.getSessions().then(setSessions).catch(() => {});
    loadStoredSessions();
  }, [loadStoredSessions]);

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
      if (event.type === "agent_sessions_updated") {
        loadStoredSessions();
      }
    });
    return unsub;
  }, [loadStoredSessions]);

  const handleStart = useCallback(async (tool: string, cwd: string, name?: string) => {
    const session = await api.startSession(tool, cwd, name);
    setSessions(prev => {
      const withoutExisting = prev.filter(s => s.id !== session.id);
      return [session, ...withoutExisting];
    });
  }, []);

  const handleResume = useCallback(async (agent: string, stored: AgentSession) => {
    const resumeId = stored.agentSessions[agent];
    if (!resumeId) return;
    const session = await api.startSession(agent, stored.cwd, stored.title, resumeId);
    setSessions(prev => {
      const withoutExisting = prev.filter(s => s.id !== session.id);
      return [session, ...withoutExisting];
    });
  }, []);

  const handleRemove = useCallback((id: number) => {
    setSessions(prev => prev.filter(s => s.id !== id));
  }, []);

  const handleToggleSync = useCallback(async () => {
    const next = await api.setSessionSync(!(syncStatus?.enabled ?? true));
    setSyncStatus(next);
    loadStoredSessions();
  }, [loadStoredSessions, syncStatus?.enabled]);

  return (
    <div className="flex h-full min-w-0 flex-col">
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
      <ScrollArea className="min-w-0 flex-1">
        {sessions.length === 0 && agentSessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted-foreground">
            <Inbox className="h-10 w-10 opacity-30" />
            <div className="text-center">
              <p className="text-sm font-medium">No sessions yet</p>
              <p className="text-xs mt-0.5">Browse to a folder and tap Launch here, or tap New session</p>
            </div>
          </div>
        ) : (
          <div className="min-w-0 space-y-3 p-3">
            {sessions.map(s => (
              <SessionCard key={s.id} session={s} onRemove={handleRemove} />
            ))}
            <div className="rounded-lg border bg-card">
              <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">Stored sessions</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {agentSessions.length} unique across Codex and Claude
                    {syncStatus?.lastError ? ` · sync error: ${syncStatus.lastError}` : ""}
                  </p>
                </div>
                <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={handleToggleSync}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  {syncStatus?.enabled === false ? "Sync off" : "Sync on"}
                </Button>
              </div>
              {agentSessions.length === 0 ? (
                <p className="px-4 py-5 text-sm text-muted-foreground">No stored agent sessions found yet.</p>
              ) : (
                <div className="divide-y">
                  {agentSessions.slice(0, 20).map(session => (
                    <div key={`${session.cwd}:${session.title}`} className="min-w-0 px-4 py-3">
                      <div className="flex min-w-0 items-center justify-between gap-3">
                        <p className="min-w-0 truncate text-sm font-medium">{session.title}</p>
                        <div className="flex shrink-0 gap-1">
                          {session.agents.map(agent => (
                            <span key={agent} className="rounded border px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                              {agent}
                            </span>
                          ))}
                        </div>
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">{session.cwd}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {session.agents.map(agent => (
                          <Button
                            key={agent}
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => handleResume(agent, session)}
                          >
                            Resume {agent}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
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
