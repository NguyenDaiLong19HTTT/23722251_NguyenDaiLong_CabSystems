# RabbitMQ contract

## Wire và nguồn tin cậy

AMQPS với verify broker certificate, vhost `/cab`; mỗi MS một broker credential riêng, chỉ cấp runtime write exchange của chính nó và read queue của chính nó. Topology bootstrap bằng deployment identity, runtime không có configure permission. `topology.json` là specification để triển khai, không giả là RabbitMQ definitions import. Exchange topic durable **riêng từng producer**: `cab.identity.events`, `cab.customer.events` (chưa có publisher/event MVP nên không tạo), `cab.driver.events`, `cab.booking.events`, `cab.trip.events`, `cab.payment.events`. Không cho producer publish default exchange hoặc exchange MS khác. Broker mapping exchange→source phải khớp body; không tin `source` tự khai. Với exchange chung và broad write ACL thì chưa đáp ứng hợp đồng này.

AMQP properties bắt buộc: content_type=`application/json`, content_encoding=`utf-8`, delivery_mode=2, message_id=eventId, type=eventType, correlation_id=correlationId. Routing key `notification.v2.<EVENT_TYPE>` hoặc `domain.v1.<EVENT_TYPE>` chính xác như topology; header `cab-schema-version` bằng body schemaVersion (integer). Max body 64KiB. Từ chối duplicate JSON key, NaN/Infinity, UTF-8 sai. Schema strict additionalProperties=false; không đưa raw user JWT/OTP/license/phone/email/password vào event. GPS chỉ có ở domain driver→trip, không ở Notification.

Publisher confirms + mandatory, check basic.return và nack. Confirm mất thì gửi lại cùng eventId/body/properties. Commit outbox cùng business transaction, không gửi rồi mới commit. Một business fact có hai contract (ví dụ Trip COMPLETED notification và metrics confirmed domain) là **hai event ID khác nhau**, cùng correlation/causation khi có. Không dùng eventId chung cho hai payload.

## Schema và semantic checks

`notification-v2.schema.json` được trích từ API06 NotificationDomainEvent và dependent schemas; validator đối chiếu lại để tránh drift. Giữ nguyên schemaVersion=2, không thêm causationId/payload vào message này. Mỗi event có fixture riêng trong examples.

| Producer | Notification event | Recipients lấy từ source đã commit |
|---|---|---|
| Booking | BOOKING_RECEIVED, BOOKING_CANCELLED, DRIVER_ASSIGNED, NO_DRIVER_FOUND | Account Customer |
| Booking | TRIP_REQUEST_RECEIVED | Account Driver nhận offer |
| Driver | DRIVER_APPLICATION_SUBMITTED, DRIVER_APPLICATION_APPROVED, DRIVER_APPLICATION_REJECTED | Account ứng viên Driver |
| Trip | DRIVER_ARRIVED, TRIP_STARTED | Account Customer |
| Trip | TRIP_COMPLETED, TRIP_CANCELLED, TRIP_ERROR, TRIP_RECOVERED, TRIP_CLOSED_ABNORMALLY | Account Customer và Driver lịch sử |
| Payment | PAYMENT_SUCCESS | Account Customer và Driver lịch sử |
| Payment | PAYMENT_FAILED, PAYMENT_UNKNOWN, PAYMENT_REVIEW_REQUIRED | Account Customer |

Notification aggregate/ref mapping theo schema API06. `aggregateId == referenceId` trừ DRIVER_ASSIGNED: aggregate Booking nhưng reference Trip. Không nhầm Account ID với Customer/Driver ID. Consumer kiểm tra số người nhận và uniqueness; chỉ producer mới xác nhận được ID là đúng bên nghiệp vụ, phải contract-test tại producer. Chỉ event snapshot fields có ý nghĩa với event được phép xuất hiện: cancellation reasonCode/reasonText (Booking code OTHER); rejection reasonText; offer expiresAt; Payment attemptId/amount/currency và reason phù hợp. Amount/currency đồng xuất hiện; PAYMENT_SUCCESS phải có attemptId+amount+currency, PAYMENT_FAILED phải có attemptId. Event khác không mang dữ liệu payment hay GPS. Nội dung hiển thị plain text, render escape.

`domain-v1.schema.json` là hợp đồng mới, tách hoàn toàn khỏi Notification:

| Event / aggregate | Producer | Consumer / semantics |
|---|---|---|
| ACCOUNT_PROVISIONED / ACCOUNT | Identity | Bảy MS còn lại cập nhật projection nếu cần; chỉ phát sau registration SUCCEEDED. Không thay response/query xác nhận provisioning. |
| ACCOUNT_ACCESS_CHANGED / ACCOUNT | Identity | Bảy MS invalidate authorization projections; Booking hủy offer chưa nhận, Driver chặn công việc mới, không tự hủy Trip. Payload accountStatus/sessionEpoch, aggregateVersion là Account security revision tăng trên lock/unlock/logout/password/session revocation. |
| DRIVER_LOCATION_RECORDED / DRIVER | Driver | Trip ghi journey; sampleId ổn định. aggregateVersion là location stream sequence riêng, **không tăng version nghiệp vụ Driver/Trip**. recordedAt không lớn hơn receivedAt. |
| JOURNEY_METRICS_CONFIRMED / TRIP | Trip | Payment gọi GetFareContext(tripId,metricsVersion) rồi phát hành Fare idempotent; chỉ emit khi COMPLETED và metrics CONFIRMED. |

