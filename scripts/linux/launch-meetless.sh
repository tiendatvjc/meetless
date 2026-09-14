#!/usr/bin/env bash
# Meetless launcher (linux-port) — dùng bởi desktop shortcut.
# Dừng daemon nền (nếu có) để cửa sổ desktop tự làm chủ runtime, rồi mở app.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG=/tmp/meetless-desktop.log
export MEETLESS_RUNTIME_ROOT="${MEETLESS_RUNTIME_ROOT:-$HOME/.local/share/meetless}"
export MEETLESS_LISTEN="${MEETLESS_LISTEN:-127.0.0.1:8081}"
export MEETLESS_DEV_STATIC_RENDERER=1
# GLM/Gemini qua opencode cần thời gian dài hơn 3 phút mặc định của chat.
export MEETLESS_CHAT_TIMEOUT_MS="${MEETLESS_CHAT_TIMEOUT_MS:-600000}"

# Desktop menu chạy với PATH hệ thống — tự dò Node của nvm nếu thiếu.
if ! command -v npm >/dev/null 2>&1; then
  for nv in "$HOME"/.nvm/versions/node/*/bin; do
    [ -x "$nv/npm" ] && export PATH="$nv:$PATH" && break
  done
fi
command -v npm >/dev/null 2>&1 || { echo "[meetless] Không tìm thấy npm (cả nvm lẫn hệ thống)." >> "$LOG"; exit 1; }

# "Đang chạy" = cổng renderer 8082 đang lắng nghe. Tiến trình electron sót
# mà không lắng nghe cổng thì là rác — dọn rồi chạy lại.
app_running() { ss -tln 2>/dev/null | grep -q ":8082 "; }
if app_running; then
  echo "[meetless] Đang chạy rồi." >> "$LOG"
  exit 0
fi
pkill -f "electron-bootstrap" 2>/dev/null || true
sleep 1

# Cửa sổ desktop không dùng chung được với daemon systemd — dừng nếu đang bật.
if systemctl --user is-active --quiet meetless-daemon 2>/dev/null; then
  systemctl --user stop meetless-daemon
  sleep 2
fi

cd "$REPO"
echo "[meetless] khởi động $(date +%H:%M:%S) npm=$(command -v npm)" >> "$LOG"
nohup npm run runtime:desktop >> "$LOG" 2>&1 &
disown || true
