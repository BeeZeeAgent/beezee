// PTY sessions — Python pty.spawn wrapper on Linux/Mac, native Bun on Windows
// Python path works without a controlling terminal (daemon/service safe)

import { spawnSync } from 'child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const IS_WIN = process.platform === 'win32';

function checkPython3() {
  try {
    const r = spawnSync('python3', ['-c', 'import pty, os, fcntl, termios'], {
      timeout: 3000,
      windowsHide: true,
    });
    return r.status === 0;
  } catch { return false; }
}

const USE_PYTHON_PTY = !IS_WIN && checkPython3();

const PYTHON_HELPER = String.raw`
import pty, os, sys, signal, select, struct, fcntl, termios, threading

resize_file = sys.argv[1]
argv = sys.argv[2:]

master_fd, slave_fd = os.openpty()

pid = os.fork()
if pid == 0:
    os.close(master_fd)
    os.setsid()
    fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
    for fd in (0, 1, 2):
        os.dup2(slave_fd, fd)
    if slave_fd > 2:
        os.close(slave_fd)
    os.execvpe(argv[0], argv, os.environ)
    os._exit(1)

os.close(slave_fd)

def do_resize():
    try:
        data = open(resize_file).read().strip()
        if not data: return
        cols, rows = data.split()
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ,
                    struct.pack('HHHH', int(rows), int(cols), 0, 0))
        os.kill(pid, signal.SIGWINCH)
    except Exception:
        pass

def on_winch(s, f):
    do_resize()

def on_term(s, f):
    try: os.kill(pid, signal.SIGTERM)
    except: pass
    os._exit(0)

signal.signal(signal.SIGWINCH, on_winch)
signal.signal(signal.SIGTERM, on_term)

try:
    with open(resize_file) as _: pass
    do_resize()
except: pass

while True:
    try:
        r, _, _ = select.select([master_fd, sys.stdin.fileno()], [], [], 0.5)
        for fd in r:
            try:
                d = os.read(fd, 4096)
                if not d:
                    os._exit(0)
                os.write(sys.stdout.fileno() if fd == master_fd else master_fd, d)
            except OSError:
                os._exit(0)
        # Check if child exited
        result = os.waitpid(pid, os.WNOHANG)
        if result[0] != 0:
            os._exit(0)
    except Exception:
        os._exit(0)
`.trimStart();

let helperPath = null;

function ensureHelper() {
  if (helperPath) return helperPath;
  const dir = mkdtempSync(join(tmpdir(), 'beezee-pty-'));
  helperPath = join(dir, 'helper.py');
  writeFileSync(helperPath, PYTHON_HELPER);
  return helperPath;
}

function stripAnsi(str) {
  return str.replace(
    // eslint-disable-next-line no-control-regex
    /[\x1B\x9B][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|[\x1B\x9B][= ]./g,
    ''
  );
}

// id → { proc, rawBuf, subscribers, exitCode, resizeFile }
const ptys = new Map();

export function spawnPty(id, cmd, args, { cwd, env, cols = 220, rows = 50 } = {}) {
  const rawBuf = [];
  const subscribers = new Set();

  let proc;
  let resizeFile = null;

  if (USE_PYTHON_PTY) {
    const helper = ensureHelper();
    resizeFile = join(tmpdir(), `beezee-resize-${id}.txt`);
    writeFileSync(resizeFile, `${cols} ${rows}`);

    proc = Bun.spawn(['python3', helper, resizeFile, cmd, ...args], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: IS_WIN,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLUMNS: String(cols),
        LINES: String(rows),
        ...(env || {}),
      },
    });
  } else {
    proc = Bun.spawn([cmd, ...args], {
      stdin: 'pipe',
      stdout: 'pipe',
      tty: true,
      windowsHide: IS_WIN,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLUMNS: String(cols),
        LINES: String(rows),
        ...(env || {}),
      },
    });
  }

  const entry = { proc, rawBuf, subscribers, exitCode: null, resizeFile };
  ptys.set(id, entry);

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
  const entry = ptys.get(id);
  if (!entry || entry.exitCode !== null) return;

  if (USE_PYTHON_PTY && entry.resizeFile) {
    try { writeFileSync(entry.resizeFile, `${cols} ${rows}`); } catch {}
    try { process.kill(entry.proc.pid, 'SIGWINCH'); } catch {}
  } else {
    try {
      spawnSync('stty', ['-F', `/proc/${entry.proc.pid}/fd/0`, 'cols', String(cols), 'rows', String(rows)],
        { stdio: 'ignore', timeout: 500, windowsHide: true });
    } catch {}
    try { process.kill(entry.proc.pid, 'SIGWINCH'); } catch {}
  }
}

export function refreshPty(id) {
  const entry = ptys.get(id);
  if (!entry || entry.exitCode !== null) return;
  try { process.kill(entry.proc.pid, 'SIGWINCH'); } catch {}
}

export function capturePty(id) {
  const entry = ptys.get(id);
  return entry ? stripAnsi(entry.rawBuf.join('')) : '';
}

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
  if (entry.resizeFile) {
    try { unlinkSync(entry.resizeFile); } catch {}
  }
  ptys.delete(id);
}

export function isPtyAlive(id) {
  const entry = ptys.get(id);
  return !!entry && entry.exitCode === null;
}
