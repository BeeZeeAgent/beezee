import express from 'express';
import { spawn, spawnSync, execSync } from 'child_process';
import { createServer } from 'net';
import fs from 'fs';
import path from 'path';
import { networkInterfaces } from 'os';
import { getSyncStatus, listAgentSessions, saveSyncConfig, startSessionSyncLoop } from './agentSessionSync.js';

const app = express();
const PORT = 4242;
const HOME = process.env.HOME || '/home/pi';

const RELAY_CONFIG_PATH = path.join(HOME, '.launchpad-relay.json');

function loadRelayConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(RELAY_CONFIG_PATH, 'utf8')); } catch {}
  return {
    url: process.env.BEEZEE_RELAY_URL || process.env.LAUNCHPAD_RELAY_URL || saved.url || '',
    nodeId: process.env.BEEZEE_RELAY_NODE_ID || process.env.LAUNCHPAD_RELAY_NODE_ID || saved.nodeId || 'beezee-local',
    token: process.env.BEEZEE_RELAY_TOKEN || process.env.LAUNCHPAD_RELAY_TOKEN || saved.token || '',
  };
}

let relayConfig = loadRelayConfig();

const sessions = new Map();
let nextId = 1;
const sseClients = new Set();

// ── Utilities ─────────────────────────────────────────────────────────────

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) c.write(msg);
}

function sanitize({ proc, tmuxSession, ...s }) { return s; }

function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;]*[mGKHFJA-Za-z]/g, '')
    .replace(/\x1B[()][AB012]/g, '')
    .replace(/\x1B[>=]/g, '');
}

function getLocalIPs() {
  const nets = networkInterfaces();
  const results = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) results.push(net.address);
    }
  }
  return results;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

function which(bin) {
  try { return execSync(`which ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function stopSessionProcess(s, signal = 'SIGTERM') {
  if (s.tmuxSession) {
    try { execSync(`tmux kill-session -t ${s.tmuxSession}`, { stdio: 'ignore' }); } catch {}
  }
  try {
    if (s.proc) s.proc.kill(signal);
    else if (s.pid) process.kill(s.pid, signal);
  } catch {}
}

function tmuxCapture(sessionName) {
  const result = spawnSync('tmux', ['capture-pane', '-p', '-t', sessionName, '-S', '-300'], { encoding: 'utf8' });
  return result.status === 0 ? stripAnsi(result.stdout || '') : '';
}

function startClaudeResumeRemoteSession({ id, session, resumeId, remoteName, cwd, agent }) {
  const start = spawnSync('tmux', [
    'new-session',
    '-d',
    '-s',
    session.tmuxSession,
    '-c',
    cwd,
    `claude --resume '${String(resumeId).replace(/'/g, `'\\''`)}'`,
  ], { encoding: 'utf8' });

  if (start.status !== 0) {
    session.status = 'error';
    session.log.push(start.stderr || start.stdout || 'Failed to start tmux session');
    return;
  }

  setTimeout(() => {
    spawnSync('tmux', ['send-keys', '-t', session.tmuxSession, `/remote-control ${remoteName}`, 'Enter']);
  }, 4000);

  let attempts = 0;
  const timer = setInterval(() => {
    const s = sessions.get(id);
    if (!s) {
      clearInterval(timer);
      return;
    }

    const pane = tmuxCapture(s.tmuxSession);
    if (pane) {
      s.log = [pane];
      s.lastActivityAt = Date.now();
    }

    const match = pane.match(agent.urlPattern);
    if (match) {
      s.url = match[0].replace(/[.,;:)\]]+$/, '');
      s.status = 'running';
      broadcast({ type: 'session_update', session: sanitize(s) });
      clearInterval(timer);
      return;
    }

    attempts += 1;
    const tmuxAlive = spawnSync('tmux', ['has-session', '-t', s.tmuxSession], { stdio: 'ignore' }).status === 0;
    if (!tmuxAlive || attempts > 30) {
      s.status = 'error';
      if (!pane) s.log.push('Claude resume remote-control did not produce a URL.');
      broadcast({ type: 'session_update', session: sanitize(s) });
      clearInterval(timer);
      return;
    }

    broadcast({ type: 'session_update', session: sanitize(s) });
  }, 1000);
}

