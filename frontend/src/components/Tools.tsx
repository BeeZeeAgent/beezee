import { useEffect, useMemo, useState } from "react";
import { Check, CopyPlus, Loader2, Plus, RefreshCcw, Terminal, X } from "lucide-react";
import { api, type McpServer, type ToolsInventory } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";

function splitArgs(value: string): string[] {
  return value.trim() ? value.trim().split(/\s+/) : [];
}

function envFromText(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return env;
}

function serverSubtitle(server: McpServer): string {
  if (server.url) return server.url;
  return [server.command, ...(server.args || [])].filter(Boolean).join(" ");
}

export function Tools() {
  const [data, setData] = useState<ToolsInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<"http" | "stdio">("http");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("npx");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const { toast } = useToast();

  const load = () => {
    setLoading(true);
    api.getTools()
      .then(setData)
      .catch(err => toast({ title: "Tool scan failed", description: err.message, variant: "destructive" }))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const missingCount = useMemo(
    () => data?.mcpServers.filter(s => s.inCodex !== s.inClaude).length || 0,
    [data]
  );

  const save = async (payload: Parameters<typeof api.saveMcpServer>[0], key: string) => {
    setBusy(key);
    try {
      const result = await api.saveMcpServer(payload);
      setData(result.tools);
      toast({ title: "MCP server saved" });
    } catch (err) {
      toast({ title: "MCP save failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const syncServer = (server: McpServer, target: "codex" | "claude") => {
    save({
      target,
      name: server.name,
      type: server.type,
      url: server.url || undefined,
      command: server.command || undefined,
      args: server.args || [],
      env: server.env || {},
    }, `${server.name}:${target}`);
  };

  const addServer = () => {
    save({
      target: "both",
      name,
      type: mode,
      url: mode === "http" ? url : undefined,
      command: mode === "stdio" ? command : undefined,
      args: mode === "stdio" ? splitArgs(args) : [],
      env: envFromText(env),
    }, "add");
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-24 text-sm text-muted-foreground">
        Loading tools...
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1 h-full">
      <div className="p-4 space-y-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Tools</h2>
            <p className="text-xs text-muted-foreground">{missingCount} MCP servers need sync</p>
          </div>
          <Button variant="outline" size="icon" onClick={load} disabled={loading} aria-label="Refresh tools">
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCcw />}
          </Button>
        </div>

        <section>
          <p className="text-xs font-medium text-muted-foreground mb-2">CLI tools</p>
          <div className="grid grid-cols-2 gap-2">
            {data?.cliTools.map(tool => (
              <div key={tool.name} className="rounded-lg border bg-card p-3 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{tool.name}</span>
                  {tool.installed ? <Check className="h-4 w-4 text-emerald-600" /> : <X className="h-4 w-4 text-muted-foreground" />}
                </div>
                <p className="truncate text-[11px] text-muted-foreground mt-1">{tool.path || "not found"}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-lg border bg-card p-3 space-y-3">
          <div className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            <p className="text-sm font-medium">Add MCP to both</p>
          </div>
          <Input placeholder="Server name" value={name} onChange={e => setName(e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <Button variant={mode === "http" ? "default" : "outline"} size="sm" onClick={() => setMode("http")}>HTTP</Button>
            <Button variant={mode === "stdio" ? "default" : "outline"} size="sm" onClick={() => setMode("stdio")}>Stdio</Button>
          </div>
          {mode === "http" ? (
            <Input placeholder="https://example.com/mcp" value={url} onChange={e => setUrl(e.target.value)} />
          ) : (
            <>
              <Input placeholder="Command" value={command} onChange={e => setCommand(e.target.value)} />
              <Input placeholder="Args, space separated" value={args} onChange={e => setArgs(e.target.value)} />
            </>
          )}
          <textarea
            className="min-h-16 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder={"Optional env\nKEY=value"}
            value={env}
            onChange={e => setEnv(e.target.value)}
          />
          <Button className="w-full" onClick={addServer} disabled={busy === "add" || !name || (mode === "http" ? !url : !command)}>
            {busy === "add" ? <Loader2 className="animate-spin" /> : <CopyPlus />}
            Install for Codex and Claude
          </Button>
        </section>

        <section>
          <p className="text-xs font-medium text-muted-foreground mb-2">MCP servers</p>
          <div className="space-y-2">
            {data?.mcpServers.length ? data.mcpServers.map(server => (
              <div key={server.name} className="rounded-lg border bg-card p-3 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{server.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{serverSubtitle(server) || "configuration unavailable"}</p>
                  </div>
                  <Terminal className="h-4 w-4 text-muted-foreground mt-0.5" />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={server.inCodex ? "default" : "outline"}>Codex</Badge>
                  <Badge variant={server.inClaude ? "default" : "outline"}>Claude</Badge>
                  {server.claudeStatus && <Badge variant="secondary">{server.claudeStatus}</Badge>}
                </div>
                {server.inCodex !== server.inClaude && (
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={server.inCodex || !server.canSyncToCodex || busy === `${server.name}:codex`}
                      onClick={() => syncServer(server, "codex")}
                    >
                      {busy === `${server.name}:codex` ? <Loader2 className="animate-spin" /> : <CopyPlus />}
                      Codex
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={server.inClaude || !server.canSyncToClaude || busy === `${server.name}:claude`}
                      onClick={() => syncServer(server, "claude")}
                    >
                      {busy === `${server.name}:claude` ? <Loader2 className="animate-spin" /> : <CopyPlus />}
                      Claude
                    </Button>
                  </div>
                )}
              </div>
            )) : (
              <div className="rounded-lg border bg-card p-4 text-center text-sm text-muted-foreground">
                No MCP servers found.
              </div>
            )}
          </div>
        </section>

        <p className="text-[11px] text-muted-foreground text-center pb-2">
          Codex: {data?.configFiles.codex} · Claude: {data?.configFiles.claude}
        </p>
      </div>
    </ScrollArea>
  );
}
