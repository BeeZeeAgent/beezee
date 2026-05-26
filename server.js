#!/usr/bin/env node
import express from 'express';
import { createServer as createHttpServer } from 'http';
import { spawn, spawnSync, execSync } from 'child_process';
import { createServer } from 'net';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { networkInterfaces, homedir } from 'os';
import multer from 'multer';
import { getSyncStatus, listAgentSessions, saveSyncConfig, startSessionSyncLoop } from './agentSessionSync.js';
import { spawnPty, writePty, resizePty, refreshPty, capturePty, subscribePty, killPty, isPtyAlive } from './pty-manager.js';
import { embeddedFrontend } from './frontend-embed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// When compiled with `bun build --compile`, import.meta.url resolves into Bun's
// virtual FS (/$bunfs/root/...) where static files don't exist. Fall back to the
// directory containing the executable so frontend/dist can live alongside it.
const ASSETS_DIR = __dirname.startsWith('/$bunfs')
  ? path.dirname(process.execPath)
  : __dirname;

const BEEZEE_VERSION = '0.2.0';
const GITHUB_REPO = 'BeeZeeAgent/beezee';

// ── CLI subcommands (runs before server starts) ────────────────────────────

const [,, subcmd] = process.argv;

if (subcmd === '--version' || subcmd === '-v' || subcmd === 'version') {
  console.log(`beezee ${BEEZEE_VERSION}`);
  process.exit(0);
}

if (subcmd === 'update') {
  await runUpdate();
  process.exit(0);
}

async function runUpdate() {
  const platform = process.platform; // linux, darwin, win32
  const arch = process.arch;         // arm64, x64
  const assetName = `beezee-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`;

  console.log(`BeeZee ${BEEZEE_VERSION} — checking for updates...`);

  let release;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { 'User-Agent': `beezee/${BEEZEE_VERSION}` },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    release = await res.json();
  } catch (err) {
    console.error(`Failed to fetch release info: ${err.message}`);
    process.exit(1);
  }

  const latest = release.tag_name?.replace(/^v/, '');
  if (!latest) { console.error('Could not parse release tag.'); process.exit(1); }

  if (latest === BEEZEE_VERSION) {
    console.log(`Already up to date (${BEEZEE_VERSION}).`);
    return;
  }

  const asset = release.assets?.find(a => a.name === assetName);
  if (!asset) {
    console.error(`No binary for ${assetName} in release ${release.tag_name}.`);
    console.error(`Available: ${(release.assets || []).map(a => a.name).join(', ')}`);
    process.exit(1);
  }

  console.log(`Downloading ${BEEZEE_VERSION} → ${latest} (${(asset.size / 1024 / 1024).toFixed(1)} MB)...`);

  const dest = process.execPath;
  const tmp = `${dest}.new`;

  let dlRes;
  try {
    dlRes = await fetch(asset.browser_download_url, { headers: { 'User-Agent': `beezee/${BEEZEE_VERSION}` } });
    if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
  } catch (err) {
    console.error(`Download error: ${err.message}`);
    process.exit(1);
  }

  const buf = Buffer.from(await dlRes.arrayBuffer());
  fs.writeFileSync(tmp, buf);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest);

  console.log(`Updated to ${latest}. Restart BeeZee to apply.`);
}

if (subcmd === 'service') {
  const action = process.argv[3];
  if (!['install', 'uninstall', 'start', 'stop'].includes(action)) {
    console.log('Usage: beezee service <install|uninstall|start|stop>');
    process.exit(1);
  }
  await runService(action);
  process.exit(0);
}

async function runService(action) {
  const bin = process.execPath;
  const platform = process.platform;

  if (platform === 'win32') {
    await runServiceWindows(action, bin);
  } else if (platform === 'linux') {
    runServiceLinux(action, bin);
  } else if (platform === 'darwin') {
    runServiceMac(action, bin);
  } else {
    console.error(`Service management not supported on ${platform}.`);
    process.exit(1);
  }
}

