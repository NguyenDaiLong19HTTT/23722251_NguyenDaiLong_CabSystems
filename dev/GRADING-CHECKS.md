# Kiểm tra thủ công các mục chấm bổ sung

Base URL của mọi request là http://127.0.0.1:33201. Tạo request trống trong
Postman rồi nhập method, URL, Header và Body ở dưới; không dùng environment,
pre-request script hoặc token có sẵn trong collection. Dùng các collection
Customer/Driver/Booking–Trip–Payment/Rating trong dev/postman để chuẩn bị
Customer, Driver MOTORBIKE đã duyệt và một Trip thật. Đăng nhập từng tài khoản
bằng POST http://127.0.0.1:33201/v1/auth/login, Body JSON
{"emailOrPhone":"<email hoặc phone>","password":"<mật khẩu local>"}.
Chép accessToken từ response; không lưu vào collection chia sẻ.

## Driver theo ID — mục 12

Nếu đã có `driverId` của Driver A, tạo request GET
http://127.0.0.1:33201/v1/drivers/<driverId> trong Postman. Chọn Auth →
Bearer Token và dán **accessToken** của OPERATOR; Body để none. Không dùng
`/drivers/me` làm request chấm điểm. Kết quả 200 chỉ có `driverId` đúng ID
trong URL và `fullName` của Driver A.

Có thể dùng token của chính Driver A để đọc ID của họ. Nếu dùng Customer,
Customer phải từng có Trip được phân công cho Driver A: GET
http://127.0.0.1:33201/v1/trips?limit=20 với Bearer Customer để lấy
`items[].tripId`, sau đó GET /v1/trips/<tripId> để lấy `driverId` từ chi tiết
Trip; cuối cùng GET /v1/drivers/<driverId> với cùng token Customer.
Danh sách Trip tóm tắt **không có** `driverId`.

Driver chủ ID và OPERATOR cũng được 200;
Customer không có Trip với Driver đó và Driver khác nhận 404. ID UUID không
tồn tại trả 404, ID sai dạng trả 400, thiếu/sai token trả 401. Không dùng
GET /v1/drivers/me thay cho request theo ID.

## Nearby — mục 13

Sau `docker compose up -d`, đợi `nearby-demo-gps` healthy. Ít nhất năm Driver demo
riêng đã APPROVED, AVAILABLE và có MOTORBIKE ACTIVE được container này cập
nhật GPS qua Gateway bằng token Driver mỗi 12 giây. Đây là dữ liệu vị trí
**giả lập chỉ cho demo**, không bỏ quy tắc GPS mới tối đa 30 giây hoặc xác thực.
Không cần chạy lệnh Node trước khi bấm Send trong Postman.

Tạo request GET
http://127.0.0.1:33201/v1/drivers/nearby?latitude=10.78&longitude=106.7
với **Auth → Bearer Token → token OPERATOR** vừa đăng nhập; Body none.
Kỳ vọng 200, `items` có ít nhất năm Driver demo, `radiusKm=1`, `limit=20`,
`hasMore=false`. Token CUSTOMER vẫn được phép theo API03. Thêm `&limit=2`
vào URL ngắn để chứng minh phân trang; chép
`nextCursor` vào request kế tiếp và giữ nguyên các tham số khác. Nếu không
đủ năm, kiểm tra `docker compose ps nearby-demo-gps` và
`docker compose logs --tail=100 nearby-demo-gps`; không tự bỏ điều kiện GPS.

Kịch bản GPS thủ công riêng: Driver synthetic đã duyệt cập nhật PUT
http://127.0.0.1:33201/v1/drivers/me/location, Authorization Bearer Driver
token, Content-Type application/json, Body
{"latitude":10.7777,"longitude":106.7009}. Compose demo tự ghi recordedAt lúc Gateway nhận request; production vẫn yêu cầu timestamp thiết bị.
Sau đó PUT /v1/drivers/me/availability với Body
{"expectedVersion":<version từ GET /v1/drivers/me>,"driverStatus":"AVAILABLE"}.
Kết quả sắp distance rồi driverId. Thử xa hơn 1 km, OFFLINE, GPS cũ trên
Driver synthetic **khác năm Driver của nguồn GPS demo**. Không sửa TaiXeDemo1
hoặc đổi xe legacy. Script opt-in dev/nearby-negative-http.mjs
kiểm tra 999 m, 1001 m, OFFLINE và GPS cũ; script khôi phục GPS/trạng thái.

