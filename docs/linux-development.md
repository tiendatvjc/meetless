# Phát triển Meetless trên Linux

Hướng dẫn ngắn cho nhánh `linux-port` trên Ubuntu. Thiết kế đầy đủ xem tại
[spec ubuntu-port](superpowers/specs/2026-09-13-ubuntu-port-design.md).

## Prerequisites

- Ubuntu 24.04+ (kiểm tra trên bản mới hơn thì cập nhật phần "Verified on" bên dưới).
- Node 20+.
- Công cụ capture/audio:

```bash
sudo apt install ffmpeg pipewire-audio-utils
```

(`parec` và `pactl` nằm trong gói `pipewire-audio-utils`.)

`npm run build:native` trên Linux chỉ kiểm tra `ffmpeg`/`parec`/`pactl` có trong PATH
(không build Swift). Thiếu công cụ nào thì nó in lệnh apt tương ứng và exit 1.

## Build

```bash
npm run build:paseo && npm run build:meetless
```

Chỉ chạy `build:paseo:types` là không đủ: daemon probe cần dist của
`@getpaseo/server` (`supervisor-entrypoint`) cùng highlight/cli/desktop
build, tức toàn bộ `build:paseo`.

## Cài daemon như systemd user service

Runtime root trên Linux: `~/.local/share/meetless` (macOS dùng thư mục app support).

- **Dry-run (mặc định, không ghi gì ra ngoài repo):** in kế hoạch stage, unit file
  sẽ ghi và các lệnh systemctl sẽ chạy.

```bash
npm run host:linux:install
```

- **Cài thật:** build TS, sao chép `packages/runtime/dist` cùng
  `capture-helper-entry.js` vào `~/.local/share/meetless/runtime/`, ghi
  `~/.config/systemd/user/meetless-daemon.service` rồi enable service.

```bash
npm run host:linux:apply
```

- **Gỡ service:** dừng, disable và xóa unit file (giữ nguyên dữ liệu dưới
  `~/.local/share/meetless`).

```bash
npm run host:linux:uninstall
```

- **Trạng thái:**

```bash
npm run runtime:linux:status
```

Capture helper được stage tại `~/.local/share/meetless/runtime/capture-helper-entry.js`;
việc wiring `captureHelperPath` vào config là task sau.

## BYOK OpenAI key (transcription)

Linux không có transcription managed. Tạo tay file key (chưa có writer):

```bash
mkdir -p ~/.local/share/meetless
cat > ~/.local/share/meetless/byok-openai.json <<'EOF'
{"version":1,"apiKey":"sk-..."}
EOF
chmod 600 ~/.local/share/meetless/byok-openai.json
```

## Web companion

```bash
npm run runtime:web
```

Mở http://localhost:8082 (daemon chạy tại 127.0.0.1:8081).

## Verified on

- 2026-09-13, Ubuntu 26.04.1, Node v24.16.0: `npm run proof:linux` (sau khi đổi
  sang `build:paseo` đầy đủ) — daemon probe stage 0 nghe TCP tại
  `127.0.0.1:18081` trong 4.1s (module error supervisor-entrypoint đã hết);
  cả 5 stage `ok:true`, exit 0. Manifest:
  `.artifacts/linux-proof/manifest-20260913T121515.json`.
- 2026-09-13, desktop dev smoke (có display, `MEETLESS_RUNTIME_ROOT=/tmp/... timeout 25
  npm run runtime:desktop`): fail-closed ngay tại host attestation trước khi spawn
  electron — "Production Meetless host attestation failed closed: cannot attest the
  installed host: ENOENT ... realpath '/Applications/Meetless.app'", exit 1 sau ~2s.
  Hợp đồng spawn dev đã được khoá bởi `packages/runtime/test/linux-desktop-spawn.test.ts`;
  nhánh dev host-attestation cho linux là việc của task sau.

## Khác biệt so với macOS

- Không RevenueCat, không attestation, không App Store/MAS gate — Premium managed
  là no-op trên Linux; transcription dùng BYOK OpenAI key như trên.
- Daemon chạy như systemd user service thay vì qua MeetlessHost/LaunchServices.
- Chi tiết quyết định A1–A4 xem
  [spec ubuntu-port](superpowers/specs/2026-09-13-ubuntu-port-design.md).
