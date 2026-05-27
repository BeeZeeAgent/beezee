export interface BrowseItem {
  name: string;
  path: string;
  isDir: boolean;
}

export interface BrowseResult {
  path: string;
  parent: string;
  items: BrowseItem[];
}

export interface Agent {
  id: string;
  label: string;
  installed: boolean;
  nativeRemoteControl: boolean;
  installHint: string;
  installUrl: string;
}

export interface Session {
  id: number;
  tool: string;
  name: string;
  cwd: string;
  status: "starting" | "running" | "stopped" | "error";
  url: string | null;
  mode: "native" | "ttyd";
  pid: number;
  log: string[];
  startedAt: number;
  lastActivityAt: number;
  exitCode?: number;
  idleKilled?: boolean;
  paused?: boolean;
}

export interface AgentSession {
  agent: string;
  id: string;
  cwd: string;
  title: string;
  updatedAt: number;
  agents: string[];
  agentSessions: Record<string, string>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface CodexModelUsage {
  promptTokens: number;
  completionTokens: number;
  requests: number;
}

export interface UsageData {
  updatedAt: string;
  claude: {
    totalSessions: number;
    totalMessages: number;
    modelUsage: Record<string, ModelUsage>;
    dailyActivity: Array<{ date: string; messageCount: number; sessionCount: number; toolCallCount: number }>;
    dailyModelTokens: Array<{ date: string; tokensByModel: Record<string, number> }>;
  } | null;
  codex: {
    updatedAt: string;
    modelUsage: Record<string, CodexModelUsage>;
    dailyUsage: Array<{ date: string; totalTokens: number; requests: number }>;
  } | null;
}

export interface SessionSyncStatus {
  enabled: boolean;
  intervalMs: number;
  agents: string[];
  lastRunAt: string | null;
  lastError: string | null;
  mirrors: number;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  assetName: string;
  assetSize: number | null;
  assetUrl: string | null;
  canAutoUpdate: boolean;
  error?: string;
}

export interface UpdateApplyResult {
  ok: boolean;
  updated: boolean;
  latestVersion?: string;
  restartRequired?: boolean;
  message: string;
  error?: string;
}

export interface CliToolStatus {
  name: string;
  path: string | null;
  installed: boolean;
}

export interface McpServer {
  name: string;
  type: "http" | "stdio" | string;
  url: string | null;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  inCodex: boolean;
  inClaude: boolean;
  claudeStatus: string | null;
  canSyncToCodex: boolean;
  canSyncToClaude: boolean;
  config: Record<string, unknown>;
}

export interface ToolsInventory {
  updatedAt: string;
  configFiles: {
    codex: string;
    claude: string;
  };
  cliTools: CliToolStatus[];
  mcpServers: McpServer[];
}

const BASE = import.meta.env.DEV ? "http://localhost:4242" : "";

export const api = {
  getHome: (): Promise<{ home: string }> =>
    fetch(`${BASE}/api/home`).then(r => r.json()),

  checkUpdate: (): Promise<UpdateInfo> =>
    fetch(`${BASE}/api/update/check`).then(r => r.json()),

  applyUpdate: (): Promise<UpdateApplyResult> =>
    fetch(`${BASE}/api/update/apply`, { method: "POST" }).then(r => r.json()),

  browse: (path: string, hidden = false): Promise<BrowseResult> =>
    fetch(`${BASE}/api/browse?path=${encodeURIComponent(path)}&hidden=${hidden}`).then(r => r.json()),

  searchDirs: (q: string): Promise<{ results: { path: string; name: string }[] }> =>
    fetch(`${BASE}/api/search-dirs?q=${encodeURIComponent(q)}`).then(r => r.json()),

  getAgents: (): Promise<Agent[]> =>
    fetch(`${BASE}/api/agents`).then(r => r.json()),

  getSessions: (): Promise<Session[]> =>
    fetch(`${BASE}/api/sessions`).then(r => r.json()),

  getAgentSessions: (): Promise<{ sessions: AgentSession[] }> =>
    fetch(`${BASE}/api/agent-sessions`).then(r => r.json()),

  getSessionSync: (): Promise<SessionSyncStatus> =>
    fetch(`${BASE}/api/session-sync`).then(r => r.json()),

  setSessionSync: (enabled: boolean): Promise<SessionSyncStatus> =>
    fetch(`${BASE}/api/session-sync`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }).then(r => r.json()),

  startSession: (tool: string, cwd: string, name?: string, resumeId?: string): Promise<Session> =>
    fetch(`${BASE}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, cwd, name, resumeId }),
    }).then(r => r.json()),

  deleteSession: (id: number): Promise<{ ok: boolean }> =>
    fetch(`${BASE}/api/sessions/${id}`, { method: "DELETE" }).then(r => r.json()),

  pauseSession: (id: number): Promise<Session> =>
    fetch(`${BASE}/api/sessions/${id}/pause`, { method: "POST" }).then(r => r.json()),

  getLog: (id: number): Promise<{ log: string[] }> =>
    fetch(`${BASE}/api/sessions/${id}/log`).then(r => r.json()),

  relayStatus: (): Promise<{ configured: boolean; url: string; nodeId: string }> =>
    fetch(`${BASE}/api/relay/status`).then(r => r.json()),

  getUsage: (): Promise<UsageData> =>
    fetch(`${BASE}/api/usage`).then(r => r.json()),

  getTools: (): Promise<ToolsInventory> =>
    fetch(`${BASE}/api/tools`).then(r => r.json()),

  saveMcpServer: (payload: {
    target: "codex" | "claude" | "both";
    name: string;
    type?: string;
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  }): Promise<{ ok: boolean; tools: ToolsInventory }> =>
    fetch(`${BASE}/api/tools/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(async r => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Failed to save MCP server");
      return data;
    }),

  upload: (dest: string, files: File[], relativePaths: string[]): Promise<{ ok: boolean; count: number }> => {
    const form = new FormData();
    files.forEach((f, i) => {
      form.append('files', f);
      form.append('paths', relativePaths[i] || f.name);
    });
    return fetch(`${BASE}/api/upload?dest=${encodeURIComponent(dest)}`, { method: 'POST', body: form }).then(r => r.json());
  },

  relayPair: (code: string, relayUrl: string): Promise<{ ok: boolean; instanceName: string }> =>
    fetch(`${BASE}/api/relay/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, relayUrl }),
    }).then(async r => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Pairing failed');
      return data;
    }),
};

export function subscribeEvents(onEvent: (data: unknown) => void): () => void {
  const es = new EventSource(`${BASE}/api/events`);
  es.onmessage = (e) => onEvent(JSON.parse(e.data));
  es.onerror = () => {};
  return () => es.close();
}