Domain aggregateId phải bằng accountId/driverId/tripId tương ứng trong payload. causationId là commandId hoặc input eventId gây ra thay đổi; không raw token. UUID eventId không dùng làm timestamp/order. ACCOUNT_ACCESS_CHANGED không thay Identity check theo request; sessionEpoch tăng cũng khi chỉ revoke một session để invalidate cache, không có nghĩa tất cả session đều revoked. Identity vẫn là nguồn xác minh cụ thể.

GPS event không nhận tripId tự khai. Trip ánh xạ Driver→Trip lịch sử theo recordedAt và các khoảng assignment/phase đã lưu tại Trip; không dựa vào chuyến hiện tại lúc nhận event. Nếu metadata Trip chưa tới thì inbox/job WAITING_CONTEXT và retry; ngoài mọi interval hợp lệ thì bỏ có audit reason. Dedup sampleId và (driverId,recordedAt), cùng timestamp khác coords là conflict. Mẫu đến trễ không thay latest/tracking, không rò chuyến sau. Account sequence stale có thể bỏ projection sau dedupe; GPS cũ vẫn xét journey; Notification cũ vẫn phải tạo thông báo lịch sử. Không dùng một quy tắc `version <= latest → drop` cho mọi event.

## Inbox, retry và DLQ

Quorum queue durable theo topology (single-node MVP có durability nhưng chưa có HA). Consumer prefetch 20/manual ACK. Local transaction ghi Inbox(eventId, source, canonicalPayloadDigest) và durable job trước ACK. Notification thêm unique `(eventId, recipientAccountId, IN_APP)`; template/title/body sinh server-side. Realtime delivery lỗi không rollback inbox hoặc đổi một notification đã SENT thành FAILED. ReadAt là lần đọc đầu tiên.

Duplicate eventId với cùng canonical JSON/nguồn → ACK, không side effect; khác payload/nguồn → persist quarantine và alert, không ghi đè dữ liệu cũ. Canonical digest sắp xếp key, giữ kiểu/giá trị; không normalize nghiệp vụ sau khi freeze. Đối chiếu exchange/routing/properties/schema trước consume. Lỗi không hợp lệ không requeue vòng lặp.

Consumer không access được DB: giữ delivery unacked, pause/reconnect có backoff, không ACK rồi làm mất. Sau local inbox+job commit, ACK; job worker retry nội bộ **1s, 5s, 30s, 2m, 10m** (5 retries sau lần đầu), jitter ±20%. Hết vòng chuyển job DEAD_LETTER và ghi durable DLQ-outbox trong cùng transaction; publisher gửi DLQ có confirm/mandatory trước đánh dấu published. Schema-invalid message cũng ghi quarantine+DLQ-outbox trước ACK; DB lỗi thì không ACK. DLQ exchange riêng `cab.<consumer>.dead`, queue `<original>.dlq`, runtime consumer chỉ write exchange dead của chính nó. Deployment bind routing key bằng tên queue gốc. Bọc DLQ gồm original exchange/key/properties/raw bytes, reason và failedAt; raw bytes mã hóa tại rest nếu có GPS, quyền vận hành giới hạn.

Replay chỉ tooling vận hành, ghi audit; đẩy đúng exchange/key với original eventId và payload. Operator không sửa nội dung rồi giữ eventId. Replay job cùng eventId cho phép resume DEAD_LETTER bằng CAS; không tạo side effect lần hai dù inbox đã tồn tại. Retain dedupe/tombstone suốt MVP theo RPC.md; không TTL event đang lỗi. Poison message không chặn toàn queue. Closure release và payment UNKNOWN là workflow bền vững khác: cảnh báo/manual review nhưng không bỏ công việc hoặc coi timeout là thất bại tài chính sau 5 retries.

## Cutover và compatibility

Notification v1 CAB_CORE không tương thích v2: queue riêng, deploy v2 consumer trước producer. Drain v1 bằng consumer cũ hoặc migration được kiểm chứng nguồn, giữ eventId/recipients/occurredAt; không đoán source và không republish bằng ID mới. Sau drain và so số lượng mới revoke credential CAB_CORE. Không đưa payload v2 vào queue v1.

Schema strict nên **thêm field cũng cần rollout consumer trước producer hoặc version mới**; không nói additive luôn tương thích. Domain v1 và notification v2 độc lập. Trước deploy chạy validator, producer/consumer fixture tests, broker ACL negative tests và mất-confirm/duplicate/out-of-order/DLQ replay integration tests. Bộ hiện tại chưa triển khai broker hoặc kiểm chứng các hành vi runtime đó.