function recoverTtydSessions() {
  let output = '';
  try {
    output = execSync('ps -eo pid=,args=', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch {
    return;
  }

  const ip = getLocalIPs()[0] || 'localhost';
  for (const line of output.split('\n')) {
    if (!line.includes('ttyd ') || !line.includes(' -p ')) continue;
    if (!line.includes(' codex') && !line.includes(' claude')) continue;

    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const args = match[2].split(/\s+/);
    const port = args[args.indexOf('-p') + 1];
    const tmuxSession = args.includes('-s') ? args[args.indexOf('-s') + 1] : null;
    if (!tmuxSession) continue;
    if (!port || [...sessions.values()].some(s => s.pid === pid || s.url === `http://${ip}:${port}`)) continue;

    const tool = args.includes('claude') ? 'claude' : 'codex';
    const cwd = args.includes('-c')
      ? args[args.indexOf('-c') + 1]
      : args.includes('-w')
        ? args[args.indexOf('-w') + 1]
        : HOME;
    const id = nextId++;
    sessions.set(id, {
      id,
      tool,
      name: `Recovered ${AGENTS[tool]?.label || tool}`,
      cwd,
      status: 'running',
      url: `http://${ip}:${port}`,
      mode: 'ttyd',
      tmuxSession,
      pid,
      log: [`Recovered existing ttyd process ${pid} on port ${port}`],
      startedAt: Date.now(),
    });
  }
}

let stopCurrentRelay = null;

function startCloudRelayConnector() {
  if (!relayConfig.url || !relayConfig.token) return null;
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) {
    console.warn('[Relay] WebSocket is not available in this Node runtime. Use Node 22+ for cloud relay linking.');
    return null;
  }

  let stopped = false;
  const stop = () => { stopped = true; };

  const connect = () => {
    const url = new URL('/node', relayConfig.url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('node_id', relayConfig.nodeId);
    url.searchParams.set('token', relayConfig.token);

    const ws = new WebSocketCtor(url);

    ws.addEventListener('open', () => {
      console.log(`[Relay] Connected as ${relayConfig.nodeId}`);
    });

    ws.addEventListener('message', async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type !== 'proxy_request') return;

      try {
        const body = msg.body_b64 ? Buffer.from(msg.body_b64, 'base64') : undefined;
        const response = await fetch(`http://127.0.0.1:${PORT}${msg.path || '/'}`, {
          method: msg.method || 'GET',
          headers: Object.fromEntries(Object.entries(msg.headers || {}).filter(([, value]) => value)),
          body: ['GET', 'HEAD'].includes(msg.method) ? undefined : body,
        });
        const responseBody = Buffer.from(await response.arrayBuffer());
        const headers = {};
        response.headers.forEach((value, key) => { headers[key] = value; });
        ws.send(JSON.stringify({
          type: 'proxy_response',
          id: msg.id,
          status: response.status,
          headers,
          body_b64: responseBody.toString('base64'),
        }));
      } catch (err) {
        ws.send(JSON.stringify({
          type: 'proxy_response',
          id: msg.id,
          status: 502,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body_b64: Buffer.from(`Launchpad proxy error: ${err.message}`).toString('base64'),
        }));
      }
    });

    ws.addEventListener('close', () => {
      if (stopped) return;
      console.warn('[Relay] Disconnected; retrying in 5s');
      setTimeout(connect, 5000);
    });

    ws.addEventListener('error', () => {
      try { ws.close(); } catch {}
    });
  };

  process.on('SIGTERM', () => { stopped = true; });
  process.on('SIGINT', () => { stopped = true; });
  connect();
  return stop;
}

// ── Agent registry ─────────────────────────────────────────────────────────
//
// Each agent defines:
//   isInstalled()      — can it run at all?
//   nativeAvailable()  — does it support native web remote control?
//   nativeBin/Args     — command for native mode
//   urlPattern         — regex to extract the session URL from stdout
//   fallbackBin        — binary name to pass to ttyd when native is unavailable
//
// Priority: native remote control > ttyd terminal fallback

