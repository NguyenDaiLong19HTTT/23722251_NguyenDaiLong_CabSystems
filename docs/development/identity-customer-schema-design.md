# Đề xuất schema Identity/Customer để review — chưa triển khai

Ngày 2026-10-02. Chủ dự án đã duyệt các quyết định **MVP local** về UUID, contact reuse sau FAILED,
Session 7 ngày, khóa ổn định và protocol coordinator. Schema Prisma/SQL V1 production riêng hai service
đã được tạo để review; chưa triển khai register/login. Probe `probe_*` không chuyển thành bảng nghiệp vụ.
SQL migration là đặc tả vật lý ưu tiên khi tên constraint/nullable cần đối chiếu. V1 đã được kiểm
chứng trên PostgreSQL 17.11 của project thử nghiệm riêng: fresh deploy, replay và 10/10 ca DB PASS;
không suy thành HTTP/gRPC coordinator/JWT đã đạt.

## Nguồn và nguyên tắc

Các ký hiệu trong bảng trỏ tới nguồn cụ thể:

- **S**: [srs.md](../../srs.md) §FR01, §FR28, §8.2 Account, §9.1–9.3, §UC01, §UC22, §AC01,
  §4.5 thông số đề xuất.
- **M**: [Micro_Service_Design.md](../../Micro_Service_Design.md) §4, §5.1–5.2, §5.9,
  §6.1–6.2, §8, §10.1–10.2, §18.
- **A**: [API01](../../API-Document/01-auth-customer-api.yaml) các operation `registerCustomer`,
  `getCustomerRegistrationOperation`, `login`, `refreshSession`, `logout`, `getMyAccount`,
  `getCustomerById` và schemas `Account`, `AuthSessionResponse`, `CustomerRegistrationOperation`.
- **R**: [RPC.md](../../contracts/RPC.md) §Quy tắc chung, §Identity và đăng ký, §Lưu giữ,
  §Guard/reservation và phân công.
- **Q**: [SECURITY.md](../../contracts/SECURITY.md) §User context và metadata, D07.
- **G**: [GATEWAY-CUSTOMER.md](../../contracts/GATEWAY-CUSTOMER.md) §Route/ownership,
  §Danh tính, §Success, §Deadline/retry, §Public retention.
- **P**: [Identity proto](../../contracts/proto/cab/internal/v1/identity.proto),
  [Customer proto](../../contracts/proto/cab/internal/v1/customer.proto),
  [facade proto](../../contracts/proto/cab/gateway/v1/customer_facade.proto).
- **E**: [EVENTS.md](../../contracts/EVENTS.md) §Quy tắc phát/nhận, `ACCOUNT_PROVISIONED`;
  [domain-v1.schema.json](../../contracts/events/domain-v1.schema.json).

Mỗi service có database, runtime role, schema/client/migration riêng. UUID dùng cho ID nội bộ theo M§4;
`operation_id` giữ `TEXT` với CHECK độ dài 1–128 vì API01/P coi đây là ID opaque, không ép UUID.
`TIMESTAMPTZ` giữ thời gian UTC; `BYTEA` chứa digest/ciphertext, không lưu khóa trong DB.
FK chỉ nối bảng **cùng** database; `account_id` trong Customer và `customer_id` trong Identity
là tham chiếu logic, được xác nhận bằng RPC. Không JOIN, FK hoặc transaction xuyên DB. [M§4, R§Identity, A register]

## cab_identity

Các tên `snake_case` nay được dùng trong SQL V1. Nullable được ghi rõ; trường còn lại NOT NULL.
Không sao chép email/phone dạng rõ sang receipt/outbox/audit. [M§5.1, §10.1; G§Danh tính]