function runServiceWindows(action, bin) {
  const taskName = 'BeeZee';
  const vbsPath = path.join(path.dirname(bin), 'beezee-launcher.vbs');

  if (action === 'install') {
    // VBScript launches the exe with window style 0 (hidden)
    fs.writeFileSync(vbsPath,
      `Set WShell = CreateObject("WScript.Shell")\r\n` +
      `WShell.Run """${bin}""", 0, False\r\n`
    );
    spawnSync('schtasks', [
      '/create', '/f',
      '/tn', taskName,
      '/tr', `wscript.exe "${vbsPath}"`,
      '/sc', 'onlogon',
      '/rl', 'limited',
    ], { stdio: 'inherit' });
    console.log(`Service installed. BeeZee will start automatically on login.`);
    console.log(`Run now: beezee service start`);

  } else if (action === 'uninstall') {
    spawnSync('schtasks', ['/delete', '/f', '/tn', taskName], { stdio: 'inherit' });
    try { fs.unlinkSync(vbsPath); } catch {}
    console.log('Service removed.');

  } else if (action === 'start') {
    spawnSync('schtasks', ['/run', '/tn', taskName], { stdio: 'inherit' });

  } else if (action === 'stop') {
    spawnSync('taskkill', ['/f', '/im', path.basename(bin)], { stdio: 'inherit' });
  }
}

function runServiceLinux(action, bin) {
  const unitDir = path.join(homedir(), '.config', 'systemd', 'user');
  const unitFile = path.join(unitDir, 'beezee.service');

  if (action === 'install') {
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(unitFile,
      `[Unit]\nDescription=BeeZee\nAfter=network.target\n\n` +
      `[Service]\nExecStart=${bin}\nRestart=on-failure\n\n` +
      `[Install]\nWantedBy=default.target\n`
    );
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    spawnSync('systemctl', ['--user', 'enable', 'beezee'], { stdio: 'inherit' });
    console.log('Service installed. Run: beezee service start');

  } else if (action === 'uninstall') {
    spawnSync('systemctl', ['--user', 'disable', '--now', 'beezee'], { stdio: 'inherit' });
    try { fs.unlinkSync(unitFile); } catch {}
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    console.log('Service removed.');

  } else if (action === 'start') {
    spawnSync('systemctl', ['--user', 'start', 'beezee'], { stdio: 'inherit' });

  } else if (action === 'stop') {
    spawnSync('systemctl', ['--user', 'stop', 'beezee'], { stdio: 'inherit' });
  }
}

function runServiceMac(action, bin) {
  const plistDir = path.join(homedir(), 'Library', 'LaunchAgents');
  const plistFile = path.join(plistDir, 'com.beezee.app.plist');
  const label = 'com.beezee.app';

  if (action === 'install') {
    fs.mkdirSync(plistDir, { recursive: true });
    fs.writeFileSync(plistFile,
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
      `<plist version="1.0"><dict>\n` +
      `  <key>Label</key><string>${label}</string>\n` +
      `  <key>ProgramArguments</key><array><string>${bin}</string></array>\n` +
      `  <key>RunAtLoad</key><true/>\n` +
      `  <key>KeepAlive</key><true/>\n` +
      `</dict></plist>\n`
    );
    spawnSync('launchctl', ['load', plistFile], { stdio: 'inherit' });
    console.log('Service installed and started.');

  } else if (action === 'uninstall') {
    spawnSync('launchctl', ['unload', plistFile], { stdio: 'inherit' });
    try { fs.unlinkSync(plistFile); } catch {}
    console.log('Service removed.');

  } else if (action === 'start') {
    spawnSync('launchctl', ['start', label], { stdio: 'inherit' });

  } else if (action === 'stop') {
    spawnSync('launchctl', ['stop', label], { stdio: 'inherit' });
  }
}

const app = express();
const PORT = Number(process.env.PORT) || 4242;
const HOME = process.env.HOME || homedir();

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

function sanitize({ proc, tmuxSession, ptyId, ...s }) { return s; }

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

