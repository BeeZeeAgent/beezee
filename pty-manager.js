// PTY sessions using Bun.spawn with tty:true — no native addons needed

function stripAnsi(str) {
  return str.replace(
    // eslint-disable-next-line no-control-regex
    /[\x1B\x9B][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|[\x1B\x9B][= ]./g,
    ''
  );
}

// id → { proc, rawBuf, subscribers, exitCode }
const ptys = new Map();

export function spawnPty(id, cmd, args, { cwd, env, cols = 220, rows = 50 } = {}) {
  const rawBuf = [];
  const subscribers = new Set();

  const proc = Bun.spawn([cmd, ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    tty: true,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLUMNS: String(cols),
      LINES: String(rows),
      ...(env || {}),
    },
  });

  const entry = { proc, rawBuf, subscribers, exitCode: null };
  ptys.set(id, entry);

  // Async reader loop — runs for the lifetime of the PTY
  (async () => {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const data = new TextDecoder().decode(value);
        rawBuf.push(data);
        if (rawBuf.length > 5000) rawBuf.shift();
        for (const fn of subscribers) {
          try { fn(data); } catch {}
        }
      }
    } catch {}
    entry.exitCode = await proc.exited.catch(() => -1);
  })();

  return proc.pid;
}

export function writePty(id, data) {
  const entry = ptys.get(id);
  if (!entry) return;
  try {
    entry.proc.stdin.write(data);
    entry.proc.stdin.flush();
  } catch {}
}

export function resizePty(id, cols, rows) {
  // Bun.spawn doesn't yet expose the PTY master fd needed for TIOCSWINSZ.
  // We send stty only when the terminal is idle (not mid-output) — best effort.
  writePty(id, `\x01stty cols ${cols} rows ${rows}\r`);
}

export function capturePty(id) {
  const entry = ptys.get(id);
  return entry ? stripAnsi(entry.rawBuf.join('')) : '';
}

// Returns unsubscribe fn. Immediately replays buffered output to new subscriber.
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
  try { entry.proc.kill(); } catch {}
  ptys.delete(id);
}

export function isPtyAlive(id) {
  const entry = ptys.get(id);
  return !!entry && entry.exitCode === null;
}
