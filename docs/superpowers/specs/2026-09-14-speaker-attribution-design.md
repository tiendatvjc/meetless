# Speaker Attribution — Design Spec (trình duyệt, chưa code)

- Ngày: 2026-09-14
- Repo: fork `tiendatvjc/meetless`, nhánh `main` (đã merge port)
- Trạng thái: **CHỜ CHỦ SỞ HỮU DUYỆT** — chưa viết bất kỳ code nào

## 1. Mục tiêu

Gắn nhãn **ai nói** cho từng đoạn transcript, theo hai mức:

- **Giai đoạn A — "Bạn" / "Cuộc họp" (2 phía):** tận dụng việc app thu 2 nguồn tách
  biệt (micro = bạn, system = mọi người). Không cần AI mới. Với họp 1-1 cho kết quả
  đúng gần như tuyệt đối.
- **Giai đoạn B — Diarization đầy đủ (A/B/C…):** phân biệt **từng cá nhân** phía
  cuộc họp bằng `pyannote.audio` chạy **cục bộ trên máy** (không gửi audio đi đâu).

## 2. Nguyên tắc giữ nguyên (từ upstream)

- Local-first: audio không rời máy (trừ Transcribe BYOK có sẵn); không cloud bắt buộc.
- Hành động chủ động: diarization là nút riêng ("Nhận diện người nói"), không tự chạy.
- MeetingStore vẫn là nguồn chân lý duy nhất; chỉ thêm metadata.
- Darwin/macOS: không đổi bất kỳ hành vi nào.

## 3. Thiết kế Giai đoạn A — nhãn 2 phía

### Dữ liệu

- Session chunks giữ file WAV riêng theo nguồn (`*-microphone.wav`, `*-system.wav`)
  tới khi bị dọn — đủ đầu vào.
- Bước mới "xây timeline từng nguồn": nối chunks mỗi nguồn thành 2 WAV đầy đủ
  (ffmpeg concat), kèm bản đồ offset thời gian chunk→timeline.

### Transcription

- Gọi BYOK (OpenAI gpt-transcribe) **2 lần** — 1 lần cho timeline micro, 1 lần cho
  timeline system — rồi trộn kết quả theo mốc thời gian thành transcript duy nhất.
- Mỗi segment lưu thêm `source: "microphone" | "system"` nội bộ; hiển thị:
  micro → nhãn **"Bạn"**, system → nhãn **"Cuộc họp"**.

### Hợp đồng (wire)

- `TranscriptSegment` mở rộng trường **optional** `speakerLabel?: string`
  (meeting-contracts, zod) — cũ không có trường này vẫn hợp lệ → tương thích ngược.
- UI (meeting-surface): chip nhỏ `[Bạn]` / `[Cuộc họp]` đầu mỗi đoạn; transcript cũ
  (không có nhãn) hiển thị như cũ.

### Phạm vi sửa

- `packages/meetless-plugin/src/transcription-service.ts` (route 2 nguồn)
- `packages/meetless-plugin/src/finalizer.ts` hoặc module mới `source-timeline.ts`
- `packages/meeting-contracts/src/index.ts` (+1 optional field)
- `packages/meeting-surface/src/index.tsx` (hiển thị nhãn)
- Tests: trộn timeline (unit, fixture offsets), schema tương thích ngược, UI render.

### Ảnh hưởng chi phí

- 2 lần gọi OpenAI thay vì 1 (cùng tổng dung lượng audio) — chi phí BYOK không đổi
  đáng kể. Tùy chọn cấu hình: nếu chỉ muốn nhãn mà không tốn thêm, có thể transcribe
  system track đầy đủ + micro track (thường ngắn) — vẫn 2 calls; chấp nhận.

## 4. Thiết kế Giai đoạn B — diarization đầy đủ (pyannote, cục bộ)

### Kiến trúc

```
[Transcript đã có (giai đoạn A)]
        │ nút "Nhận diện người nói" trong meeting
        ▼
packages/meetless-plugin/src/diarization/
  ├─ diarizer.ts            ← giao diện DiarizerProvider (Node)
  ├─ pyannote-provider.ts   ← spawn sidecar Python, đọc turns.json
  └─ attribution.ts         ← ghép turns ↔ segments bằng overlap (pure, unit-test)
        ▼
~/.local/share/meetless/tools/pyannote/   (venv Python 3.11 do `uv` quản lý)
  └─ diarize.py  <audio.wav> →  [{speaker, startMs, endMs}, …]
```

