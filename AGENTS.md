# Hướng dẫn Codex — CAB System

## Phạm vi và cách làm việc
- Là partner Backend Engineer và Tester; mỗi nhiệm vụ xử lý một chức năng hoặc mục tiêu kỹ thuật cụ thể.
- Trước sửa, đọc code/config liên quan, nêu kế hoạch ngắn và tiêu chí đạt; giữ scaffold và thay đổi người dùng.
- Không reset/clean, xóa thay đổi local hoặc volume; fetch/tạo/chuyển nhánh chỉ khi nhiệm vụ cho phép và không ghi đè local.
- Không tự stash, commit hoặc push; không dùng nhiều subagent khi chưa được yêu cầu.
- Thực hiện đầy đủ thay đổi code/tài liệu/contract trong phạm vi nhiệm vụ đã cho phép, không hỏi lại quyền đã được cấp.
- Chỉ hỏi khi đổi nghiệp vụ hoặc thiếu quyết định không suy ra được từ nguồn; tiếp tục phần độc lập trong lúc chờ.
- Không tự thêm nghiệp vụ, mở rộng service hoặc để TODO thay nghiệp vụ cốt lõi đã được giao.
- Cài dependency, chạy container/migration chỉ khi thuộc phạm vi nhiệm vụ được giao; khảo sát không tự thực hiện các việc đó.
- Đọc `docs/development/status.md` để tiếp nối và `implementation-plan.md` khi lập bước triển khai.
- Hướng dẫn này không thay thế tài liệu nguồn; các phiên sau chỉ đọc tài liệu/file cần cho nhiệm vụ.

## Nguồn và quyết định
- `srs.md`: yêu cầu, phạm vi nghiệp vụ, FR/UC/AC/NFR.
- `Micro_Service_Design.md`: kiến trúc, ownership dữ liệu, luồng phục hồi; xem cả §18 cập nhật hợp đồng.
- `API-Document/*.yaml`: REST công khai, request/response, lỗi và security theo endpoint.
- `contracts/README.md`, `RPC.md`, `SECURITY.md`, `EVENTS.md`: giao tiếp nội bộ và invariant liên dịch vụ.
- `contracts/proto/`, `rpc-policy.json`, `events/`: field/type, allowlist, schema/routing/fixture thực thi.
- Facade slice: đọc mapping/spec và policy riêng trong contracts; không mở rộng số endpoint ngoài phạm vi đang giao.
- Khi nguồn mâu thuẫn, ghi file/mục/dòng và ảnh hưởng, yêu cầu quyết định cho phần phụ thuộc; tiếp tục phần độc lập.
- Không suy rằng mô tả đã được duyệt hoặc kiểm thử chỉ vì tồn tại trong tài liệu; dùng baseline được nhiệm vụ chỉ định.
- Không đọc `CAB_Test_Cases_ver_1.xlsx`. Chỉ đọc bản `CAB_Test_Cases_ver_1.3.xlsx` khi cần kiểm thử; không tự đánh dấu PASS.
- Không đọc lại toàn repository/log dài, không tạo báo cáo trùng nội dung, không paste toàn bộ file vào câu trả lời.

## Kiến trúc bắt buộc
- Node.js, Microservices, DDD, Database-per-Service; phân biệt stack đề xuất với quyết định đã duyệt trong kế hoạch/status.
- Tám service: identity-service, customer-service, driver-service, booking-service,
  trip-service, payment-service, rating-service, notification-service.
- Gateway riêng; Dispatch thuộc Booking; Pricing/Fare thuộc Payment; không tạo thêm Operations/Tracking/Analytics MS trong MVP.
- Client → Gateway: REST. Gateway → service và đồng bộ MS→MS: gRPC. Sự kiện bất đồng bộ: RabbitMQ.
- `cab.internal.v1` là MS→MS; facade dùng package/policy riêng và chỉ mở method được đặc tả cho Gateway.
- Không coi RPC nội bộ hoặc facade của một slice là toàn bộ API Gateway, webhook và health.
- Chỉ Gateway publish cổng ứng dụng. Allowlist method/path, chặn workflow nội bộ, ưu tiên route cụ thể.
- Mỗi service có PostgreSQL database và credential riêng; local được dùng chung server.
- Không đọc/ghi, JOIN, foreign key hoặc transaction xuyên database service; ID liên dịch vụ là tham chiếu logic.
- Gateway không truy cập DB nghiệp vụ. Redis là cache/GEO/rate limiter, không quyết định giữ quyền/phân công cuối cùng.
- Role chỉ CUSTOMER, DRIVER, OPERATOR; không thay PostgreSQL bằng MongoDB hoặc role member/admin từ ví dụ.
- Chỉ dựng các thành phần cần cho luồng đang giao; không tạo cả tám service trong một nhiệm vụ khởi đầu.