| Bảng, chủ sở hữu | Trường/kiểu và nullable | PK/FK, unique/index/CHECK | Trạng thái, retention và nguồn |
|---|---|---|---|
| `account` — Identity | `account_id UUID`, `full_name TEXT`, encrypted email/phone gồm ciphertext/nonce/tag/key version, `email_lookup_hmac BYTEA`, `phone_lookup_hmac BYTEA`, `lookup_key_version TEXT`, `password_hash TEXT`, `role TEXT`, `account_status TEXT`, `registration_access_state TEXT`, `version BIGINT`, `confirmed_profile_id UUID NULL`, `profile_confirmed_at TIMESTAMPTZ NULL`, timestamps | PK account_id; **không UNIQUE lookup digest trên Account lịch sử**. CHECK role/status, access BLOCKED/READY/FAILED; READY cần confirmed profile, FAILED không có; version≥1. Index role/status. Không FK profile xuyên DB. | FAILED giữ contact mã hóa/evidence nhưng không login/refresh; chỉ active claim xác định chủ contact hiện tại. Account INACTIVE/SUSPENDED vẫn giữ claim. [S§9.1/AC01; M§5.1/§10.1; A Account/login; R§Identity; quyết định MVP local] |
| `contact_claim` — Identity | `claim_id UUID`, `account_id UUID`, `operation_id VARCHAR(128)`, `kind EMAIL/PHONE`, `lookup_hmac BYTEA`, `lookup_key_version TEXT`, `claimed_at`, `released_at TIMESTAMPTZ NULL` | FK Account và composite `(operation_id,account_id)` tới registration; UNIQUE `(account_id,kind)` và `(operation_id,kind)`; partial UNIQUE `(kind,lookup_hmac) WHERE released_at IS NULL`; CHECK thời gian. Trigger từ chối release trừ khi operation và Account cùng FAILED sau bù, cấm sửa release cũ. | Một claim active cho mỗi contact; transaction FAILED giải phóng cả email/phone. Historical digest vẫn ở Account/claim; login chỉ JOIN claim active + Account READY/ACTIVE + operation SUCCEEDED. Không check-then-write. [A register/login; R§Identity/§Lưu giữ; quyết định MVP local] |
| `session` — Identity | `session_id UUID`, `account_id UUID`, `refresh_token_digest BYTEA`, `digest_key_version TEXT`, `created_at`, `expires_at TIMESTAMPTZ`, `rotated_at TIMESTAMPTZ NULL`, `revoked_at TIMESTAMPTZ NULL`, `version BIGINT` | PK; FK Account RESTRICT; UNIQUE digest; index account/revoked/expiry; CHECK `expires_at=created_at+168 hours`, version≥1. Trigger chặn tạo/giữ Session chưa revoked nếu Account không READY/ACTIVE; chuyển Account FAILED phải revoke Session trước. | Absolute expiry **7 ngày từ login đã duyệt cho MVP local**, refresh không kéo dài; access token không vượt expiry. Không purge tự động; production PII retention D08 còn mở. [A login/refresh/logout; Q§User context; quyết định MVP local] |
| `registration_operation` — Identity | `operation_id TEXT`, `flow_type TEXT`, `account_id UUID`, `target_profile_id UUID`, `public_status TEXT`, `internal_phase TEXT`, `idempotency_key_hmac BYTEA`, `idempotency_key_version TEXT`, `recovery_token_digest BYTEA`, `recovery_digest_key_version TEXT`, `request_fingerprint_hmac BYTEA`, `fingerprint_key_version TEXT`, `customer_provision_state TEXT NULL`, `terminal_error_code TEXT NULL`, `result_snapshot_ciphertext BYTEA NULL`, `result_snapshot_nonce BYTEA NULL`, `result_snapshot_tag BYTEA NULL`, `result_snapshot_key_version TEXT NULL`, `result_snapshot_format_version INTEGER NULL`, `created_at`, `updated_at TIMESTAMPTZ`, `terminal_at TIMESTAMPTZ NULL`, `public_lookup_until TIMESTAMPTZ NULL`, `version BIGINT` | PK `operation_id`; FK `account_id→account`; UNIQUE `(flow_type,idempotency_key_hmac)` trong MVP dùng key ổn định, **không xóa key/digest khi public hết hạn**; UNIQUE `(flow_type,target_profile_id)`; index `(public_status,updated_at)` và `(internal_phase,updated_at)` cho worker; CHECK opaque ID dài 1–128, flow_type hợp lệ, public_status PROCESSING/SUCCEEDED/FAILED, version≥1, terminal/public time và bộ field snapshot nhất quán. | Slice này chỉ `CUSTOMER`; public status theo A/G/P. `COMPENSATING` là internal phase, vẫn public PROCESSING đến quyết định cuối. PROCESSING/evidence giữ đến terminal; public replay/lookup thêm 7 ngày sau terminal theo A/G; receipt/saga/key tombstone nội bộ suốt MVP theo R. PII trong evidence sau cửa sổ cần D08. [S§UC22; M§5.1/§6.2; A register/lookup; R§Identity/§Lưu giữ; G§Public retention] |
| `registration_step` — Identity | `step_id UUID`, `operation_id TEXT`, `step_kind TEXT`, `command_id UUID`, `target_service TEXT`, `request_fingerprint_hmac BYTEA`, `step_state TEXT`, `attempt_count INTEGER`, `next_attempt_at TIMESTAMPTZ NULL`, `last_safe_reason TEXT NULL`, `created_at`, `updated_at TIMESTAMPTZ` | PK `step_id`; FK `operation_id→registration_operation`; UNIQUE `(operation_id,step_kind)` cho bước một lần, UNIQUE `(target_service,command_id)`; CHECK attempt≥0, step_state theo tiến trình được review; index `(step_state,next_attempt_at)`. Nếu một step cần nhiều command hợp lệ, mở rộng key theo `step_generation`, không reuse command_id. | Lưu **ý định và ID retry ổn định** cho Provision/Cancel; không payload chứa password/token/PII rõ. Receipt/saga giữ suốt MVP. [S§UC22; M§6.1–6.2; R§Quy tắc chung/§Identity/§Lưu giữ] |
| `identity_outbox` — Identity | `event_id UUID`, `aggregate_id UUID`, `aggregate_version BIGINT`, `event_type TEXT`, `schema_version INTEGER`, `payload JSONB`, `correlation_id TEXT`, `causation_id TEXT`, `occurred_at TIMESTAMPTZ`, `publish_state TEXT`, `attempt_count INTEGER`, `next_attempt_at TIMESTAMPTZ NULL`, `published_at TIMESTAMPTZ NULL` | PK `event_id`; UNIQUE `(aggregate_id,aggregate_version,event_type)` theo fact; index `(publish_state,next_attempt_at)`; CHECK version/schema/attempt dương hợp lệ. Payload `ACCOUNT_PROVISIONED` chỉ các ID, role, operation ID theo E schema. | Tạo cùng transaction khi registration chuyển SUCCEEDED; publisher confirm rồi đánh dấu. Retry giữ nguyên eventId/body. ACK payload có thể archive nhưng khóa dedupe/evidence giữ baseline suốt MVP; D08 chốt archive chứa PII nếu có. [M§8; R§Lưu giữ; E§Quy tắc/ACCOUNT_PROVISIONED] |
| `identity_audit` — Identity | `audit_id UUID`, `account_id UUID NULL`, `operation_id VARCHAR(128) NULL`, `action TEXT`, `actor_account_id UUID NULL`, `occurred_at TIMESTAMPTZ`, `correlation_id TEXT NULL`, `safe_detail JSONB NULL` | PK; index account/time và operation/time; CHECK action allowlist. **Không FK** để evidence không phụ thuộc vòng đời Account/operation. | Chỉ metadata an toàn; không password/JWT/recovery/token/contact rõ. Không purge MVP local, D08 production còn mở. [S§NFR06; M§10.1/§10.5; G§Danh tính] |

