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

Service chạy **dev-mode-from-repo**: `ExecStart` trỏ thẳng vào
`packages/runtime/dist/cli.js` của repo checkout (render đường dẫn tuyệt đối
khi install) với node của người cài; `MEETLESS_RUNTIME_ROOT` vẫn giữ
`~/.local/share/meetless`. Lý do (ruling R1): dist/config.js import
node_modules (zod/ws/…) chỉ resolve từ cây repo, và các đường dẫn
REPOSITORY_ROOT-relative (plugin, capture helper entry, vendored paseo) chỉ đúng
từ checkout. Bundling thật nằm ở pipeline đóng gói (`npm run package:linux`);
`--install` không sao chép gì ra ngoài repo (staging dưới `.artifacts` chỉ là
preview dry-run).

- **Dry-run (mặc định, không ghi gì ra ngoài repo):** in kế hoạch, unit file
  sẽ ghi và các lệnh systemctl sẽ chạy.

```bash
npm run host:linux:install
```

- **Cài thật:** build TS, ghi `~/.config/systemd/user/meetless-daemon.service`
  (ExecStart = repo checkout) rồi enable service.

```bash
npm run host:linux:apply
```

- **Gỡ service:** dừng, disable và xóa unit file (giữ nguyên dữ liệu dưới
  `~/.local/share/meetless` và repo checkout).

```bash
npm run host:linux:uninstall
```

- **Trạng thái:**

```bash
npm run runtime:linux:status
```

Capture helper: khi daemon start, runtime tự sinh wrapper chạy được tại
`~/.local/share/meetless/capture-helper` (`exec node
<repo>/packages/meetless-plugin/dist/src/linux/capture-helper-entry.js`,
`--fixture` truyền qua nguyên vẹn) — xem `captureHelperCommand` trong
`packages/runtime/src/config.ts`. Không cần wiring thủ công.

## BYOK OpenAI key (transcription)

Linux không có transcription managed: BYOK key là điều kiện để recording
production start được miễn socket native (managed route vẫn yêu cầu socket đó
nhưng không tồn tại trên Linux). Tạo tay file key (chưa có writer):

```bash
mkdir -p ~/.local/share/meetless
cat > ~/.local/share/meetless/byok-openai.json <<'EOF'
{"version":1,"apiKey":"sk-..."}
EOF
chmod 600 ~/.local/share/meetless/byok-openai.json
```

File key được đọc từ runtime root của daemon (`MEETLESS_RUNTIME_ROOT`,
mặc định `~/.local/share/meetless`) — chạy root khác thì đặt key vào
`<runtime-root>/byok-openai.json`.

## Web companion

```bash
npm run runtime:web
```

Mở http://localhost:8082 (daemon chạy tại 127.0.0.1:8081).

## Kiểm chứng Microsoft Teams

Capture là ở tầng OS (PipeWire mic + sink-monitor) nên Teams không cần tích hợp
riêng cho từng app — kịch bản kiểm chứng giống Zoom/Meet.

Trạng thái: (chưa thực hiện trên máy này — cần pipewire-audio-utils). Sau khi
chạy thử, ghi kết quả + ngày vào mục "Verified on" bên dưới; trước đó không
khai báo đã kiểm chứng.

Các bước smoke:

1. Mở Teams (web hoặc desktop app) và tham gia cuộc gọi thử (Call bot / test
   call trong Teams).