const AGENTS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    binary: 'claude',
    isInstalled: () => !!which('claude'),
    nativeAvailable: () => !!which('claude'),
    nativeBin: () => 'claude',
    nativeArgs: (name) => {
      const args = ['remote-control', '--spawn', 'session'];
      if (name) args.push('--name', name);
      return args;
    },
    urlPattern: /https:\/\/claude\.ai\/code[^\s\x00-\x1F"']+/,
    installHint: 'npm install -g @anthropic-ai/claude-code',
    installUrl: 'https://claude.ai/code',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    binary: 'codex',
    // Native remote-control requires the standalone installer binary, not the npm version
    isInstalled: () => !!which('codex') || fs.existsSync(path.join(HOME, '.codex/packages/standalone/current/codex')),
    nativeAvailable: () => fs.existsSync(path.join(HOME, '.codex/packages/standalone/current/codex')),
    nativeBin: () => path.join(HOME, '.codex/packages/standalone/current/codex'),
    nativeArgs: () => ['remote-control', 'start', '--json'],
    urlPattern: /https:\/\/[^\s\x00-\x1F"']+/,
    installHint: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    installUrl: 'https://chatgpt.com/codex',
  },
};

// ── Filesystem browse ─────────────────────────────────────────────────────

app.use(express.json());
app.get(['/sw.js', '/registerSW.js'], (_req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.send(`
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      self.registration.unregister(),
      caches.keys().then(keys => Promise.all(keys.map(key => caches.delete(key)))),
      self.clients.matchAll({ type: 'window' }).then(clients => clients.forEach(client => client.navigate(client.url))),
    ])
  );
});
`);
});
app.use(express.static(path.join(process.cwd(), 'frontend/dist')));

app.get('/api/agents', (_req, res) => {
  res.json(Object.values(AGENTS).map(a => ({
    id: a.id,
    label: a.label,
    installed: a.isInstalled(),
    nativeRemoteControl: a.nativeAvailable(),
    installHint: a.installHint,
    installUrl: a.installUrl,
  })));
});

app.get('/api/browse', (req, res) => {
  const dir = req.query.path || HOME;
  const showHidden = req.query.hidden === 'true';
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const items = entries
      .filter(e => showHidden || !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: path.join(dir, e.name), isDir: e.isDirectory() }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ path: dir, parent: path.dirname(dir), items });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Sessions ──────────────────────────────────────────────────────────────

app.get('/api/sessions', (_req, res) => {
  res.json([...sessions.values()].map(sanitize));
});

app.get('/api/agent-sessions', (_req, res) => {
  res.json({ sessions: listAgentSessions() });
});

app.get('/api/session-sync', (_req, res) => {
  res.json(getSyncStatus());
});

app.patch('/api/session-sync', (req, res) => {
  res.json(saveSyncConfig({ enabled: req.body?.enabled !== false }));
});