`registration_operation` dùng hàng chứa key/digest làm **public idempotency receipt**;
không cần bảng receipt thứ hai cho cùng POST. Cùng key nhưng token sai không đọc operation;
đúng token rồi mới đối chiếu fingerprint. `terminal_error_code` chỉ mã an toàn. Snapshot 201
được mô tả cụ thể bên dưới; không lấy Account hiện tại để dựng replay. [A register/lookup;
G§Public retention; M§10.1; R§Lưu giữ]

## cab_customer

Customer không sở hữu fullName/email/phone hoặc password. Customer lookup lấy Account ID từ mapping local,
rồi lấy contact có thẩm quyền qua Identity RPC với user token/quyền được kiểm tra. [M§5.2;
A getCustomerById/CustomerProfile; R§GetAccountContact]

| Bảng, chủ sở hữu | Trường/kiểu và nullable | PK/FK, unique/index/CHECK | Trạng thái, retention và nguồn |
|---|---|---|---|
| `customer` — Customer | `customer_id UUID`, `account_id UUID`, `provision_operation_id VARCHAR(128)`, timestamps, `version BIGINT` | PK customer_id; UNIQUE account_id và provision_operation_id; composite FK **local** `(provision_operation_id,account_id,customer_id)→customer_provision` xác nhận binding; CHECK version≥1. Account chỉ tham chiếu logic sang Identity. | Tombstone trước Provision chỉ nằm ở `customer_provision`, nên FK không cản. Không xóa completed/active profile khi timeout; D08 production còn mở. [M§4/§5.2/§6.2; A register/getCustomerById; R§Identity] |
| `customer_provision` — Customer | `operation_id TEXT`, `account_id UUID`, `customer_id UUID`, `state TEXT`, `created_at`, `updated_at TIMESTAMPTZ`, `cancelled_at TIMESTAMPTZ NULL`, `version BIGINT` | PK operation_id; UNIQUE **vô điều kiện** `account_id`, UNIQUE **vô điều kiện** `customer_id`; CHECK state PROVISIONED/PROVISION_CANCELLED, opaque ID 1–128, version≥1, cancelled_at tương ứng state. `customer_id` là intended ID ngay cả khi row Customer chưa tồn tại: **không FK** tới Customer. | Cancel trước Provision vẫn ghi tombstone; late Provision bị chặn. Không reuse operation/account/profile ID từ row CANCELLED; không xóa tombstone. Completed/active profile không bị xóa bằng Cancel. Tombstone/receipt giữ suốt MVP. [R§Identity/§Lưu giữ; P CustomerProvision; S§UC22] |
| `customer_rpc_receipt` — Customer | `receipt_id UUID`, `caller_service TEXT`, `full_method TEXT`, `command_id UUID`, `operation_id TEXT`, `fingerprint_hmac BYTEA`, `fingerprint_key_version TEXT`, `result_operation_id TEXT`, `result_account_id UUID`, `result_customer_id UUID`, `result_state TEXT`, `created_at TIMESTAMPTZ` | PK receipt_id; UNIQUE `(caller_service,full_method,command_id)`; FK `operation_id→customer_provision` cho Provision/Cancel; CHECK method ProvisionCustomer/CancelCustomerProvision và result_state PROVISIONED/PROVISION_CANCELLED. Index `(operation_id,created_at)`. Bốn `result_*` là snapshot bất biến của `CustomerProvision`; không FK tới trạng thái hiện tại. | Ghi **cùng transaction** với provision/cancel. Replay sau xác thực lấy bốn field đã lưu, không đọc current provision để dựng response. Không raw token/PII trong fingerprint/receipt; HMAC keyed. Giữ suốt MVP. [R§Quy tắc chung/§Identity/§Lưu giữ; P CustomerProvision/Command] |
| `customer_audit` — Customer | `audit_id UUID`, `operation_id VARCHAR(128) NULL`, `customer_id UUID NULL`, `action TEXT`, `occurred_at TIMESTAMPTZ`, `correlation_id TEXT NULL`, `safe_detail JSONB NULL` | PK; index operation/time và customer/time; CHECK action PROVISIONED/PROVISION_CANCELLED. **Không FK**: tombstone có thể tồn tại trước profile và audit là evidence bền vững. | Không contact/token rõ; không purge MVP local, D08 production còn mở. [S§NFR06; M§10.1/§10.5] |

