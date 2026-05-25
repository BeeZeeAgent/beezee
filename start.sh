#!/bin/bash
cd "$(dirname "$0")"

# ── RTK: ensure binary is installed ─────────────────────────────────────────
RTK_BIN="$HOME/.local/bin/rtk"
if ! command -v rtk &>/dev/null && [ ! -f "$RTK_BIN" ]; then
  echo "RTK not found — installing..."
  ARCH=$(uname -m)
  case "$ARCH" in
    aarch64) RTK_ASSET="rtk-aarch64-unknown-linux-gnu.tar.gz" ;;
    x86_64)  RTK_ASSET="rtk-x86_64-unknown-linux-musl.tar.gz" ;;
    *) echo "Unsupported arch ($ARCH), skipping RTK install" ;;
  esac
  if [ -n "$RTK_ASSET" ]; then
    RTK_URL=$(curl -sf https://api.github.com/repos/rtk-ai/rtk/releases/latest \
      | grep browser_download_url | grep "$RTK_ASSET" | cut -d '"' -f4)
    if [ -n "$RTK_URL" ]; then
      mkdir -p "$HOME/.local/bin"
      curl -sL "$RTK_URL" | tar -xz -C "$HOME/.local/bin" rtk
      chmod +x "$RTK_BIN"
      echo "RTK installed → $RTK_BIN"
    else
      echo "Could not resolve RTK download URL, skipping"
    fi
  fi
fi

# ── RTK: init for Claude Code globally (idempotent) ──────────────────────────
export PATH="$HOME/.local/bin:$PATH"
if command -v rtk &>/dev/null; then
  rtk init --global 2>/dev/null || true
  echo "RTK ready ($(rtk --version 2>/dev/null || echo 'unknown version'))"
fi

node server.js
