import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import net from 'net';

const TMP = path.join('/tmp', `server-test-${process.pid}`);
const FIXTURE_DIR = path.join(TMP, 'fixtures');
const UPLOAD_DIR = path.join(TMP, 'uploads');

let serverProc = null;
let baseUrl = '';

function request(method, urlPath, { body, headers = {}, raw } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { ...headers },
    };

    if (body && !raw) {
      const data = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (body && raw) {
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = http.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        res.body = buf;
        res.text = buf.toString();
        try { res.json = JSON.parse(res.text); } catch { res.json = null; }
        resolve(res);
      });
    });
    req.on('error', reject);
    if (body && !raw) req.write(JSON.stringify(body));
    if (body && raw) req.write(body);
    req.end();
  });
}

function waitForServer(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      http.get(url + '/health-check-dummy', () => {
        resolve(true);
      }).on('error', () => {
        if (Date.now() - start > timeout) reject(new Error('Server did not start'));
        else setTimeout(check, 300);
      });
    };
    check();
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}

function requestSSE(urlPath, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const req = http.request({
      method: 'GET',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
    }, res => {
      let data = '';
      const timer = setTimeout(() => {
        req.destroy();
        res.text = data;
        res.statusCode = res.statusCode;
        resolve(res);
      }, timeout);
      res.on('data', c => { data += c.toString(); });
      res.on('end', () => {
        clearTimeout(timer);
        res.text = data;
        resolve(res);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('server.js integration', () => {
  beforeAll(async () => {
    fs.mkdirSync(TMP, { recursive: true });
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.mkdirSync(path.join(TMP, '.beezee-upload-tmp'), { recursive: true });

    fs.writeFileSync(path.join(FIXTURE_DIR, 'hello.txt'), 'hello world');
    fs.writeFileSync(path.join(FIXTURE_DIR, '.hidden'), 'hidden file');
    fs.mkdirSync(path.join(FIXTURE_DIR, 'subdir'), { recursive: true });

    const port = await findFreePort();

    serverProc = spawn('node', ['server.js'], {
      cwd: '/tmp/launchpad-tests',
      env: {
        ...process.env,
        HOME: TMP,
        PATH: process.env.PATH,
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const portUsed = port;

    serverProc.stderr.on('data', d => {
      if (process.env.DEBUG_TESTS) process.stderr.write(d);
    });

    baseUrl = `http://127.0.0.1:${portUsed}`;

    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => {
        reject(new Error(`Server did not start in time. Output so far: ${output}`));
      }, 15000);
      serverProc.stdout.on('data', d => {
        output += d.toString();
        if (output.includes('Launchpad ready')) {
          clearTimeout(timer);
          resolve();
        }
      });
      serverProc.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      serverProc.on('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Server exited with code=${code} signal=${signal}. Output: ${output}`));
      });
    });
  }, 30000);

  afterAll(() => {
    if (serverProc) {
      serverProc.kill('SIGTERM');
      serverProc = null;
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  describe('GET /api/agents', () => {
    it('returns agent list', async () => {
      const res = await request('GET', '/api/agents');
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json)).toBe(true);
      const ids = res.json.map(a => a.id);
      expect(ids).toContain('claude');
      expect(ids).toContain('codex');
    });

    it('includes required fields per agent', async () => {
      const res = await request('GET', '/api/agents');
      for (const agent of res.json) {
        expect(agent).toHaveProperty('id');
        expect(agent).toHaveProperty('label');
        expect(agent).toHaveProperty('installed');
        expect(agent).toHaveProperty('nativeRemoteControl');
        expect(agent).toHaveProperty('installHint');
        expect(agent).toHaveProperty('installUrl');
      }
    });
  });

  describe('GET /api/browse', () => {
    it('lists directory contents', async () => {
      const res = await request('GET', `/api/browse?path=${encodeURIComponent(FIXTURE_DIR)}`);
      expect(res.statusCode).toBe(200);
      expect(res.json.path).toBe(FIXTURE_DIR);
      expect(res.json.items.length).toBeGreaterThanOrEqual(1);
      const names = res.json.items.map(i => i.name);
      expect(names).toContain('hello.txt');
      expect(names).toContain('subdir');
    });

    it('hides hidden files by default', async () => {
      const res = await request('GET', `/api/browse?path=${encodeURIComponent(FIXTURE_DIR)}`);
      const names = res.json.items.map(i => i.name);
      expect(names).not.toContain('.hidden');
    });

    it('shows hidden files when hidden=true', async () => {
      const res = await request('GET', `/api/browse?path=${encodeURIComponent(FIXTURE_DIR)}&hidden=true`);
      const names = res.json.items.map(i => i.name);
      expect(names).toContain('.hidden');
    });

    it('sorts directories first', async () => {
      const res = await request('GET', `/api/browse?path=${encodeURIComponent(FIXTURE_DIR)}`);
      const first = res.json.items[0];
      expect(first.isDir).toBe(true);
    });

    it('returns error for nonexistent directory', async () => {
      const res = await request('GET', `/api/browse?path=${encodeURIComponent('/no/such/dir')}`);
      expect(res.statusCode).toBe(400);
      expect(res.json).toHaveProperty('error');
    });

    it('includes parent path', async () => {
      const res = await request('GET', `/api/browse?path=${encodeURIComponent(FIXTURE_DIR)}`);
      expect(res.json.parent).toBe(path.dirname(FIXTURE_DIR));
    });
  });

  describe('GET /api/sessions', () => {
    it('returns empty array initially', async () => {
      const res = await request('GET', '/api/sessions');
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json)).toBe(true);
    });
  });

  describe('POST /api/sessions', () => {
    it('rejects unknown tool', async () => {
      const res = await request('POST', '/api/sessions', { body: { tool: 'unknown-tool' } });
      expect(res.statusCode).toBe(400);
      expect(res.json.error).toContain('Unknown tool');
    });

    it('starts a session with claude if installed', async () => {
      const res = await request('POST', '/api/sessions', { body: { tool: 'claude' } });
      expect([200, 400, 503]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        expect(res.json).toHaveProperty('id');
        expect(res.json).toHaveProperty('tool', 'claude');
      }
    });
  });

  describe('session lifecycle', () => {
    let sessionId = null;

    it('creates a session', async () => {
      const res = await request('POST', '/api/sessions', { body: { tool: 'claude', cwd: TMP } });
      if (res.statusCode === 200) {
        sessionId = res.json.id;
        expect(res.json.tool).toBe('claude');
        expect(res.json.cwd).toBe(TMP);
        expect(res.json).toHaveProperty('mode');
        expect(res.json).toHaveProperty('startedAt');
      }
    });

    it('lists created session', async () => {
      const res = await request('GET', '/api/sessions');
      expect(res.statusCode).toBe(200);
      if (sessionId) {
        const found = res.json.find(s => s.id === sessionId);
        expect(found).toBeDefined();
      }
    });

    it('gets session log', async () => {
      if (!sessionId) return;
      const res = await request('GET', `/api/sessions/${sessionId}/log`);
      expect(res.statusCode).toBe(200);
      expect(res.json).toHaveProperty('log');
    });

    it('pauses a session', async () => {
      if (!sessionId) return;
      const res = await request('POST', `/api/sessions/${sessionId}/pause`);
      expect(res.statusCode).toBe(200);
      expect(res.json.paused).toBe(true);
      expect(res.json.status).toBe('stopped');
    });

    it('deletes a session', async () => {
      if (!sessionId) return;
      const res = await request('DELETE', `/api/sessions/${sessionId}`);
      expect(res.statusCode).toBe(200);
      expect(res.json.ok).toBe(true);
    });

    it('session is gone after delete', async () => {
      if (!sessionId) return;
      const res = await request('GET', `/api/sessions/${sessionId}/log`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/sessions/:id', () => {
    it('returns 404 for nonexistent session', async () => {
      const res = await request('DELETE', '/api/sessions/99999');
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/sessions/:id/pause', () => {
    it('returns 404 for nonexistent session', async () => {
      const res = await request('POST', '/api/sessions/99999/pause');
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/sessions/:id/log', () => {
    it('returns 404 for nonexistent session', async () => {
      const res = await request('GET', '/api/sessions/99999/log');
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/usage', () => {
    it('returns usage data', async () => {
      const res = await request('GET', '/api/usage');
      expect(res.statusCode).toBe(200);
      expect(res.json).toHaveProperty('claude');
      expect(res.json).toHaveProperty('codex');
    });

    it('returns claude null when no stats file', async () => {
      const res = await request('GET', '/api/usage');
      expect(res.json.claude).toBeNull();
    });
  });

  describe('GET /api/relay/status', () => {
    it('returns relay status', async () => {
      const res = await request('GET', '/api/relay/status');
      expect(res.statusCode).toBe(200);
      expect(res.json).toHaveProperty('configured');
      expect(res.json).toHaveProperty('url');
      expect(res.json).toHaveProperty('nodeId');
    });

    it('shows not configured when no relay env vars', async () => {
      const res = await request('GET', '/api/relay/status');
      expect(res.json.configured).toBe(false);
    });
  });

  describe('POST /api/relay/pair', () => {
    it('rejects missing code', async () => {
      const res = await request('POST', '/api/relay/pair', { body: { relayUrl: 'http://relay.test' } });
      expect(res.statusCode).toBe(400);
    });

    it('rejects missing relayUrl', async () => {
      const res = await request('POST', '/api/relay/pair', { body: { code: 'ABC123' } });
      expect(res.statusCode).toBe(400);
    });

    it('handles unreachable relay', async () => {
      const res = await request('POST', '/api/relay/pair', {
        body: { code: 'ABC123', relayUrl: 'http://127.0.0.1:1' },
      });
      expect(res.statusCode).toBe(500);
    });
  });

  describe('GET /api/agent-sessions', () => {
    it('returns sessions object', async () => {
      const res = await request('GET', '/api/agent-sessions');
      expect(res.statusCode).toBe(200);
      expect(res.json).toHaveProperty('sessions');
      expect(Array.isArray(res.json.sessions)).toBe(true);
    });
  });

  describe('GET /api/session-sync', () => {
    it('returns sync status', async () => {
      const res = await request('GET', '/api/session-sync');
      expect(res.statusCode).toBe(200);
      expect(res.json).toHaveProperty('enabled');
      expect(res.json).toHaveProperty('mirrors');
    });
  });

  describe('PATCH /api/session-sync', () => {
    it('updates sync config', async () => {
      const res = await request('PATCH', '/api/session-sync', { body: { enabled: false } });
      expect(res.statusCode).toBe(200);
      expect(res.json.enabled).toBe(false);

      const verify = await request('GET', '/api/session-sync');
      expect(verify.json.enabled).toBe(false);
    });
  });

  describe('GET /api/events (SSE)', () => {
    it('sends SSE connected event', async () => {
      const res = await requestSSE('/api/events');
      expect(res.statusCode).toBe(200);
      expect(res.text).toContain('connected');
    });

    it('sets correct content type', async () => {
      const res = await requestSSE('/api/events');
      expect(res.headers['content-type']).toContain('text/event-stream');
    });
  });

  describe('GET /sw.js', () => {
    it('returns service worker JS', async () => {
      const res = await request('GET', '/sw.js');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('javascript');
      expect(res.text).toContain('skipWaiting');
    });
  });

  describe('GET * (SPA fallback)', () => {
    it('returns 503 when frontend not built', async () => {
      const res = await request('GET', '/some/spa/route');
      expect(res.statusCode).toBe(503);
      expect(res.text).toContain('Frontend not built');
    });
  });

  describe('codex usage tracking', () => {
    it('reads codex usage stats', async () => {
      const usagePath = path.join(TMP, '.beezee-codex-usage.json');
      fs.writeFileSync(usagePath, JSON.stringify({
        modelUsage: { 'gpt-4': { promptTokens: 100, completionTokens: 200, requests: 5 } },
        dailyUsage: [{ date: '2025-01-01', totalTokens: 300, requests: 5 }],
      }));
      const res = await request('GET', '/api/usage');
      expect(res.json.codex).not.toBeNull();
      expect(res.json.codex.modelUsage['gpt-4'].requests).toBe(5);
    });
  });

  describe('POST /api/upload', () => {
    it('rejects invalid multipart gracefully', async () => {
      const boundary = '----TestBoundary';
      const body = `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="test.txt"\r\n\r\nhello\r\n--${boundary}--\r\n`;
      const res = await request('POST', `/api/upload?dest=${encodeURIComponent(UPLOAD_DIR)}`, {
        raw: body,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
      });
      expect([200, 500]).toContain(res.statusCode);
    });
  });
});
