# Theo dõi 30 mục phiếu chấm CAB

## Cập nhật 2026-10-12 — bằng chứng mới (thay trạng thái lịch sử bên dưới)

| Mục | Bằng chứng hiện có | Còn thiếu để nghiệm thu đầy đủ |
|---|---|---|
| 13 Nearby | HTTP thật: 5 Driver MOTORBIKE synthetic trong 1 km, cursor size 2, xa 200/0 | Postman GUI, thử tải/biên rộng hơn |
| 14 Booking list | 5 Booking của cùng Customer, cursor size 2; đọc chéo 404 | Postman GUI |
| 15 Booking/offer | 201 có Payment PricingSnapshot 6.625 VND; dispatch tạo offer; NO_DRIVER_FOUND khi GPS cũ | Fault-injection/restart toàn tuyến, Postman GUI |
| 16 Driver nhận | HTTP offer→accept→Trip DRIVER_ASSIGNED qua Customer guard/Driver reservation/Trip ACTIVE; hai HTTP accept đồng thời cùng offer trả một Trip, cancel/closure giải phóng owner | Race nhiều instance và fault-injection trong project tách biệt |
| 17 Trip lifecycle | CASH và DEMO_TRANSFER qua ARRIVED_PICKUP→PICKED_UP→IN_PROGRESS→COMPLETED; GPS assigned LIVE, STOPPED sau đóng; HTTP Incident→ERROR giữ reservation | JourneyMetrics CONFIRMED/REVIEW_REQUIRED còn D03, Operations khôi phục/đóng ERROR, GUI |
| 18 Hủy/thông báo | 5 Booking hủy, Trip đã thanh toán hủy trước chạy; Notification TRIP_CANCELLED đúng owner; Payment giữ SUCCESS/review; bốn Trip đóng có closure SUCCEEDED | Fault-injection closure/release, Postman GUI |
| 19 Thanh toán demo | HTTP CASH confirm sau COMPLETED; DEMO_TRANSFER PENDING/FAILED chặn, retry SUCCESS, amount VND cố định | Không có provider thật theo MVP; GUI và thử tải |
| 20 Rating | HTTP thật: Customer chủ Trip COMPLETED/CASH PENDING tạo 5 sao + nhận xét; GET/replay cùng ID; nội dung khác 409; Customer khác 404, Driver/Operator POST 403; Driver/Operator đọc đúng phạm vi. PostgreSQL riêng kiểm chứng unique/concurrency/rollback; stop/start giữ Rating | Postman GUI và fault-injection nhiều instance chưa chạy; không có ranking/average theo MVP |
| 30 Chống thu trùng | HTTP Payment replay cùng key, CASH confirm replay, notification theo paymentId một bản; DB harness CAS/receipt | HTTP concurrent/late-result fault-injection tách biệt |

Các ca trên dùng Compose demo thật, không phải Postman GUI. Linux Vitest
74/74, `test:built`, build/typecheck, validator và PostgreSQL disposable cho
Booking/Trip/Rating PASS; harness test-only không thay thế HTTP proof.
Dockerfile chuẩn đã build và Compose đã triển khai image mới. Không đánh dấu
tất cả 30 mục PASS; Postman GUI và fault-injection toàn tuyến chưa chạy.

2026-10-10 Trip: service/database/mTLS/policy/Gateway slice có kiểm thử tĩnh,
PostgreSQL test-only và Compose HTTP 401/403/404/health. Preparation/activation owner
Booking/Customer guard/Driver reservation, Trip GPS/Incident và closure release
thật chưa đủ để đánh dấu mục 17/18 PASS. Payment decision gRPC mTLS đã chạy
với ledger thật nhưng principal/owner fixture trong harness; không đánh dấu
Payment–Booking–Trip end-to-end hoặc Postman GUI PASS.

2026-10-09 Payment: source, DB/migration, Gateway/mTLS, Compose health và
PostgreSQL harness riêng đã có bằng chứng; HTTP có token trả 503 đúng khi
thiếu Trip/Booking. Không nâng mục thanh toán thành PASS end-to-end từ kết quả
DB độc lập. Notification event Payment chưa có bằng chứng consumer runtime;
Postman GUI chưa chạy. MOTORBIKE chỉ cho request mới; profile xe legacy đọc
được, không sửa TaiXeDemo1.

