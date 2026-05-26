import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';

const TMP = path.join('/tmp', `sync-test-${process.pid}`);

const origHome = process.env.HOME;

function setHome() {
  fs.mkdirSync(TMP, { recursive: true });
  process.env.HOME = TMP;
}

function cleanHome() {
  process.env.HOME = origHome;
  fs.rmSync(TMP, { recursive: true, force: true });
}

function makeJsonlFile(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

describe('agentSessionSync', () => {
  beforeEach(() => {
    setHome();
  });

  afterEach(() => {
    cleanHome();
  });

  describe('loadSyncConfig', () => {
    it('returns defaults when no config file exists', async () => {
      const { loadSyncConfig } = await import('../agentSessionSync.js');
      const config = loadSyncConfig();
      expect(config.enabled).toBe(true);
      expect(config.intervalMs).toBe(5000);
      expect(config.agents).toEqual(['codex', 'claude']);
    });

    it('reads config from disk', async () => {
      const configPath = path.join(TMP, '.launchpad-agent-sync.json');
      fs.writeFileSync(configPath, JSON.stringify({ enabled: false, intervalMs: 1000, agents: ['codex'] }));
      const { loadSyncConfig } = await import('../agentSessionSync.js');
      const config = loadSyncConfig();
      expect(config.enabled).toBe(false);
      expect(config.intervalMs).toBe(1000);
      expect(config.agents).toEqual(['codex']);
    });
  });

  describe('saveSyncConfig', () => {
    it('persists config and merges with existing', async () => {
      const { saveSyncConfig, loadSyncConfig } = await import('../agentSessionSync.js');
      const saved = saveSyncConfig({ enabled: false });
      expect(saved.enabled).toBe(false);
      const loaded = loadSyncConfig();
      expect(loaded.enabled).toBe(false);
    });

    it('returns merged config', async () => {
      const { saveSyncConfig } = await import('../agentSessionSync.js');
      const result = saveSyncConfig({ intervalMs: 9999 });
      expect(result.intervalMs).toBe(9999);
      expect(result.enabled).toBe(true);
      expect(result.agents).toEqual(['codex', 'claude']);
    });
  });

  describe('getSyncStatus', () => {
    it('returns config plus state fields', async () => {
      const { getSyncStatus } = await import('../agentSessionSync.js');
      const status = getSyncStatus();
      expect(status).toHaveProperty('enabled');
      expect(status).toHaveProperty('lastRunAt');
      expect(status).toHaveProperty('lastError');
      expect(status).toHaveProperty('mirrors');
    });
  });

  describe('runSessionSync', () => {
    it('skips when disabled', async () => {
      const { saveSyncConfig, runSessionSync } = await import('../agentSessionSync.js');
      saveSyncConfig({ enabled: false });
      const result = runSessionSync();
      expect(result.synced).toBe(0);
      expect(result.skipped).toBe(true);
    });

    it('syncs sessions between agents', async () => {
      const codexRoot = path.join(TMP, '.codex/sessions');
      const codexFile = path.join(codexRoot, 'test-session.jsonl');
      makeJsonlFile(codexFile, [
        { type: 'session_meta', payload: { id: 'sess-1', cwd: TMP } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: 'hello world' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] } },
      ]);

      const claudeRoot = path.join(TMP, '.claude/projects');
      const claudeCwd = String(TMP).replace(/^\/+/, '-').replace(/\//g, '-').replace(/[^A-Za-z0-9._-]/g, '-');
      const claudeFile = path.join(claudeRoot, claudeCwd, 'sess-2.jsonl');
      makeJsonlFile(claudeFile, [
        { sessionId: 'sess-2', cwd: TMP, type: 'user', message: { content: 'claude question' } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'claude answer' }] } },
      ]);

      const { runSessionSync } = await import('../agentSessionSync.js');
      const result = runSessionSync();
      expect(result.synced).toBeGreaterThanOrEqual(1);

      const codexSyncRoot = path.join(TMP, '.codex/sessions');
      const syncedFiles = [];
      function findJsonl(dir) {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) findJsonl(full);
          else if (full.includes('launchpad-sync-')) syncedFiles.push(full);
        }
      }
      findJsonl(codexSyncRoot);
      findJsonl(claudeRoot);
      expect(syncedFiles.length).toBeGreaterThanOrEqual(2);
    });

    it('handles no sessions gracefully', async () => {
      const { runSessionSync } = await import('../agentSessionSync.js');
      const result = runSessionSync();
      expect(result.synced).toBe(0);
    });
  });

  describe('listAgentSessions', () => {
    it('returns empty array when no sessions exist', async () => {
      const { listAgentSessions } = await import('../agentSessionSync.js');
      const sessions = listAgentSessions();
      expect(Array.isArray(sessions)).toBe(true);
    });

    it('lists sessions from codex data', async () => {
      const codexRoot = path.join(TMP, '.codex/sessions');
      makeJsonlFile(path.join(codexRoot, 'test-session.jsonl'), [
        { type: 'session_meta', payload: { id: 'c-1', cwd: TMP } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: 'my first prompt' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'response' }] } },
      ]);

      const { listAgentSessions } = await import('../agentSessionSync.js');
      const sessions = listAgentSessions();
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      expect(sessions[0].title).toContain('my first prompt');
      expect(sessions[0].agents).toContain('codex');
    });

    it('lists sessions from claude data', async () => {
      const claudeCwd = String(TMP).replace(/^\/+/, '-').replace(/\//g, '-').replace(/[^A-Za-z0-9._-]/g, '-');
      const claudeRoot = path.join(TMP, '.claude/projects', claudeCwd);
      makeJsonlFile(path.join(claudeRoot, 'abc123.jsonl'), [
        { sessionId: 'abc123', cwd: TMP, type: 'user', message: { content: 'claude prompt here' } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'claude response' }] } },
      ]);

      const { listAgentSessions } = await import('../agentSessionSync.js');
      const sessions = listAgentSessions();
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      const claudeSession = sessions.find(s => s.agents.includes('claude'));
      expect(claudeSession).toBeDefined();
      expect(claudeSession.title).toContain('claude prompt here');
    });

    it('merges sessions with same title across agents', async () => {
      const codexRoot = path.join(TMP, '.codex/sessions');
      makeJsonlFile(path.join(codexRoot, 'shared.jsonl'), [
        { type: 'session_meta', payload: { id: 'shared-1', cwd: TMP } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: 'shared prompt' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'resp' }] } },
      ]);

      const claudeCwd = String(TMP).replace(/^\/+/, '-').replace(/\//g, '-').replace(/[^A-Za-z0-9._-]/g, '-');
      const claudeRoot = path.join(TMP, '.claude/projects', claudeCwd);
      makeJsonlFile(path.join(claudeRoot, 'shared.jsonl'), [
        { sessionId: 'shared-2', cwd: TMP, type: 'user', message: { content: 'shared prompt' } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'resp' }] } },
      ]);

      const { listAgentSessions } = await import('../agentSessionSync.js');
      const sessions = listAgentSessions();
      const merged = sessions.find(s => s.agents.length > 1);
      expect(merged).toBeDefined();
      expect(merged.agents).toContain('codex');
      expect(merged.agents).toContain('claude');
    });

    it('ignores launchpad-sync files', async () => {
      const codexRoot = path.join(TMP, '.codex/sessions');
      makeJsonlFile(path.join(codexRoot, 'launchpad-sync-claude-abc.jsonl'), [
        { type: 'session_meta', payload: { id: 'synced', cwd: TMP } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: 'synced prompt' } },
      ]);

      const { listAgentSessions } = await import('../agentSessionSync.js');
      const sessions = listAgentSessions();
      expect(sessions.find(s => s.id === 'synced')).toBeUndefined();
    });
  });

  describe('startSessionSyncLoop', () => {
    it('returns a stop function', async () => {
      const { startSessionSyncLoop } = await import('../agentSessionSync.js');
      const stop = startSessionSyncLoop(() => {});
      expect(typeof stop).toBe('function');
      stop();
    });
  });
});
