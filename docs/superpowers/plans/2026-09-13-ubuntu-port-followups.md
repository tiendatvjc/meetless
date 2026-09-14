# Ubuntu Port — Follow-ups & Rulings Record

Branch `linux-port` (fork tiendatvjc/meetless), completed 2026-09-13. Spec: ../specs/2026-09-13-ubuntu-port-design.md. Plan: 2026-09-13-ubuntu-port.md.

## Controller rulings (những quyết định agent đã thay chủ sở hữu)

1. Submodule paseo pin `ee3420e` (base được docs tuyên bố) thay gitlink `a2c8ff34` (bị force-push mất, không fetch được). Pin cập nhật trong PINNED_PASEO_COMMIT + paseo-dependency.mjs.
2. Plan Task 1 lỗi nhất quán nội (regex test vs message) → chuẩn hóa "unsupported platform: ...".
3. parseProcCmdline giữ argv rỗng giữa chừng (khớp hợp đồng darwin), bỏ NUL cuối.
4. Task 5 storage-contract adapter: helper linux tự rename chunk theo validator (chunk--<source>--<seq>--<startFrame>--<frames>--16000--1.wav) + viết lại id/logicalStartMs/durationMs bằng công thức của validator.
5. host.test.ts "production CLI fails closed..." là hợp đồng darwin → darwin-conditional; linux counterpart trong linux-desktop-attestation.test.ts.
6. Linux dev-mode bypass attestation (host.ts + production-host.ts): chỉ linux + unpackaged + defaultDependencies; sở hữu qua /proc ppid; darwin byte-identical.
7. Capture helper linux = wrapper executable materialize trong runtime root (readiness pin helperPath + cấm args production → execPath+[entry] không thể pass).
8. Installer --install chạy repo checkout (dev-mode-from-repo) thay dist staged (thiếu node_modules); staging chỉ là dry-run preview.
9. Deb/AppImage maintainer = fork identity (tiendatvjc, repo URL).
10. Metadata repackage folded vào fix packaging; client.test.ts 1F = pre-existing ở base.

## Follow-ups (đều fail-closed, không chặn dùng dev-mode)