## Danh sách Booking Customer — mục 14

Customer L cho buổi chấm là `dailong@gmail.com`; mật khẩu được chủ dự án chọn
và lưu riêng tại `.secrets/customer-dev/grading_customer_l_password` (ignored).
Đăng nhập bằng POST http://127.0.0.1:33201/v1/auth/login, Body
`{"emailOrPhone":"dailong@gmail.com","password":"<mật khẩu đã chọn>"}`.
Sao chép `accessToken`, không dùng token OPERATOR cho request này.

Tạo GET http://127.0.0.1:33201/v1/bookings?limit=2 với Auth → Bearer Token
là token Customer L, Body none. Kỳ vọng 200, trang đầu hai Booking và
`hasMore=true`. Trang sau thêm `&cursor=<nextCursor>` đúng giá trị trả về,
giữ `limit=2`; duyệt lần lượt 2/2/1 Booking. Năm Booking fixture được tạo
qua Gateway rồi hủy để không giữ Trip/Driver đang hoạt động; `CANCELLED`
vẫn thuộc danh sách theo API02. Token OPERATOR gọi danh sách này trả 403.

## SQL injection và XSS — mục 25/26

POST http://127.0.0.1:33201/v1/auth/login, Content-Type application/json,
Body {"emailOrPhone":"' OR 1=1 --","password":"synthetic-only"}:
400 VALIDATION_ERROR. Dạng email hợp cú pháp nhưng chứa dấu nháy
{"emailOrPhone":"a'OR1=1--@example.test","password":"synthetic-only"}
trả 401 INVALID_CREDENTIALS. Không đăng nhập thành công. Lệnh read-only
audit-login-injection trong dev/compose kiểm tra Account/Session không đổi.

Với Trip COMPLETED riêng, Customer POST
http://127.0.0.1:33201/v1/trips/<tripId>/rating, Bearer Customer token,
Content-Type application/json, Body
{"score":5,"comment":"<script>alert('hack')</script>"}.
Response 201 application/json; GET cùng URL trả nguyên nhận xét như văn bản.
Payload này không được diễn giải là HTML trong client. CAB chưa có frontend,
nên HTTP/Postman không chứng minh contextual output encoding tại chỗ render
HTML. Script dev/booking-http-e2e.mjs rating dùng Trip/Customer synthetic thật
để thử dữ liệu này, không dùng Trip người dùng.

## Booking rate limit — mục 29

Chỉ chạy script dev/booking-limit-http.mjs khi sẵn sàng chờ tối đa 60 giây
trước khi tạo Booking từ cùng máy: script gửi 30 POST /v1/bookings Body {}
trả 400 rồi request tiếp theo trả 429 RATE_LIMIT_EXCEEDED với Retry-After.
Request bị chặn không tới Booking service; GET /v1/bookings không bị limiter
tạo Booking. Sau Retry-After, request hợp lệ/validation được xử lý lại.
Limiter demo hiện theo peer IP, 30/phút trên một Gateway; không tuyên bố
distributed. Script test/booking-rate-load-built.mjs chạy trên HTTP adapter
tạm riêng, 1.200 request hữu hạn và báo tốc độ đo thực tế; không chạy trên
Compose demo.

## Payment replay — mục 30

Từ Trip thật lấy tripId sau Driver chấp nhận offer, chuyển Trip đến
`COMPLETED` rồi mới tạo Payment. Customer POST
http://127.0.0.1:33201/v1/trips/<tripId>/payments, Headers Bearer Customer
token, Content-Type application/json, Idempotency-Key: <UUID riêng>;
Body {"paymentMethod":"DEMO_TRANSFER"}. Gửi lại cùng key/Body: 201 và cùng
paymentId. Cùng key đổi paymentMethod sang CASH: 409 IDEMPOTENCY_CONFLICT.
Key mới cho Trip đã có Payment: 409 PAYMENT_ALREADY_EXISTS. GET
/v1/payments/<paymentId>/attempts?limit=20 cho thấy một Attempt.

