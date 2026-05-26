#!/usr/bin/env node
// Build and package the BeeZee Windows bundle.
// Usage: node scripts/bundle-windows.js
// Produces: dist/beezee-windows-x64.zip

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Patch a Windows PE executable from CONSOLE subsystem (3) to GUI subsystem (2).
// This is equivalent to Bun's --windows-hide-console flag but works in cross-compilation.
// PE layout: at 0x3C is the PE header offset; subsystem is at PE_offset + 4 + 20 + 68.
function patchPeSubsystem(exePath) {
  const buf = fs.readFileSync(exePath);
  const peOffset = buf.readUInt32LE(0x3C);
  const sig = buf.toString('ascii', peOffset, peOffset + 4);
  if (sig !== 'PE\0\0') throw new Error(`Not a valid PE file: ${exePath}`);
  const subsystemOffset = peOffset + 4 + 20 + 68;
  const current = buf.readUInt16LE(subsystemOffset);
  if (current === 3) {
    buf.writeUInt16LE(2, subsystemOffset);  // CUI → GUI
    fs.writeFileSync(exePath, buf);
    console.log(`  Patched PE subsystem: CONSOLE → GUI (offset 0x${subsystemOffset.toString(16)})`);
  } else if (current === 2) {
    console.log(`  PE subsystem already GUI, no patch needed.`);
  } else {
    console.warn(`  Unexpected PE subsystem value: ${current}, skipping patch.`);
  }
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist', 'windows');
const EXE  = path.join(ROOT, 'beezee-windows-x64.exe');
const ZIP  = path.join(ROOT, 'dist', 'beezee-windows-x64.zip');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

// ── 1. Build ─────────────────────────────────────────────────────────────────
console.log(`Building beezee v${VERSION} for Windows x64…`);
// Note: --windows-* flags (icon, hide-console, title…) only work when Bun itself
// runs on Windows. We apply the subsystem patch manually below instead.
const build = spawnSync('bun', [
  'build', '--compile',
  '--target=bun-windows-x64',
  'server.js',
  '--outfile', EXE,
], { cwd: ROOT, stdio: 'inherit' });

if (build.status !== 0) {
  console.error('Build failed.');
  process.exit(1);
}
console.log(`Built: ${EXE}`);

// Patch from CONSOLE (3) → GUI (2) subsystem so no terminal window appears.
// This is what --windows-hide-console does; we do it manually for cross-compilation.
patchPeSubsystem(EXE);

// ── 2. Assemble bundle dir ────────────────────────────────────────────────────
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// Copy exe
fs.copyFileSync(EXE, path.join(DIST, 'beezee.exe'));

// ── Helper scripts ────────────────────────────────────────────────────────────

fs.writeFileSync(path.join(DIST, 'Start BeeZee.bat'), [
  '@echo off',
  'tasklist /FI "IMAGENAME eq beezee.exe" 2>NUL | find /I "beezee.exe" >NUL',
  'if "%ERRORLEVEL%"=="0" (',
  '    echo BeeZee is already running.',
  '    start http://localhost:4242',
  ') else (',
  '    echo Starting BeeZee...',
  '    start "" "%~dp0beezee.exe"',
  '    timeout /t 2 /nobreak >NUL',
  '    start http://localhost:4242',
  ')',
].join('\r\n'));

fs.writeFileSync(path.join(DIST, 'Stop BeeZee.bat'), [
  '@echo off',
  'taskkill /IM beezee.exe /F 2>NUL',
  'if "%ERRORLEVEL%"=="0" (',
  '    echo BeeZee stopped.',
  ') else (',
  '    echo BeeZee was not running.',
  ')',
  'pause',
].join('\r\n'));

fs.writeFileSync(path.join(DIST, 'Install to Startup.bat'), [
  '@echo off',
  'set "STARTUP=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"',
  'copy /Y "%~dp0beezee.exe" "%STARTUP%\\beezee.exe" >NUL',
  'echo BeeZee added to Windows Startup.',
  'echo It will launch automatically (and silently) each time you log in.',
  'echo.',
  'echo To start it right now, run "Start BeeZee.bat"',
  'pause',
].join('\r\n'));

fs.writeFileSync(path.join(DIST, 'Uninstall from Startup.bat'), [
  '@echo off',
  'set "STARTUP=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"',
  'del /F /Q "%STARTUP%\\beezee.exe" 2>NUL',
  'echo BeeZee removed from Windows Startup.',
  'pause',
].join('\r\n'));

fs.writeFileSync(path.join(DIST, 'README.txt'), [
  `BeeZee v${VERSION} — Windows Bundle`,
  '=' .repeat(40),
  '',
  'QUICK START',
  '  Double-click  "Start BeeZee.bat"',
  '  BeeZee opens in your browser at http://localhost:4242',
  '',
  'AUTO-START ON LOGIN',
  '  Run "Install to Startup.bat" once.',
  '  BeeZee will launch silently in the background each time you log in.',
  '  Your browser will open automatically on first launch.',
  '',
  'STOPPING',
  '  Run "Stop BeeZee.bat"  — or kill beezee.exe in Task Manager.',
  '',
  'REMOVE AUTO-START',
  '  Run "Uninstall from Startup.bat"',
  '',
  'NOTES',
  '  beezee.exe runs as a hidden background process (no terminal window).',
  '  It listens on port 4242. Logs are written to %APPDATA%\\beezee\\',
  '',
  'https://github.com/PAndreew/launchpad',
].join('\r\n'));

// ── 3. Zip ────────────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(ZIP), { recursive: true });
try { fs.unlinkSync(ZIP); } catch {}

console.log(`Packaging → ${ZIP}`);
const zip = spawnSync('zip', ['-r', ZIP, '.'], { cwd: DIST, stdio: 'inherit' });
if (zip.status !== 0) {
  console.error('zip failed — is "zip" installed?');
  process.exit(1);
}

const sizeMB = (fs.statSync(ZIP).size / 1024 / 1024).toFixed(1);
console.log(`\nBundle ready: ${ZIP} (${sizeMB} MB)`);
console.log('Contents:');
for (const f of fs.readdirSync(DIST)) {
  const stat = fs.statSync(path.join(DIST, f));
  console.log(`  ${f.padEnd(36)} ${(stat.size / 1024).toFixed(0)} KB`);
}
