#!/usr/bin/env bash
# Meetless — cài bộ máy speaker-diarization (pyannote, chạy sidecar cạnh app).
#
#   bash scripts/linux/install-diarization.sh           # cài (idempotent)
#   bash scripts/linux/install-diarization.sh --check   # kiểm tra trạng thái
#   npm run diarization:install
#
# Những gì script làm (tất cả trong $HOME, không sudo):
#   1. uv  (nếu thiếu) → ~/.local/bin  qua script chính thức astral.sh
#   2. venv Python 3.11 → ~/.local/share/meetless/tools/pyannote/
#   3. torch (wheel CPU từ download.pytorch.org/whl/cpu — nhỏ hơn nhiều so với
#      wheel CUDA mặc định, đủ vì pyannote chạy CPU) + pyannote.audio==3.3.2
#      (onnxruntime KHÔNG cần cho pipeline chuẩn 3.x — chỉ cài nếu import lỗi)
#   4. Hướng dẫn lưu HF token tại ~/.local/share/meetless/tools/pyannote/hf-token
#
# Exit code --check: 0 = sẵn sàng (venv + pyannote + token)
#                    2 = thiếu venv / import pyannote.audio thất bại
#                    3 = có venv + pyannote nhưng thiếu HF token
set -euo pipefail

PYANNOTE_PIN="pyannote.audio==3.3.2"
# Pin cặp torch/torchaudio tương thích pyannote.audio 3.3.2:
# - torchaudio >=2.9 đã bỏ API legacy (torchaudio.AudioMetaData) mà pyannote dùng;
# - bản mới nhất trên index CPU (torch 2.14/torchaudio 2.11) làm 'import pyannote.audio' lỗi.
TORCH_PIN="torch==2.6.0"
TORCHAUDIO_PIN="torchaudio==2.6.0"
# pyannote 3.3.2 gọi huggingface_hub với kwarg cũ 'use_auth_token' — bị bỏ ở
# huggingface-hub 1.x → phải pin bản 0.x thì from_pretrained mới chạy được.
HUGGINGFACE_HUB_PIN="huggingface-hub==0.36.0"
TORCH_CPU_INDEX="https://download.pytorch.org/whl/cpu"
INSTALL_DIR="$HOME/.local/share/meetless/tools/pyannote"
VENV_PY="$INSTALL_DIR/bin/python"
TOKEN_FILE="$INSTALL_DIR/hf-token"
UV_BIN="$HOME/.local/bin/uv"

say() { printf '\n\033[1;34m[diarization]\033[0m %s\n' "$1"; }
warn() { printf '\n\033[1;33m[diarization]\033[0m %s\n' "$1" >&2; }
fail() { printf '\n\033[1;31m[lỗi diarization]\033[0m %s\n' "$1" >&2; exit 1; }

do_check() {
  # 0 = ok; 2 = thiếu venv/pyannote; 3 = thiếu token. In rõ từng thiếu sót.
  local status=0
  if [ ! -x "$VENV_PY" ]; then
    warn "Thiếu venv python: $VENV_PY — chạy lại: npm run diarization:install"
    status=2
  elif ! "$VENV_PY" -c "import pyannote.audio" 2>/dev/null; then
    warn "Venv có nhưng 'import pyannote.audio' thất bại — chạy lại: npm run diarization:install"
    status=2
  elif [ ! -s "$TOKEN_FILE" ]; then
    warn "Thiếu HF token: $TOKEN_FILE — xem hướng dẫn khi cài (npm run diarization:install)"
    status=3
  fi
  if [ "$status" -eq 0 ]; then
    say "Sẵn sàng: venv + pyannote + HF token ✔"
  fi
  return "$status"
}

if [ "${1:-}" = "--check" ]; then
  do_check
  exit $?
fi

say "1/4 Chuẩn bị uv…"
if command -v uv >/dev/null 2>&1; then
  UV_BIN="$(command -v uv)"