function getTailscaleIP() {
  const nets = networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && net.address.startsWith('100.')) return net.address;
    }
  }
  return null;
}

function getTerminalUrl(id) {
  if (relayConfig.url && relayConfig.token && relayConfig.nodeId) {
    return `${relayConfig.url}/i/${relayConfig.nodeId}/terminal/${id}`;
  }
  const tsIP = getTailscaleIP();
  const ip = tsIP || getLocalIPs()[0] || 'localhost';
  return `http://${ip}:${PORT}/terminal/${id}`;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

const IS_WIN = process.platform === 'win32';

function which(bin) {
  const cmd = IS_WIN ? `where "${bin}"` : `which ${bin}`;
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\r?\n/)[0] || null; } catch { return null; }
}

function readUsageStats() {
  const claudeCachePath = path.join(HOME, '.claude', 'stats-cache.json');
  try {
    const data = JSON.parse(fs.readFileSync(claudeCachePath, 'utf8'));
    return {
      updatedAt: new Date().toISOString(),
      claude: {
        totalSessions: data.totalSessions || 0,
        totalMessages: data.totalMessages || 0,
        modelUsage: data.modelUsage || {},
        dailyActivity: (data.dailyActivity || []).slice(-30),
        dailyModelTokens: (data.dailyModelTokens || []).slice(-30),
      },
    };
  } catch { return null; }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function stopSessionProcess(s, signal = IS_WIN ? 'SIGKILL' : 'SIGTERM') {
  if (s.ptyId != null) killPty(s.ptyId);
  try {
    if (s.proc) s.proc.kill(signal);
    else if (s.pid) process.kill(s.pid, signal);
  } catch {}
}

function startClaudeResumeRemoteSession({ id, session, resumeId, remoteName, cwd, agent }) {
  let pid;
  try {
    pid = spawnPty(id, agent.nativeBin(), ['--resume', String(resumeId)], { cwd });
  } catch (e) {
    session.status = 'error';
    session.log.push(`Failed to start PTY session: ${e.message}`);
    broadcast({ type: 'session_update', session: sanitize(session) });
    return;
  }
  session.pid = pid;
  session.ptyId = id;

  setTimeout(() => writePty(id, `/remote-control ${remoteName}\r`), 4000);

  let attempts = 0;
  const timer = setInterval(() => {
    const s = sessions.get(id);
    if (!s) { clearInterval(timer); return; }

    const output = capturePty(id);
    if (output) {
      s.log = [output];
      s.lastActivityAt = Date.now();
    }

    const match = output.match(agent.urlPattern);
    if (match) {
      s.url = match[0].replace(/[.,;:)\]]+$/, '');
      s.status = 'running';
      broadcast({ type: 'session_update', session: sanitize(s) });
      clearInterval(timer);
      return;
    }

    attempts += 1;
    if (!isPtyAlive(id) || attempts > 60) {
      s.status = 'error';
      if (!output) s.log.push('Claude resume did not produce a URL within timeout.');
      broadcast({ type: 'session_update', session: sanitize(s) });
      clearInterval(timer);
      return;
    }

    broadcast({ type: 'session_update', session: sanitize(s) });
  }, 1000);
}