### Vì sao các lựa chọn này (tính khả thi)

- **Python 3.11 pin bằng `uv`** (self-contained, không cần sudo, không phụ thuộc
  python hệ thống — Ubuntu 26.04 có thể mang Python mới hơn mức pyannote hỗ trợ).
- **pyannote.audio 3.1 (bản segmentation+clustering)**: SOTA open-source, chạy CPU
  được (ONNX/int8). Ước tính thực tế: họp 1 giờ ≈ vài phút xử lý trên CPU 8 nhân;
  có GPU thì nhanh hơn nhiều — GPU là tùy chọn, không bắt buộc.
- **Chỉ diarization bằng pyannote, text vẫn bằng BYOK OpenAI** (đã chạy ổn) — tránh
  kéo whisperX/whisper-local (nặng, cần GPU thực dụng) vào vòng bắt buộc.
- **Sidecar process + JSON contract**: giữ tách bạch Node/Python, dễ test, dễ hủy
  (kill process), timeout rõ ràng.

### Luồng chạy

1. Người dùng bấm **"Nhận diện người nói"** trên meeting đã có transcript.
2. Plugin ghép timeline **system** (nguồn chứa nhiều người) → gọi sidecar.
3. Sidecar trả `turns[]` → `attribution.ts` gán speaker cho từng segment theo
   độ phủ thời gian (ngưỡng ≥50% đoạn nằm trong turn; đoạn căng giữa 2 người →
   người phủ nhiều hơn).
4. Segments phía micro giữ nhãn "Bạn". Speakers phía hệ thống đặt tên tạm
   `Người 1, Người 2…`; **UI cho đổi tên** (ví dụ "Sếp", "Khách A") lưu vào meeting.
5. Kết quả ghi đè metadata transcript (giữ bản không nhãn để hoàn tác).

### Cài đặt (opt-in, một lệnh)

```bash
npm run diarization:install
```

Script: cài `uv` (nếu thiếu) → tạo venv 3.11 tại
`~/.local/share/meetless/tools/pyannote` → `pip install pyannote.audio onnxruntime`
→ hướng dẫn người dùng **một lần**: tạo tài khoản HuggingFace miễn phí, bấm chấp
nhận điều khoản 2 model gated (`pyannote/speaker-diarization-3.1`,
`pyannote/segmentation-3.0`), lưu token vào
`~/.local/share/meetless/tools/pyannente/hf-token` (chmod 600).

Không cài đặt / không token → nút "Nhận diện người nói" hiển thị trạng thái
"chưa cài" kèm hướng dẫn — **không phá gì**.

### Quyền riêng tư

- Audio **không rời máy**: pyannote chạy offline sau khi model tải về 1 lần (~500MB
  vào cache HF cục bộ). Token HF chỉ dùng tải model.
- Phần text đã transcribe vẫn theo quy định BYOK hiện có.

## 5. Rủi ro & cách phủ

| Rủi ro | Mức | Ứng phó |
| --- | --- | --- |
| Model HF gated cần người dùng tự chấp nhận điều khoản | Chắc chắn xảy ra | Hướng dẫn từng bước trong installer + thông báo rõ trong UI; không thể tự động hóa (điều khoản HF) |
| Tốc độ CPU với họp dài | Trung bình | ProgressBar + có thể hủy; tài liệu khuyến nghị GPU nếu họp >2h; xử lý theo khối 15 phút |
| Python/pyannote 版 bản phụ thuộc lởm | Trung bình | Pin version bằng lock file trong venv; `uv` isolate khỏi hệ thống |
| Nhãn sai ở đoạn người nói chồng lấn | Thấp | Ngưỡng overlap + hiển thị độ tin cậy; người dùng đổi tên/sửa tay |
| Sai lệch lệch thời gian giữa transcript & turns | Thấp | Cả hai đều mốc ms trên cùng timeline system; test fixture |

## 6. Những gì cần chủ sở hữu duyệt

1. **Duyệt cả A + B?** (A nhỏ, giá trị ngay; B cần cài thêm ~600MB + token HF miễn phí.)
2. **Triết lý local-only cho diarization** — không dùng cloud diarization (AssemblyAI…)
   kể cả khi nhanh hơn. (Khuyến nghị: local-only.)
3. **Nút hành động chủ động** thay vì tự chạy sau transcribe. (Khuyến nghị: nút riêng.)
4. **Tên mặc định** "Bạn"/"Cuộc họp"/"Người 1…" — chấp nhận? Muốn tên khác?
