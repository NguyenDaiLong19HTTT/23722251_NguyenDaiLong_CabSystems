# CAB — Hướng dẫn Postman theo thứ tự phiếu chấm

## Cách sử dụng

Chấm theo đúng mục 01 → 30 bên dưới.

- Mục cần Postman: có Method, URL, Auth, Body và kết quả cần chứng minh.
- Mục kiến trúc/hạ tầng/bảo mật: ghi công cụ và bằng chứng cần trình bày.
- Các bước xử lý 202, GPS cũ, token hết hạn nằm trong phụ lục; không phải mục chấm riêng.
- Hướng dẫn bám 30 tiêu chí trong ảnh phiếu chấm đã cung cấp. Chưa đối chiếu được nội dung bản PDF “PHIEU_CHAM_PROJECT (2).pdf” nếu bản đó có thay đổi.
- Đây là hướng dẫn thực hiện, không phải xác nhận toàn bộ 30 mục đã PASS.

## Chuẩn bị trước khi chấm

### Khởi động

```powershell
Set-Location 'D:\HK1-Y4\Fullstack\Cab_sys\23722251_NguyenDaiLong_CabSystems'
docker compose up -d
docker compose ps
```

Đợi các app và hạ tầng healthy.

### Quy tắc Postman

- URL gốc: `http://127.0.0.1:33201`.
- Các đường dẫn `/v1/...` bên dưới phải ghép với URL gốc.
- Auth Customer/Driver/Operator: Authorization → Bearer Token → dán accessToken đúng tài khoản.
- No Auth: không gửi Authorization.
- Body JSON: Body → raw → JSON.
- GET: Body → none.
- Thay `<...>` bằng ID thật, bỏ cả dấu `< >`.
- Không gửi nguyên placeholder hoặc dấu `*`.
- `expectedVersion` phải là version hiện tại của đúng đối tượng.
- Chỉ Payment mới cần client Idempotency-Key ở những request có ghi rõ.

### Dữ liệu phải có trước để giữ đúng thứ tự chấm

Phiếu chấm đặt “xem Driver/nhận chuyến” trước “đăng ký và duyệt Driver”, nên cần chuẩn bị dữ liệu trước buổi chấm.

| Dữ liệu | Dùng cho mục |
|---|---|
| Operator có sẵn và token mới | 6, 22 |
| Driver A đã APPROVED, MOTORBIKE ACTIVE | 12, 15–17 |
| Ít nhất 5 Driver demo có trạng thái khác nhau | 13 |
| Customer L có ít nhất 5 Booking | 14 |
| Customer C sẽ đăng ký tại mục 9 | 9–11, 15–20 |
| Trip A tạo ở mục 15–17, chọn CASH | Hoàn thành chuyến và Rating |
| Trip B riêng, chưa bắt đầu chạy | 18 — hủy |
| Trip C riêng, ở PICKED_UP, chuyển khoản chưa thành công | 19 — thanh toán online |
| Driver D mới và Driver E mới | 21–22 — duyệt/từ chối |

Chuẩn bị fixture bằng luồng API hoặc công cụ demo được hỗ trợ, không sửa trực tiếp DB để giả tạo trạng thái.

Không dùng cùng một Trip cho cả hoàn thành, hủy và kiểm thử chuyển khoản.

### Đăng nhập tài khoản có sẵn để chuẩn bị token

```text
POST /v1/auth/login
Auth: No Auth
```

```json
{
  "emailOrPhone": "EMAIL_TAI_KHOAN",
  "password": "MAT_KHAU"
}
```

Mong đợi 200. Giữ riêng token Customer, Driver, Operator.

Token hết hạn thì login lại, không đăng ký lại.

---

## 01. Mô tả kiến trúc tổ chức source code

**Công cụ:** VS Code, không phải Postman.

Mở và giải thích:

- `services/`: Gateway và các service nghiệp vụ.
- `packages/`: phần dùng chung.
- `contracts/`: hợp đồng API/protobuf/policy.
- `dev/`: công cụ chạy và kiểm thử demo.
- `docs/`: tài liệu.
- `compose.yaml`: đóng gói hệ thống.

**Cần chứng minh:** hiểu trách nhiệm từng service và cách tách mã nguồn/dữ liệu.

## 02. Kiểm tra .gitignore và .env trên GitHub

**Công cụ:** Git/VS Code/GitHub.

Cho xem `.gitignore`, cấu hình mẫu và danh sách file tracked:

```powershell
git status --short
git ls-files
```

**Cần chứng minh:**

- Secret, mật khẩu, private key, `.env` thật không bị đưa lên Git.
- File mẫu chỉ chứa placeholder.
- `.gitignore` không tự bỏ file đã track trước đó, nên cần kiểm tra cả file tracked.