function recoverTtydSessions() {
  // PTY sessions live in-process — nothing to recover after a server restart.
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
      const sendUsage = () => {
        const stats = readUsageStats();
        const codexStats = readCodexUsageStats();
        const snapshot = {
          updatedAt: new Date().toISOString(),
          claude: stats?.claude ? { totalSessions: stats.claude.totalSessions, totalMessages: stats.claude.totalMessages, modelUsage: stats.claude.modelUsage } : null,
          codex: codexStats,
        };
        try { ws.send(JSON.stringify({ type: 'usage_update', data: snapshot })); } catch {}
      };
      sendUsage();
      const usageTimer = setInterval(sendUsage, 5 * 60 * 1000);
      ws.addEventListener('close', () => clearInterval(usageTimer), { once: true });
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
        const headers = {};
        response.headers.forEach((value, key) => { headers[key] = value; });
        const contentType = headers['content-type'] || '';
        if (contentType.includes('text/event-stream') && response.body) {
          ws.send(JSON.stringify({ type: 'proxy_response', id: msg.id, status: response.status, headers }));
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              ws.send(JSON.stringify({ type: 'proxy_chunk', id: msg.id, data_b64: Buffer.from(value).toString('base64') }));
            }
          } catch {}
          ws.send(JSON.stringify({ type: 'proxy_stream_end', id: msg.id }));
        } else {
          const responseBody = Buffer.from(await response.arrayBuffer());
          ws.send(JSON.stringify({ type: 'proxy_response', id: msg.id, status: response.status, headers, body_b64: responseBody.toString('base64') }));
        }
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
    isInstalled: () => !!which('codex') || fs.existsSync(path.join(HOME, '.codex', 'packages', 'standalone', 'current', IS_WIN ? 'codex.exe' : 'codex')),
    nativeAvailable: () => fs.existsSync(path.join(HOME, '.codex', 'packages', 'standalone', 'current', IS_WIN ? 'codex.exe' : 'codex')),
    nativeBin: () => path.join(HOME, '.codex', 'packages', 'standalone', 'current', IS_WIN ? 'codex.exe' : 'codex'),
    nativeArgs: () => ['remote-control', 'start', '--json'],
    urlPattern: /https:\/\/[^\s\x00-\x1F"']+/,
    installHint: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    installUrl: 'https://chatgpt.com/codex',
  },
};

// ── Codex usage proxy ─────────────────────────────────────────────────────

const CODEX_USAGE_PATH = path.join(HOME, '.beezee-codex-usage.json');
const CODEX_CONFIG_PATH = path.join(HOME, '.codex', 'config.toml');
let codexSessionCount = 0;

function setCodexProxyConfig(enable) {
  const proxyUrl = `http://localhost:${PORT}/codex-proxy/v1`;
  try {
    let config = '';
    try { config = fs.readFileSync(CODEX_CONFIG_PATH, 'utf8'); } catch {}
    const hasUrl = /^base_url\s*=/m.test(config);
    if (enable) {
      if (hasUrl) {
        config = config.replace(/^base_url\s*=.*$/m, `base_url = "${proxyUrl}"`);
      } else {
        config = `base_url = "${proxyUrl}"\n` + config;
      }
    } else {
      // Remove our proxy URL, leave any other base_url intact
      config = config.replace(new RegExp(`^base_url\\s*=\\s*"${proxyUrl.replace(/\//g, '\\/')}"\n?`, 'm'), '');
    }
    fs.writeFileSync(CODEX_CONFIG_PATH, config);
  } catch (e) {
    console.warn('[Codex proxy] Could not modify config.toml:', e.message);
  }
}