app.post('/api/sessions', async (req, res) => {
  const { tool, cwd, name, resumeId } = req.body;
  const workDir = cwd || HOME;

  const agent = AGENTS[tool];
  if (!agent) return res.status(400).json({ error: `Unknown tool: ${tool}` });
  if (!agent.isInstalled()) return res.status(400).json({ error: `${agent.label} is not installed` });

  const existing = [...sessions.values()]
    .filter(s =>
      s.tool === tool &&
      s.cwd === workDir &&
      s.mode === 'ttyd' &&
      s.status === 'running' &&
      s.url
    )
    .sort((a, b) => Number(!!b.tmuxSession) - Number(!!a.tmuxSession))[0];
  if (existing) {
    if (!isProcessAlive(existing.pid)) {
      existing.status = 'stopped';
      sessions.delete(existing.id);
      broadcast({ type: 'session_removed', id: existing.id });
      // fall through to create a new session
    } else {
      existing.log.push(`Reconnected at ${new Date().toISOString()}\n`);
      broadcast({ type: 'session_update', session: sanitize(existing) });
      return res.json(sanitize(existing));
    }
  }

  let cmd, args, mode, immediateUrl, tmuxSession = null;

  if (resumeId && tool === 'claude' && agent.nativeAvailable()) {
    if (!which('tmux')) {
      return res.status(503).json({ error: 'tmux not found — install it to resume Claude sessions into Remote Control' });
    }
    const id = nextId++;
    tmuxSession = `lp-claude-${Date.now()}-${id}`;
    const session = {
      id,
      tool,
      name: name || `Resume ${String(resumeId).slice(0, 8)}`,
      cwd: workDir,
      status: 'starting',
      url: null,
      mode: 'native',
      tmuxSession,
      pid: 0,
      log: [`Starting Claude resume ${resumeId} and attaching /remote-control...\n`],
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    sessions.set(id, session);
    startClaudeResumeRemoteSession({
      id,
      session,
      resumeId,
      remoteName: name || `Resume ${String(resumeId).slice(0, 8)}`,
      cwd: workDir,
      agent,
    });
    res.json(sanitize(session));
    return;
  } else if (resumeId) {
    if (!which('ttyd')) {
      return res.status(503).json({ error: 'ttyd not found — install it to resume stored sessions' });
    }
    const port = await getFreePort();
    const ip = getLocalIPs()[0] || 'localhost';
    tmuxSession = `lp-${Date.now()}-${nextId}`;
    cmd = 'ttyd';
    const resumeArgs = tool === 'codex' ? ['resume', String(resumeId)] : ['--resume', String(resumeId)];
    args = ['-p', String(port), '-W', '-t', 'fontSize=16',
            'tmux', 'new-session', '-A', '-s', tmuxSession, '-c', workDir, agent.binary, ...resumeArgs];
    mode = 'ttyd';
    immediateUrl = `http://${ip}:${port}`;
  } else if (agent.nativeAvailable()) {
    cmd = agent.nativeBin();
    args = agent.nativeArgs(name);
    mode = 'native';
  } else {
    if (!which('ttyd')) {
      return res.status(503).json({ error: 'ttyd not found — install it to use the terminal fallback' });
    }
    const port = await getFreePort();
    const ip = getLocalIPs()[0] || 'localhost';
    // Wrap in tmux so closing the browser tab detaches rather than killing the
    // agent. Reconnecting to the same URL reattaches to the running session.
    tmuxSession = `lp-${Date.now()}-${nextId}`;
    cmd = 'ttyd';
    args = ['-p', String(port), '-W', '-t', 'fontSize=16',
            'tmux', 'new-session', '-A', '-s', tmuxSession, '-c', workDir, agent.binary];
    mode = 'ttyd';
    immediateUrl = `http://${ip}:${port}`;
  }

  const id = nextId++;

  const proc = spawn(cmd, args, {
    cwd: workDir,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      // Strip color codes in native mode so the log buffer stays readable;
      // in ttyd mode the terminal handles rendering so leave colors intact.
      ...(mode === 'native' ? { FORCE_COLOR: '0', NO_COLOR: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const session = {
    id,
    tool,
    name: name || `${agent.label} #${id}`,
    cwd: workDir,
    status: immediateUrl ? 'running' : 'starting',
    url: immediateUrl ?? null,
    mode,
    tmuxSession: mode === 'ttyd' ? tmuxSession : null,
    pid: proc.pid,
    log: [],
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
  };

  sessions.set(id, { ...session, proc });

  const handleData = (chunk) => {
    const text = stripAnsi(chunk.toString());
    const s = sessions.get(id);
    if (!s) return;

    s.lastActivityAt = Date.now();
    s.log.push(text);
    if (s.log.length > 300) s.log.shift();

    // For native mode, scan output for the session URL.
    // Agents that emit JSON (codex --json) get their url field extracted;
    // agents that print a plain URL are caught by the regex.
    if (!s.url && mode === 'native') {
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Try JSON first (e.g. codex remote-control start --json)
        try {
          const json = JSON.parse(trimmed);
          const url = json.url || json.relay_url || json.connection_url;
          if (url) {
            s.url = url;
            s.status = 'running';
            broadcast({ type: 'session_update', session: sanitize(s) });
            return;
          }
        } catch {}

        // Plain URL fallback
        const match = trimmed.match(agent.urlPattern);
        if (match) {
          s.url = match[0].replace(/[.,;:)\]]+$/, '');
          s.status = 'running';
          broadcast({ type: 'session_update', session: sanitize(s) });
          return;
        }
      }
    }

    broadcast({ type: 'session_update', session: sanitize(s) });
  };

  proc.stdout.on('data', handleData);
  proc.stderr.on('data', handleData);

  proc.on('error', (err) => {
    const s = sessions.get(id);
    if (s) {
      s.status = 'error';
      s.log.push(`Error: ${err.message}`);
      broadcast({ type: 'session_update', session: sanitize(s) });
    }
  });

  proc.on('exit', (code) => {
    const s = sessions.get(id);
    if (s) {
      s.status = 'stopped';
      s.exitCode = code;
      broadcast({ type: 'session_update', session: sanitize(s) });
    }
  });

  res.json(sanitize(session));
});

app.delete('/api/sessions/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  stopSessionProcess(s);
  sessions.delete(id);
  broadcast({ type: 'session_removed', id });
  res.json({ ok: true });
});

app.post('/api/sessions/:id/pause', (req, res) => {
  const id = parseInt(req.params.id);
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  stopSessionProcess(s);
  s.status = 'stopped';
  s.paused = true;
  s.lastActivityAt = Date.now();
  s.log.push(`[launchpad] Paused at ${new Date().toISOString()}\n`);
  if (s.log.length > 300) s.log.shift();
  broadcast({ type: 'session_update', session: sanitize(s) });
  res.json(sanitize(s));
});

app.get('/api/sessions/:id/log', (req, res) => {
  const id = parseInt(req.params.id);
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (s.status === 'running' || s.status === 'starting') s.lastActivityAt = Date.now();
  res.json({ log: s.log });
});

app.get('/api/relay/status', (_req, res) => {
  res.json({
    configured: !!(relayConfig.url && relayConfig.token),
    url: relayConfig.url,
    nodeId: relayConfig.nodeId,
  });
});

app.post('/api/relay/pair', express.json(), async (req, res) => {
  const { code, relayUrl } = req.body || {};
  if (!code || !relayUrl) return res.status(400).json({ error: 'code and relayUrl are required' });
  try {
    const response = await fetch(`${relayUrl}/api/pair/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(400).json({ error: data.error || 'Claim failed' });
    const newConfig = { url: relayUrl, nodeId: data.nodeId, token: data.token };
    fs.writeFileSync(RELAY_CONFIG_PATH, JSON.stringify(newConfig, null, 2));
    relayConfig = newConfig;
    if (stopCurrentRelay) stopCurrentRelay();
    stopCurrentRelay = startCloudRelayConnector();
    res.json({ ok: true, instanceName: data.instanceName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SSE ───────────────────────────────────────────────────────────────────

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  for (const s of sessions.values()) {
    res.write(`data: ${JSON.stringify({ type: 'session_update', session: sanitize(s) })}\n\n`);
  }
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── SPA fallback ──────────────────────────────────────────────────────────

app.get('*', (_req, res) => {
  const index = path.join(process.cwd(), 'frontend/dist/index.html');
  if (fs.existsSync(index)) {
    res.sendFile(index);
  } else {
    res.status(503).send('Frontend not built. Run: cd frontend && npm run build');
  }
});

recoverTtydSessions();

// Kill processes that have been idle for 30 minutes to prevent memory leaks.
// The session entry (id, logs, url) is preserved so the user can resume.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.status !== 'running' && s.status !== 'starting') continue;
    if (now - s.lastActivityAt < IDLE_TIMEOUT_MS) continue;
    s.log.push(`[launchpad] Idle for 30 min — process killed to free memory. Start a new session to resume.\n`);
    if (s.log.length > 300) s.log.shift();
    s.idleKilled = true;
    stopSessionProcess(s);
  }
}, 2 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log(`\nLaunchpad ready:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  Network: http://${ip}:${PORT}`);
  if (relayConfig.url && relayConfig.token) console.log(`  Relay:   ${relayConfig.url} (${relayConfig.nodeId})`);
  console.log();
  stopCurrentRelay = startCloudRelayConnector();
  startSessionSyncLoop(() => {
    broadcast({ type: 'agent_sessions_updated' });
  });
});