Không mở giá trị secret để trình diễn.

## 03. Mô tả nhiệm vụ Gateway

**Thao tác:** mở một request Postman có URL qua cổng 33201.

**Giải thích:**

- Gateway nhận HTTP từ client.
- Kiểm tra đầu vào, xác thực và quyền theo hợp đồng.
- Gọi service nghiệp vụ qua gRPC mTLS.
- Trả response cho client.

**Bằng chứng:** URL Gateway và controller/policy tương ứng. Không cần tạo thêm dữ liệu tại mục này.

## 04. Mô tả IPC giữa microservice

**Công cụ:** code/protobuf/cấu hình broker.

Trình bày:

- gRPC mTLS cho lời gọi đồng bộ.
- RabbitMQ AMQPS cho sự kiện bất đồng bộ.
- Ví dụ: Driver review → outbox → RabbitMQ → Notification → MongoDB.

Không gọi trực tiếp RPC nội bộ từ Postman thay cho đường Gateway.

## 05. Compose hệ thống và liệt kê container

```powershell
docker compose ps -a
docker compose config --services
```

**Cần chứng minh:**

- Một project `cab`, nhiều container riêng.
- Gateway, Identity, Customer, Driver, Booking, Trip, Payment, Notification, Rating.
- PostgreSQL, RabbitMQ, MongoDB và các job hỗ trợ.

Migration/setup job `Exited (0)` sau khi hoàn tất là bình thường. App chính phải đang chạy/healthy.

## 06. POSTMAN — Health check

| Bước | Method và URL | Auth | Body | Mong đợi |
|---|---|---|---|---|
| 6.1 | GET `/health` | No Auth | Không | 200 `{"status":"UP"}` |
| 6.2 | GET `/ready` | No Auth | Không | 200 `{"status":"READY"}` |
| 6.3 | GET `/health/services` | Operator | Không | 200, danh sách thành phần hệ thống |

Ví dụ URL đầy đủ:

```text
http://127.0.0.1:33201/health
```

**Cần chứng minh:** Gateway sống, hệ thống sẵn sàng và có danh sách service.

Theo hợp đồng bàn giao, health/services có 12 thành phần gồm MongoDB. Không dùng health thay bằng chứng login thành công.

## 07. Kiểm tra RabbitMQ

```powershell
docker compose ps rabbitmq
docker compose logs --tail=50 rabbitmq
```

Xem topology/queue bằng cách được README hiện hành hỗ trợ.

**Cần chứng minh:** broker hoạt động, queue/binding được tạo. Liên hệ sự kiện và Notification ở mục 16/18/22.

Không tự giả định cổng management được publish. Log healthy riêng lẻ chưa đủ chứng minh toàn bộ đường phát/nhận sự kiện.

## 08. Kiểm tra mọi request client đi qua Gateway

Cho xem URL các request đều dùng:

```text
http://127.0.0.1:33201
```

Đối chiếu Compose và policy:

- Client gọi Gateway.
- Gateway gọi RPC facade được phép.
- Không có luồng Postman đi thẳng vào HTTP nghiệp vụ của service khác.

Không cần tạo request nghiệp vụ mới ở mục này.

## 09. POSTMAN — Đăng ký khách hàng

```text
POST /v1/auth/register
Auth: No Auth
Body: raw JSON
```

```json
{
  "fullName": "Khach Cham Demo",
  "email": "customer.cham.001@example.com",
  "phone": "0900000301",
  "password": "DemoCab2026!"
}
```

Dùng email/phone chưa đăng ký; các giá trị trên là ví dụ.

**Mong đợi:** 201, tài khoản và hồ sơ Customer được tạo.

**Giữ:** `accountId`, `customerId`.

Đây là Customer C dùng ở các mục sau. Nếu 202, dùng recovery đúng collection Customer, không đăng ký lại liên tục.

## 10. POSTMAN — Đăng nhập khách hàng

```text
POST /v1/auth/login
Auth: No Auth
```

```json
{
  "emailOrPhone": "customer.cham.001@example.com",
  "password": "DemoCab2026!"
}
```

**Mong đợi:** 200, có accessToken và Account đúng Customer C.

**Giữ:** Customer C token.

## 11. POSTMAN — Lấy thông tin khách hàng bằng mã số

```text
GET /v1/customers/<customerId>
Auth: Customer C sở hữu hồ sơ
Body: none
```

**Mong đợi:** 200, thông tin đúng customerId.

Không dùng accountId thay customerId.

GET `/v1/accounts/me` chỉ là bước hỗ trợ, không thay yêu cầu lấy Customer theo mã số.