function captureCodexUsage(usage, model) {
  let store = { modelUsage: {}, dailyUsage: [] };
  try { store = JSON.parse(fs.readFileSync(CODEX_USAGE_PATH, 'utf8')); } catch {}
  if (!store.modelUsage) store.modelUsage = {};
  if (!store.dailyUsage) store.dailyUsage = [];
  const m = model || 'unknown';
  if (!store.modelUsage[m]) store.modelUsage[m] = { promptTokens: 0, completionTokens: 0, requests: 0 };
  store.modelUsage[m].promptTokens += usage.prompt_tokens || 0;
  store.modelUsage[m].completionTokens += usage.completion_tokens || 0;
  store.modelUsage[m].requests += 1;
  const today = new Date().toISOString().slice(0, 10);
  let dayEntry = store.dailyUsage.find(d => d.date === today);
  if (!dayEntry) { dayEntry = { date: today, totalTokens: 0, requests: 0 }; store.dailyUsage.push(dayEntry); }
  dayEntry.totalTokens += (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
  dayEntry.requests += 1;
  store.dailyUsage = store.dailyUsage.slice(-30);
  store.updatedAt = new Date().toISOString();
  try { fs.writeFileSync(CODEX_USAGE_PATH, JSON.stringify(store, null, 2)); } catch {}
}

function readCodexUsageStats() {
  try { return JSON.parse(fs.readFileSync(CODEX_USAGE_PATH, 'utf8')); } catch { return null; }
}

// Must be registered before app.use(express.json()) so express.raw() gets the body first
app.all('/codex-proxy/v1/*', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  let bodyObj = null;
  try { if (req.body?.length) bodyObj = JSON.parse(req.body.toString()); } catch {}

  const isStreaming = bodyObj?.stream === true;
  let outBody = req.body;
  if (isStreaming && bodyObj) {
    bodyObj.stream_options = { ...(bodyObj.stream_options || {}), include_usage: true };
    outBody = Buffer.from(JSON.stringify(bodyObj));
  }

  const targetPath = req.path.replace(/^\/codex-proxy/, '');
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const upstreamUrl = `https://api.openai.com${targetPath}${query}`;

  const fwdHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'connection', 'content-length'].includes(k.toLowerCase())) continue;
    fwdHeaders[k] = v;
  }
  if (outBody?.length) fwdHeaders['content-length'] = String(outBody.length);

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers: fwdHeaders,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : outBody,
    });
  } catch (err) {
    return res.status(502).json({ error: `Proxy error: ${err.message}` });
  }

  res.status(upstreamRes.status);
  for (const [k, v] of upstreamRes.headers) {
    if (['transfer-encoding', 'connection', 'content-encoding'].includes(k.toLowerCase())) continue;
    res.setHeader(k, v);
  }

  if (isStreaming && upstreamRes.body) {
    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        sseBuffer += decoder.decode(value, { stream: true });
      }
    } finally {
      res.end();
    }
    for (const line of sseBuffer.split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.usage?.total_tokens > 0) { captureCodexUsage(data.usage, bodyObj?.model || data.model); break; }
      } catch {}
    }
  } else {
    const bodyBuf = Buffer.from(await upstreamRes.arrayBuffer());
    res.send(bodyBuf);
    try {
      const data = JSON.parse(bodyBuf.toString());
      if (data.usage) captureCodexUsage(data.usage, data.model || bodyObj?.model);
    } catch {}
  }
});

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
if (embeddedFrontend) {
  const ONE_YEAR = 60 * 60 * 24 * 365;
  app.use((req, res, next) => {
    const key = req.path === '/' ? '/index.html' : req.path;
    const file = embeddedFrontend.get(key);
    if (!file) return next();
    const isAsset = key.startsWith('/assets/');
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Cache-Control', isAsset ? `public, max-age=${ONE_YEAR}, immutable` : 'no-cache');
    res.send(Buffer.from(file.data, 'base64'));
  });
} else {
  app.use(express.static(path.join(ASSETS_DIR, 'frontend/dist')));
}

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

app.get('/api/home', (req, res) => res.json({ home: HOME }));

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.next', 'dist', 'build', 'out',
  'target', '.cargo', 'vendor', 'venv', '.venv', 'env', '.tox', 'coverage', '.nyc_output']);
let dirIndexCache = null;
let dirIndexCacheAt = 0;
const DIR_INDEX_TTL = 10 * 60 * 1000;

async function buildDirIndex(root) {
  const dirs = [];
  const walk = async (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      dirs.push(full);
      await walk(full, depth + 1);
    }
  };
  await walk(root, 0);
  return dirs;
}

function fuzzyScore(str, query) {
  const s = str.toLowerCase();
  const q = query.toLowerCase();
  const base = path.basename(s);
  if (base === q) return 3;
  if (base.startsWith(q)) return 2;
  if (s.includes(q)) return 1;
  // chars in order
  let qi = 0;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) qi++;
  }
  return qi === q.length ? 0 : -1;
}