2. Start recording qua web companion (http://localhost:8082).
3. Nói vào micro và phát audio từ phía người tham gia xa trong lúc ghi.
4. Stop recording rồi kiểm tra `~/Documents/meetings/*.mp3`: phải nghe được cả
   hai phía (mic local + remote system audio).
5. Ghi kết quả + ngày vào mục "Verified on" (kèm lỗi/manifest nếu fail).

## Verified on

- 2026-09-13, final fix wave: `npm run host:linux:apply` (sau fix Issue 3) —
  service `meetless-daemon.service` active, ExecStart chạy
  `packages/runtime/dist/cli.js daemon` của repo, Paseo Supervisor + Daemon
  sống, nghe TCP 127.0.0.1:8081, runtime root `~/.local/share/meetless` có
  wrapper `capture-helper` (0755) do runtime sinh. `npm run proof:linux` (sau
  fix Issues 1/2/5): daemon stage khẳng định plugin health qua
  `waitForRecordingRuntime` (pluginId meetless/running, captureMode
  production, sessionStatus idle); cả 6 stage `ok:true`, exit 0; stage desktop
  lần đầu đạt renderer HTTP 200 (`http://127.0.0.1:18086`, 3.6s) — electron
  binarydev fail "Electron failed to install correctly" là lỗi môi trường
  node_modules/electron sau khi renderer đã trả 200. Manifest:
  `.artifacts/linux-proof/manifest-20260913T134752.json`.

- 2026-09-13, Ubuntu 26.04.1, Node v24.16.0: `npm run proof:linux` (sau khi đổi
  sang `build:paseo` đầy đủ) — daemon probe stage 0 nghe TCP tại
  `127.0.0.1:18081` trong 4.1s (module error supervisor-entrypoint đã hết);
  cả 5 stage `ok:true`, exit 0. Manifest:
  `.artifacts/linux-proof/manifest-20260913T121515.json`.
- 2026-09-13, desktop dev smoke (có display, `MEETLESS_RUNTIME_ROOT=/tmp/... timeout 25
  npm run runtime:desktop`): fail-closed ngay tại host attestation trước khi spawn
  electron — "Production Meetless host attestation failed closed: cannot attest the
  installed host: ENOENT ... realpath '/Applications/Meetless.app'", exit 1 sau ~2s.
  (Đã sửa ở desktop side bởi commit `b89aefa` — linux dev-mode bypass cho
  `assertDesktopLaunchedByHost`; xem bullet proof desktop mới hơn bên dưới.)
- 2026-09-13, packaging (Task 11): `npm run package:linux` tạo ra
  `release/linux/meetless-0.1.0-x86_64.AppImage` (117.1 MiB, sha256
  f6166ba06356e6e50eb360cd92b0ec5dc21997fd97df7def413e6cf9de8d267c) và
  `release/linux/meetless_0.1.0_amd64.deb` (91.8 MiB, sha256
  536cf91542c5d7fd6da896d35490341c3f6088cc61c997e6126261fc5e24163c); extract +
  metadata đã kiểm. Lưu ý: hai artifact này còn mang maintainer/homepage
  placeholder cũ `Meetless <dev@meetless.app>` / `https://meetless.app` —
  bản sửa fork identity (`tiendatvjc <tiendatvjc@users.noreply.github.com>` /
  `https://github.com/tiendatvjc/meetless`) nằm ở source
  (`scripts/package-linux.mjs`, `scripts/linux/electron-builder.meetless.yml`),
  cần chạy lại `package:linux` để artifact mới nhận metadata mới.
- 2026-09-13, proof đầy đủ 6 stage (Task 12, có display `:0`): `npm run proof:linux`
  — exit 0, gate `record/finalize/transcribe` đều `ok:true`; stage desktop
  (evidence-only) `ok:true` theo tiêu chí liveness: process sống 30.1s đến khi
  `timeout 30` TERM (exit 124), daemon con nghe tại `127.0.0.1:18085` và các port
  đóng sạch sau exit. Renderer origin `http://127.0.0.1:18086` KHÔNG trả HTTP 200:
  desktop dev chặn tại `waitForRecordingRuntime` vì plugin trong daemon từ chối
  recording start ("no complete MeetlessHost attestation" —
  `packages/meetless-plugin/src/production-host.ts:79` cần env
  `MEETLESS_HOST_PID/BUNDLE_PATH/IDENTITY_PATH` mà trên macOS do
  `npm run runtime:host` cung cấp; nhánh linux tương đương là task sau). Expo
  renderer và electron do đó chưa được spawn trong proof. Manifest:
  `.artifacts/linux-proof/manifest-20260913T125851.json`.

## Khác biệt so với macOS

- Không RevenueCat, không attestation, không App Store/MAS gate — Premium managed
  là no-op trên Linux; transcription dùng BYOK OpenAI key như trên.
- Daemon chạy như systemd user service thay vì qua MeetlessHost/LaunchServices.
- Chi tiết quyết định A1–A4 xem
  [spec ubuntu-port](superpowers/specs/2026-09-13-ubuntu-port-design.md).
