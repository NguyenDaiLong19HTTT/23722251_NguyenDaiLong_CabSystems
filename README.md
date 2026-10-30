# CAB demo (Docker Compose)

Compose `cab` hiện gồm Booking, Trip, Payment và Rating thật bên cạnh Identity,
Customer, Driver, Notification, Gateway và ba thành phần hạ tầng. Sau khi đã
thiết lập local secret/database một lần, `docker compose up -d` là lệnh chạy
thường ngày. Customer có thể tạo Booking MOTORBIKE với giá cố định từ Payment,
Driver nhận offer, Trip chạy lifecycle và Payment CASH/DEMO_TRANSFER; sự kiện
đi qua RabbitMQ vào Notification MongoDB. Postman nhập tay tại
[`dev/postman/CAB-Booking-Trip-Payment-Manual.postman_collection.json`](dev/postman/CAB-Booking-Trip-Payment-Manual.postman_collection.json).
Rating có [collection nhập tay](dev/postman/CAB-Rating-Manual.postman_collection.json).
Các mục Health, Driver theo ID, Nearby, SQLi/XSS, Booking limiter, Payment
replay và Trip ERROR có [hướng dẫn Postman nhập tay](dev/GRADING-CHECKS.md).
Đây là demo; D03 đã chọn rà soát JourneyMetrics thủ công, bản ghi vẫn PENDING
cho đến khi có thao tác xác nhận riêng. Postman GUI chưa được chạy tự động.

Từ Git root, sau khi đã thiết lập local secret/volume một lần, chạy toàn bộ demo trong **một Compose project `cab`**:

```powershell
docker compose up -d
```

Gateway cho Postman: `http://127.0.0.1:33201`. Chín app chạy trong container riêng: `api-gateway`, `identity-service`, `customer-service`, `driver-service`, `notification-service`, `payment-service`, `trip-service`, `booking-service`, `rating-service`. Hạ tầng gồm PostgreSQL, RabbitMQ, MongoDB; thêm `cert-renewer`, bảy migration job và broker setup riêng cho Payment/Trip/Booking. Không cần giữ terminal Node.

`GET /health`, `GET /ready` và `GET /health/services` tại Gateway đều không
cần token. Route cuối trả tên/trạng thái/checkedAt/reasonCode chuẩn hóa cho
12 thành phần; DOWN hoặc UNKNOWN trả HTTP 503. Không trả secret hay URL kết nối.

RabbitMQ Management UI cho demo: `http://127.0.0.1:15672` (chỉ bind
loopback). Username là `cab_dev_admin`; mật khẩu nằm trong file local đã ignore
`.secrets/customer-dev/rabbit_admin_password`. Chỉ đọc file trên máy để đăng
nhập, không dán mật khẩu vào chat hoặc commit. Cổng AMQPS 5671 vẫn chỉ dùng
trong mạng Compose, không publish ra host.

