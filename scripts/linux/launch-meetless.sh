#!/usr/bin/env bash
# Meetless launcher (linux-port) — dùng bởi desktop shortcut.
# Dừng daemon nền (nếu có) để cửa sổ desktop tự làm chủ runtime, rồi mở app.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export MEETLESS_RUNTIME_ROOT="${MEETLESS_RUNTIME_ROOT:-$HOME/.local/share/meetless}"
export MEETLESS_LISTEN="${MEETLESS_LISTEN:-127.0.0.1:8081}"
export MEETLESS_DEV_STATIC_RENDERER=1

# đã chạy thì thôi
if pgrep -f "electron-bootstrap" >/dev/null 2>&1; then
  echo "Meetless đang chạy rồi."
  exit 0
fi

# cửa sổ desktop không dùng chung được với daemon systemd — dừng nó nếu đang bật
if systemctl --user is-active --quiet meetless-daemon 2>/dev/null; then
  systemctl --user stop meetless-daemon
  sleep 2
fi

cd "$REPO"
nohup npm run runtime:desktop > /tmp/meetless-desktop.log 2>&1 &
echo "Meetless đang khởi động… (log: /tmp/meetless-desktop.log)"
