import pty from 'node-pty';

// Strip ANSI escape codes for plain-text log capture
function stripAnsi(str) {
  return str.replace(
    // eslint-disable-next-line no-control-regex
    /[\x1B\x9B][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|[\x1B\x9B][= ]./g,
    ''
  );
}

// id → { pty, rawBuf, subscribers, exitCode }
const ptys = new Map();

export function spawnPty(id, cmd, args, { cwd, env, cols = 220, rows = 50 } = {}) {
  const rawBuf = [];
  const subscribers = new Set();

  const p = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...process.env, ...(env || {}) },
  });

  const entry = { pty: p, rawBuf, subscribers, exitCode: null };
  ptys.set(id, entry);

  p.onData(data => {
    rawBuf.push(data);
    if (rawBuf.length > 5000) rawBuf.shift();
    for (const fn of subscribers) {
      try { fn(data); } catch {}
    }
  });

  p.onExit(({ exitCode }) => { entry.exitCode = exitCode; });

  return p.pid;
}

export function writePty(id, data) {
  ptys.get(id)?.pty.write(data);
}

export function resizePty(id, cols, rows) {
  try { ptys.get(id)?.pty.resize(cols, rows); } catch {}
}

export function capturePty(id) {
  const entry = ptys.get(id);
  return entry ? stripAnsi(entry.rawBuf.join('')) : '';
}

// Returns unsubscribe fn. Immediately sends buffered output to new subscriber.
export function subscribePty(id, fn) {
  const entry = ptys.get(id);
  if (!entry) return () => {};
  if (entry.rawBuf.length > 0) {
    try { fn(entry.rawBuf.join('')); } catch {}
  }
  entry.subscribers.add(fn);
  return () => entry.subscribers.delete(fn);
}

export function killPty(id) {
  const entry = ptys.get(id);
  if (!entry) return;
  try { entry.pty.kill(); } catch {}
  ptys.delete(id);
}

export function isPtyAlive(id) {
  const entry = ptys.get(id);
  return !!entry && entry.exitCode === null;
}