## 12. POSTMAN — Lấy thông tin tài xế bằng mã số

**Chuẩn bị:** Driver A đã tồn tại và driverId của Driver đó.

b1: đăng nhập tài xế driver@example.test bằng mật khẩu cục bộ để lấy driverId

b2: nhập url: http://127.0.0.1:33201/v1/drivers/<id-driver>

b3: đăng nhập OPERATOR (admin@example.test, mật khẩu cục bộ) để lấy token

b4: nhập token OPERATION

| Thành phần | Giá trị |
|---|---|
| Method | GET |
| URL Driver-by-ID | Điền từ request thực tế trong repo |
| Auth | OPERATION|
| Body | none |



## 13. POSTMAN — Danh sách Driver trong khu vực

**Chuẩn bị:** ít nhất 5 Driver có trạng thái khác nhau. Driver cần xuất hiện phải đủ điều kiện và có GPS mới gần điểm đón.

```text
GET /v1/drivers/nearby?latitude=10.7769&longitude=106.7009&radiusKm=1&limit=2
Auth: Customer
Body: none
```

| Param | Ý nghĩa |
|---|---|
| latitude, longitude | Tâm tìm kiếm/điểm đón |
| radiusKm=1 | Bán kính 1 km |
| limit=2 | Tối đa 2 kết quả mỗi trang |

**Thao tác chấm:**

1. Send, xem items và thông tin phân trang.
2. Dùng cursor trang sau từ response theo hợp đồng hiện hành để xem trang tiếp.
3. Đối chiếu kết quả với Driver đã chuẩn bị.

**Cần chứng minh:** dữ liệu ít nhất 5 Driver khác trạng thái, bán kính 1 km, limit và paging.

Muốn có trang sau phải có hơn 2 Driver đủ điều kiện. Có 5 hồ sơ không đồng nghĩa cả 5 phải xuất hiện.

200 `items: []` chưa đủ bằng chứng cho danh sách/paging.

## 14. POSTMAN — Danh sách Booking của Customer

Dùng **Customer L có sẵn ít nhất 5 Booking**, không dùng Customer C vừa đăng ký nếu chưa có dữ liệu.

```text
GET /v1/bookings?limit=2
Auth: Customer L
Body: none
```

**Thao tác:**

1. Xem trang đầu.
2. Dùng cursor trả về để xem các trang sau theo hợp đồng.
3. Đối chiếu ít nhất 5 Booking thuộc Customer L.

**Mong đợi:** 200, tối đa 2 kết quả/trang, có phân trang, đúng chủ tài khoản.

## 15. POSTMAN — Đặt xe, tìm tài xế, gửi offer

Quay lại token Customer C hoặc dùng Customer L. Các Driver demo riêng được `nearby-demo-gps` giữ
AVAILABLE, MOTORBIKE hợp lệ và GPS mới. Driver nhận offer là Driver có ID
trong `initialOffer.driverId`, không mặc định là một Driver khác đã đăng nhập.
Với `driver@example.test` (ID `23411fa8-d14f-4ef8-a4ff-14165a540c8c`),
Compose demo giữ GPS mới và đưa Driver về AVAILABLE sau khi Trip trước đã
giải phóng. Tại đúng điểm đón bên dưới, Driver này gần nhất trong fixture demo.
Nếu Driver còn BUSY vì Trip trước, Dispatch phải chọn người khác; hoàn tất
hoặc hủy Trip cũ theo API và đợi closure giải phóng trước khi tạo Booking mới.
Không dùng token của Driver này để nhận offer có `driverId` khác. Booking đã
tạo trước khi Driver AVAILABLE vẫn giữ offer lịch sử của nó; không sửa ID offer.

```text
POST /v1/bookings
Auth: Customer C hoặc Customer L
```

```json
{
  "pickup": {
    "latitude": 10.7769,
    "longitude": 106.7009,
    "address": "A"
  },
  "destination": {
    "latitude": 10.7869,
    "longitude": 106.7109,
    "address": "B"
  },
  "vehicleType": "MOTORBIKE"
}
```

Để dễ nhớ: địa chỉ chỉ cần `A`/`B`; tọa độ điểm đến bằng tọa độ điểm đón
cộng `0.01` ở cả latitude và longitude. Giữ đúng bốn tọa độ này vì tuyến
1.250 m/6.625 VND được server cấu hình theo tọa độ chính xác.

