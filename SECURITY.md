# Xác thực, phân quyền và lỗi

## Danh tính dịch vụ

Chốt **mTLS trực tiếp giữa các dịch vụ**, không dùng service JWT chung cho cả cụm. Internal gRPC không publish cổng host; network isolation không thay authentication. CA nội bộ tin cậy, certificate EKU client/server tương ứng; service identity từ URI SAN chính xác `spiffe://cab.local/service/<service-name>`, ví dụ `rating-service`. Không đọc identity từ CN, request body, x-service-name hoặc x-forwarded-*.

Client kiểm tra CA, hạn certificate và SAN dịch vụ đích. Server kiểm tra CA, hạn certificate và URI SAN caller; interceptor áp allowlist `rpc-policy.json` trên full method. Scope trong policy là quyền logic gắn với SAN, không phải scope tự khai metadata. Cert lifetime tối đa 24h, rotate trước 2h, overlap CA tối đa 24h khi rollout; private key ngoài Git/DB, quyền file chỉ workload. Kênh quá 10 phút phải reconnect; nghi lộ key phải remove SAN/serial allowlist, terminate connection và rotate, không chờ certificate hết hạn. Local test dùng CA riêng do test tạo; không có chế độ plaintext fallback trong deployment profile.

Không thêm mTLS+service JWT kép khi chưa có nhu cầu; nếu sau này dùng mesh/workload issuer phải ADR và contract test mới. Không cho gateway gọi các RPC worker/compensation; Gateway có facade policy riêng. Interceptor deny khi method/caller thiếu policy. REST client không bao giờ chọn caller hoặc scope nội bộ.

## User context và metadata

Mỗi RPC có `x-correlation-id` (1–200 ký tự an toàn, Gateway sinh lại nếu sai), `traceparent` chuẩn nếu có. Các method `userContext=required` gửi `x-cab-user-authorization: Bearer <access token>` qua mTLS; không dùng header Authorization cho cả service lẫn user. Gateway xóa mọi x-cab-*, x-service-*, role/account ID do bên ngoài tự gửi rồi tự đặt user token từ phiên đã nhận. Downstream chỉ forward token đang xử lý, không refresh thay user. Không log metadata token. Metadata tổng tối đa 8KiB.

MS xử lý public use case và Trip context phải gọi Identity verify ngay trong request. Identity kiểm tra thuật toán allowlist, issuer cấu hình, audience public CAB API, exp/nbf, Session hiện tại, ACTIVE, profile provisioning; không chỉ decode JWT. Client deadline/Identity outage → UNAVAILABLE, không giả user invalid. Principal trả về chỉ dùng trong request, không cache xuyên request. Các RPC `userContext=none` không coi user token là quyền; caller mTLS+owned operation mới là quyền.

D07 chốt chính sách **quyền tại lúc tiếp nhận công việc**: xác minh Identity xong, service phải commit authorization receipt cùng operation trong tối đa 2 giây; quá thời gian phải verify lại. Receipt gồm accountId/sessionId/accountVersion/verifiedAt/action/resource, không raw JWT. Lock/Logout commit trước verify thì request bị từ chối; lock sau verify có thể vẫn cho operation đã nhận hoàn tất trong cửa sổ này. Đây là race được chấp nhận, không atomic xuyên DB. Worker chỉ tiếp tục operation đã ghi, không dùng receipt để tạo ý định mới; vẫn recheck eligibility ở reserve và enforce trạng thái tài nguyên. Release/compensation/reconcile công việc cũ tiếp tục khi Account đã khóa. Nếu cần chặn tuyệt đối mọi commit sau lock phải thiết kế một giao thức mới; không tuyên bố event giải quyết được điều đó.

## Ánh xạ lỗi

Server dùng gRPC status và pack `cab.internal.v1.ErrorDetail` vào `google.rpc.Status.details` (`grpc-status-details-bin`). Không trả HTTP code trong protobuf. `reason` là mã ổn định, message an toàn, không stack trace/PII. Caller map theo bảng và mã lỗi OpenAPI của use case; lỗi không biết/thiếu detail phải fail closed, không đổi thành 404 hoặc mảng rỗng.

| gRPC / reason | Ý nghĩa | HTTP tại facade |
|---|---|---|
| INVALID_ARGUMENT / VALIDATION_ERROR | Field sai, enum=0, metadata sai | 400 |
| UNAUTHENTICATED + END_USER / UNAUTHENTICATED | User token/Session không hợp lệ | 401 |
| PERMISSION_DENIED + END_USER / ACCOUNT_INACTIVE hoặc FORBIDDEN | User bị khóa/sai role | 403 |
| UNAUTHENTICATED hoặc PERMISSION_DENIED + SERVICE | Sai caller/cert/quyền method | 503 và cảnh báo cấu hình |
| NOT_FOUND / TRIP_NOT_FOUND | Không tồn tại hoặc ngoài quyền đối tượng | 404 |
| ALREADY_EXISTS / IDEMPOTENCY_CONFLICT | Key cũ khác dữ liệu | 409 |
| ABORTED / VERSION_CONFLICT | expectedVersion không khớp | 409 |
| FAILED_PRECONDITION / ACTIVE_CUSTOMER_ACTIVITY, DRIVER_UNAVAILABLE, STALE_FENCE, TRIP_ALREADY_ACTIVE, TRIP_NOT_COMPLETED, METRICS_NOT_CONFIRMED | Invariant chưa đạt | 409 theo OpenAPI endpoint |
| RESOURCE_EXHAUSTED / RATE_LIMITED | Limiter của user endpoint | 429 theo OpenAPI; overload dependency →503 |
| DEADLINE_EXCEEDED, UNAVAILABLE, transport TLS failure | Không biết outcome hoặc dependency hỏng | 503; operation đã ghi có thể 202 theo API |
| INTERNAL, DATA_LOSS, status/detail không biết | Bug/corruption | 500 nếu local; 503 nếu dependency, alert |

mTLS handshake fail không có gRPC detail: caller mặc định dependency/service error 503, tuyệt đối không 401 user. Auth failure từ Identity bắt buộc auth_origin=END_USER hoặc SERVICE. Không lộ version của object ngoài quyền. Không map mọi failed precondition giống nhau nếu OpenAPI đã có mã cụ thể. 202 chỉ khi có durable operation và endpoint tra cứu có quyền; không dùng 202 che mutation không được persist. Xác thực/ủy quyền luôn trước replay kết quả nhạy cảm.
