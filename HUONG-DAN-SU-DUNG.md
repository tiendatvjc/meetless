# Hướng dẫn sử dụng Meetless trên Ubuntu (cho người mới bắt đầu)

> Tài liệu này giả định bạn **chưa biết gì** về lập trình. Làm theo từng bước, copy-paste
> từng lệnh vào Terminal (Ctrl+Alt+T). Máy trong ví dụ dùng Ubuntu, đường dẫn dự án là
> `/home/dat/Applications/meetless`.

---

## 0. Meetless là gì? (đọc 1 phút)

Meetless là **trình ghi âm + tra cứu cuộc họp cá nhân** chạy ngay trên máy bạn:

```
Ghi âm cuộc họp (Zoom / Google Meet / Microsoft Teams...)
   → Lưu file âm thanh vào máy bạn (~/Documents/meetings)
   → Bấm nút "Transcribe" để chuyển giọng nói thành văn bản (cần key OpenAI của bạn)
   → Đọc toàn bộ transcript, bấm vào trích dẫn để NGHE LẠI đúng đoạn đó
```

- Mọi bản ghi âm **nằm trên máy bạn** (không tự tải lên đâu cả).
- Chỉ khi bạn chủ động bấm **Transcribe**, phần audio mới được gửi tới OpenAI để
  chuyển văn bản (dùng API key của chính bạn — xem mục 4).
- Bản chạy trên Ubuntu này là port từ bản macOS gốc, đang ở chế độ **dev-mode**
  (chạy thẳng từ thư mục code — ổn để dùng hàng ngày trên máy cá nhân).

---

## 1. Kiểm tra máy đã đủ chưa

Mở Terminal và chạy lần lượt:

```bash
node --version
```
→ cần từ **20 trở lên** (máy này đang có v24 ✓). Nếu báo "command not found", cài NodeJS
trước (hỏi trợ giúp hoặc xem https://nodejs.org).

```bash
sudo apt update
sudo apt install ffmpeg pulseaudio-utils pipewire-pulse
```

Ba gói này cung cấp: `ffmpeg` (đóng gói file MP3), `parec` + `pactl` (thu âm hệ thống
qua PipeWire). Kiểm tra:

```bash
ffmpeg -version | head -1
command -v parec pactl
pactl info | grep "Server Name"
```
→ `pactl info` phải hiện đại loại `PulseAudio (on PipeWire ...)`.

> ⚠️ Lưu ý: **không có** gói tên `pipewire-audio-utils` trên Ubuntu — đừng cài nó.

---

## 2. Cài đặt lần đầu (chỉ làm 1 lần)

Từ thư mục dự án:

```bash
cd /home/dat/Applications/meetless
```

**Bước 1 — tải thư viện:**

```bash
npm install
```
(Chạy vài phút, chỉ cần làm một lần.)

**Bước 2 — build chương trình:**

```bash
npm run build:paseo
npm run build:meetless
npm run build:app
```
(Ba lệnh này phải kết thúc không báo lỗi.)

**Bước 3 — xem trước rồi cài dịch vụ nền (daemon):**

```bash
node scripts/install-linux-host.mjs            # XEM TRƯỚC: chỉ in kế hoạch, không cài gì
node scripts/install-linux-host.mjs --install  # CÀI THẬT: tạo service systemd cho user bạn
```

Sau khi cài, daemon tự chạy mỗi khi bạn đăng nhập. Kiểm tra:

```bash
systemctl --user status meetless-daemon
```
→ phải thấy **`Active: active (running)`**.

---

## 3. Sử dụng hằng ngày

### Bật/tắt và kiểm tra daemon

```bash
systemctl --user status  meetless-daemon   # xem trạng thái
systemctl --user stop    meetless-daemon   # tắt
systemctl --user start   meetless-daemon   # bật lại
journalctl --user -u meetless-daemon -n 50 # xem 50 dòng log gần nhất (F10 để thoát)
```

### Mở giao diện web (companion) trên chính máy này

```bash
cd /home/dat/Applications/meetless && npm run runtime:web
```
→ mở trình duyệt tại **http://localhost:8082**. Để dừng: nhấn `Ctrl+C` trong Terminal.

### Ghi âm một cuộc họp

1. Bật daemon (mục trên) + mở giao diện web.
2. Bắt đầu cuộc họp Zoom / Google Meet / Teams **trên chính máy này** (app hoặc web).
   Meetless KHÔNG tự phát hiện cuộc họp — bạn chủ động ghi như dưới.
3. Trong giao diện Meetless, màn hình *"Your meetings live here"* → bấm **"Record
   meeting"** → ở màn hình thiết lập, **gõ tiêu đề cuộc họp** (bắt buộc — nút chỉ
   bật khi có tiêu đề) → bấm **Start recording**. Meetless thu **2 nguồn riêng**:
   micro của bạn + âm thanh phát ra từ loa (giọng người đối diện).