**Mong đợi:** 201 với `bookingStatus: "PENDING"`,
`pricingSnapshot.distanceMeters: 1250`, `totalAmount: 6625`,
`dispatchStatus: "SEARCHING"` và `initialOffer` có
`tripRequestId`, `driverId`, `status: "PENDING"`, `sentAt`, `expiresAt`.
Giữ `bookingIdA` và `tripRequestId` cho mục 16. Offer đã commit cùng outbox
và Driver có thể đọc; response này chưa chứng minh Notification đã giao.
Nếu `initialOffer` vắng mặt, Booking vẫn được tạo nhưng chưa chứng minh đã
gửi offer; kiểm tra điều kiện Driver/worker trước khi chấm mục này.

Tuyến demo server quản lý: 1.250 m, cước 6.625 VND. Không gửi tiền/quãng đường từ client.

**Kết thúc mục 15:** một POST cho thấy Booking đã tạo, tiến trình SEARCHING
và offer PENDING có ID thật. Offer đầu tiên có tối đa 2 phút kể từ `sentAt`,
theo `expiresAt`; các offer về sau có thể ngắn hơn do hạn tìm chung 180 giây.
Chuẩn bị token
của Driver được chọn trước khi thao tác tiếp. Với nhóm Driver demo riêng,
tìm đúng `driverId` trong file local ignored
`.secrets/customer-dev/nearby-demo/drivers.json`, đăng nhập email/password
của entry đó để lấy token Driver; không chép credential vào collection chia sẻ.

POST trả 201 thì không cần tra cứu operation. Chỉ gặp 202 mới dùng phụ lục A.

## 16. POSTMAN — Driver nhận chuyến

### 16.1. Chấp nhận offer

```text
POST /v1/trip-requests/<tripRequestId>/accept
Auth: Driver có ID đúng `initialOffer.driverId` của response mục 15
```

Driver demo riêng cho mục này: đăng nhập `driver@example.test` bằng mật khẩu
đã được chủ dự án chọn. Hồ sơ đã được duyệt, xe MOTORBIKE và GPS demo được
làm mới tự động. Với điểm đón demo `10.7769,106.7009`, đối chiếu
`initialOffer.driverId` với Driver ID của tài khoản này trước khi chấp nhận;
nếu offer thuộc Driver khác, không dùng token tài khoản này để nhận thay.

```json
{}
```

Giữ tripIdA. Nếu 202, dùng phụ lục A.

### 16.2. Customer xem Driver được phân công

```text
GET /v1/trips/<tripIdA>
Auth: Customer C
Body: none
```

Kiểm tra thông tin Driver được gán, trạng thái và version Trip.

### 16.3. Kiểm tra thông báo tương ứng

```text
GET /v1/notifications?limit=20
Auth: Driver hoặc Customer của chuyến
Body: none
```

Dùng từng token để xem thông báo riêng của từng người.

**Cần chứng minh:** Driver chấp nhận, Trip gắn đúng Driver, Customer nhận thông tin Driver.

## 17. POSTMAN — Cập nhật trạng thái chuyến

Dùng Trip A. Giá đã chốt trong Booking; chưa cần tạo Payment trước khi chạy chuyến.

### 17.1. Chuyển trạng thái theo thứ tự

```text
PATCH /v1/trips/<tripIdA>/status
Auth: Driver A
```

| Thứ tự | Body mẫu |
|---|---|
| Đến điểm đón | `{"expectedVersion":1,"tripStatus":"ARRIVED_PICKUP"}` |
| Đã đón khách | `{"expectedVersion":2,"tripStatus":"PICKED_UP"}` |
| Bắt đầu chuyến | `{"expectedVersion":3,"tripStatus":"IN_PROGRESS"}` |

Các số 1–3 chỉ là ví dụ. Lấy version Trip thực tế từ response hoặc GET Trip.

### 17.2. Cập nhật vị trí trong chuyến

```text
PUT /v1/drivers/me/location
Auth: Driver A
```

```json
{
  "latitude": 10.777,
  "longitude": 106.701
}
```

Trong Compose demo, Gateway tự ghi `recordedAt` khi nhận request. Production
vẫn yêu cầu client gửi thời điểm thiết bị lấy mẫu; cách rút gọn này không
chứng minh độ mới của mẫu trên thiết bị.

Customer C xem:

```text
GET /v1/trips/<tripIdA>/tracking
Auth: Customer C
Body: none
```

### 17.3. Hoàn thành

```text
PATCH /v1/trips/<tripIdA>/status
Auth: Driver A
```

```json
{
  "expectedVersion": 4,
  "tripStatus": "COMPLETED"
}
```

Thay version 4 bằng giá trị hiện tại.

**Cần chứng minh:** đúng thứ tự trạng thái, cập nhật GPS/tracking, Trip hoàn thành.

Giữ Trip A COMPLETED cho mục 20. Xác nhận CASH xem phụ lục B.