`CustomerActivityGuard` và tombstone `CancelBookingGuard` thuộc Customer nhưng phục vụ Booking/Trip,
không thuộc migration đăng ký đầu tiên. Thiết kế tương lai phải giữ unique một guard **chưa RELEASED**
cho mỗi Customer, generation tăng đơn điệu, row RELEASED và tombstone theo bookingId để chặn
Acquire đến muộn; release chỉ đúng guardId/generation/owner. Không reuse `customer_provision`
làm guard. [M§5.2; R§Guard/reservation, §Lưu giữ; P CustomerInternalService]

## Invariant: DB và application

| DB bảo vệ trong từng service | Application/worker phải bảo vệ thêm | Nguồn |
|---|---|---|
| Partial UNIQUE claim active cho email/phone với lookup key ổn định, Account role/status/access hợp lệ, optimistic `version`; Session digest unique và expiry 168 giờ; unique register key/target; Step command ID ổn định | Chuẩn hóa email/phone trước HMAC; rotation cần cơ chế cross-version riêng; password Argon2id nguyên trạng; giải mã contact theo quyền; kiểm tra JWT/Session/Account/profile. Không lấy role/ID từ client | S§AC01; M§5.1/§10.1; A register/login/refresh; Q§User context; R§Identity; quyết định MVP local |
| Identity transaction tạo Account+operation+step+safe audit; transition SUCCEEDED+profile ref+`ACCOUNT_PROVISIONED` outbox atomic; CAS version/state chặn finalize sau COMPENSATING | Gọi Customer **sau** local commit, không giữ transaction qua RPC; timeout là outcome unknown → GetProvision rồi retry cùng operation/command; chỉ 201 khi cả hai commit và Identity SUCCEEDED, 202 chỉ operation bền vững | A register; M§6.1–6.2/§8; R§Identity; G§Success/§Deadline |
| Customer transaction ghi provision/profile/receipt cùng nhau; Cancel tombstone+receipt serialize với Provision trên cùng operation, unique account/profile local | Xác minh caller mTLS/policy; sai payload cho command cũ conflict; nếu profile đã hoàn tất hoặc hoạt động thì không xóa; compensation sau quyết định Identity, không suy NOT_FOUND/timeout là rollback | R§Quy tắc chung/§Identity; P CustomerInternalService; M§6.1–6.2 |
| FK và CHECK chỉ bảo vệ row trong cùng DB; unique guard chưa RELEASED sẽ dùng partial index khi tới Booking | Customer phải VerifyUserIdentity và object authorization khi đọc; Identity xác nhận profile bằng RPC, không cross-DB join/transaction; D07 receipt trong 2 giây chỉ cho mutation đã cấp quyền | M§4/§5.2; R§GetAccountContact/§Guard; Q§D07; A getCustomerById |