4. Cần tạm dừng thì bấm **Pause**, xong bấm **Resume**; kết thúc bấm **Stop**.
5. File kết quả nằm ở **`~/Documents/meetings/`**: một file `.mp3` để nghe lại và một
   file `.wav` gốc để transcribe về sau. Không bao giờ bị ghi đè file cũ.

> Ghi được cả Zoom, Meet, Teams hay bất kỳ app nào — vì Meetless thu ở cấp hệ điều
> hành, không cần tích hợp riêng với từng app.

### Chuyển giọng nói thành văn bản (Transcribe)

**Điều kiện trước:** đã tạo key OpenAI (mục 4).

1. Mở meeting vừa ghi trong giao diện web → bấm **Transcribe** (đây là hành động
   chủ động — Meetless **không bao giờ** tự upload audio nếu bạn không bấm).
2. Chờ vài phút (tùy độ dài cuộc họp). Xong sẽ thấy transcript chia thành các đoạn
   có mốc thời gian.
3. Bấm vào một đoạn trích dẫn → trình phát audio nhảy đúng vị trí đó để bạn nghe lại.

Hỗ trợ tiếng **Anh** và tiếng **Việt**. Nếu transcription lỗi giữa chừng, audio vẫn
còn nguyên — bấm Transcribe lại được.

---

## 4. Tạo key OpenAI (cho tính năng Transcribe) — làm 1 lần

Meetless dùng cách **BYOK** ("Bring Your Own Key" — key của chính bạn):

1. Đăng ký / đăng nhập **https://platform.openai.com**, vào **API keys** → **Create new
   secret key** → đặt tên `meetless` → copy key (dạng `sk-...`). Key chỉ hiện 1 lần!
2. Nạp tối thiểu tiền cho tài khoản API (Billing) — transcribe audio rất rẻ, tính theo
   số phút âm thanh.
3. Tạo file key trên máy (copy lệnh, thay `sk-...` bằng key của bạn):

```bash
mkdir -p ~/.local/share/meetless
cat > ~/.local/share/meetless/byok-openai.json <<'EOF'
{"version": 1, "apiKey": "sk-DÁN-KEY-CỦA-BẠN-VÀO-ĐÂY"}
EOF
chmod 600 ~/.local/share/meetless/byok-openai.json
```

4. Kiểm tra (không bắt buộc):

```bash
cat ~/.local/share/meetless/byok-openai.json   # xem lại (chỉ bạn thấy được)
```

**Bảo mật:** file này là "chìa khóa ví tiền" OpenAI của bạn — đừng đưa cho ai, đừng
đăng lên đâu. Muốn đổi key thì sửa file; muốn thu hồi thì xóa key trên trang OpenAI.

---

## 5. Mã QR và "Connect a companion" là gì? Cách dùng

**Companion** = giao diện điều khiển/tra cứu Meetless từ **một thiết bị khác** (điện
thoại, máy tính khác) — trong khi máy desktop đang chạy daemon làm "trạm ghi âm".
Companion chỉ **xem/đọc/chat/nghe lại**; việc ghi âm luôn diễn ra trên máy desktop.

Lần đầu mở companion trên thiết bị mới, app hiện màn hình **"Connect a companion"**
(kết nối với máy chủ). Màn hình này có **mã QR**: bản QR chỉ là **đường link kết
giao pair** ở dạng quét được (dán link hoặc quét QR đều như nhau). Link/QR do daemon
tạo và **hiển thị ngay trong giao diện desktop** ở màn hình "Connect a companion"
(trên máy này, cửa sổ desktop Meetless đang chạy và hiện sẵn màn hình này).

### Cách dùng ngay trên CÙNG một máy (khuyên dùng, đã cấu hình sẵn)

Daemon đã lắng nghe `127.0.0.1:8081`, cho phép trang web `127.0.0.1:8082` kết nối,
và **đã đặt mật khẩu host** (bắt buộc — form Direct không cho bấm "Pair securely"
nếu ô mật khẩu trống):