### 17.4. Thanh toán CASH sau chuyến

Customer sở hữu Trip A gọi `POST /v1/trips/<tripIdA>/payments` với
`Idempotency-Key` mới và body `{"paymentMethod":"CASH"}`. Giữ paymentIdA;
Payment mới ở PENDING. Sau đó đúng Driver đã chạy Trip xác nhận đã nhận tiền
theo phụ lục B. Trip COMPLETED và Payment SUCCESS là hai kết quả riêng.

## 18. POSTMAN — Hủy chuyến

Dùng **Trip B riêng**, chưa bắt đầu chạy; không hủy Trip A đã hoàn thành.

1. Dùng token Customer chủ Trip B gửi:

```text
POST /v1/trips/<tripIdB>/cancel
Auth: Customer chủ Trip B
```

```json
{
  "reason": "Khách thay đổi kế hoạch — demo chấm"
}
```

2. GET Trip kiểm tra CANCELLED.
3. Customer và Driver GET `/v1/notifications?limit=20`.

Gateway đọc version hiện tại và dùng mã `CHANGE_OF_PLANS` cho request rút gọn
của Customer. Trip vẫn kiểm tra version và quyền; nếu chuyến đổi trạng thái
đồng thời, gửi lại sau khi GET Trip để xác định hiện trạng.

**Cần chứng minh:** có lý do hủy, Trip CANCELLED, các bên nhận thông báo.

## 19. POSTMAN — Thanh toán online giả lập

Dùng **Trip C riêng đã COMPLETED** theo thứ tự trạng thái mục 17.1–17.3.
Sau đó Customer mới tạo Payment DEMO_TRANSFER và giả lập kết quả.

### 19.1. Tạo DEMO_TRANSFER Payment

Nếu đã chuẩn bị Payment thì đọc lại, không tạo khoản khác.

```text
POST /v1/trips/<tripIdC>/payments
Auth: Customer chủ Trip C
Header: Idempotency-Key mới
```

```json
{"paymentMethod":"DEMO_TRANSFER"}
```

Giữ paymentIdC, attemptId và Payment version.

### 19.2. Xem tiền đã chốt

```text
GET /v1/trips/<tripIdC>/fare
Auth: Customer chủ Trip C
Body: none
```

Tuyến demo trên có cước 6625 VND.

### 19.3. Giả lập kết quả thành công

```text
POST /v1/payments/<paymentIdC>/demo-result
Auth: Customer chủ Payment
Header: Idempotency-Key riêng cho kết quả
```

```json
{
  "attemptId": "ATTEMPT_ID_HIEN_TAI",
  "expectedVersion": 1,
  "expectedAmount": 6625,
  "currency": "VND",
  "outcome": "SUCCESS"
}
```

Dùng Payment version hiện tại, đúng attempt và số tiền.

**Lưu nguyên URL, key, Body và response thành công để dùng mục 30.**

### 19.4. Kiểm tra

```text
GET /v1/payments/<paymentIdC>
Auth: Customer chủ Payment
Body: none
```

Kiểm tra SUCCESS và đúng số tiền. Trip C đã COMPLETED trước khi tạo Payment;
thao tác thanh toán không thay đổi trạng thái Trip.

**Cách trình bày:** phiếu ghi Payment COMPLETED và nhận callback. CAB MVP dùng trạng thái thành công SUCCESS và thao tác demo-result để giả lập kết quả; không phải callback ngân hàng thật. Cần đối chiếu cách quy đổi này khi chấm.

## 20. POSTMAN — Đánh giá chuyến

Dùng Trip A COMPLETED ở mục 17.

```text
POST /v1/trips/<tripIdA>/rating
Auth: Customer C chủ chuyến
```

```json
{
  "score": 5,
  "comment": "Tài xế đến đúng điểm đón và lái xe cẩn thận."
}
```

**Mong đợi:** 201, Rating gắn đúng Trip/Customer/Driver lịch sử.

Đọc lại:

```text
GET /v1/trips/<tripIdA>/rating
Auth: Customer C
Body: none
```

Mong đợi 200 cùng ratingId.

Không cần Idempotency-Key hoặc Payment SUCCESS. Trip phải COMPLETED.

## 21. POSTMAN — Đăng ký Driver qua OTP

Dùng Driver D mới, không đăng ký lại Driver A.

### 21.1. Xin OTP

```text
POST /v1/auth/driver-registration/otp
Auth: No Auth
```

```json
{"phone":"0900000302"}
```

202: giữ challengeId. Lấy OTP demo từ response nếu được bật, nếu không dùng cách lấy OTP trong README hiện hành.