fi
if [ ! -x "$UV_BIN" ]; then
  say "Chưa có uv — tải về ~/.local/bin (script chính thức astral.sh, không sudo)…"
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
[ -x "$UV_BIN" ] || fail "Không tìm thấy uv sau khi cài ($UV_BIN)"

say "2/4 Tạo venv Python 3.11 tại $INSTALL_DIR…"
if [ -x "$VENV_PY" ]; then
  say "Venv đã có — giữ nguyên (cài lại từ đầu: rm -rf $INSTALL_DIR rồi chạy lại)"
else
  # uv tự tải Python 3.11 build nếu máy chưa có.
  "$UV_BIN" venv --python 3.11 "$INSTALL_DIR"
fi
[ -x "$VENV_PY" ] || fail "Tạo venv thất bại"

say "3/4 Cài torch CPU + pyannote (tải ~1 lần, vài trăm MB)…"
# Chỉ tải khi venv chưa có — lần chạy sau là no-op nhanh.
if "$VENV_PY" -c "import torch, torchaudio" 2>/dev/null; then
  say "torch/torchaudio đã có trong venv — bỏ qua"
else
  # Wheel CPU (không CUDA): nhỏ hơn nhiều và đủ dùng vì pyannote chạy CPU.
  # QUAN TRỌNG: torchaudio phải cùng index CPU với torch — nếu để pyannote tự kéo
  # torchaudio từ PyPI sẽ nhận bản build CUDA (cần libcudart) incompatible với
  # torch CPU → 'import pyannote.audio' lỗi OSError libcudart.so.
  "$UV_BIN" pip install --python "$VENV_PY" "$TORCH_PIN" "$TORCHAUDIO_PIN" --index-url "$TORCH_CPU_INDEX"
fi
"$UV_BIN" pip install --python "$VENV_PY" "$PYANNOTE_PIN" "$HUGGINGFACE_HUB_PIN"

say "4/4 Kiểm tra import trong venv…"
if ! "$VENV_PY" -c "import pyannote.audio" 2>/dev/null; then
  # pyannote 3.x chuẩn không cần onnxruntime; chỉ thêm nếu import vẫn lỗi.
  warn "import pyannote.audio thất bại — thử thêm onnxruntime…"
  "$UV_BIN" pip install --python "$VENV_PY" onnxruntime
fi
"$VENV_PY" -c "import pyannote.audio, torch; print('OK pyannote.audio', pyannote.audio.__version__, '| torch', torch.__version__)"

# Nếu env có HF_TOKEN thì lưu sẵn vào token file (chmod 600).
# (umask để trong subshell — umask 177 để dính ra ngoài sẽ làm import torch lỗi
# vì tempfile tạo thư viện tạm không ghi được)
if [ -n "${HF_TOKEN:-}" ] && [ ! -s "$TOKEN_FILE" ]; then
  ( umask 177; printf '%s\n' "$HF_TOKEN" > "$TOKEN_FILE" )
  chmod 600 "$TOKEN_FILE"
  say "Đã lưu HF_TOKEN (từ env) vào $TOKEN_FILE"
fi

cat <<EOF

HF token (bắt buộc — model pyannote là gated):
  1. Đồng ý điều khoản tại:
       https://huggingface.co/pyannote/speaker-diarization-3.1
       https://huggingface.co/pyannote/segmentation-3.0
  2. Tạo token (quyền read) tại: https://huggingface.co/settings/tokens
  3. Lưu token (một token/dòng) rồi chmod 600:
       printf 'TOKEN_CUA_BAN' > $TOKEN_FILE
       chmod 600 $TOKEN_FILE
  (lần chạy đầu sidecar sẽ tải model ~600MB vào ~/.cache/huggingface)
EOF

do_check || true   # cài xong thường chỉ thiếu token (exit 3) — không coi là lỗi cài
say "Hoàn tất cài đặt."