Register recovery token chỉ giữ digest; key chỉ giữ keyed digest; fingerprint là HMAC canonical
request, không fast hash password. Salt Argon2id riêng trong password hash envelope; mã hóa
email/phone có xác thực, nonce/tag/key version; khóa mã hóa và lookup-HMAC tách DB/Git.
Session chỉ lưu refresh digest, access JWT transient; worker/outbox/audit không lưu raw password,
JWT, refresh hay recovery token. [A register/login/refresh; M§10.1; G§Danh tính; Q§User context]

## Receipt lịch sử và tombstone Customer

Với `ProvisionCustomer` và `CancelCustomerProvision`, khóa receipt là `(caller đã xác thực,
full RPC method, command_id)`. Fingerprint HMAC bao phủ canonical request **kể cả operationId**, dùng
key version riêng. Sau khi xác thực caller và quyền method, cùng command/fingerprint trả đúng bốn field
`CustomerProvision` đã đóng băng trong receipt: `operation_id`, `account_id`, `customer_id`, `state`.
Đây là toàn bộ response proto hiện tại; không lưu `result_ref` rồi dựng state từ row hiện tại. Cùng
command khác payload → `ALREADY_EXISTS/IDEMPOTENCY_CONFLICT`; command mới vẫn phải qua PK/UNIQUE
operation/account/profile và đối chiếu binding. Receipt và mutation profile/tombstone commit trong
**một** transaction Customer. `GetCustomerProvision(operationId)` đọc `customer_provision` hiện tại,
có thể trả `PROVISION_CANCELLED` trong khi replay Provision cũ vẫn là `PROVISIONED`. Không có raw
token/contact trong receipt hoặc fingerprint. [R§Quy tắc chung/§Identity; P CustomerProvision]

| Tình huống | Kết quả và fence DB/application | Nguồn |
|---|---|---|
| Cancel trước Provision | Ghi row tombstone `PROVISION_CANCELLED` với cả ba ID và receipt Cancel; không cần row `customer`. Serialize theo operation; PK/UNIQUE vô điều kiện khóa ID. | R§Identity/§Lưu giữ; P CancelProvisionRequest |
| Provision rồi Cancel | Nếu Identity đã CAS COMPENSATING và Customer xác định profile chưa hoàn tất/hoạt động: chuyển provision sang CANCELLED, xử lý profile an toàn, ghi receipt cùng transaction. Không xóa completed/active profile. | R§Identity; M§6.2 |
| Late Provision cùng operation | Tombstone còn giữ nên từ chối mutation; replay **cùng command đã có receipt Provision** chỉ trả lịch sử sau auth, không tái provision. | R§Quy tắc chung/§Identity |
| Command mới cùng operation | Không qua receipt cũ; đối chiếu immutable binding op/account/profile và state, tombstone chặn Provision mới dù payload cùng ID. | R§Quy tắc chung/§Identity |
| Operation mới dùng lại account/profile | UNIQUE vô điều kiện `account_id` và `customer_id` trên cả tombstone → conflict, không tự cho reuse hay xóa tombstone. | R§Identity/§Lưu giữ |

