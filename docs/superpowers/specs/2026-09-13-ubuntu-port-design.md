# Meetless Ubuntu Port — Design Spec

- Ngày: 2026-09-13
- Nhánh: `linux-port` trên fork `tiendatvjc/meetless` (base `5bafe57`, submodule pin `ee3420e`)
- Trạng thái: chờ chủ sở hữu duyệt (các quyết định phạm vi được phán đoán do chủ sở hữu chưa trả lời câu hỏi brainstorming — xem "Giả định chờ duyệt")

## 1. Mục tiêu

Chạy được vòng lặp sản phẩm V1 đầy đủ của Meetless trên Ubuntu 24.04+:

```
ghi âm cuộc họp (micro + system audio qua PipeWire)
  — nền tảng họp: Zoom, Google Meet, Microsoft Teams, và bất kỳ app nào
    phát audio qua sink mặc định (capture ở tầng OS, không tích hợp API từng app)
  → chunk WAV kháng crash
  → ffmpeg finalize MP3 + WAV vào ~/Documents/meetings
  → transcript BYOK (OpenAI gpt-transcribe, key của người dùng)
  → web companion (Expo web) duyệt/đọc/chat/nghe qua LAN pairing
  → coding agent hỏi-đáp qua MCP transcript tools với trích dẫn segmentId
```

## 2. Giả định chờ duyệt (quyết định phạm vi do agent đề xuất)

| # | Quyết định | Lý do | Đổi được không |
|---|---|---|---|
| A1 | Phạm vi **đầy đủ có app desktop** (chủ sở hữu chọn 2026-09-13): tasks nền tảng 1-9 (headless + web) + tasks 10-12 desktop Electron shell và đóng gói AppImage/deb | Chủ sở hữu trả lời câu hỏi phạm vi: "Đầy đủ có app desktop". Nhánh dev của `desktop.ts` vốn đã đa nền tảng (`electron/cli.js` + `scripts/electron-bootstrap.mjs`); nhánh MAS-Chromium chỉ áp dụng packaged macOS | Đã chốt |
| A2 | Transcription: **BYOK trước** (key OpenAI của người dùng, gọi trực tiếp; chủ sở hữu xác nhận 2026-09-13); managed Convex giữ nguyên code nhưng không bật trên Linux | `docs/product/monetization.md` đã định nghĩa BYOK là route miễn phí có quyền ưu tiên; RevenueCat không có SDK Linux nên premium gate không hoạt động | Đã chốt |
| A3 | Premium/RevenueCat trên Linux = **no-op "inactive"**; managed route từ chối với thông báo rõ; BYOK không bị gate | Không phá chính sách sản phẩm, không xóa code macOS | Có |
| A4 | Submodule paseo pin `ee3420e` (tag `meetless-v1-base-2026-08-16`) thay vì gitlink `a2c8ff34` | `a2c8ff34` đã bị force-push mất, không fetch được từ bất kỳ nhánh nào của `hoangnb24/paseo`; `ee3420e` là base được `docs/paseo-p0-inventory.md` tuyên bố | Thỏa thuận lại với upstream nếu commit cũ quay lại |
| A5 | Cả hai repo fork về `tiendatvjc` (đã tạo) | Làm fork tự chủ, submodule trỏ về paseo fork của mình | Có |
| A6 | **Microsoft Teams là nền tảng được kiểm chứng chính thức** (chủ sở hữu yêu cầu 2026-09-13). Capture tầng OS nên Teams (desktop PWA/web) không cần tích hợp riêng; công việc = cập nhật product docs (recording.md, overview.md, platforms.md) nêu Zoom/Meet/Teams + kịch bản smoke Teams trong bằng chứng | Replay cùng cơ chế sink-monitor; không có code phân biệt app họp | Đã chốt |

## 3. Dữ kiện đã kiểm chứng trong code (neo cho kế hoạch)

