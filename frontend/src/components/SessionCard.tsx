import { useState } from "react";
import { ExternalLink, Pause, Trash2, ChevronDown, ChevronUp, Terminal, Loader2, Clock } from "lucide-react";
import { type Session, api } from "@/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface SessionCardProps {
  session: Session;
  onRemove: (id: number) => void;
}

const TOOL_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const STATUS_COLORS: Record<Session["status"], string> = {
  starting: "bg-yellow-500/15 text-yellow-600 border-yellow-500/30",
  running: "bg-green-500/15 text-green-600 border-green-500/30",
  stopped: "bg-zinc-500/15 text-zinc-500 border-zinc-500/30",
  error: "bg-red-500/15 text-red-600 border-red-500/30",
};

export function SessionCard({ session, onRemove }: SessionCardProps) {
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [loadingLog, setLoadingLog] = useState(false);

  const toggleLog = async () => {
    if (!showLog && log.length === 0) {
      setLoadingLog(true);
      try {
        const { log: lines } = await api.getLog(session.id);
        setLog(lines);
      } catch {}
      setLoadingLog(false);
    }
    setShowLog(v => !v);
  };

  const handleStop = async () => {
    await api.pauseSession(session.id);
    setLog(prev => prev.length ? [...prev, "[launchpad] Session paused\n"] : prev);
  };

  const handleDelete = async () => {
    await api.deleteSession(session.id);
    onRemove(session.id);
  };

  const elapsed = Math.floor((Date.now() - session.startedAt) / 1000);
  const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m`;

  const isTtyd = session.mode === "ttyd";

  return (
    <Card className="w-full max-w-full overflow-hidden">
      <CardContent className="p-0">
        {/* Header */}
        <div className="flex min-w-0 items-start gap-3 p-4">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1 min-w-0">
              <span className="min-w-0 max-w-full flex-1 basis-24 truncate text-sm font-medium">{session.name}</span>
              <span className={cn(
                "shrink-0 text-xs px-1.5 py-0.5 rounded-full border font-medium",
                STATUS_COLORS[session.status]
              )}>
                {session.status === "starting" && (
                  <Loader2 className="h-3 w-3 animate-spin inline mr-1" />
                )}
                {session.status}
              </span>
              {session.idleKilled && (
                <span className="shrink-0 text-xs px-1.5 py-0.5 rounded-full border font-medium bg-amber-500/15 text-amber-600 border-amber-500/30 flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  idle timeout
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <Badge variant="outline" className="max-w-full text-xs font-mono px-1.5 py-0 shrink-0">
                {TOOL_LABELS[session.tool] ?? session.tool}
              </Badge>
              {isTtyd && (
                <Badge variant="outline" className="text-xs px-1.5 py-0 text-muted-foreground gap-1 shrink-0">
                  <Terminal className="h-2.5 w-2.5" />
                  terminal
                </Badge>
              )}
              <span className="min-w-0 flex-1 basis-32 truncate text-xs text-muted-foreground">{session.cwd}</span>
              <span className="text-xs text-muted-foreground shrink-0">{elapsedStr}</span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {session.status !== "stopped" && session.status !== "error" && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={handleStop}
                title="Pause session"
              >
                <Pause className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive hover:text-destructive"
              onClick={handleDelete}
              title="Delete session"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Open button */}
        {session.url ? (
          <div className="px-4 pb-3">
            <a
              href={session.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full"
            >
              <Button className="w-full gap-2" size="sm">
                {isTtyd
                  ? <><Terminal className="h-3.5 w-3.5" /> Open terminal</>
                  : <><ExternalLink className="h-3.5 w-3.5" /> Open session</>
                }
              </Button>
            </a>
          </div>
        ) : session.status === "starting" ? (
          <div className="px-4 pb-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted rounded-md px-3 py-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              Waiting for session URL…
            </div>
          </div>
        ) : null}

        {/* Log toggle */}
        <div className="border-t">
          <button
            onClick={toggleLog}
            className="w-full flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <Terminal className="h-3 w-3" />
            <span>Output log</span>
            {loadingLog
              ? <Loader2 className="h-3 w-3 animate-spin ml-auto" />
              : showLog
              ? <ChevronUp className="h-3 w-3 ml-auto" />
              : <ChevronDown className="h-3 w-3 ml-auto" />
            }
          </button>
          {showLog && (
            <pre className="text-xs text-muted-foreground bg-zinc-950 p-3 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono">
              {log.join("") || "(no output yet)"}
            </pre>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