POST /v1/payments/<paymentId>/demo-result với key khác, Body
{"attemptId":"<currentAttemptId>","expectedVersion":<version>,
"expectedAmount":<amount>,"currency":"VND","outcome":"SUCCESS"}:
200 SUCCESS. Gửi lại cùng key/Body: cùng kết quả. Gửi FAILED muộn với key mới:
409 PAYMENT_NOT_PENDING; GET Payment vẫn SUCCESS. Notification list của
Customer chỉ có một PAYMENT_SUCCESS với referenceId=paymentId. Script opt-in
dev/booking-http-e2e.mjs payment-replay tạo fixture synthetic mới; lệnh
dev/compose/audit-payment-replay.mjs đếm Fare/Payment/Attempt/receipt/outbox
read-only. Không gửi lại lệnh tạo trên Trip người dùng khi chưa xem trạng thái.

## Bảo vệ dữ liệu — mục 24

Postman không đọc DB/key. Chạy audit-data-protection.mjs bên trong container
Identity/Driver bằng quyền runtime và chỉ in cờ kiểm chứng hash
Argon2id, ciphertext/nonce/tag, HMAC và key mount ngoài DB. Image không chứa
.secrets; Dockerfile loại qua .dockerignore. Password là hash một chiều,
không phải mã hóa giải ngược. Không in giá trị key, hash hoặc PII khi trình bày.

## Health và Trip ERROR

GET http://127.0.0.1:33201/health không cần token: 200 `{"status":"UP"}`
chỉ chứng minh Gateway còn sống. GET http://127.0.0.1:33201/ready không cần
token: 200 `{"status":"READY"}` khi các probe còn mới và đều đạt, ngược lại
503 `{"status":"NOT_READY"}`. GET
http://127.0.0.1:33201/health/services không cần Authorization: 200 với
12 thành phần gồm MongoDB. Báo cáo 503 nếu thành phần bắt buộc DOWN/UNKNOWN. Snapshot probe tối
đa 25 giây; mỗi container tự kiểm tra listener mTLS, database runtime,
RabbitMQ/MongoDB cần thiết và heartbeat vòng worker. Chỉ một Gateway demo dùng
limiter trong tiến trình, nên Redis không thuộc Compose/readiness này. Script
`node dev/health-http.mjs` chỉ đọc runtime; test health.spec.ts dùng thư mục
tạm để mô phỏng probe lỗi/cũ, không dừng database/broker demo.

Với một Trip tổng hợp riêng đang ERROR và chưa đóng, lấy `tripId` và `version`
từ GET http://127.0.0.1:33201/v1/trips/<tripId> bằng Customer/Driver chủ
chuyến. OPERATOR gửi POST
http://127.0.0.1:33201/v1/operations/trips/<tripId>/resolve-error với
`Authorization: Bearer <Operator token>`, `Content-Type: application/json`,
Body `{"expectedTripVersion":<version>,"resolutionAction":"RESTORE_PREVIOUS_STATUS","resolutionNote":"Đã xác minh Driver, xe và guard"}`.
200 chỉ khi Account/Driver/xe/reservation/guard còn hợp lệ; cùng Body gửi lại
trả snapshot cũ. Sau một Incident ERROR mới, dùng version mới và
`"resolutionAction":"CLOSE_ABNORMALLY"` cùng note để đóng: 200 ghi Trip và
closure bền vững; GET /v1/trips/<tripId>/closure cho biết release đã hoàn tất
hay còn PROCESSING. Body khác sau khi đóng trả 409 TRIP_NOT_RESOLVABLE;
Customer/Driver không có quyền POST. Không sửa Trip người dùng để thử; script
opt-in `node dev/booking-http-e2e.mjs resolve-incident` tự tạo Customer,
Booking, Trip/Incident tổng hợp, kiểm tra restore/close/Notification và release.
Audit SQL đọc-only nằm ở `dev/compose/audit-trip-resolution.mjs`.

D03 giữ JourneyMetrics PENDING/REVIEW_REQUIRED để OPERATOR rà soát thủ công
theo quyết định chủ dự án; chưa có ngưỡng tự động hoặc thao tác xác nhận trong
demo. Cước cố định đã chốt không tính lại từ GPS.