1. **Finalizer đã dùng `ffmpeg`** (`packages/meetless-plugin/src/finalizer.ts:149-170`): `amix=inputs=2` → `libmp3lame` MP3 16kHz mono + `pcm_s16le` WAV. Không phụ thuộc API Apple → Linux chỉ cần binary `ffmpeg`.
2. **Hợp đồng capture helper** (`packages/meetless-plugin/src/capture-helper.ts`): helper là process con, nhận command JSON-lines trên stdin (`start|pause|resume|stop`), phát event JSON-lines strict-zod trên stdout (`started|chunkCommitted|paused|resumed|stopped|interrupted|captureFailed|error`). Chunk = file WAV 16kHz mono trong sessionDirectory, có `sha256/byteLength/logicalStartMs/durationMs`, source `microphone`|`system` tách bạch. Có chế độ `--fixture` (biến `MEETLESS_CAPTURE_MODE=fixture`).
3. **Provider abstraction đã tồn tại** (`packages/meetless-plugin/src/transcription-provider.ts`): interface `TranscriptionProvider { status(); transcribe() }` + hằng số `OPENAI_TRANSCRIPTION_ENDPOINT/MODEL/LANGUAGES` (gpt-transcribe, en/vi) + `DeterministicFixtureTranscriptionProvider`. Route hiện chỉ `"managed"` (`transcription-route.ts`).
4. **`config.ts` hardcode đường dẫn macOS**: `Library/Application Support/Meetless` (runtimeRoot), `Documents/meetings`, container MAS; zod bắt buộc absolute path.
5. **`readiness.ts:916`** ném lỗi khi `process.platform !== "darwin"` khi inspect argv (dùng helper `meetless-process-argv` build bằng swiftc) → Linux đọc `/proc/<pid>/cmdline`.
6. **Paseo daemon (vendor) thuần Node**: deps `node-pty`, `sherpa-onnx-node`, `ws`, `esbuild` — đều build/chạy trên Linux; các tham chiếu darwin chỉ nằm trong loader/test/config provider.
7. **Dev entry không cần MeetlessHost**: `assertPackagedDaemonOwnedByHost` chỉ áp dụng packaged runtime; dev daemon dùng `MEETLESS_RUNTIME_ROOT` + `MEETLESS_LISTEN`.

## 4. Kiến trúc đích trên Ubuntu

```
systemd user service meetless-daemon.service        (thay LaunchServices→MeetlessHost)
  └─ node packages/runtime/dist/cli.js daemon        (dev-mode, MEETLESS_RUNTIME_ROOT=~/.local/share/meetless)
      └─ Paseo daemon (vendor, Node)                 (WebSocket, LAN pairing / relay)
          └─ @meetless/plugin
              ├─ linux capture helper (Node, spawn 2× parec/pw-cat)   (thay meetless-capture Swift)
              ├─ ffmpeg (finalizer — dùng nguyên)
              ├─ MeetingStore (~/.local/share/meetless)              (nguồn chân lý duy nhất — giữ nguyên)
              ├─ BYOK OpenAI provider (mới)                          (thay managed-only route)
              └─ MCP transcript server (chat citations — dùng nguyên)
Web companion: npm run runtime:web (Expo web, port 8082) — không đổi
Coding agent: Codex/Claude Code qua Paseo — không đổi
Desktop (tasks 10-12): Electron (paseo desktop) chạy renderer Expo export
  từ isolated origin — đường dev đã đa nền tảng; đóng gói AppImage + deb
```

Nguyên tắc giữ nguyên từ ADR0003: **MeetingStore là nguồn chân lý duy nhất**; companion chỉ giữ pairing state; readiness = daemon + plugin + capture helper đồng thuận. Những gì bỏ qua trên Linux là **attestation codesign + TCC + MAS packaging**, không phải ranh giới dữ liệu.

## 5. Thiết kế chi tiết

### 5.1 Capture helper Linux (`packages/meetless-plugin/src/linux/capture-helper-linux.ts`)

- Một executable Node (`dist/linux/capture-helper-entry.js`), đọc command từ stdin, phát event ra stdout — implement đúng schema zod ở mục 3.2.
- Chế độ thật: spawn 2 process con `parec --format=s16le --rate=16000 --channels=1 --device=<source>`:
  - mic: source mặc định (`pactl get-default-source`)
  - system: monitor của sink mặc định (`$(pactl get-default-sink).monitor`)
  - Phụ thuộc: `pipewire`, `pipewire-pulse`, `pulseaudio-utils`, `ffmpeg` (Ubuntu desktop mặc định có pipewire; outros cài qua apt).
- Gộp raw PCM tích lũy thành chunk WAV ~30s (960.000 bytes payload), ghi file `<sessionDirectory>/<recordingId>-<source>-<seq>.wav` với header 44 bytes, sha256 toàn file, emit `chunkCommitted`.
- `pause`/`resume`: ngừng/đọc lại stream, `logicalStartMs` tính theo elapsed logic (không tính thời gian pause) — giống semantic macOS helper.
- `stop`: flush chunk cuối, emit `stopped`, exit 0. Crash con parec giữa chừng: emit `captureFailed` với error, giữ chunk đã commit (kháng crash theo đúng `docs/product/recording.md`).
- Chế độ `--fixture`: phát chunk WAV tĩnh định sẵn (đã có sẵn pattern `MEETLESS_CAPTURE_MODE=fixture`) — dùng cho test + proof + CI không cần thiết bị âm thanh.

### 5.2 Đường dẫn & cấu hình (`packages/runtime/src/config.ts`)

