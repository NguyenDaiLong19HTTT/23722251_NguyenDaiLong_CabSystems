# Theo dõi 30 mục phiếu chấm CAB — trạng thái hiện hành

Ngày rà soát: 2026-10-12. Bảng này phân biệt source, kiểm thử tự động,
HTTP qua Compose và Postman GUI. PASS của một lớp không suy ra PASS lớp khác.
Các báo cáo từng thời kỳ được giữ nguyên tại
[grading-tracker-history.md](grading-tracker-history.md); các dòng “CHƯA” ở đó
thuộc mốc cũ. Không sửa workbook chấm điểm.

| # | Implementation hiện có | Bằng chứng tự động / HTTP thật | Postman GUI | Còn thiếu theo phiếu | Backlog ngoài demo |
|---|---|---|---|---|---|
| 1 | Tám MS, Gateway, tách lớp DDD | Build/typecheck và DI smoke lịch sử đạt | Chưa áp dụng | Rà source DDD độc lập | Tối ưu kiến trúc production |
| 2 | Ignore secret/build; config local | Git status hiện tại; chưa audit lịch sử Git | Chưa áp dụng | Kiểm tra Git/ZIP review | Secret manager production |
| 3 | Gateway REST→gRPC mTLS | HTTP các slice đã triển khai theo status | Customer/Driver lịch sử | Retest image mới | Gateway đa instance |
| 4 | gRPC mTLS và policy namespace | Network tests trước đây; validator hiện tại 15 proto, 41 internal/52 facade đạt | Chưa áp dụng | Network regression riêng cho RPC mới | Transport hardening |
| 5 | Compose cab: 9 app, PG/Rabbit/Mongo | Chín app running/healthy; app sửa đã redeploy image mới, dữ liệu giữ nguyên | Chưa áp dụng | Stop/up toàn bộ sau thay đổi mới | Deployment production |
| 6 | `/health`, `/ready`, `/health/services` từ probe còn mới và worker heartbeat; cả ba công khai | HTTP Compose mới: 200/200/anonymous 200 với 12 UP, header Bearer sai không cần thiết; health unit dependency lỗi/stale → 503 | Chưa | GUI và fault recovery dài hơn | Monitoring đa node |
| 7 | RabbitMQ AMQPS, outbox/inbox Notification | HTTP và harness broker/Mongo lịch sử đạt | Notification hồ sơ lịch sử | Retest image hiện hành | Vận hành broker production |
| 8 | API người dùng qua Gateway | HTTP các slice triển khai lịch sử | Customer/Driver/Notification lịch sử | GUI các slice mới | Edge deployment |
| 9 | Đăng ký Customer | HTTP 201/202 và recovery lịch sử | Có, lịch sử | Retest image mới | SMS/email thực |
| 10 | Login email/phone | HTTP lịch sử | Có, lịch sử | Injection negative trên DB/HTTP mới | Identity production hardening |
| 11 | GET Customer theo ID | HTTP quyền sở hữu lịch sử | Có, lịch sử | Retest image mới | Không có |
| 12 | GET Driver theo ID qua Trip/Identity | HTTP thật Customer có Trip, Driver chủ, Operator 200; trái quyền/không có 404; invalid 400, auth 401 | Chưa | GUI | Không mở danh bạ công khai |
| 13 | Nearby 1 km, snapshot/cursor | HTTP 5 Driver/trang 2 lịch sử; lượt này 999 m có, 1001 m/OFFLINE/GPS cũ loại | Chưa | Ca chưa duyệt và GUI | Bản đồ thật |
| 14 | Booking list theo Customer | HTTP 5 Booking, trang 2 lịch sử | Chưa | GUI | Không có |
| 15 | Booking/dispatch/offer | HTTP mới: một POST 201 trả snapshot PENDING + SEARCHING + initialOffer có tripRequestId/driverId; đúng Driver đọc offer PENDING, RabbitMQ→MongoDB có một Notification; ca no-driver lịch sử | Chưa | GUI và recovery rộng hơn; offer không bảo đảm có khi không đủ Driver | Dispatch tối ưu |
| 16 | Accept offer, reservation/guard | HTTP race cùng offer lịch sử | Chưa | GUI và multi-instance race | Fault injection rộng |
| 17 | Trip lifecycle, tracking, incident và resolve ERROR | HTTP synthetic OPERATOR restore/replay rồi close/replay; role/version sai bị chặn; DB 2 incident/audit/receipt, mỗi event một bản | Chưa | GUI; D03 JourneyMetrics rà soát thủ công chưa có thao tác xác nhận | Analytics hành trình |
| 18 | Hủy, lý do, notification, closure | HTTP closure lịch sử; ERROR close mới có worker release guard/reservation, Driver OFFLINE/xe sự cố INACTIVE, Notification một bản | Chưa | GUI và fault-injection restart closure | Không tự refund |
| 19 | Payment CASH/DEMO_TRANSFER | HTTP thật lịch sử, PG harness | Chưa | GUI, đối chiếu thêm replay side effects | Provider thật ngoài MVP |
| 20 | Rating Trip COMPLETED, DB riêng | HTTP thật + PG concurrent/rollback/restart lịch sử | Chưa | GUI image hiện hành | Ranking/average ngoài MVP |
| 21 | OTP→Driver application | HTTP lịch sử | Có, lịch sử | Retest image mới | SMS thật |
| 22 | Operator review, Driver xem kết quả | HTTP + Notification lịch sử | Có, lịch sử | Retest image mới | Workflow duyệt nâng cao |
| 23 | AVAILABLE/OFFLINE + GPS | HTTP approved/rejected lịch sử | Có; REJECTED error code, status chưa ghi rõ | Retest status HTTP | GPS/map nâng cao |
| 24 | Argon2id hash; ciphertext/HMAC cho contact/license | DB synthetic read-only xác nhận hash/ciphertext/nonce/tag/HMAC; key mount ngoài DB, image không chứa secret | Chưa áp dụng | Audit đủ mọi trường nhạy cảm | KMS/rotation production |
| 25 | Login validation, truy vấn tham số hóa | HTTP thật SQLi trả 400/401; Account/Session counts không đổi | Chưa | Rà thêm input truy vấn động | SAST rộng |
| 26 | JSON text cho nhận xét; không render HTML | HTTP Rating lưu/trả nguyên chuỗi script với application/json | Chưa | Contextual encoding khi có frontend | Frontend ngoài MVP |
| 27 | JWT/Session validation | HTTP token sửa bị 401 lịch sử | Chưa | Retest image mới | Auth hardening |
| 28 | Role/object auth | HTTP Customer→Driver 403 và Rating trái quyền lịch sử | Chưa | GUI | ACL audit rộng |
| 29 | Gateway Booking create limiter 30/phút/peer mới; OTP limiter cũ | Built HTTP chặn trước downstream; Compose HTTP 30×400 rồi 429/Retry-After 60, sau cửa sổ 400; load adapter Linux isolated 1200/0,998s = 1202,4 req/s (Windows 459 req/s) | Chưa | GUI và đo trên môi trường chấm; harness Linux cảnh báo MaxListeners do concurrency 48 | Distributed limiter nhiều Gateway |
| 30 | Payment receipt/unique/replay | HTTP đồng thời cùng key/cùng Payment, khác payload/key 409, late FAILED 409; DB 1 Fare/Payment/Attempt, 2 receipt, 1 SUCCESS outbox/0 FAILED, Notification một bản | Chưa | GUI và multi-instance failure rộng | Provider thật ngoài MVP |

GUI Customer đăng ký/login/Account/profile, Driver OTP/review/availability và
Notification hồ sơ là bằng chứng lịch sử do người dùng cung cấp. Chưa có GUI
proof cho Booking–Trip–Payment–Rating. Không lấy kết quả unit/validator thay cho
HTTP Compose hoặc Postman GUI. Trip ERROR có bằng chứng HTTP/DB riêng; D03 vẫn
PENDING để OPERATOR rà soát thủ công và chưa có GUI proof.
