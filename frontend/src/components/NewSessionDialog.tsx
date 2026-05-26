import { useState, useEffect, type ComponentType, type SVGProps } from "react";
import { Loader2, Rocket, Bot, Terminal, PackagePlus, CheckCircle2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { api, type Agent } from "@/api";
import { AnthropicIcon } from "@/components/icons/AnthropicIcon";
import { OpenAIIcon } from "@/components/icons/OpenAIIcon";

const AGENT_ICONS: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  claude: AnthropicIcon,
  codex: OpenAIIcon,
};

function agentModeLabel(agent: Agent): string {
  if (!agent.installed) return "not installed";
  if (agent.nativeRemoteControl) return "native remote";
  return "web terminal";
}

function agentModeIcon(agent: Agent) {
  if (!agent.installed) return PackagePlus;
  if (agent.nativeRemoteControl) return CheckCircle2;
  return Terminal;
}

interface NewSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultDir: string;
  onStart: (tool: string, cwd: string, name?: string) => Promise<void>;
}

export function NewSessionDialog({ open, onOpenChange, defaultDir, onStart }: NewSessionDialogProps) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [tool, setTool] = useState<string>("");
  const [cwd, setCwd] = useState(defaultDir);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  // Fetch agents whenever the dialog opens. Can't rely on onOpenChange(true)
  // because the parent controls `open` directly via state — onOpenChange only
  // fires for close events (Escape, outside click).
  useEffect(() => {
    if (!open) return;
    setCwd(defaultDir);
    setLoadingAgents(true);
    api.getAgents().then(list => {
      setAgents(list);
      const first = list.find(a => a.installed);
      if (first) setTool(first.id);
      setLoadingAgents(false);
    }).catch(() => setLoadingAgents(false));
  }, [open]);

  const handleOpenChange = (v: boolean) => {
    onOpenChange(v);
  };

  const handleStart = async () => {
    if (!tool) return;
    setLoading(true);
    try {
      await onStart(tool, cwd, name.trim() || undefined);
      onOpenChange(false);
      setName("");
    } finally {
      setLoading(false);
    }
  };

  const selectedAgent = agents.find(a => a.id === tool);
  const canStart = !!tool && !!cwd.trim() && !!selectedAgent?.installed && !loading;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm w-[calc(100vw-2rem)]">
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Agent picker */}
          <div>
            <Label className="mb-2 block">Agent</Label>
            {loadingAgents ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Detecting agents…
              </div>
            ) : agents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No agents found.</p>
            ) : (
              <div className="grid grid-cols-2 gap-2 min-w-0">
                {agents.map(agent => {
                  const Icon = AGENT_ICONS[agent.id] ?? Bot;
                  const ModeIcon = agentModeIcon(agent);
                  const modeLabel = agentModeLabel(agent);
                  const isSelected = tool === agent.id && agent.installed;

                  return (
                    <button
                      key={agent.id}
                      onClick={() => agent.installed && setTool(agent.id)}
                      disabled={!agent.installed}
                      className={cn(
                        "flex min-w-0 flex-col items-start gap-1.5 overflow-hidden rounded-lg border p-3 text-left transition-colors",
                        agent.installed
                          ? isSelected
                            ? "border-primary bg-primary/5"
                            : "border-border hover:bg-accent"
                          : "border-border/50 opacity-50 cursor-not-allowed"
                      )}
                    >
                      <Icon className={cn("h-4 w-4", isSelected ? "text-primary" : "text-muted-foreground")} />
                      <span className="w-full truncate text-sm font-medium">{agent.label}</span>
                      <span className={cn(
                        "flex w-full min-w-0 items-center gap-1 text-xs font-mono",
                        isSelected ? "text-primary/70" : "text-muted-foreground"
                      )}>
                        <ModeIcon className="h-3 w-3 shrink-0" />
                        <span className="min-w-0 truncate">{modeLabel}</span>
                      </span>

                      {/* Install hint for missing agents */}
                      {!agent.installed && (
                        <span className="text-[10px] text-muted-foreground font-mono break-all mt-0.5">
                          {agent.installHint}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Working directory */}
          <div>
            <Label htmlFor="cwd" className="mb-1.5 block">Working directory</Label>
            <Input
              id="cwd"
              value={cwd}
              onChange={e => setCwd(e.target.value)}
              placeholder="/home/pi/myproject"
              className="font-mono text-xs"
            />
          </div>

          {/* Session name */}
          <div>
            <Label htmlFor="name" className="mb-1.5 block">
              Session name <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input
              id="name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="My Project"
              onKeyDown={e => e.key === "Enter" && canStart && handleStart()}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleStart} disabled={!canStart} className="gap-2">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
            {loading ? "Starting…" : "Start"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