For blank Postman tabs without an environment or registration keys, see [manual Customer and Driver requests](dev/README.md#manual-postman-registration-compose-no-environment-required) and the [manual Driver OTP collection](dev/postman/CAB-Driver-Manual-OTP.postman_collection.json).

## Thiết lập một lần cho dữ liệu dev hiện có

Giữ nguyên `.secrets/customer-dev/` và bốn volume cũ. Từ Git root:

```powershell
node dev/compose/prepare.mjs
docker compose up -d --build
docker compose ps
```

Khi nâng cấp một bộ demo chưa có Booking, chạy `node dev/compose/setup-booking.mjs`
**một lần trước** `prepare.mjs`. Lệnh setup chỉ tạo `cab_booking`, migration/runtime
role và secret riêng; không reset database/volume đã có. Từ bộ đã thiết lập,
không chạy lại setup mỗi ngày.
Khi nâng cấp bộ cũ chưa có Rating, chạy `node dev/compose/setup-rating.mjs`
**một lần trước** `prepare.mjs` để tạo `cab_rating`, role và secret riêng.

`prepare.mjs` chỉ tạo bản sao credential đúng phạm vi cho từng runtime/migration job và thư mục certificate trong `.secrets/` đã ignore; chạy lại sẽ đối chiếu byte và từ chối bản sao khác nguồn. Cấu hình root Compose tham chiếu **tên external volume đã xác minh trên máy này**. Khi chuyển sang máy khác, phải restore backup và cập nhật mapping có kiểm chứng trước khi `up`; không để Compose tự tạo volume rỗng thay dữ liệu.

Chạy thường ngày từ Git root: mở Docker Desktop, rồi chạy `up`. Đợi
`/ready` trả `{"status":"READY"}` trước khi đăng nhập Operator/Customer/Driver
trong Postman để lấy token mới. Token của buổi trước không cần tái sử dụng.
Kết thúc buổi test bằng `stop`; hôm sau chỉ cần `up` lại và đợi ready.

Riêng Nearby câu 13, đợi thêm `nearby-demo-gps` healthy rồi dùng token
OPERATOR gọi URL ngắn trong `dev/GRADING-CHECKS.md` (mặc định 1 km, limit 20). Container demo này
giữ GPS mới cho ít nhất năm Driver synthetic riêng; không cần chạy lệnh Node trước
mỗi request Postman. Vị trí là giả lập, chỉ bật trong Compose dev. Thiết lập
một lần trên môi trường mới: sau khi Gateway đã chạy, gọi
`node dev/nearby-demo-setup.mjs` để tạo năm tài khoản demo qua OTP/duyệt; file
credential được lưu trong `.secrets/customer-dev/nearby-demo/` đã ignore.
Từ các lần sau chỉ dùng `docker compose up -d`.

```powershell
docker compose up -d
docker compose ps
Invoke-RestMethod http://127.0.0.1:33201/ready
docker compose stop
```

Khi source đổi, dùng `docker compose up -d --build`. Nếu chưa READY, xem
`docker compose ps` và `docker compose logs --tail=100 <service>`; không
đăng nhập liên tục để thử vận may. `stop` giữ container và dữ liệu.

```powershell
docker compose up -d --build
docker compose logs --tail=100 api-gateway
```

`down` xóa container/network của project `cab` nhưng external volume còn nguyên; không dùng `down -v` để xử lý lỗi. Migration job dùng role DDL riêng, chạy `migrate deploy` từ SQL đã review; app chỉ có runtime credential. Lỗi migration chặn app phụ thuộc. Operator/demo seed không chạy lúc `up`, nên không đổi mật khẩu hiện có.

Certificate workload dev vẫn có giới hạn **tối đa 24 giờ** theo transport policy.
`cert-renewer` cấp với khoảng đệm dưới 24 giờ, kiểm tra CA/SAN/EKU/khóa và
gia hạn khi khởi động hoặc kiểm tra mỗi giờ nếu còn dưới 12 giờ. Launcher
khởi động lại app khi fingerprint cert đổi (kiểm tra mỗi phút); CA và khóa
dữ liệu được giữ ngoài image. Healthcheck kiểm tra cả thời hạn tối đa, nên
`/ready` không báo sẵn sàng với chứng chỉ Gateway hiện biết là sai chính sách.
RabbitMQ healthcheck đợi ứng dụng cùng các listener trước khi broker setup
job chạy. Broker dùng cert DNS `rabbitmq` (và localhost cho môi trường cũ),
được đọc từ local secret; không tắt TLS/mTLS hoặc xác minh danh tính. Broker
certificate hạn 30 ngày: khi gần hết hạn, `docker compose stop` rồi
`docker compose up -d` để broker đọc chứng chỉ đã gia hạn. Nút **Start** trong
Docker Desktop chưa được xác minh là chạy migration/certificate setup như
`compose up`; dùng lệnh Compose.

## Postman và OTP dev

Import `dev/postman/CAB-Customer-Demo.postman_collection.json`, `CAB-Driver-Registration.postman_collection.json`, `CAB-Driver-Rejection.postman_collection.json`, `CAB-Notification.postman_collection.json` và environment `dev/postman/CAB-Customer-Demo.postman_environment.json`. Đặt `baseUrl=http://127.0.0.1:33201`. Theo thứ tự: Customer Register → Lookup nếu 202 → Login → Me → Profile; Driver OTP → Verify OTP → Submit → Operator Login → List/Detail → Review → Driver Profile → Notification List → Mark Read. Credential demo local nằm trong các manifest `*.json` và file `*_demo_password` tại `.secrets/customer-dev/`; không export Postman environment đã điền password/token.

Trong Compose demo, response 202 của `POST /v1/auth/driver-registration/otp`
trả `challengeId` và `otp` để nhập thủ công vào request verify; xem collection
`dev/postman/CAB-Driver-Manual-OTP.postman_collection.json`. Khi tắt cờ demo
hoặc ở production, response không có `otp`. Lệnh đọc OTP dev cũ dưới đây
chỉ là phương án dự phòng cục bộ theo challenge ID:

```powershell
docker compose run --rm --no-deps identity-service node dev/compose/launch.mjs otp <challengeId>
```

Chỉ dùng lệnh này trong dev; OTP được in ra terminal đang chạy lệnh, không vào image/Compose config.

## Dữ liệu và quay lại bộ cũ

Lần cutover ngày 2026-10-06 tái sử dụng volume chính xác theo `compose.yaml`:

| Dữ liệu | Volume giữ nguyên |
|---|---|
| PostgreSQL Identity/Customer/Driver | `cab-customer-dev-bdb8a430-c2b7-466e-ab77-7b509be16898_cab_dev_data` |
| RabbitMQ node `rabbit@95a48b840782` | `cab-customer-dev-bdb8a430-c2b7-466e-ab77-7b509be16898_cab_rabbit_data` |
| MongoDB data | `cab-customer-dev-bdb8a430-c2b7-466e-ab77-7b509be16898_cab_notification_data` |
| MongoDB configdb | `560f0f4b8c6702a09fb9c6cbf4fab0829980ea0669b08863e3b581d276f5d512` |

Backup nhất quán khi nguồn ghi/server cũ đã dừng nằm tại `.secrets/cab-cutover-backups/`: `postgres-quiesced.tgz`, `rabbitmq-quiesced.tgz`, `mongo-data-quiesced.tgz`, `mongo-config-quiesced.tgz`, cùng bản sao local secret/CA và baseline aggregate. Thư mục này đã ignore; không đưa vào Git/chat. Bộ container cũ của project `cab-customer-dev-bdb8a430-c2b7-466e-ab77-7b509be16898` được **giữ dừng**, không xóa. Nhóm `cab-bootstrap-test-*` và `cab-notification-harness-*` không bị dừng/xóa; Mongo harness còn dữ liệu thử nghiệm riêng, không trộn vào Mongo demo chính.

Muốn quay lại: dừng **toàn bộ** project mới bằng `docker compose stop`, xác nhận không còn app/publisher/consumer mới chạy, rồi mới khởi động lại đúng ba container data cũ và runner Node cũ bằng lệnh dev tương ứng. Không cho hai server cùng mount volume hoặc hai nhóm publisher/consumer cùng chạy. Trước khi rollback dữ liệu đã phát sinh trong project mới, chụp backup mới và đối chiếu baseline; không khôi phục backup cũ đè dữ liệu mới một cách tự động.

Chi tiết kiểm chứng và giới hạn nằm trong [status](docs/development/status.md) và [development README](dev/README.md).