1. Mở trình duyệt tại **http://localhost:8082** (hoặc nhìn cửa sổ desktop Meetless).
2. Ở màn hình "Connect a companion" chọn kiểu **Direct connection** và nhập:
   - **Endpoint:** `127.0.0.1:8081`
   - **Host password:** `meetless2026` (mật khẩu mặc định đã cài — đổi ngay như dưới)
3. Bấm **Pair securely**. Từ đó companion nhớ thiết bị này, không phải làm lại.

**Đổi mật khẩu host:** mật khẩu được lưu dạng hash bcrypt trong
`~/.local/share/meetless/paseo-home/config.json` (mục `daemon.auth.password`).
Cách đổi:

```bash
cd /home/dat/Applications/meetless
HASH=$(node -e "console.log(require('bcryptjs').hashSync('MẬT-KHÓU-MỚI', 12))")
python3 - "$HASH" <<'EOF'
import json, sys
p = "/home/dat/.local/share/meetless/paseo-home/config.json"
cfg = json.load(open(p)); cfg["daemon"]["auth"] = {"password": sys.argv[1]}
json.dump(cfg, open(p, "w"), indent=2)
EOF
systemctl --user restart meetless-daemon
```
(rồi dùng mật khẩu mới ở bước 2.)

### Kết nối từ ĐIỆN THOẠI / máy khác — 2 cách

**Cách 1 — Relay mã hóa (mặc định của app, khuyến nghị):** quét mã QR hiển thị
trên màn hình desktop (hoặc copy link dán vào companion). Đặc điểm: mã hóa đầu-cuối,
dùng được qua internet (không cần cùng wifi); dữ liệu meeting vẫn chỉ nằm trên máy
desktop, relay chỉ chuyển tiếp đã mã hóa.

> Link/QR có dạng `https://app.paseo.sh/#offer=...` — do daemon sinh ra (chứa ID +
> khóa công khai của daemon + địa chỉ relay). Trong sản phẩm gốc, nó hiển thị kèm mã
> QR ngay trên màn hình "Connect a companion" của phiên desktop **đã kết nối**, để
> bạn đưa vào THIẾT BỊ KHÁC. Lưu ý trên bản port: link này mở web app của Paseo
> (`app.paseo.sh`) chứ chưa trỏ về companion Meetless — luồng relay **chưa dùng
> được** cho tới khi cấu hình lại `appBaseUrl`; dùng **Direct LAN** cho cùng máy.

**Cách 2 — Direct LAN (cùng wifi):** nhập endpoint + mật khẩu host. Nhanh, không
đi ra internet, nhưng tín hiệu trên wifi nội bộ **không mã hóa** — chỉ dùng ở mạng
nhà. Để dùng được cần mở daemon ra ngoài và đặt mật khẩu (mục dưới).

> Ghi trạng thái: luồng relay mặc định đi qua relay công khai của Paseo
> (`relay.paseo.sh`) — phần cấu hình này kế thừa từ vendor và chưa được kiểm chứng
> đầy đủ trên bản port. Kết nối cùng-máy (127.0.0.1) là đường đã cấu hình sẵn.

### Mở daemon ra cho điện thoại trong wifi (nâng cao, tự chịu rủi ro)

```bash
systemctl --user edit meetless-daemon
# thêm 3 dòng rồi lưu (đổi mật khẩu thành của bạn):
[Service]
Environment=MEETLESS_LISTEN=0.0.0.0:8081
```
rồi `systemctl --user restart meetless-daemon`, mở tường lửa nếu có:
`sudo ufw allow from 192.168.0.0/16 to any port 8081 proto tcp`.
Endpoint trên điện thoại sẽ là `<IP-máy-tính>:8081` (xem IP bằng `hostname -I`),
mật khẩu là mật khẩu host (mục trên).

### Khi máy desktop tắt

Companion sẽ hiện trạng thái **host-offline** (máy chủ ngoại tuyến) và **giữ nguyên**
danh sách meeting đã biết — không "mất dữ liệu". Bật lại máy desktop là companion
tự kết nối lại.

---

## 6. Hỏi-đáp về nội dung cuộc họp (chat) — phần nâng cao

Ngoài việc đọc transcript, Meetless cho phép **hỏi câu hỏi về cuộc họp** và câu trả
lời phải **kèm trích dẫn** (bấm trích dẫn để nghe lại đoạn audio). Cơ chế này chạy
qua một **coding agent** (Codex / Claude Code...) do bạn cấu hình — nếu bạn chưa dùng
các agent đó, hãy bỏ qua phần chat và dùng transcript + trình phát; cấu hình agent
nằm ngoài phạm vi tài liệu này.

