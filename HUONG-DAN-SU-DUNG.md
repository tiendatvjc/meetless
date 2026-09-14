# Hướng dẫn sử dụng Meetless trên Ubuntu (bản đầy đủ)

> Viết cho người chưa biết gì về lập trình. Làm theo từng bước, copy-paste lệnh vào
> Terminal (Ctrl+Alt+T). Thư mục dự án: `/home/dat/Applications/meetless`.

---

## 0. Meetless là gì? (1 phút)

Trình **ghi âm + tra cứu cuộc họp cá nhân** chạy ngay trên máy bạn:

```
Ghi âm cuộc họp (Zoom / Google Meet / Microsoft Teams, hoặc app gọi nào có âm thanh)
  → Lưu file vào máy bạn (~/Documents/meetings)
  → Bấm "Transcribe" để chuyển giọng nói thành văn bản (dùng key OpenAI của bạn)
  → Đọc transcript theo đoạn có mốc thời gian; bấm đoạn trích dẫn để NGHE LẠI đúng chỗ
```

- Bản ghi âm **nằm trên máy bạn**; chỉ khi bạn chủ động bấm Transcribe thì audio mới
  được gửi tới OpenAI (không tự động bao giờ).
- Thu **hai nguồn tách biệt**: micro (giọng bạn) + âm thanh hệ thống (giọng người
  đối diện). Bạn im lặng cả buổi vẫn ghi trọn phần người khác nói.
- Transcript **gắn nhãn người nói** ở hai mức: tự động `[Bạn]` / `[Cuộc họp]` khi
  transcribe (không cần cài thêm gì), và nhận diện **từng cá nhân** (Người 1,
  Người 2…) qua mục 5 bên dưới.

---

## 1. Cài đặt từ đầu (chỉ 1 lệnh)

```bash
cd ~/Applications/meetless && npm run desktop:linux:install
```

Script tự làm: kiểm tra phần mềm cần thiết → npm install → build → **tự tạo desktop
shortcut** (không cần làm gì tay). Yêu cầu máy phải có sẵn:

```bash
sudo apt update && sudo apt install -y ffmpeg pulseaudio-utils pipewire-pulse nodejs npm
```

(Node 20+; ⚠️ không có gói `pipewire-audio-utils` trên Ubuntu — đừng cài nó.)

### Desktop icon / shortcut

- **Sau khi cài, shortcut tự xuất hiện**: mở menu ứng liệu (phím Super/Activities)
  → gõ **"Meetless"** → icon Meetless xuất hiện (đặt nó vào thanh Dock bằng cách
  chuột phải → *Add to Favorites* nếu muốn ghim).
- Shortcut thực chất là file `~/.local/share/applications/meetless.desktop` trỏ
  vào launcher `scripts/linux/launch-meetless.sh` + icon của app.
- **Nếu shortcut bị mất** (dọn máy, cài lại OS…), tạo lại bằng 1 lệnh — không build lại:

```bash
cd ~/Applications/meetless && npm run desktop:linux:shortcut
```

- Hoặc tạo tay file `~/.local/share/applications/meetless.desktop` với nội dung:

```ini
[Desktop Entry]
Type=Application
Name=Meetless
Exec=/home/dat/Applications/meetless/scripts/linux/launch-meetless.sh
Icon=/home/dat/Applications/meetless/scripts/linux/icon.png
Terminal=false
Categories=Utility;AudioVideo;
```

sau đó chạy `update-desktop-database ~/.local/share/applications`.

---

## 2. Mở app hằng ngày (3 cách)

1. **Menu ứng dụng**: gõ "Meetless" (Activities → Meetless) — cách khuyên dùng.
2. **Lệnh**: `cd ~/Applications/meetless && npm run desktop:linux`
3. Đang chạy rồi thì mở lại shortcut sẽ không nhân bản.

Khi mở, launcher tự dừng daemon nền (nếu có) để cửa sổ tự làm chủ hệ thống —
**một thời điểm chỉ chạy một trong hai chế độ** (cửa sổ app ∥ daemon nền).

Log khi cần xem: `/tmp/meetless-desktop.log` • Trạng thái file ghi: `~/Documents/meetings/`

---

## 3. Ghi âm một cuộc họp