Customer serialize Provision/Cancel trên cùng operation bằng transaction và row lock hoặc insert
đụng PK; nếu chưa có row, unique constraints vẫn bắt race. Identity là nơi duy nhất biết quyết định
SUCCEEDED toàn cục: protocol bắt buộc Identity không gọi Cancel sau SUCCEEDED. Customer còn kiểm
tra activity/completion local trước xóa, nhưng hiện **không có RPC xác nhận finality toàn cục** cho
Customer; không tuyên bố local check chứng minh được trạng thái Identity. Nếu cần Customer tự chứng
minh finality độc lập, đó là thay đổi giao thức phải review riêng, không thêm RPC tại đây. [R§Identity;
M§6.1–6.2; P CustomerInternalService]

## Khóa HMAC và snapshot công khai

MVP local đã duyệt **một lookup-HMAC key ổn định cho toàn bộ contact đang giữ**; partial UNIQUE
trên `contact_claim(kind,lookup_hmac)` khi `released_at IS NULL` bảo vệ contact đã chuẩn hóa
trong transaction cạnh tranh. Account lịch sử giữ digest không UNIQUE. Có `lookup_key_version`
để đọc/khôi phục nhưng **chưa xoay lookup key trong MVP**.
`UNIQUE(key_version,digest)` không chặn cùng email/phone dưới hai phiên bản. Khi nâng cấp rotation,
cần migration thiết kế alias digest cho **mọi** key đang chấp nhận, unique trên một namespace
canonical, backfill và dual-read/dual-write trong cửa sổ giao thoa, serialize tranh chấp theo
contact và kiểm thử đồng thời trước khi đổi active key; không bật key mới khi backfill chưa xong.
Không giữ plaintext để giải quyết uniqueness. [M§5.1/§10.1; A register]

Idempotency-key HMAC, request fingerprint HMAC và recovery-token digest có **key ID riêng**; trong
MVP, mỗi mục đích dùng key ổn định riêng và chưa rotation. Khóa cũ phải còn khả dụng cho
lookup/verification suốt retention liên quan, kể cả sau public expiry khi evidence nội bộ còn giữ.
Nếu đổi khóa, phải tra các
version còn hiệu lực trước khi tạo operation mới, hoặc duy trì alias/rehash được bảo vệ theo cùng
quy tắc unique. Session refresh digest cũng cần key ID và khả năng verify đến khi Session hết hạn
và replay window liên quan kết thúc. Dùng khóa mã hóa contact/snapshot, khóa contact lookup, khóa
idempotency/fingerprint và khóa token digest **tách mục đích**; version/ID trong DB, vật liệu khóa
ngoài DB/Git. Không giả định chung một khóa hoặc tự dựng KMS. [M§10.1–10.2; A register/refresh;
G§Danh tính; R§Lưu giữ]

Khi Identity finalize, cùng transaction CAS SUCCEEDED ghi `confirmed_profile_id`, snapshot bất biến
và `ACCOUNT_PROVISIONED` outbox. Snapshot mã hóa có xác thực, bao gồm đúng `RegisteredCustomerAccount`
201: `accountId`, `fullName`, `email`, `phone`, `role=CUSTOMER`, `accountStatus=ACTIVE`,
`customerId`, `createdAt`, `updatedAt`; format version và nonce/tag/key version được lưu riêng,
AAD gắn operationId/format version. Chỉ Identity registration handler đã kiểm tra đúng recovery
token/idempotency/fingerprint và trong public window mới giải mã; worker/outbox/audit không được
đọc hoặc sao chép contact rõ. Replay/GET SUCCEEDED dùng snapshot này, **không dùng Account hiện tại**.
PROCESSING/FAILED không có snapshot 201. `terminal_at` định mốc public replay/lookup thêm 7 ngày
theo A/G; hết hạn public không cho xóa saga/receipt/tombstone nội bộ suốt MVP. Chưa thiết kế purge
hay TTL; retention/erasure snapshot chứa PII sau public window chờ D08. [A register/lookup,
RegisteredCustomerAccount; G§Success/§Public retention; R§Lưu giữ; E ACCOUNT_PROVISIONED; M§10.1]

## State machine nội bộ Customer registration