### 21.2. Xác minh

```text
POST /v1/auth/driver-registration/otp/verify
Auth: No Auth
```

```json
{
  "challengeId": "CHALLENGE_ID",
  "otp": "MA_OTP"
}
```

200: giữ verificationToken. OTP là chuỗi.

### 21.3. Gửi hồ sơ

```text
POST /v1/driver-applications
Auth: No Auth
```

```json
{
  "verificationToken": "VERIFICATION_TOKEN",
  "fullName": "Tai Xe Cham Demo D",
  "email": "driver.cham.d@example.com",
  "password": "DemoCab2026!",
  "licenseNumber": "790123456793",
  "vehicle": {
    "plateNumber": "59A1-12003",
    "vehicleType": "MOTORBIKE"
  }
}
```

Dùng thông tin chưa trùng.

**Cần chứng minh:** hồ sơ SUBMITTED/PENDING_APPROVAL, Driver OFFLINE.

Giữ applicationIdD, driverIdD. Chưa duyệt tại mục 21.

## 22. POSTMAN — Duyệt hoặc từ chối hồ sơ Driver

### 22.1. Operator mở danh sách chờ duyệt

```text
GET /v1/operations/driver-applications?status=SUBMITTED&limit=20
Auth: Operator
Body: none
```

Xác định đúng hồ sơ D và Application version.

**Xem chi tiết:** mở request chi tiết hồ sơ trong collection Driver Registration hiện hành. URL chi tiết chưa được cung cấp trong các đoạn collection của cuộc trò chuyện, nên cần đối chiếu trước buổi chấm.

Driver D login rồi GET `/v1/drivers/me` để lấy version Driver phục vụ review.

### 22.2. Duyệt

```text
POST /v1/operations/driver-applications/<applicationIdD>/review
Auth: Operator
```

```json
{
  "decision": "APPROVED",
  "expectedVersion": 1,
  "expectedDriverVersion": 1
}
```

Hai version lấy từ đúng hai đối tượng.

**Mong đợi:** APPROVED, có xe gắn cho Driver, Driver vẫn OFFLINE.

### 22.3. Driver xem kết quả

Dùng Driver D token:

```text
GET /v1/drivers/me
GET /v1/notifications?limit=20
```

Body none.

**Cần chứng minh:** trạng thái hồ sơ thay đổi và Driver nhận kết quả.

### Nhánh từ chối nếu cần trình diễn cả hai

Dùng hồ sơ E riêng đang chờ duyệt:

```text
POST /v1/operations/driver-applications/<applicationIdE>/review
Auth: Operator
```

```json
{
  "decision": "REJECTED",
  "expectedVersion": 1,
  "expectedDriverVersion": 1,
  "rejectionReason": "Thông tin hồ sơ chưa đầy đủ — demo chấm"
}
```

Driver E đọc hồ sơ/thông báo: REJECTED, OFFLINE, có lý do.

Không từ chối lại hồ sơ D vừa APPROVED.

## 23. POSTMAN — Bật/tắt nhận chuyến

Dùng Driver D vừa được duyệt, không có chuyến đang hoạt động.

1. GET `/v1/drivers/me`, lấy Driver version.
2. Bật nhận chuyến (ONLINE) trong Compose demo, không cần gửi GPS riêng:

```text
PUT /v1/drivers/me/availability
Auth: Driver D
```

```json
{
  "driverStatus": "AVAILABLE",
  "expectedVersion": 2
}
```

3. GET hồ sơ xác nhận AVAILABLE và lấy version mới.
4. Tắt nhận chuyến (OFFLINE):

```json
{
  "driverStatus": "OFFLINE",
  "expectedVersion": 3
}
```

Cùng URL và Auth. Thay version 2/3 bằng số thực tế.

5. GET hồ sơ xác nhận OFFLINE.

API vẫn dùng `driverStatus: AVAILABLE/OFFLINE`; ONLINE là tên thao tác trong
Postman. Compose demo tự đặt vị trí mẫu gần điểm đón nếu Driver chưa có GPS mới.
Vị trí mẫu chỉ có hiệu lực tìm xe trong 30 giây; nếu thử Booking sau đó, cần
làm mới vị trí hoặc bật lại theo version hiện tại. Production vẫn cần GPS thật.

**Cần chứng minh:** hệ thống ghi nhận bật/tắt đúng.

## 24. Data encryption at rest

**Công cụ:** API tạo dữ liệu + công cụ DB/code cấu hình.

Thao tác:

1. Chọn tài khoản/hồ sơ demo.
2. Dùng truy vấn chỉ đọc đúng schema để xem trường lưu mật khẩu và dữ liệu nhạy cảm được mã hóa.
3. Chứng minh không thấy mật khẩu nguyên văn.
4. Cho xem cơ chế quản lý khóa/quyền, không mở giá trị khóa.