---

## 7. Xử lý sự cố thường gặp

| Hiện tượng | Nguyên nhân & cách xử lý |
| --- | --- |
| `systemctl` báo `inactive`/`failed` | `journalctl --user -u meetless-daemon -n 50` xem lỗi; thử `systemctl --user restart meetless-daemon`. |
| Báo thiếu `parec`/`pactl` | `sudo apt install pulseaudio-utils pipewire-pulse`. |
| Ghi âm không có tiếng người đối diện | Kiểm tra loa máy tính đang phát (không phải tai nghe Bluetooth ở chế phạm vi gọi HFP), và `pactl info` phải chạy đúng PipeWire. |
| Web không mở được ở :8082 | Kiểm tra Terminal `npm run runtime:web` còn đang chạy; thử cổng khác: `npm run start:web --workspace=@meetless/app -- --port 8083`. |
| Nút "Pair securely" không bấm được | Form Direct yêu cầu ô mật khẩu KHÔNG được trống — nhập mật khẩu host (mục 5, mặc định `meetless2026`). Form Relay yêu cầu dán pairing link trước. |
| Chạy `npm run runtime:desktop` nhưng không có cửa sổ nào mở | Hai nguyên nhân: (1) cổng 8082 đang bận — tắt server web đang chạy (`Ctrl+C` ở Terminal lệnh `runtime:web`); (2) daemon systemd đang chạy nền — cửa sổ desktop **từ chối mượn daemon của systemd** (nó chỉ chạy khi tự làm chủ runtime). Muốn cửa sổ desktop: `systemctl --user stop meetless-daemon` rồi `MEETLESS_RUNTIME_ROOT=$HOME/.local/share/meetless MEETLESS_LISTEN=127.0.0.1:8081 npm run runtime:desktop`; **đóng cửa sổ = daemon tắt theo** — cần lại nền thì `systemctl --user start meetless-daemon`. Đây là hạn chế đã biết (xem followups). |
| Companion (điện thoại) không thấy máy | Cùng wifi? Đã bật `MEETLESS_LISTEN=0.0.0.0:8081` (mục 5)? Tường lửa: `sudo ufw allow from 192.168.0.0/16 to any port 8081 proto tcp`. |
| Transcribe báo lỗi key | Kiểm tra file `~/.local/share/meetless/byok-openai.json`: key đúng định dạng `sk-...`, còn hiệu lực, tài khoản OpenAI còn credit. |
| Transcribe báo hết hạn mức (quota) | Bản port này không dùng quota; nếu gặp thông báo liên quan premium/managed → chọn Transcribe lại bằng BYOK key (mục 4). |
| Muốn đọc log ghi âm | `journalctl --user -u meetless-daemon | grep -i record`. |

---

## 8. Gỡ cài đặt

```bash
systemctl --user disable --now meetless-daemon
rm ~/.config/systemd/user/meetless-daemon.service
systemctl --user daemon-reload
```
Dữ liệu ghi âm ở `~/Documents/meetings/` và cấu hình ở `~/.local/share/meetless/`
**không bị xóa** — muốn xóa hẳn thì tự remove 2 thư mục đó (cẩn thận, mất là mất
hẳn) và xóa thư mục `/home/dat/Applications/meetless`.

---

## 9. Trạng thái đã kiểm chứng trên máy này (trung thực)

- ✅ Daemon chạy dưới systemd, lắng nghe kết nối; vòng lặp record → MP3 → transcribe
  (BYOK) → MCP đã chứng minh bằng `npm run proof:linux` (chạy lại bất cứ lúc nào).
- ✅ Đóng gói AppImage/deb tạo được (`release/linux/`).
- ⏳ Ghi âm **âm thanh thật** (micro + loa) cần `pulseaudio-utils` + `pipewire-pulse`
  đã cài — hãy chạy thử 1 cuộc họp ngắn và nghe lại file MP3 để tự xác nhận.
- ⏳ Cửa sổ desktop (Electron) và companion qua relay công khai của Paseo là các
  phần đang hoàn thiện tiếp (xem `docs/superpowers/plans/2026-09-13-ubuntu-port-followups.md`).

*Cập nhật: 2026-09-13 — nhánh `linux-port`, fork `tiendatvjc/meetless`.*