Đề xuất phase Identity tối thiểu `PROVISION_PENDING`, `PROVISION_UNKNOWN`, `FINALIZING`,
`COMPENSATING`, `SUCCEEDED`, `FAILED`; public chỉ PROCESSING/SUCCEEDED/FAILED. Step
`PROVISION_CUSTOMER` và `CANCEL_CUSTOMER_PROVISION` có state `READY`, `OUTCOME_UNKNOWN`,
`CONFIRMED`; `FINALIZING` là quyết định local ngắn, không được giữ DB transaction qua RPC.
`registration_step` giữ ổn định `command_id`, target service, kind, fingerprint, `operation_id`,
`account_id`, `target_profile_id` lấy từ operation. Request retry được dựng lại từ các ID này,
không từ password/recovery token thô. [R§Quy tắc chung/§Identity; M§6.1–6.2; A register]

| Transition | Điều kiện trước và CAS dự kiến | Ghi local cùng transaction; RPC sau commit | Restart/timeout |
|---|---|---|---|
| Nhận register | Key/token/fingerprint hợp lệ và chưa có operation; unique key/contact | Tạo Account chưa login được, operation PROCESSING/PROVISION_PENDING, step Provision READY, audit an toàn; **sau commit** gọi Provision | Scan READY, retry đúng command/payload |
| Gửi Provision | `internal_phase IN (PROVISION_PENDING,PROVISION_UNKNOWN)` và `public_status=PROCESSING`; worker claim bằng version/lease, không cấp quyền | Đánh dấu step OUTCOME_UNKNOWN nếu mất kết quả; gọi `ProvisionCustomer` ngoài transaction | Query `GetCustomerProvision`; cùng binding PROVISIONED thì finalize, NOT_FOUND/timeout đơn lẻ vẫn unknown; retry đúng command nếu phase còn cho phép |
| Xác nhận Provision | CAS `WHERE operation_id=? AND version=? AND internal_phase IN (PROVISION_PENDING,PROVISION_UNKNOWN) AND public_status=PROCESSING`; đối chiếu cả ba ID/state | Step CONFIRMED, phase FINALIZING; không gửi RPC khác trong transaction | Scan FINALIZING; kiểm tra evidence provision rồi finalize nếu chưa COMPENSATING |
| Finalize | CAS `WHERE ... AND internal_phase=FINALIZING AND public_status=PROCESSING`; chỉ khi provision đúng binding được xác nhận | Trong một transaction: phase/public SUCCEEDED, profile ref, snapshot 201, outbox; sau commit mới trả 201 | Replay snapshot; không provision/cancel nữa |
| Quyết định bù | CAS `WHERE ... AND internal_phase IN (PROVISION_PENDING,PROVISION_UNKNOWN,FINALIZING) AND public_status=PROCESSING` → COMPENSATING; không được thắng nếu finalize đã commit | Tạo/giữ step Cancel READY và command ID ổn định; **sau commit** gọi Cancel | Scan COMPENSATING; cấm mọi Provision mới/retry và finalize; query outcome rồi retry Cancel |
| Xác nhận bù | CAS `WHERE ... AND internal_phase=COMPENSATING AND public_status=PROCESSING`; Customer đã xác nhận tombstone/Cancel đúng binding và không còn profile có thể hoạt động | Step Cancel CONFIRMED; phase/public FAILED và safe error cùng transaction | Nếu timeout/NOT_FOUND hoặc bằng chứng chưa đủ: giữ COMPENSATING/PROCESSING, tiếp tục tra cứu/bù; không tự FAILED |

Mọi nhánh gửi RPC phải recheck phase/version ngay trước dispatch; lease/job cũ không vượt được
COMPENSATING. CAS thắng giữa finalize và bù là điểm quyết định Identity; sau bù, retry Provision
cũ có thể đã bay trên mạng, nên Customer tombstone chặn mutation muộn. Nếu Customer từ chối Cancel
vì profile completed/active, giữ PROCESSING và điều tra/forward recovery; không giả FAILED. SQL CAS,
claim worker và transaction boundary nêu ở đây là thiết kế để review, chưa là migration/code.
[R§Identity/§Quy tắc chung; M§6.1–6.2; A register; G§Deadline/retry]

## ID và ranh giới validation