1. Vào cuộc họp Zoom/Meet/Teams **trên chính máy này** (app hoặc web đều được).
2. Mở Meetless → **Record meeting** → **gõ tiêu đề** (bắt buộc — nút chỉ bật khi có
   tiêu đề) → **Start recording** → đồng hồ đếm thời gian hiện ra.
3. Cứ họp bình thường (nói hoặc im lặng đều được). Tạm dừng: **Pause**/**Resume**.
4. Hết: **Stop** → chờ vài giây → cuộc họp xuất hiện trong danh sách với file:
   - `~/Documents/meetings/HH-DD-Mm-YY.mp3` — nghe lại (trộn cả 2 phía)
   - WAV gốc theo từng nguồn — phục vụ transcribe
5. Mở thư mục nghe: `xdg-open ~/Documents/meetings`

Điều kiện để ghi được giọng đối diện: bạn phải **nghe thấy họ qua tai nghe/loa mặc
định** (đừng mute loa trong Zoom). Mọi âm thanh khác phát ra máy (nhạc, thông báo)
cũng bị thu — muốn sạch thì tắt tiếng nguồn khác.

---

## 4. Transcribe (chuyển văn bản) — làm 1 lần trước khi dùng

**Lấy key OpenAI (BYOK):**
1. Đăng nhập https://platform.openai.com → API keys → Create new secret key → copy (`sk-...`).
2. Nạp tiền cho tài khoản API (Billing) — transcribe rẻ, tính theo phút audio.
3. Tạo file key trên máy:

```bash
mkdir -p ~/.local/share/meetless
cat > ~/.local/share/meetless/byok-openai.json <<'EOF'
{"version": 1, "apiKey": "sk-DÁN-KEY-VÀO-ĐÂY"}
EOF
chmod 600 ~/.local/share/meetless/byok-openai.json
```

Key là "chìa khóa ví" của bạn — đừng chia sẻ. Muốn thu hồi: xóa key trên trang OpenAI.

**Chạy:** mở meeting trong app → **Transcribe** (bấm chủ động — không bao giờ tự
upload) → chờ vài phút → transcript chia đoạn có mốc thời gian; bấm đoạn nào nghe
lại đúng chỗ đó. Hỗ trợ tiếng Anh + Việt. Nếu lỗi giữa chừng, audio còn nguyên —
bấm Transcribe lại được.

---

## 5. Nhận diện người nói (ai nói đoạn nào)

Transcript có nhãn người nói ở **hai mức**:

- **Mức 1 — tự động (đã có, không cần cài thêm):** khi bạn bấm Transcribe, vì bản
  ghi thu hai nguồn riêng (micro + hệ thống), mỗi đoạn tự mang nhãn `[Bạn]`
  (giọng từ micro của bạn) hoặc `[Cuộc họp]` (giọng người đối diện).
- **Mức 2 — từng cá nhân (cài thêm 1 lần):** chạy thêm bộ máy **pyannote** ngay
  trên máy bạn (không gửi audio đi đâu) để tách "Người 1, Người 2, …" trong phần
  âm thanh cuộc họp, rồi gán cho từng đoạn transcript. Sau đó bạn đổi tên
  "Người 1" thành tên thật (VD: "Chị Lan").

### Cài mức 2 (làm 1 lần)

```bash
cd ~/Applications/meetless && npm run diarization:install
```

Script tự cài (tất cả trong `$HOME`, không sudo): `uv` → venv Python 3.11 tại
`~/.local/share/meetless/tools/pyannote/` → torch CPU + pyannote.audio (tải
vài trăm MB, chỉ lần đầu). Xong còn 1 bước tay — **HF token** (model pyannote
là "gated", phải đồng ý điều khoản trước):

1. Đăng nhập https://huggingface.co rồi bấm đồng ý điều khoản tại BOTH hai model:
   - https://huggingface.co/pyannote/speaker-diarization-3.1
   - https://huggingface.co/pyannote/segmentation-3.0
2. Tạo token (quyền read): https://huggingface.co/settings/tokens
3. Lưu token vào file (một token trên một dòng):

```bash
printf 'TOKEN_CUA_BAN' > ~/.local/share/meetless/tools/pyannote/hf-token
chmod 600 ~/.local/share/meetless/tools/pyannote/hf-token
```

Kiểm tra sẵn sàng: `npm run diarization:check` (in rõ thiếu gì nếu chưa xong).
Lần chạy **đầu tiên** sẽ tải model ~600MB vào `~/.cache/huggingface` (chỉ 1 lần).

### Dùng trong app

1. Mở meeting đã có transcript (đã bấm Transcribe xong).
2. Bấm nút **Nhận diện người nói** → chờ (xem tiến độ trên nút).
3. Xong: các đoạn hệ thống được gán `Người 1`, `Người 2`, …; các đoạn micro của
   bạn vẫn giữ nhãn `Bạn`. Chạy lại lần nữa → ghi đè kết quả mới (an toàn).
4. **Đổi tên người**: bấm đổi tên người nói → gõ tên thật → Lưu. Đổi tên không
   sửa transcript gốc — chỉ đổi nhãn hiển thị (luôn hoàn tác được bằng chạy lại).

### Thời gian chạy thực tế (CPU)

- pyannote chạy **CPU** là đủ (không cần card đồ họa). Tốc độ xấp xỉ thời gian
  cuộc họp: họp 30 phút → chờ cỡ 20–40 phút tùy máy; họp dài tự chia khối 15
  phút và báo tiến độ từng khối.
- Chỉ chạy khi bạn bấm nút; transcript/MP3 gốc **không bao giờ bị sửa đổi**.

### Gỡ mức 2

```bash
rm -rf ~/.local/share/meetless/tools/pyannote ~/.cache/huggingface
```

(Thư mục `~/.cache/huggingface` là model đã tải — xóa nếu muốn giải phóng
~600MB. Mức 1 `[Bạn]`/`[Cuộc họp]` không bị ảnh hưởng.)

---

## 6. Mã QR và "Connect a companion" (kết nối thiết bị khác)

Companion = giao diện Meetless từ **thiết bị khác** (điện thoại/máy khác) trong khi
máy desktop làm "trạm ghi âm". Lần đầu mở companion sẽ hiện màn hình kết nối:

- **Mã QR** bản质 là một **đường link kết nối** ở dạng quét — dùng cho chế độ relay
  mã hóa (qua internet). *Trạng thái trên bản port: link trỏ tới web app của Paseo
  chứ chưa trỏ về companion Meetless — luồng relay chưa dùng được, đã ghi followups.*
- **Cùng một máy** (đã cấu hình sẵn): chọn **Direct connection** → endpoint
  `127.0.0.1:8081` → mật khẩu `meetless2026` → **Pair securely**.
- **Điện thoại cùng wifi** (nâng cao): mở daemon lắng nghe ngoài +
  `sudo ufw allow from 192.168.0.0/16 to any port 8081 proto tcp` → endpoint
  `<IP-máy>:8081` (xem IP: `hostname -I`).

Máy desktop tắt → companion hiện "host offline", danh sách meeting cũ vẫn hiển thị.

---

## 7. Thẻ "Meetless Premium" — bỏ qua

Giao diện monetization của bản macOS (RevenueCat). Linux không có SDK này → luôn
"chưa kích hoạt", nút Purchase không chạy. Transcribe của bạn đi qua key OpenAI cá
nhân (mục 4) — không liên quan.

---

## 8. Hỏi đáp cuộc họp với provider tự cấu hình (nâng cao)

Tính năng **Hỏi đáp** (Ask) trong meeting mặc định chạy qua các agent có sẵn
(Codex/Claude/OpenCode…). Bạn có thể **tự thêm provider tương thích OpenAI**
(vd GLM của Z.ai) bằng file cấu hình — model sẽ xuất hiện trong cùng bộ chọn
model của phần Hỏi đáp.

Tạo file `~/.local/share/meetless/chat-providers.json`:

```bash
mkdir -p ~/.local/share/meetless
cat > ~/.local/share/meetless/chat-providers.json <<'EOF'
{
  "version": 1,
  "providers": [
    {
      "id": "zai-glm",
      "name": "GLM (Z.ai)",
      "baseUrl": "https://api.z.ai/api/paas/v4",
      "apiKey": "DÁN-KEY-VÀO-ĐÂY",
      "models": [
        { "id": "glm-5.3", "label": "GLM 5.3" }
      ]
    }
  ]
}
EOF
chmod 600 ~/.local/share/meetless/chat-providers.json
```

- **GLM (Z.ai):** lấy key tại https://z.ai (OpenAI-compatible endpoint
  `https://api.z.ai/api/paas/v4`) rồi điền như ví dụ trên; đổi `models` thành
  tên model bạn được cấp.
- **Gemini:** nếu Google cung cấp cho bạn endpoint tương thích OpenAI thì khai
  báo tương tự (đổi `baseUrl` + key + tên model). Nếu không, dùng qua OpenCode
  như hiện có.
- File chỉ được đọc khi cần (đổi key không phải khởi động lại); key không bao
giờ xuất hiện trong giao diện. Câu trả lời vẫn **bắt buộc trích dẫn đoạn
transcript** như mọi provider khác — model không đưa ra được trích dẫn đúng thì
sẽ trả "không đủ bằng chứng". Xóa file (hoặc xóa provider trong file) là ẩn khỏi
bộ chọn model.

---

## 9. Xử lý sự cố (theo thứ tự thường gặp)

| Hiện tượng | Cách xử lý |
| --- | --- |
| Mở shortcut không thấy cửa sổ | Xem `/tmp/meetless-desktop.log`; cổng 8082 bận → tắt server web cũ (`pkill -f "expo start"`); daemon systemd đang chạy → `systemctl --user stop meetless-daemon` rồi mở lại. |
| Cửa sổ trắng | Binary Electron hỏng → chạy lại `npm run desktop:linux:install` (script tự phục hồi từ cache). |
| Nút "Start recording" sáng mà bấm không chạy | Đã sửa (bug RN-web) — nếu tái diễn: gõ tiêu đề xong bấm ngoài ô rồi bấm nút; báo tôi kèm log. |
| Trạng thái host offline trong companion | Dùng đúng địa chỉ `127.0.0.1:8082` (không phải `localhost:8082`); F5. |
| Ghi xong không có file / recording "failed" | Xem lý do trong `/tmp/meetless-desktop.log` tìm "recording-submit" hoặc "interruption". |
| Transcribe báo lỗi key | Kiểm tra file byok-openai.json (đúng `sk-...`, còn credit trên OpenAI). |
| Muốn daemon nền thay cửa sổ | `systemctl --user start meetless-daemon` (đóng cửa sổ trước). Xem: `systemctl --user status meetless-daemon`. |
| Ghi âm không có tiếng đối diện | Loa Zoom đang phát? Thiết bị xuất mặc định đúng? `pactl info` phải thấy PipeWire. |
| Nút "Nhận diện người nói" mờ / báo chưa cài | Chạy `npm run diarization:check` xem thiếu gì (venv / HF token) rồi `npm run diarization:install`. Cần transcript đã xong (mục 4). |

---

## 10. Gỡ cài đặt

```bash
systemctl --user disable --now meetless-daemon 2>/dev/null
rm -f ~/.config/systemd/user/meetless-daemon.service && systemctl --user daemon-reload
rm -f ~/.local/share/applications/meetless.desktop
```

Dữ liệu (`~/Documents/meetings`, `~/.local/share/meetless`) và mã nguồn
(`~/Applications/meetless`) không bị xóa — muốn sạch thì tự remove thêm.

---

## 11. Trạng thái đã kiểm chứng trên máy này

- ✅ Cài 1 lệnh + desktop shortcut (menu Activities → Meetless).
- ✅ Ghi âm thật 2 phía (micro + hệ thống) → MP3 trong `~/Documents/meetings`.
- ✅ Vòng lặp prove: record → ffmpeg finalize → BYOK transcribe → MCP (chạy `npm run proof:linux`).
- ✅ Đóng gói AppImage/deb (`npm run package:linux`).
- ⏳ Smoke trực tiếp trên Teams (cần làm theo mục 3 rồi ghi kết quả vào đây).
- ⏳ Relay qua internet cho điện thoại (xem mục 6).
- ✅ Nhận diện người nói mức 1 (`Bạn`/`Cuộc họp`) + proof fixture toàn luồng
  mức 2 (`npm run proof:diarization`). ⏳ Smoke mức 2 với model thật cần HF
  token (mục 5) — chạy trên họp thật ≥2 người nói rồi ghi kết quả vào đây.
- ✅ Proof chat popup + provider phát sinh (phase C1, mục 8) qua test tự động;
  ⏳ smoke GLM thật chờ key của bạn.

*Cập nhật: 2026-09-14 — fork `tiendatvjc/meetless`, nhánh `main` (bản port).*