- `platform === "linux"`: `runtimeRoot = ~/.local/share/meetless`; recordings vẫn `~/Documents/meetings` (giữ contract sản phẩm); bỏ container MAS.
- Thêm `captureHelperCommand(platform)`: linux → `process.execPath` + entry script trong dist; darwin → giữ nguyên logic hiện tại.

### 5.3 Readiness (`packages/runtime/src/readiness.ts`)

- Nhánh linux: đọc argv từ `/proc/<pid>/cmdline` (split `\0`) thay `meetless-process-argv`; bỏ yêu cầu binary attestation (không codesign trên Linux), thay bằng kiểm tra `sha256` của entry script ghi tại install (tinh giản, tài liệu hóa trong decision mới).

### 5.4 Transcription BYOK (`packages/meetless-plugin/src/openai-byok-provider.ts`)

- `OpenAiByokTranscriptionProvider implements TranscriptionProvider`: đọc key từ `~/.local/share/meetless/byok-openai.json` (0600), POST multipart tới `OPENAI_TRANSCRIPTION_ENDPOINT` với model/languages hiện có.
- `transcription-route.ts`: mở rộng route `"managed" | "byok"`; thứ tự chọn theo `docs/product/monetization.md`: BYOK hợp lệ → BYOK (không đụng premium); không BYOK + premium → managed; không BYOK + không premium → giữ audio, thông báo.
- Premium Linux no-op: `premiumStatus` → inactive vĩnh viễn (không socket native).

### 5.5 Vận hành (`scripts/install-linux-host.mjs`, systemd)

- `npm run host:linux:install`: build TS, tạo `~/.config/systemd/user/meetless-daemon.service` (ExecStart=daemon, Environment=MEETLESS_RUNTIME_ROOT), `systemctl --user enable --now`, sức khỏe daemon qua `runtime:status`.
- `npm run build:native` trên linux: bỏ swift build, chỉ verify `ffmpeg` + `parec` + `pactl` có trong PATH (in hướng dẫn cài nếu thiếu).
- Proof: `scripts/prove-linux-port.mjs` theo văn hóa evidence của repo: fixture record → ffmpeg finalize → fixture/BYOK transcribe → MCP `tools/list` + citations → in manifest bằng chứng.

### 5.6 Testing

- Unit vitest cho: path resolution linux, /proc argv parser, chunk writer (WAV header + sha256 + logical clock pause/resume), BYOK provider (mock fetch), route precedence, premium no-op.
- Tích hợp: chạy `CaptureHelper` (class hiện có, không đổi) qua entry fixture của helper linux — chứng minh helper nói đúng giao thức.
- Smoke thủ công (ghi in tài liệu): `pw-play` fixture wav → record thật 2 nguồn → kiểm tra MP3+WAV trong `~/Documents/meetings`.

### 5.7 Desktop Electron shell trên Linux (tasks 10-12)

- **Dev**: `runtime:desktop` dùng nhánh sẵn có của `desktop.ts` — `buildElectronSpawnOptions` với command `process.execPath` + args `[electron/cli.js, scripts/electron-bootstrap.mjs]` khi không phải MAS packaged (đã kiểm chứng dòng 195-220: yêu cầu `MAC_CHROMIUM_TMPDIR` chỉ áp dụng nhánh `isMacAppStoreDesktop`). Việc cần làm: test unit cho nhánh linux của spawn options + smoke mở cửa sổ tải renderer origin.
- **Renderer**: giữ nguyên kiến trúc host-owned isolated renderer origin; renderer build bằng `npm run build:app` (`expo export --platform web`) — không đổi.
- **Đóng gói**: `scripts/package-linux.mjs` + cấu hình electron-builder target `AppImage` + `deb` (appId `com.meetless.app`, productName `Meetless`, icon từ `design/`), bỏ after-sign (không ký trên Linux), `packageResources.electronBinary` trỏ binary Electron đóng gói kèm `meetless runtime` + renderer dist. Không dùng electron-builder.yml của paseo (appId/thumbnail khác) — viết config riêng cho meetless.

## 6. Phạm vi loại trừ (kế hoạch này)

- Managed Convex self-host trên Linux (giữ code, không bật).
- App Store, notarization, RevenueCat purchase flow trên Linux.
- Speaker diarization, cross-meeting Q&A (đã ngoài V1 upstream).

## 7. Rủi ro & mở

- `parec` monitor sink có thể không tồn tại nếu người dùng không dùng pipewire-pulse → installer kiểm tra + hướng dẫn; fallback sau này có thể viết bằng libpipewire native.
- Paseo daemon trên Linux chưa được upstream chứng minh — nhưng deps Node Runner thuần; risk chấp nhận được, smoke proof sẽ xác nhận.
- Upstream repo đang diễn ra Shipaton 2026 — rebase định kỳ từ `hoangnb24/meetless` khi cần.