**Phân biệt:** mật khẩu cần băm một chiều; theo bàn giao Identity dùng Argon2. Không đổi mật khẩu sang mã hóa giải mã được chỉ để giống hình minh họa.

Băm mật khẩu riêng lẻ chưa chứng minh mã hóa mọi dữ liệu nhạy cảm hoặc quản lý khóa.

**Cần chuẩn bị thêm:** truy vấn DB read-only đúng bảng/cột hiện hành từ repo/Codex. Collection Postman không đủ bằng chứng cho mục này.

## 25. POSTMAN — SQL injection

```text
POST /v1/auth/login
Auth: No Auth
```

```json
{
  "emailOrPhone": "' OR 1=1 --",
  "password": "anything"
}
```

**Mong đợi:** 400 hoặc 401; không có token; không lộ SQL/dữ liệu DB.

CAB dùng `emailOrPhone`, dù ví dụ trong phiếu dùng `email`. Gửi sai tên trường chỉ chứng minh validation thiếu trường.

## 26. POSTMAN — XSS input

Chuẩn bị một Trip riêng COMPLETED, thuộc Customer kiểm thử và chưa có Rating.

```text
POST /v1/trips/<tripIdXss>/rating
Auth: Customer chủ Trip
```

```json
{
  "score": 5,
  "comment": "<script>alert('hack')</script>"
}
```

Nếu được lưu, GET cùng URL để đọc lại. Nếu bị validator từ chối, ghi status thực tế.

**Cần chứng minh theo phiếu:** script không thực thi và output xử lý an toàn khi hiển thị.

**Giới hạn:** Postman hiển thị JSON không chạy script không đủ chứng minh giao diện web chống XSS. Nếu chưa có giao diện hiển thị nhận xét, cần bằng chứng renderer/encoding phù hợp và thống nhất với giảng viên. Không tự ghi PASS đầy đủ chỉ vì response là JSON.

## 27. POSTMAN — JWT tampering

1. Login lấy token Customer hợp lệ.
2. Tạo bản sao token, sửa payload `sub` hoặc role nếu có, giữ nguyên signature bằng công cụ local.
3. Gọi:

```text
GET /v1/accounts/me
Auth: Bearer Token đã sửa
Body: none
```

**Mong đợi:** 401, không trả Account, không nâng quyền.

Token có thể decode được nhưng phải bị từ chối khi xác minh chữ ký. Không ký lại token, không dùng private key, không đưa token thật lên website công cộng.

Cần chuẩn bị token demo đã sửa trước phần chấm này.

## 28. POSTMAN — Truy cập API không đúng quyền

```text
GET /v1/drivers/me
Auth: Customer token hợp lệ
Body: none
```

**Mong đợi:** 403 Forbidden, không trả hồ sơ Driver.

Nếu 401, kiểm tra token hết hạn; 401 chưa chứng minh chặn theo role.

## 29. Rate limit

**Request mục tiêu:** POST `/v1/bookings`, Customer demo token, Body hợp lệ như mục 15.

**Thao tác:**

1. Dùng bộ test tải Booking được dự án chuẩn bị trên môi trường/dữ liệu demo riêng.
2. Cho xem 429 khi vượt ngưỡng, số request và thời gian đo.
3. Sau tải, gọi `/health`, `/ready` và API hợp lệ để kiểm tra hệ thống còn phục vụ.

**Cần chứng minh:** giới hạn hoạt động, không sập hệ thống; đối chiếu yêu cầu >1.000 request/giây trong phiếu.

Không coi vài lần bấm Send hoặc Collection Runner là bằng chứng đạt >1.000 request/giây.

Báo cáo 1.202 request/giây trước đây là harness HTTP cô lập Linux, không phải benchmark end-to-end Compose.

**Cần chuẩn bị thêm:** lệnh/cấu hình tải đã đối chiếu trong repo hiện hành. Không chạy vòng lặp POST tùy tiện trên Customer đang chấm vì có thể tạo dữ liệu hoặc chạm guard nghiệp vụ.

## 30. POSTMAN — Replay Payment, không thanh toán trùng

Dùng lại request demo-result thành công đã lưu ở mục 19.

### 30.1. Gửi lặp

- Cùng URL `/v1/payments/<paymentIdC>/demo-result`.
- Cùng Customer chủ Payment; có thể login lấy token mới của cùng tài khoản.
- Giữ nguyên Idempotency-Key.
- Giữ nguyên Body, kể cả expectedVersion cũ.
- Không đổi key hoặc attemptId.

