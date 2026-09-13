#!/usr/bin/env bash
# Meetless linux-port — CÀI ĐẶT MỘT LỆNH (build + desktop shortcut).
# Dùng: bash scripts/linux/install-desktop.sh   (hoặc: npm run desktop:linux:install)
# Chỉ tạo lại shortcut (không build): bash scripts/linux/install-desktop.sh --shortcut-only
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

say() { printf '\n\033[1;34m[meetless]\033[0m %s\n' "$1"; }
fail() { printf '\n\033[1;31m[lỗi]\033[0m %s\n' "$1" >&2; exit 1; }

install_shortcut() {
  local LAUNCHER="$REPO/scripts/linux/launch-meetless.sh"
  chmod +x "$LAUNCHER"
  mkdir -p "$HOME/.local/share/applications"
  cat > "$HOME/.local/share/applications/meetless.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Meetless
Comment=Ghi âm cuộc họp (Zoom/Meet/Teams) và tra cứu trên máy bạn
Exec=$LAUNCHER
Icon=$REPO/scripts/linux/icon.png
Terminal=false
Categories=Utility;AudioVideo;
StartupWMClass=Meetless
EOF
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
  echo "Đã tạo shortcut: ~/.local/share/applications/meetless.desktop (mở menu → gõ Meetless)"
}

if [ "${1:-}" = "--shortcut-only" ]; then
  install_shortcut
  exit 0
fi

say "1/5 Kiểm tra phần mềm cần thiết…"
command -v node >/dev/null || fail "Thiếu Node.js (cài bản 20+ từ nodejs.org)"
for tool in ffmpeg parec pactl; do
  command -v "$tool" >/dev/null || fail "Thiếu $tool — chạy: sudo apt install ffmpeg pulseaudio-utils pipewire-pulse"
done

say "2/5 Cài thư viện (npm install)…"
[ -d node_modules ] || npm install

say "3/5 Build chương trình (vài phút)…"
npm run build:paseo
npm run build:meetless
npm run build:app

# phục hồi binary electron nếu install bị hỏng (dist trống/thiếu path.txt)
if [ ! -x node_modules/electron/dist/electron ] || [ ! -f node_modules/electron/path.txt ]; then
  say "   Phục hồi binary Electron từ cache…"
  (cd node_modules/electron && rm -rf dist path.txt && node install.js) || true
  if [ ! -x node_modules/electron/dist/electron ]; then
    Z="$(ls ~/.cache/electron/*/electron-v*-linux-x64.zip 2>/dev/null | head -1 || true)"
    if [ -n "$Z" ]; then
      (cd node_modules/electron && mkdir -p dist && unzip -qo "$Z" -d dist && printf electron > path.txt)
    fi
  fi
fi

say "4/5 Tạo desktop shortcut…"
install_shortcut

say "5/5 Hoàn tất ✔"
cat <<EOF

Cách dùng:
  • Mở app: gõ "Meetless" trong menu ứng dụng (Activities → tìm Meetless)
  • Hoặc lệnh:  npm run desktop:linux
  • Log:        /tmp/meetless-desktop.log
  • Ghi âm lưu ở: ~/Documents/meetings/
  • Hướng dẫn đầy đủ: HUONG-DAN-SU-DUNG.md (mục 4 để bật Transcribe bằng key OpenAI)
EOF