app.get('/api/search-dirs', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const now = Date.now();
  if (!dirIndexCache || now - dirIndexCacheAt > DIR_INDEX_TTL) {
    dirIndexCache = await buildDirIndex(HOME);
    dirIndexCacheAt = now;
  }
  const scored = [];
  for (const p of dirIndexCache) {
    const score = fuzzyScore(p, q);
    if (score >= 0) scored.push({ path: p, name: path.basename(p), score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  res.json({ results: scored.slice(0, 50).map(({ path: p, name }) => ({ path: p, name })) });
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

const _uploadMulter = multer({ dest: path.join(HOME, '.beezee-upload-tmp') });

app.post('/api/upload', _uploadMulter.array('files'), (req, res) => {
  const tempFiles = req.files || [];
  try {
    const dest = path.resolve(String(req.query.dest || HOME));
    const relPaths = [].concat(req.body.paths || []);
    for (let i = 0; i < tempFiles.length; i++) {
      const file = tempFiles[i];
      const relPath = relPaths[i] || file.originalname;
      const target = path.resolve(dest, relPath);
      if (!target.startsWith(dest + path.sep)) { fs.unlinkSync(file.path); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try { fs.renameSync(file.path, target); }
      catch { fs.copyFileSync(file.path, target); fs.unlinkSync(file.path); }
    }
    res.json({ ok: true, count: tempFiles.length });
  } catch (e) {
    for (const f of tempFiles) { try { fs.unlinkSync(f.path); } catch {} }
    res.status(500).json({ error: e.message });
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

  // ── Native Claude resume — run in a PTY so we can send /remote-control ──
  if (resumeId && tool === 'claude' && agent.nativeAvailable()) {
    const id = nextId++;
    const session = {
      id, tool,
      name: name || `Resume ${String(resumeId).slice(0, 8)}`,
      cwd: workDir, status: 'starting', url: null, mode: 'native',
      ptyId: id, pid: 0, log: [`Starting Claude resume ${resumeId}…\n`],
      startedAt: Date.now(), lastActivityAt: Date.now(),
    };
    sessions.set(id, session);
    startClaudeResumeRemoteSession({
      id, session, resumeId,
      remoteName: name || `Resume ${String(resumeId).slice(0, 8)}`,
      cwd: workDir, agent,
    });
    res.json(sanitize(session));
    return;
  }

  // ── Terminal (browser) session — PTY streamed via SSE terminal ──
  if (resumeId || !agent.nativeAvailable()) {
    const id = nextId++;
    const termUrl = getTerminalUrl(id);
    const resumeArgs = resumeId
      ? (tool === 'codex' ? ['resume', String(resumeId)] : ['--resume', String(resumeId)])
      : [];

    if (tool === 'codex') {
      codexSessionCount++;
      if (codexSessionCount === 1) setCodexProxyConfig(true);
    }

    let pid = 0;
    try {
      pid = spawnPty(id, agent.binary, resumeArgs, {
        cwd: workDir, env: { TERM: 'xterm-256color' },
      });
    } catch (e) {
      return res.status(500).json({ error: `Failed to spawn PTY: ${e.message}` });
    }

    const session = {
      id, tool, name: name || `${agent.label} #${id}`,
      cwd: workDir, status: 'running', url: termUrl, mode: 'ttyd',
      ptyId: id, pid,
      log: [`PTY terminal started — open ${termUrl} to interact\n`],
      startedAt: Date.now(), lastActivityAt: Date.now(),
    };
    sessions.set(id, session);
    broadcast({ type: 'session_update', session: sanitize(session) });
    res.json(sanitize(session));
    return;
  }

  // ── Native mode — spawn directly, pipe stdout/stderr ──
  const id = nextId++;
  const cmd = agent.nativeBin();
  const args = agent.nativeArgs(name);
  const mode = 'native';

  if (tool === 'codex') {
    codexSessionCount++;
    if (codexSessionCount === 1) setCodexProxyConfig(true);
  }

  const proc = spawn(cmd, args, {
    cwd: workDir,
    env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const session = {
    id, tool, name: name || `${agent.label} #${id}`,
    cwd: workDir, status: 'starting', url: null, mode,
    pid: proc.pid, log: [],
    startedAt: Date.now(), lastActivityAt: Date.now(),
  };

  sessions.set(id, { ...session, proc });

  const handleData = (chunk) => {
    const text = stripAnsi(chunk.toString());
    const s = sessions.get(id);
    if (!s) return;

    s.lastActivityAt = Date.now();
    s.log.push(text);
    if (s.log.length > 300) s.log.shift();

    if (!s.url) {
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const json = JSON.parse(trimmed);
          const url = json.url || json.relay_url || json.connection_url;
          if (url) { s.url = url; s.status = 'running'; broadcast({ type: 'session_update', session: sanitize(s) }); return; }
        } catch {}
        const match = trimmed.match(agent.urlPattern);
        if (match) { s.url = match[0].replace(/[.,;:)\]]+$/, ''); s.status = 'running'; broadcast({ type: 'session_update', session: sanitize(s) }); return; }
      }
    }

    broadcast({ type: 'session_update', session: sanitize(s) });
  };

  proc.stdout.on('data', handleData);
  proc.stderr.on('data', handleData);

  proc.on('error', (err) => {
    const s = sessions.get(id);
    if (s) { s.status = 'error'; s.log.push(`Error: ${err.message}`); broadcast({ type: 'session_update', session: sanitize(s) }); }
  });

  proc.on('exit', (code) => {
    if (tool === 'codex') {
      codexSessionCount = Math.max(0, codexSessionCount - 1);
      if (codexSessionCount === 0) setCodexProxyConfig(false);
    }
    const s = sessions.get(id);
    if (s) { s.status = 'stopped'; s.exitCode = code; broadcast({ type: 'session_update', session: sanitize(s) }); }
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

app.get('/api/usage', (_req, res) => {
  const stats = readUsageStats();
  res.json({
    ...(stats ?? { updatedAt: new Date().toISOString(), claude: null }),
    codex: readCodexUsageStats(),
  });
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

// ── Built-in terminal ─────────────────────────────────────────────────────

app.get('/terminal/:id', (_req, res) => {
  if (embeddedFrontend) {
    const file = embeddedFrontend.get('/terminal.html');
    if (file) return res.setHeader('Content-Type', 'text/html; charset=utf-8').send(Buffer.from(file.data, 'base64'));
  }
  res.sendFile(path.join(ASSETS_DIR, 'terminal.html'));
});

app.get('/terminal/:id/stream', (req, res) => {
  const sessionId = Number(req.params.id);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':\n\n');
  const unsub = subscribePty(sessionId, data => {
    if (!res.writableEnded) {
      res.write(`data: ${Buffer.from(data).toString('base64')}\n\n`);
    }
  });
  refreshPty(sessionId);
  req.on('close', unsub);
});

app.post('/terminal/:id/input', express.raw({ type: '*/*' }), (req, res) => {
  const sessionId = Number(req.params.id);
  if (req.body?.length) writePty(sessionId, req.body.toString());
  res.json({ ok: true });
});

app.post('/terminal/:id/resize', (req, res) => {
  const sessionId = Number(req.params.id);
  const cols = Number(req.body?.cols);
  const rows = Number(req.body?.rows);
  if (cols && rows) resizePty(sessionId, cols, rows);
  res.json({ ok: true });
});

// ── SPA fallback ──────────────────────────────────────────────────────────

app.get('*', (_req, res) => {
  if (embeddedFrontend) {
    const file = embeddedFrontend.get('/index.html');
    res.setHeader('Content-Type', 'text/html; charset=utf-8').send(Buffer.from(file.data, 'base64'));
    return;
  }
  const index = path.join(ASSETS_DIR, 'frontend/dist/index.html');
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

const httpServer = createHttpServer(app);

httpServer.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log(`\nBeeZee ready:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  Network: http://${ip}:${PORT}`);
  if (relayConfig.url && relayConfig.token) console.log(`  Relay:   ${relayConfig.url} (${relayConfig.nodeId})`);
  console.log();
  stopCurrentRelay = startCloudRelayConnector();
  startSessionSyncLoop(() => {
    broadcast({ type: 'agent_sessions_updated' });
  });
});
