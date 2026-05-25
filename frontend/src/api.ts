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
  exitCode?: number;
}

const BASE = import.meta.env.DEV ? "http://localhost:4242" : "";

export const api = {
  browse: (path: string, hidden = false): Promise<BrowseResult> =>
    fetch(`${BASE}/api/browse?path=${encodeURIComponent(path)}&hidden=${hidden}`).then(r => r.json()),

  getAgents: (): Promise<Agent[]> =>
    fetch(`${BASE}/api/agents`).then(r => r.json()),

  getSessions: (): Promise<Session[]> =>
    fetch(`${BASE}/api/sessions`).then(r => r.json()),

  startSession: (tool: string, cwd: string, name?: string): Promise<Session> =>
    fetch(`${BASE}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, cwd, name }),
    }).then(r => r.json()),

  stopSession: (id: number): Promise<{ ok: boolean }> =>
    fetch(`${BASE}/api/sessions/${id}`, { method: "DELETE" }).then(r => r.json()),

  getLog: (id: number): Promise<{ log: string[] }> =>
    fetch(`${BASE}/api/sessions/${id}/log`).then(r => r.json()),
};

export function subscribeEvents(onEvent: (data: unknown) => void): () => void {
  const es = new EventSource(`${BASE}/api/events`);
  es.onmessage = (e) => onEvent(JSON.parse(e.data));
  es.onerror = () => {};
  return () => es.close();
}
