# Speaker Attribution — Implementation Plan (trình duyệt, chưa code)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (hoặc executing-plans) khi triển khai. Steps dùng checkbox.

**Goal:** Transcript có nhãn người nói — mức A ("Bạn"/"Cuộc họp") rồi mức B (từng cá nhân bằng pyannote cục bộ).

**Architecture:** Ghép theo metadata hai nguồn thu có sẵn (A); sidecar Python pyannote do uv quản lý + attribution thuần Node (B). Chi tiết: `docs/superpowers/specs/2026-09-14-speaker-attribution-design.md`.

**Tech Stack:** TypeScript (packages hiện có), ffmpeg, Python 3.11 (uv) + pyannote.audio 3.1, vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-speaker-attribution-design.md`

## Global Constraints

- Darwin/macOS hành vi **byte-identical**; mọi nhánh mới bọc điều kiện linux/optional.
- Wire tương thích ngược: `speakerLabel` optional; dữ liệu cũ không nhãn vẫn hiển thị như cũ.
- Transcription BYOK không đổi chính sách (không tự upload; consent như hiện có).
- Không sửa `vendor/paseo/**`, `native/**`.
- Test chuẩn vitest; every task kết thúc commit `speaker: ...`; không push giữa chừng.

---

### Task A1: Hợp đồng wire + schema (speakerLabel optional)

Files: `packages/meeting-contracts/src/index.ts`, test `packages/meeting-contracts/test/speaker-label.test.ts` (mới).
Bước: (1) test RED — parse segment KHÔNG có speakerLabel vẫn ok, CÓ thì validate string ≤80 chars, strip; (2) thêm optional field vào zod schema + type; (3) GREEN; (4) chạy toàn bộ test contracts (pass — tương thích ngược); (5) commit.

### Task A2: Xây timeline từng nguồn (source-timeline)

Files: mới `packages/meetless-plugin/src/source-timeline.ts` + test.
Giao diện: `buildSourceTimelines(sessionDir, recordingId): Promise<{ microphone: {wavPath, chunkOffsets[]}, system: {...} }>` — nối chunks mỗi nguồn thành WAV đầy đủ bằng ffmpeg concat (list file), trả map offset (chunkStartMs → timelineMs) suy từ logicalStartMs các chunk. Test: fixture chunks 2 nguồn (sinh WAV 16k mono thật trong tmpdir), assert file ra đúng độ dài + offsets đúng.
TDD đầy đủ; commit.

### Task A3: Transcription 2 nguồn + trộn có nhãn

Files: `packages/meetless-plugin/src/transcription-service.ts` (route), test mới `transcription-source-labels.test.ts`.
Logic: khi transcription bắt đầu và recordings có đủ 2 timeline nguồn → gọi BYOK cho từng nguồn (cùng provider, chia ranges như hiện có trên từng WAV) → trộn segments 2 kết quả theo startMs → segment nhận `sourceLabel` nội bộ; lưu `speakerLabel: "Bạn" | "Cuộc họp"` khi persist transcript. Fixture provider (đã có DeterministicFixtureTranscriptionProvider) dùng cho test trộn: đoạn xen kẽ, cùng mốc, rìa chồng — assert thứ tự + nhãn đúng. Nếu 1 nguồn rỗng (không có chunk) → fallback y hệt hành vi cũ (transcribe mixed) — test riêng.
Commit.

### Task A4: UI hiển thị nhãn

Files: `packages/meeting-surface/src/index.tsx` (chip nhãn trước text đoạn), test surface (đã có harness — thêm case: segment có/không speakerLabel).
Chip: `[Bạn]` accent, `[Cuộc họp]` trung tính; không có nhãn → không render gì.
Commit. → **Hết giai đoạn A — chạy `npm run proof:linux` + smoke ghi thật 1 họp ngắn 2 phía, kiểm transcript có nhãn.**

---

### Task B1: Installer diarization (uv + venv + pyannote)

Files: mới `scripts/linux/install-diarization.sh` + `scripts/linux/pyannote/diarize.py` (chưa chạy trong task này — chỉ cài) + npm script `diarization:install`.
Script: cài uv (curl official, không sudo) → `uv venv --python 3.11 ~/.local/share/meetless/tools/pyannote` → `uv pip install pyannote.audio==<pin> onnxruntime torch --index...` (pin versions ghi trong script) → in hướng dẫn HF token (2 model gated + nơi lưu `hf-token`, chmod 600) → `--check` mode: exit 0 nếu venv + token sẵn.
Verify: chạy script trên máy (cài thật), `--check` pass. Commit.

### Task B2: Sidecar diarize.py

Files: `scripts/linux/pyannote/diarize.py`.
CLI: `diarize.py --audio <wav> --out <json> [--hf-token-file <path>]` — load token từ file env `HF_TOKEN`; chạy pipeline 3.1; ghi `[{speaker:"S1", startMs, endMs}]`; xử lý khối 15' + progress JSON line ra stderr; exit code rõ (0 ok, 2 thiếu token, 3 lỗi model).
Kiểm chứng tay trên máy bằng 1 file WAV thật ≥1 phút 2 giọng (tự ghi/tự tạo) — kết quả turns.json hợp lệ. Commit.

### Task B3: DiarizerProvider Node + attribution thuần

Files: mới `packages/meetless-plugin/src/diarization/{diarizer,pyannote-provider,attribution}.ts` + tests.
- `attribution.ts` (pure): `attributeSegments(segments, turns, sourceFilter)` — overlap ≥50%, tie-break người phủ nhiều; trả segments + speakerId.
- `pyannote-provider.ts`: spawn python venv, timeout 30 phút, hủy (SIGTERM→KILL), parse turns.json.
- Test: attribution unit (đoạn đơn, chồng, rìa, không khớp); provider test với fake script python in JSON (không cần model).
Commit.

### Task B4: Nút "Nhận diện người nói" + đổi tên speakers

Files: `packages/meetless-plugin/src/diarization/meeting-diarization.ts` (RPC meeting.diarization.run), `server.ts` (đăng ký method), `packages/meeting-surface/src/index.tsx` (nút trong meeting detail + dialog đổi tên), contracts (`meeting.diarization.*`).
Luồng: nút hiện khi transcript ready + (A đã cho source labels); chạy provider trên timeline system; attribution; speakers `Người 1…`; UI đổi tên → lưu `meeting.speakerNames`; đè transcript metadata (giữ bản gốc để hoàn tác).
Tests: RPC happy-path với provider fake; UI có nút/trạng thái (chưa cài → nhãn "chưa cài diarization" + link hướng dẫn). Commit.

### Task B5: Proof + tài liệu

Files: mới `scripts/prove-diarization.mjs` (fixture turns.json + attribution thật qua RPC, không cần model), `npm run proof:diarization`; update `HUONG-DAN-SU-DUNG.md` (mục mới "Nhận diện người nói": cài `npm run diarization:install`, dùng nút, đổi tên, CPU/GPU khuyến nghị); followups ghi trạng thái.
Commit. Smoke thật (tùy chọn, cần user): họp thật ≥2 người nói → chạy diarization → kiểm nhãn.

---

## Ước lượng

- Giai đoạn A: ~1 ngày làm việc (4 task nhỏ).
- Giai đoạn B: ~2-3 ngày (installer + sidecar + UI), phần chờ lâu nhất là tải model (~600MB, 1 lần).

## Điểm dừng chờ duyệt (theo yêu cầu chủ sở hữu)

KHÔNG bắt đầu Task nào trước khi được duyệt. Sau duyệt, chạy theo A→B, giữa A và B cho phép dừng để dùng thử A.