2026-10-09: Identity eligibility and Driver candidate/nearby source compile,
but the new nearby migration is not deployed and no HTTP Booking proof exists.
Items 13–16 and 18 remain **CHƯA**. Five Driver and five Booking GUI fixtures
have not been prepared; no Trip/Payment integration or Postman GUI PASS is claimed.

Cập nhật đóng gói 2026-10-06: root Compose `cab` đã chạy năm app hiện có cùng
PostgreSQL/RabbitMQ/MongoDB; migration job và cert-renewer riêng. Kiểm chứng build,
typecheck, 55/55 test Linux, HTTP dữ liệu cũ và Driver review → Notification mới
đạt trong môi trường dev. Đây chỉ nâng bằng chứng mục Compose của **slice hiện có**;
không tự đổi trạng thái các mục Booking/Trip/Payment/Rating, health API hay Postman
GUI. Chi tiết và giới hạn tại `status.md`.

Cập nhật 2026-10-05. `PASS` chỉ là kiểm chứng tự động trong môi trường dev đã nêu, không phải Postman GUI hoặc review độc lập. `CHƯA` gồm cả mục ngoài phạm vi lượt này. Không thay Execution Status của workbook.

| # | Mục | Trạng thái | File/endpoint liên quan | Bằng chứng đã chạy | Còn thiếu |
|---|---|---|---|---|---|
| 1 | Kiến trúc source | Có cấu trúc; chưa nghiệm thu | `services/{api-gateway,identity-service,customer-service,driver-service}/src` | Build/typecheck PASS | Audit DDD toàn repo |
| 2 | `.gitignore`, `.env` trên Git | Có cấu hình; chưa nghiệm thu | `.gitignore`, `dev/setup.mjs` | `git status --short` chỉ thấy source; secret trong `.secrets/` ignored | Audit lịch sử Git |
| 3 | Vai trò Gateway | PASS slice hiện tại | `services/api-gateway/src/interfaces/` | HTTP smoke Customer/Driver/registration qua Gateway | Các API ngoài slice |
| 4 | IPC giữa MS | PASS slice hiện tại | `packages/grpc-transport/`, `contracts/proto/` | gRPC mTLS network và HTTP smoke | Toàn bộ 8 MS |
| 5 | Compose/container | PASS slice demo hiện có | root `compose.yaml`, `Dockerfile`, `README.md` | Project `cab`: năm app + PostgreSQL/RabbitMQ/MongoDB healthy; migration 0, stop/up và HTTP/outbox/Notification thật PASS | Bootstrap máy trắng, production readiness và các service chưa triển khai |
| 6 | `/health`, `/ready`, `/health/services` | CHƯA | API docs, Gateway | Chưa chạy | Implementation và integration |
| 7 | Kafka hoặc RabbitMQ | PASS dev slice Driver→Notification | `dev/notification.compose.yaml`, Driver outbox/publisher, Notification consumer | RabbitMQ AMQPS thật; approval/rejection, confirm, replay, DLQ; broker-down/recovery trên harness riêng | Vận hành production, backup/restore |
| 8 | Request người dùng qua Gateway | PASS slice hiện tại | `services/api-gateway/src/interfaces/` | HTTP smoke các route đã triển khai | Các API ngoài slice |
| 9 | Đăng ký Customer | PASS dev | `POST /v1/auth/register` | `node dev/smoke.mjs` 201 | Load/failure rộng hơn |
| 10 | Đăng nhập Customer | PASS dev | `POST /v1/auth/login` | `node dev/smoke.mjs` 200 | Security review rộng hơn |
| 11 | Xem Customer theo ID | PASS dev | `GET /v1/customers/{customerId}` | `node dev/smoke.mjs` 200 | Dữ liệu đa tenant rộng hơn |
| 12 | Xem Driver theo ID | CHƯA đúng yêu cầu | `GET /v1/drivers/me` | Driver tự xem profile 200 | Route theo ID/role theo API07 |
| 13 | Tìm Driver trong 1 km, paging, 5 mẫu | CHƯA | API07/Booking | Chưa chạy | GEO/query, 5 fixture trạng thái |
| 14 | Booking Customer, paging, 5 mẫu | CHƯA | API02 | Chưa chạy | Booking service/fixtures |
| 15 | Đặt xe, tìm gần, offer | CHƯA | API02/03 | Chưa chạy | Booking/dispatch |
| 16 | Driver nhận offer | CHƯA | API03 | Chưa chạy | Booking/Driver offer |
| 17 | Trip trình tự đầy đủ | CHƯA | API04 | Chưa chạy | Trip service |
| 18 | Hủy chuyến/lý do/thông báo | CHƯA | API02/04 | Chưa chạy | Booking/Trip/Notification |
| 19 | Chuyển khoản giả lập/thanh toán hoàn tất | Có Payment độc lập; CHƯA end-to-end | API05, `services/payment-service/` | PostgreSQL tmpfs: DEMO_TRANSFER PENDING→SUCCESS/FAILED, amount/attempt/version, late result, outbox; Compose Payment healthy; HTTP thiếu Trip/Booking trả 503 | Trip/Booking có thẩm quyền, Notification consumer từ Payment, Postman GUI; không có provider/callback thật trong MVP |
| 20 | Rating gắn Trip | CHƯA | API06 | Chưa chạy | Rating service |
| 21 | Driver OTP → hồ sơ chờ duyệt | PASS dev | `POST /v1/auth/driver-registration/otp`, `/otp/verify`, `/v1/driver-applications` | `driver-registration-smoke prepare`; `driver-otp-negative`; replay; recovery outage/restart | SMS thật ngoài phạm vi; rộng hơn ở production |
| 22 | Admin list/detail/review; Driver thấy kết quả | PASS dev gồm IN_APP Notification | Driver review, `GET/PATCH /v1/notifications` | `review`, `reject`, Notification smoke/replay/atomicity và Mongo-down/consumer-restart harness trên PostgreSQL/RabbitMQ/MongoDB thật | Postman GUI/review độc lập, review với xe hiện có |
| 23 | AVAILABLE/OFFLINE, chặn chưa duyệt | PASS dev | `PUT /v1/drivers/me/location`, `/availability` | Pending/rejected 409; approved GPS→AVAILABLE→OFFLINE; old Driver smoke | Dispatch/Trip interaction |
| 24 | Bảo vệ dữ liệu/khóa/hash | Có triển khai; chưa nghiệm thu | Identity crypto/Argon2, encrypted Driver application | Build và smoke; không log OTP/secret trong test | Key rotation/KMS, audit security |
| 25 | SQL injection | CHƯA nghiệm thu | Prisma/raw SQL tham số hóa | Không có dedicated adversarial test lượt này | Negative injection suite |
| 26 | XSS/output encoding | CHƯA | Gateway JSON API | Không có UI test | UI/contextual encoding test |
| 27 | JWT sửa bị 401 | PASS dev | Identity verify/session | `dev/driver-auth-negative.mjs` | Các route ngoài slice |
| 28 | Customer gọi Driver bị 403 | PASS dev | Driver facade auth | `dev/driver-auth-negative.mjs` | Các route ngoài slice |
| 29 | Rate limit 429 | PASS OTP dev | OTP request/verify Gateway limit, DB resend/fail | `dev/driver-otp-negative.mjs` resend 429 | Distributed/fail-closed limiter production |
| 30 | Payment replay không thu trùng | PASS độc lập; CHƯA end-to-end | API05, Payment receipt/unique index | PostgreSQL thật: concurrent same key chỉ một Payment/Attempt; đổi key không tạo Payment thứ hai; result replay không thêm outbox; migration V1/V2 replay | HTTP Trip/Booking/Notification thật và Postman GUI |

Mục 21–23 dùng PostgreSQL dev thật, HTTP Gateway → gRPC mTLS; mục 7/22 thêm RabbitMQ và MongoDB thật, nhưng chưa có lần chạy Postman GUI hoặc đánh giá độc lập. Điều kiện GPS mới ≤30 giây vẫn áp dụng. Các mục chưa làm không được suy ra PASS từ protobuf, fixture hay tài liệu.
