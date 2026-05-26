import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { homedir } from 'os';

const HOME = homedir();
const CONFIG_PATH = path.join(HOME, '.launchpad-agent-sync.json');
const STATE_PATH = path.join(HOME, '.launchpad-agent-sync-state.json');
const SYNC_MARKER = 'launchpad-sync';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function safeId(input, length = 32) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, length);
}

function uuidFrom(input) {
  const hex = safeId(input, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function walkFiles(dir, predicate, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, predicate, results);
    else if (predicate(full)) results.push(full);
  }
  return results;
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendJsonl(file, records) {
  if (!records.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => part?.text || part?.content || '')
    .filter(Boolean)
    .join('\n');
}

function projectKey(cwd) {
  return String(cwd || HOME).replace(/^\/+/, '-').replace(/\//g, '-').replace(/[^A-Za-z0-9._-]/g, '-');
}

function firstLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 90);
}

function isEnvironmentContext(text) {
  return String(text || '').trim().startsWith('<environment_context>');
}

const AGENT_SCHEMAS = {
  codex: {
    id: 'codex',
    root: path.join(HOME, '.codex', 'sessions'),
    files() {
      return walkFiles(this.root, file => file.endsWith('.jsonl') && !path.basename(file).startsWith(`${SYNC_MARKER}-`));
    },
    read(file) {
      const records = readJsonl(file);
      const meta = records.find(r => r.type === 'session_meta')?.payload || {};
      const messages = [];
      for (const record of records) {
        if (record.launchpadSync || record.payload?.launchpadSync) continue;
        const payload = record.type === 'response_item' ? record.payload : null;
        if (payload?.type !== 'message') continue;
        if (!['user', 'assistant'].includes(payload.role)) continue;
        const text = textFromContent(payload.content);
        if (!text) continue;
        messages.push({ role: payload.role, text, timestamp: record.timestamp });
      }
      const stat = fs.statSync(file);
      const id = meta.id || path.basename(file, '.jsonl').replace(/^rollout-[^-]+-/, '');
      return {
        agent: this.id,
        id,
        file,
        cwd: meta.cwd || HOME,
        title: firstLine(messages.find(m => m.role === 'user' && !isEnvironmentContext(m.text))?.text) || `Codex ${id.slice(0, 8)}`,
        updatedAt: stat.mtimeMs,
        messages,
      };
    },
    targetFile(source) {
      const date = new Date(source.updatedAt || Date.now());
      const yyyy = String(date.getFullYear());
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');
      return path.join(this.root, yyyy, mm, dd, `${SYNC_MARKER}-${source.agent}-${source.id}.jsonl`);
    },
    toRecords(source) {
      const now = new Date().toISOString();
      const id = uuidFrom(`${source.agent}:${source.id}:codex`);
      const created = new Date(source.updatedAt || Date.now()).toISOString();
      const records = [{
        timestamp: now,
        type: 'session_meta',
        launchpadSync: true,
        payload: {
          id,
          timestamp: created,
          cwd: source.cwd,
          originator: 'launchpad-sync',
          source: 'launchpad-sync',
          thread_source: 'launchpad-sync',
          launchpadSync: { sourceAgent: source.agent, sourceSessionId: source.id, sourceFile: source.file },
        },
      }];
      for (const message of source.messages) {
        records.push({
          timestamp: message.timestamp || now,
          type: 'response_item',
          launchpadSync: true,
          payload: {
            type: 'message',
            role: message.role,
            content: [{ type: message.role === 'user' ? 'input_text' : 'output_text', text: message.text }],
            launchpadSync: { sourceAgent: source.agent, sourceSessionId: source.id },
          },
        });
      }
      return records;
    },
  },
  claude: {
    id: 'claude',
    root: path.join(HOME, '.claude', 'projects'),
    files() {
      return walkFiles(this.root, file => {
        const name = path.basename(file);
        return file.endsWith('.jsonl') && !file.includes(path.sep + 'subagents' + path.sep) && !name.startsWith(`${SYNC_MARKER}-`);
      });
    },
    read(file) {
      const records = readJsonl(file);
      const messages = [];
      let sessionId = path.basename(file, '.jsonl');
      let cwd = HOME;
      for (const record of records) {
        if (record.launchpadSync) continue;
        if (record.sessionId) sessionId = record.sessionId;
        if (record.cwd) cwd = record.cwd;
        if (record.type === 'user') {
          const text = textFromContent(record.message?.content);
          if (text) messages.push({ role: 'user', text, timestamp: record.timestamp });
        } else if (record.type === 'assistant') {
          const parts = record.message?.content || [];
          const text = Array.isArray(parts)
            ? parts.filter(p => p.type === 'text').map(p => p.text).join('\n')
            : '';
          if (text) messages.push({ role: 'assistant', text, timestamp: record.timestamp });
        }
      }
      const stat = fs.statSync(file);
      return {
        agent: this.id,
        id: sessionId,
        file,
        cwd,
        title: firstLine(messages.find(m => m.role === 'user' && !isEnvironmentContext(m.text))?.text) || `Claude ${sessionId.slice(0, 8)}`,
        updatedAt: stat.mtimeMs,
        messages,
      };
    },
    targetFile(source) {
      return path.join(this.root, projectKey(source.cwd), `${SYNC_MARKER}-${source.agent}-${source.id}.jsonl`);
    },
    toRecords(source) {
      const sessionId = uuidFrom(`${source.agent}:${source.id}:claude`);
      let parentUuid = null;
      return source.messages.map((message, index) => {
        const uuid = uuidFrom(`${source.agent}:${source.id}:claude:${index}`);
        const record = {
          parentUuid,
          isSidechain: false,
          type: message.role,
          uuid,
          timestamp: message.timestamp || new Date(source.updatedAt || Date.now()).toISOString(),
          userType: 'external',
          entrypoint: 'launchpad-sync',
          cwd: source.cwd,
          sessionId,
          launchpadSync: { sourceAgent: source.agent, sourceSessionId: source.id, sourceFile: source.file },
        };
        if (message.role === 'user') {
          record.message = { role: 'user', content: message.text };
        } else {
          record.message = {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: message.text }],
            stop_reason: null,
            stop_sequence: null,
          };
        }
        parentUuid = uuid;
        return record;
      });
    },
  },
};