### 30.2. Đối chiếu

1. Response trả kết quả đã lưu.
2. GET `/v1/payments/<paymentIdC>`: vẫn Payment cũ, số tiền đúng, trạng thái thành công.
3. Nếu cần chứng minh receipt/transaction không tăng, đưa truy vấn DB read-only hoặc bằng chứng test tương ứng.

**Cần chứng minh:** không xử lý lại giao dịch, không ghi nhận tiền lần hai, trả response cũ.

Response giống nhau một mình chưa chứng minh toàn bộ bản ghi DB không trùng.

---

## Phụ lục A — Tra cứu 202: chỉ dùng khi phát sinh

| Tình huống | Request | Auth |
|---|---|---|
| Tạo Booking trả 202 | GET `/v1/booking-operations/<operationId>` | Customer gửi yêu cầu |
| Accept offer trả 202 | GET `/v1/dispatch-operations/<operationId>` | Driver nhận offer |

Body none. operationId phải lấy đúng response của thao tác đó.

Còn xử lý thì đợi rồi GET lại. POST trả 201 có kết quả thì bỏ qua phụ lục này.

Recovery Customer/Driver đăng ký dùng collection riêng; không dùng URL Booking thay thế.

## Phụ lục B — Xác nhận tiền mặt

Sau Trip CASH COMPLETED và Driver đã nhận tiền:

```text
POST /v1/payments/<paymentIdA>/confirm-cash
Auth: Driver được gán cho Trip
Header: Idempotency-Key riêng
```

```json
{"expectedVersion":1}
```

Dùng Payment version hiện tại.

Đây là bước hoàn tất nhánh CASH, không thay tiêu chí thanh toán online mục 19.

## Phụ lục C — GPS mới và lỗi thường gặp

Trong Compose demo, chỉ gửi hai tọa độ:

```text
PUT /v1/drivers/me/location
Auth: Driver cần cập nhật
```

```json
{
  "latitude": 10.7769,
  "longitude": 106.7009
}
```

Tìm nearby/bật AVAILABLE ngay sau khi cập nhật.

| Lỗi | Xử lý |
|---|---|
| LOCATION_STALE | Gửi GPS mới |
| VERSION_CONFLICT | GET đúng đối tượng để lấy version mới; ngoại lệ replay mục 30 giữ nguyên Body cũ |
| 401 | Login lại đúng tài khoản |
| 403 | Kiểm tra role và quyền |
| 404 với `//v1` | Bỏ một dấu `/` thừa |
| 400 | raw JSON, đúng tên trường/kiểu dữ liệu, thay placeholder |
| Nearby rỗng | Kiểm tra GPS, vị trí, AVAILABLE, APPROVED, xe và điều kiện nhận chuyến |
| 503 | Kiểm tra readiness/log; không mặc định sai mật khẩu |

Sinh Idempotency-Key:

```powershell
[guid]::NewGuid().ToString()
```

Xem trạng thái/log:

```powershell
docker compose ps
docker compose logs --tail=100 api-gateway identity-service
```

## Phụ lục D — Không chen vào lượt chấm chính

Các bước sau chỉ làm khi giảng viên yêu cầu hoặc khi kiểm thử mở rộng:

- Tra cứu operation nếu không nhận 202.
- Incident/Trip ERROR, restore/close abnormal.
- Closure polling.
- Payment FAILED/retry.
- Hủy sau thanh toán, rà soát thủ công.
- Rating replay/khác nội dung ngoài yêu cầu mục 20.
- Các request quản trị bổ sung không có trong phiếu.

## Danh sách cần hoàn thiện trước buổi chấm

- [ ] Mục 12: đối chiếu URL và quyền Driver-by-ID.
- [ ] Mục 13: đủ fixture Driver và có trang sau để trình diễn paging.
- [ ] Mục 14: Customer có ít nhất 5 Booking.
- [ ] Mục 22: đối chiếu request xem chi tiết hồ sơ Operator.
- [ ] Mục 24: chuẩn bị truy vấn DB và bằng chứng quản lý khóa.
- [ ] Mục 26: chuẩn bị bằng chứng XSS theo ngữ cảnh hiển thị.
- [ ] Mục 27: chuẩn bị bản JWT demo bị sửa payload.
- [ ] Mục 29: chuẩn bị lệnh tải và bằng chứng đúng phạm vi.
- [ ] Mục 30: lưu nguyên request thành công ở mục 19.
- [ ] Đối chiếu PDF mới nếu nội dung khác ảnh phiếu đã dùng.

Không đánh dấu 30/30 PASS chỉ vì hoàn thành luồng đặt xe chính.