## DDD và persistence
- Tách `domain`, `application`, `infrastructure`, `interfaces` trong từng service khi triển khai.
- Domain không import NestJS, ORM, gRPC, RabbitMQ; domain entity khác ORM entity/transport DTO.
- Repository interface phục vụ domain/application; implementation và mapping nằm ở infrastructure.
- Không chia sẻ entity ORM hoặc business model giữa service; chỉ chia sẻ hợp đồng transport được kiểm soát version.
- Transaction nằm tại service sở hữu; không giữ transaction khi chờ RPC/provider.
- DDD không mặc định yêu cầu CQRS hoặc Event Sourcing.
- Unique constraint/CAS/khóa DB bảo vệ invariant cạnh tranh; kiểm tra trước khi ghi hoặc Redis lock không đủ.
- NUMERIC/decimal cho tiền; làm tròn tổng VND một lần theo ROUND_HALF_UP, không float quyết định tiền.
- Migration/seed theo service, quyền runtime khác quyền migration; không tự reset DB hoặc xóa volume để test xanh.

## Invariant và phục hồi
- Customer không có hai công việc hoạt động; Driver và Vehicle không bị giữ/phân công đồng thời.
- Timeout không chứng minh rollback. Query outcome trước bù; retry cùng bước giữ ID/payload ổn định, chống trùng trong DB.
- Generation/tombstone chặn lệnh cũ và lệnh chưa đến; query NOT_FOUND một lần không đủ kết thúc compensation.
- Trip đã ACTIVE phải phục hồi phía trước; không xóa/giải phóng quyền để giả rollback. BOUND không tự hết bởi TTL/lease.
- Đóng Trip commit ClosureOperation trước; release đúng ID/generation, tiếp tục sau restart đến xác nhận.
- Payment UNKNOWN chặn thu lần nữa/chuyển CASH đến khi đối soát; SUCCESS không bị hạ trạng thái bởi callback muộn.
- Rating chỉ cần đúng Customer và Trip COMPLETED; không phụ thuộc Payment SUCCESS.
- Outbox cùng transaction nghiệp vụ; publisher confirm/mandatory, replay giữ eventId/body.
- Consumer commit inbox/dedupe và job trước ACK/side effect; schema/source/routing sai phải quarantine/DLQ bền vững.
- Không áp quy tắc bỏ version cũ chung cho GPS và thông báo lịch sử; theo semantic từng event.
- Giữ receipt/saga/generation/tombstone/dedupe nội bộ suốt MVP theo contracts; không tự TTL/purge.

## Bảo mật
- Không đọc/in `.env`, secret, token, private key hoặc credentials thật; chỉ dùng placeholder khi cần config mẫu.
- Không đưa secret vào Git/image/Postman/log/audit/outbox; không công bố connection string/stack trace.
- gRPC dùng mTLS, URI SAN và policy đúng namespace, deny mặc định; không plaintext fallback deployment.
- Gateway facade có policy riêng; không thêm Gateway vào allowlist worker/compensation cho tiện triển khai.
- Xóa header danh tính client giả mạo; downstream xác minh Account/Session tại Identity và quyền đối tượng.
- User token truyền qua metadata đã quy định, chỉ trong request; không lưu JWT trong durable job/receipt.
- Identity outage/service auth failure là lỗi phụ thuộc; không giả thành user 401, 404 hoặc danh sách rỗng.
- Authorization receipt commit trong cửa sổ 2 giây theo SECURITY; không hứa Account lock atomic xuyên DB.
- Password băm Argon2id theo thiết kế; email/phone/license mã hóa, lookup HMAC; khóa tách khỏi DB/Git.
- Chuẩn hóa email theo API. Request phone mới là 10 chữ số bắt đầu bằng 0; Identity dùng dạng +84 tương đương cho lookup/HMAC và trả về dạng nội địa. Riêng bản ghi legacy đã lưu `+84` cộng mười chữ số giữ nguyên khi đọc, không tự cắt hoặc dùng làm request mới. Không trim password; server quyết định role/ID/amount.
- Truy vấn tham số hóa; văn bản người dùng hiển thị như text, encode đúng ngữ cảnh; Postman không chứng minh XSS UI.
- Endpoint nhạy cảm fail closed khi không áp được rate limit; 429/Retry-After theo API.
- Registration recovery token và provider webhook có cơ chế riêng; operationId/key không tự là quyền truy cập.

## Kiểm tra và báo cáo
- Xác minh manifest/lockfile/build/test script hiện có trước chạy; không trình bày lệnh chưa tồn tại như khả dụng.
- Validator nguồn: `python contracts/tools/validate.py`, cần Python và requirements đã pin, kết quả static khác runtime.
- Cài tooling kiểm tra/container tạm chỉ trong phạm vi đã cho phép; không đổi pin hoặc assertion để test xanh.
- `contracts/VALIDATION.md` là bằng chứng lịch sử; không nhận kết quả đó là lần chạy hiện tại.
- Kiểm thử happy path, validation, role/object authorization, retry/concurrency/restart liên quan.
- Unit test có mock phải ghi rõ; integration dùng DB/broker thật và transport thật; mock không chứng minh tích hợp/provider.
- Phân tích lỗi test, không xóa test hoặc giảm assertion để xanh. Không lặp test đã đạt nếu không có thay đổi/rủi ro mới.
- Ghi lệnh, môi trường, phạm vi, kết quả thực tế, bằng chứng và phần chưa chạy/bị chặn; không giả kết quả.
- Kết thúc báo cáo ngắn: thay đổi/file, kiểm tra/kết quả, giới hạn và bước tiếp theo; cập nhật status khi có mốc đáng bàn giao.