- Live-recording helper inspection: /proc argv identity sẽ fail khi helperPid≠null (readiness.ts:705-739) — cần nhánh node-argv cho linux.
- Same-uid /proc check best-effort khi status không đọc được (production-host.ts:479-481).
- Packaged (AppImage) depth: plugin nằm trong asar → path-spawn sẽ fail; cần asarUnpack packages/meetless-plugin hoặc bundle; native node-pty/sherpa chưa stage; AppImage cần MEETLESS_RUNTIME_ROOT/PASEO_ELECTRON_USER_DATA_DIR từ ngoài (chưa có host env contract).
- paseo web app export chưa build được trên máy này (renderer content của cửa sổ desktop còn lỗi paseo://app/).
- systemd unit template: render-anchor text cũ (guard an toàn, cần dọn chữ).
- Append threshold 960KB chưa được e2e exercised; dettached-loop catch; writer commit-failure requeue; minor items khác — xem ledger trong .superpowers (đã xóa sau khi commit file này).

## Bằng chứng chính (đã verify)

- Proof `npm run proof:linux`: record→finalize(ffmpeg thật, ffprobe)→transcribe(BYOK)→MCP(HTTP thật)→daemon(listen + waitForRecordingRuntime + plugin running)→desktop — tất cả stage ok.
- systemd service ACTIVE + listened live qua host:linux:apply.
- AppImage 117MB/deb 92MB: extract + dpkg-deb + launch không crash import, window tạo được.
- Regression: runtime/plugin suites không có file fail mới so baseline môi trường; tsc sạch.

## Sửa sai sót sau bàn giao (2026-09-13)

- Tên gói apt trong hướng dẫn bị sai: không tồn tại `pipewire-audio-utils` trên Ubuntu. `parec`/`pactl` nằm trong `pulseaudio-utils`; cần thêm `pipewire-pulse` (lớp Pulse-over-PipeWire) nếu máy chưa có. Đã sửa build-native.mjs, install-linux-host.mjs, linux-development.md, platforms.md.

## Vấn đề phát hiện khi dùng thật (2026-09-13 tối)

- Runtime daemon **ghi đè `paseo-home/config.json` mỗi lần khởi động** theo template riêng: bỏ `daemon.auth.password` và các origin CORS thêm tay (chỉ giữ origin renderer `127.0.0.1:8082`). Hệ quả: đặt mật khẩu/localhost-origin qua config file không bền. Cần sửa code (đưa auth + extra origins vào template của runtime, hoặc qua env) trước khi quảng cáo các tính năng đó.
- `runtime:desktop` (khi thất bại lẫn khi chạy) cũng ghi config này — đã ghi ở mục trên.
- Companion phải mở bằng `http://127.0.0.1:8082` (localhost bị daemon từ chối origin cho tới khi follow-up trên land).

- Web companion không có nút ghi: `canRecord={mode === "desktop"}` (App.tsx) — product boundary macOS. Đã đổi cho fork: companion cũng được ghi (linux-port: browser = primary surface; recording vẫn chạy daemon-side). Divergence so với docs/product/platforms.md "companions do not record" đã ghi ở đây.

- Recording-setup bị khóa trên linux desktop: (1) endpoint /__meetless/capture-permissions chỉ tồn tại ở packaged renderer — dev spawn Expo nên UI lỗi quyền; (2) boundary đi vào socket transcription native (macOS) không tồn tại trên linux. Fix: MEETLESS_DEV_STATIC_RENDERER=1 serve expo export qua startPackagedRenderer (thêm rendererRootOverride), linux trả granted ở cả status/request trước khi chạm socket. Electron binary trong node_modules từng hỏng (dist rỗng) — phục hồi bằng unzip từ cache ~/.cache/electron + path.txt.

- Boundary quyền linux ban đầu trả "granted" — hợp đồng UI yêu cầu "authorized" (CapturePermissionStatus enum); nút sáng nhưng start() từ chối âm thầm. Đã đổi sang "authorized" (status + request) — root cause cuối của "bấm không chạy".

- ROOT CAUSE "bấm Start không chạy": supportsDesktopRecording() ép bridge platform === "darwin" (runtime.ts:27) — RecordingProvider enabled=false trên linux, client ghi không bao giờ được tạo, start() ném "not connected" và bị submit() nuốt im lặng. Fix: chấp nhận cả "linux". (Boundary "authorized" ở commit trước là điều kiện cần nhưng chưa đủ.)

- Màn hình trắng sau khi bật provider: DesktopRecordingClient constructor ép bridge.platform === "darwin" (meetless-client index.ts:82) → MeetlessFeatureUnavailableError unmount app. Fix: chấp nhận "linux". Chuỗi 3 cổng darwin-gate đã mở đủ: runtime.ts (provider) → client constructor → boundary authorized.

- ROOT CAUSE "nút sáng nhưng bấm không chạy" (xác nhận bằng Playwright + fiber probe): RN-web Pressable mount khi disabled=true (title rỗng) không tái kích hoạt press handler khi disabled chuyển false — nút hiện thị enabled nhưng responder chết. Fix: key-remount trên nút Start khi trạng thái disabled đổi. Lưu ý: các nút có pattern tương tự (Pair securely ở màn pairing — lỗi đầu tiên user gặp!) cùng gia đình bug; metro bundle meeting-surface từ dist → phải rebuild workspace package trước build:app.

- Hai fix cuối cùng cho bản ghi đầu tiên thành công (00:19 14-09): (1) CaptureHelper truyền XDG_RUNTIME_DIR cho parec/pactl trên linux (thiếu = "Connection refused" khi lấy thiết bị thu); (2) assertCapturePermissionsReady bỏ qua socket native trên linux (PipeWire không có TCC). Bằng chứng: MP3 18s hợp lệ trong ~/Documents/meetings.

- Sáng 14-09: (1) chunk-overlap bug — startFrame từ logicalStartMs bị lệch làm tròn gây chồng lấn ~80 frames giữa chunks liền kề → inventory "blocked" → Stop không finalize MP3. Fix: con trỏ frame tích lũy (chunk N bắt đầu đúng chỗ chunk N-1 kết thúc) + regression test multi-chunk + knob MEETLESS_CHUNK_PAYLOAD_BYTES cho test. Bản ghi 8 phút f695c4b1 đã cứu: rename 34 chunks theo chuỗi liên tục + patch store (inventory→pending). (2) Chỉ báo Host online: hostDot xám duy nhất → chấm xanh (colors.success) khi online, hổ phách khi offline, viền chip đậm hơn.