UUID cho Account/Customer ID do server cấp đã duyệt cho MVP local theo M§4, serialize thành public string như API01.
`operationId` luôn opaque 1–128 theo A/P; không ép UUID trong DB hay REST. ID truyền từ public
`customerId` có validation opaque riêng; adapter parse/canonicalize trước SQL nếu cột UUID, trả lỗi
validation/domain **đã được contract của đúng endpoint cho phép**, không để PostgreSQL cast exception
lọt thành HTTP 500 và không tự thêm UUID constraint vào REST. Nếu public ID hợp lệ theo API01 nhưng
không thể ánh xạ UUID DB, handler phải map theo semantics endpoint hiện có; không thêm bảng mã công khai.
HTTP/errorCode cho `operationId` path sai validation
thuộc nhiệm vụ handler riêng. [M§4; A Identifier/getCustomerById/getCustomerRegistrationOperation;
G§Validation]

## Phân loại quyết định trước migration nghiệp vụ

| Loại | Nội dung và hệ quả | Nguồn |
|---|---|---|
| Hợp đồng đã quyết định | Receipt replay lịch sử, unique account/operation/profile và tombstone không xóa; COMPENSATING chặn finalize/Provision, FAILED chỉ sau bù; public 7 ngày sau terminal khác evidence nội bộ. Áp dụng trực tiếp, không mở lại bằng predicate partial. | R§Quy tắc chung/§Identity/§Lưu giữ; A register/lookup; G§Public retention |
| MVP local đã duyệt | UUID ID do server cấp, không bảng mapping công khai; contact mới được reuse sau FAILED/bù xác nhận với ID mới qua partial UNIQUE claim; Session expiry 168 giờ; key theo mục đích ổn định, version giữ lại; Identity quyết định CAS, Customer guard local; finalize worker được giải mã trong bộ nhớ để mã hóa snapshot, không log/outbox PII. | Quyết định chủ dự án 2026-10-02; M§4/§6.2/§10.1; A register/refresh; R§Identity |
| Kỹ thuật SQL V1 đã kiểm chứng DB thử nghiệm | Composite FK binding local; trigger guard claim/session; encrypted snapshot bundle CHECK; `BIGINT` giữ `bigint` trong adapter/JS. Fresh/replay và 10/10 test PostgreSQL PASS; chưa chứng minh crypto/coordinator. | SQL V1 Identity/Customer; R§Identity; A register |
| Production D08 còn mở | Thời hạn/erasure/khóa/archive snapshot, Account, audit, Session và backup sau public window. MVP local không tự purge bất kỳ evidence nào; 7 ngày Session là lifetime, không phải retention PII production. | M§10.1/§18 D08; A refresh |
| Handler riêng | HTTP/errorCode cho `operationId` sai validation còn thiếu, chốt trước lookup handler; không chặn schema độc lập. | A getCustomerRegistrationOperation; G§Validation |

Nếu cần Customer chứng minh Identity đã finalize một cách độc lập trước khi cho Cancel, giao thức hiện
không có RPC/fence cho việc đó; phải review thay đổi contract trước khi triển khai guarantee mạnh
hơn. Không sửa OpenAPI/proto/policy trong tài liệu thiết kế này. [R§Identity; P CustomerInternalService]

Schema Prisma/SQL V1 production riêng đã tạo, fresh install/replay/rights/rollback transaction thử
nghiệm đạt trên PostgreSQL 17.11; provider đã wire AppModule và boot/query/close với runtime role.
Upgrade từ schema nghiệp vụ cũ chưa áp dụng vì V1 là lịch sử đầu tiên. Trước rollout production
cần review SQL, backup/restore và D08; tiếp theo mới là crypto/coordinator/handler.
Thiết kế này không lấy NUMERIC(30,12) hay Decimal precision 40 của probe làm chính sách tiền CAB.

V2 forward sau review V1 không đổi model nghiệp vụ: [Identity SQL V2](../../services/identity-service/src/infrastructure/prisma/migrations/202610020004_identity_evidence_guard/migration.sql) đóng hai lỗ CHECK `NULL`, giữ Session identity/absolute expiry và contact claim bất biến; [Customer SQL V2](../../services/customer-service/src/infrastructure/prisma/migrations/202610020004_customer_evidence_guard/migration.sql) giữ receipt/audit append-only và tombstone không thể xóa/đảo. Quyền runtime theo cột được ghi trong [ma trận persistence](identity-customer-persistence.md). Fresh V1+V2 và upgrade V1 có dữ liệu→V2 đã được kiểm chứng trên PostgreSQL thử nghiệm; chưa có Customer business adapter hoặc network coordinator. Trước login, chỉ tra chủ current unreleased claim; kiểm tra READY/ACTIVE/SUCCEEDED sau xác minh password, không suy lỗi HTTP từ lookup DB.