export function loadSyncConfig() {
  const config = readJson(CONFIG_PATH, {});
  return {
    enabled: config.enabled !== false,
    intervalMs: Number(config.intervalMs || 5000),
    agents: Array.isArray(config.agents) ? config.agents : ['codex', 'claude'],
  };
}

export function saveSyncConfig(next) {
  const config = { ...loadSyncConfig(), ...next };
  writeJson(CONFIG_PATH, config);
  return config;
}

export function getSyncStatus() {
  const config = loadSyncConfig();
  const state = readJson(STATE_PATH, { mirrors: {}, lastRunAt: null, lastError: null });
  return { ...config, lastRunAt: state.lastRunAt, lastError: state.lastError, mirrors: Object.keys(state.mirrors || {}).length };
}

export function listAgentSessions() {
  const config = loadSyncConfig();
  const state = readJson(STATE_PATH, { mirrors: {} });
  const byTitle = new Map();
  const bySource = new Map();
  for (const agentId of config.agents) {
    const schema = AGENT_SCHEMAS[agentId];
    if (!schema) continue;
    for (const file of schema.files()) {
      const session = schema.read(file);
      const key = `${session.cwd}:${session.title.toLowerCase()}`;
      const existing = byTitle.get(key);
      if (!existing) {
        const { messages, ...summary } = session;
        const row = { ...summary, agents: [agentId], agentSessions: { [agentId]: session.id } };
        byTitle.set(key, row);
        bySource.set(`${agentId}:${session.id}`, row);
      } else {
        if (!existing.agents.includes(agentId)) existing.agents.push(agentId);
        existing.agentSessions[agentId] = session.id;
        existing.updatedAt = Math.max(existing.updatedAt, session.updatedAt);
        bySource.set(`${agentId}:${session.id}`, existing);
      }
    }
  }
  for (const key of Object.keys(state.mirrors || {})) {
    const [sourceAgent, sourceId, targetAgent] = key.split(':');
    const row = bySource.get(`${sourceAgent}:${sourceId}`);
    if (!row) continue;
    if (!row.agents.includes(targetAgent)) row.agents.push(targetAgent);
    row.agentSessions[targetAgent] = state.mirrors[key].mirroredSessionId
      || uuidFrom(`${sourceAgent}:${sourceId}:${targetAgent}`);
  }
  return [...byTitle.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function runSessionSync() {
  const config = loadSyncConfig();
  const state = readJson(STATE_PATH, { mirrors: {}, lastRunAt: null, lastError: null });
  if (!config.enabled) {
    state.lastRunAt = new Date().toISOString();
    state.lastError = null;
    writeJson(STATE_PATH, state);
    return { synced: 0, skipped: true };
  }

  let synced = 0;
  try {
    for (const sourceAgentId of config.agents) {
      const sourceSchema = AGENT_SCHEMAS[sourceAgentId];
      if (!sourceSchema) continue;
      for (const file of sourceSchema.files()) {
        const source = sourceSchema.read(file);
        if (!source.messages.length) continue;
        for (const targetAgentId of config.agents) {
          if (targetAgentId === sourceAgentId) continue;
          const targetSchema = AGENT_SCHEMAS[targetAgentId];
          if (!targetSchema) continue;
          const key = `${sourceAgentId}:${source.id}:${targetAgentId}`;
          const targetFile = state.mirrors[key]?.targetFile || targetSchema.targetFile(source);
          const previousMtime = state.mirrors[key]?.sourceMtime || 0;
          if (fs.existsSync(targetFile) && previousMtime >= source.updatedAt) continue;
          if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);
          appendJsonl(targetFile, targetSchema.toRecords(source));
          const mirroredSessionId = uuidFrom(`${sourceAgentId}:${source.id}:${targetAgentId}`);
          state.mirrors[key] = { sourceFile: file, sourceMtime: source.updatedAt, targetFile, mirroredSessionId };
          synced += 1;
        }
      }
    }
    state.lastRunAt = new Date().toISOString();
    state.lastError = null;
  } catch (err) {
    state.lastError = err.message;
  }
  writeJson(STATE_PATH, state);
  return { synced, lastError: state.lastError };
}

export function startSessionSyncLoop(onChange) {
  let timer = null;
  const tick = () => {
    const result = runSessionSync();
    if (result.synced && onChange) onChange(result);
    const config = loadSyncConfig();
    timer = setTimeout(tick, Math.max(1000, config.intervalMs));
  };
  timer = setTimeout(tick, 1000);
  return () => timer && clearTimeout(timer);
}
