# Gateway facade — Customer slice v1

Baseline REST: `API-Document/01-auth-customer-api.yaml`, version 1.3.0 tại commit
`c5314ece78506047c85e9aeb4e836d2dc9453f84`. Chủ dự án cho phép dùng request/response/status/security
hiện có làm baseline facade trong nhiệm vụ này; không sửa OpenAPI và không coi các stack đề xuất là đã duyệt.
Đây là đặc tả facade và baseline cho runtime Gateway/Identity/Customer;
static validation và kiểm chứng network/DB được báo riêng trong `docs/development/status.md`.

## Route và ownership

| REST qua Gateway | Owner | RPC trong package `cab.gateway.v1` | Kết quả thành công |
|---|---|---|---|
| POST /v1/auth/register | identity-service | IdentityFacadeService.RegisterCustomer | created → 201 RegisteredCustomerAccount; processing → 202 CustomerRegistrationOperation |
| GET /v1/auth/customer-registrations/{operationId} | identity-service | IdentityFacadeService.GetCustomerRegistration | 200 CustomerRegistrationOperation (PROCESSING/SUCCEEDED/FAILED) |
| POST /v1/auth/login | identity-service | IdentityFacadeService.Login | 200 AuthSessionResponse |
| GET /v1/accounts/me | identity-service | IdentityFacadeService.GetMyAccount | 200 Account |
| GET /v1/customers/{customerId} | customer-service | CustomerFacadeService.GetCustomer | 200 CustomerProfile |

`gateway-customer-mapping.json` là bảng machine-readable cho đúng năm route; prefix `/v1` lấy từ API01 servers.
Không có RPC OTP/Driver/refresh/logout/update/profile-list/health/provider trong slice này.
Facade là public use case tại service sở hữu; Gateway không tự gọi ProvisionCustomer hoặc compensation.
Identity vẫn điều phối cấp phát qua CustomerInternalService; Customer lookup dùng VerifyUserIdentity/GetAccountContact
theo `rpc-policy.json` hiện có. Không thêm Gateway vào policy MS→MS và không đọc/join database khác.
Với CustomerProfile, `GetAccountContact` trả `account_status`, `created_at`, `updated_at`
từ **Account tại Identity**. Customer dùng accountId từ mapping local, kiểm tra presence,
enum và Timestamp trước khi tạo facade `Account`; không lấy thời gian từ Customer local,
không mặc định ACTIVE hoặc ghép field thiếu để trả 200. Identity proto field 1–6 giữ
nguyên; field 7–9 mới không làm phát sinh RPC hoặc quyền gọi mới.

## Danh tính, metadata và quyền

- Facade server chỉ nhận caller URI SAN **`spiffe://cab.local/service/api-gateway`** qua mTLS;
  Gateway xác minh SAN owner `identity-service`/`customer-service`. CA/EKU/rotation theo SECURITY.md.
- `gateway-customer-policy.json` allowlist full method, owner và scope, default deny.
  Scope gắn với SAN, không tin scope/caller tự khai. Policy nội bộ và facade áp đúng namespace,
  không fallback sang policy khác khi thiếu method. Network isolation không thay authentication.
- Mọi RPC có `x-correlation-id` 1–200 ký tự an toàn và `traceparent` hợp lệ nếu có;
  metadata tổng tối đa 8KiB; unary payload tối đa 1MiB. Gateway sinh lại correlation ID sai.
- Gateway xóa header `x-cab-*`, `x-service-*`, caller/role/account ID giả mạo từ REST client rồi tự tạo metadata.
  `Authorization: Bearer ...` chỉ chuyển thành **`x-cab-user-authorization`** cho GetMyAccount/GetCustomer.
  Access token không nằm trong protobuf request, không thay service identity mTLS.
- Register: Gateway tạo UUID key và token CSPRNG cho request không có cặp header;
  chuyển nội bộ qua **`x-cab-registration-idempotency-key`** và
  **`x-cab-registration-recovery-token`**. Cặp header cũ vẫn được nhận cùng nhau
  để client cũ replay; client mới chỉ cần JSON body. Token trả trong header
  `Registration-Recovery-Token` của 202, không trả ở 201.
  Lookup: chỉ recovery token bắt buộc, operationId trong request. Không nhận bearer thay recovery.
  Login: emailOrPhone/password trong request; không dùng access token/recovery token để xác thực login.
- Gateway kiểm soát bảo vệ/rate limit tương ứng và service đích vẫn kiểm tra độc lập.
  Identity verify signature/algorithm/issuer/audience/exp/nbf, Account ACTIVE, Session và provisioning ở request được bảo vệ.
  Customer gọi Identity verify trong request; CUSTOMER chỉ đọc chính mình, OPERATOR được tra cứu theo quyền,
  DRIVER →403; ngoài phạm vi/không tồn tại →404 cùng thông báo. OPERATOR ACTIVE được đọc Customer target INACTIVE/SUSPENDED.
  Không dùng principal cache xuyên request. D07 receipt/in-flight theo SECURITY.md, không atomic xuyên DB.
- Payload password/login token/recovery token không log, audit, outbox, trace attributes, metrics labels hay durable receipt.
  Registration fingerprint dùng HMAC dữ liệu chuẩn hóa, recovery chỉ digest; Account lưu password hash chuyên dụng.
  Session lưu refresh digest; response login chứa token chỉ transient qua mTLS/HTTPS, Cache-Control no-store.
  Worker tiếp tục từ operation đã ghi, không giữ raw password/JWT/recovery token để retry.

## Typed DTO, presence và validation

Nguồn type: `proto/cab/gateway/v1/customer_facade.proto`. Đây là transport DTO riêng, không business/ORM entity chung.
Proto3 không có required: mọi scalar nghiệp vụ dùng `optional`, message/oneof có presence;
server và Gateway kiểm tra presence, không thay field thiếu bằng `""`, `0`, enum UNSPECIFIED hoặc timestamp epoch.
Oneof unset hoặc enum UNSPECIFIED/unknown trong response → lỗi phụ thuộc, không render thành công.
Không dùng Struct/Any/JSON blob. Không tái sử dụng field number; bỏ field phải reserved tên/số, đổi nghĩa dùng version mới.

| DTO | Field REST ↔ proto và ràng buộc |
|---|---|
| RegisterCustomerRequest | fullName↔full_name, email, phone, password: đủ bốn field; fullName trim/nonblank, email trim/lowercase/email format, phone nội địa Việt Nam 10 chữ số bắt đầu bằng 0 `^0[0-9]{9}$`; password ≥8 ký tự, có ký tự không trắng, giữ nguyên không trim |
| LoginRequest | emailOrPhone↔email_or_phone và password: bắt buộc/nonempty; email chuẩn hóa như register, phone nội địa Việt Nam 10 chữ số bắt đầu bằng 0; password ≥1 và giữ nguyên; không nhận role |
| GetCustomerRegistrationRequest | operationId↔operation_id: bắt buộc, opaque string 1–128; không ép UUID |
| GetMyAccountRequest | Rỗng; Account lấy từ user token đã verify, không có caller accountId/profileId |
| GetCustomerRequest | customerId↔customer_id: theo Identifier API01, nonempty opaque string; không tự thêm max128/UUID vào business REST |
| Account | accountId/fullName/email/phone/role/accountStatus/createdAt/updatedAt bắt buộc; exactly one profile customerId/driverId/operatorId, khớp Role; snake_case↔camelCase. Role CUSTOMER/DRIVER/OPERATOR, AccountStatus ACTIVE/INACTIVE/SUSPENDED |

Request phone mới ở REST luôn là `^0[0-9]{9}$`. Identity đổi số nội địa sang
`+84` cộng chín chữ số cuối trước khi mã hóa/tạo HMAC lookup và so trùng;
dữ liệu `+84` đã lưu vì thế giữ nguyên và có cùng lookup với request mới.
Các snapshot lịch sử và Account cũ có `+84` cộng chín chữ số được đổi sang
dạng nội địa khi trả API. Bản ghi legacy `+84` cộng mười chữ số được giữ
nguyên khi đọc; không tự cắt số, suy ra số thay thế hay nhận dạng đó ở request
mới. Đây là ngoại lệ đọc tạm thời cho dữ liệu hiện có.
Không chấp nhận `+84` trong request REST mới. Quy tắc này không đổi field number
hoặc phân quyền RPC.
| RegisteredCustomerAccount | Account nhưng bắt buộc CUSTOMER + ACTIVE + customerId; không có Session/token |
| CustomerProfile | Account CUSTOMER + customerId, target có thể ACTIVE/INACTIVE/SUSPENDED; không thay bằng schema register |
| AuthSession | accessToken/refreshToken nonempty, tokenType BEARER render **Bearer**, expiresIn nguyên 1–900, sessionExpiresAt và Account; Account ACTIVE/profile đúng role, access expiry không vượt Session; Login vẫn hỗ trợ ba role theo API01 |
| CustomerRegistrationOperation | operationId 1–128, status, createdAt/updatedAt bắt buộc. PROCESSING không terminal; SUCCEEDED có result RegisteredCustomerAccount và không error; FAILED có ErrorResponse và không result |
| ErrorResponse | errorCode/message bắt buộc string theo API01 (không tự thêm minLength); details optional array FieldError(field/message bắt buộc), correlationId optional string. FieldErrors wrapper phân biệt thiếu details với `[]`; vắng thì omit, không serialize null |

Timestamp message phải hiện diện và hợp lệ, render RFC3339 UTC (không numeric seconds ở REST).
Enums render literal REST, không enum number; scalar presence được giữ khi render kể cả empty string được schema cho phép.
Không dùng trực tiếp JSON.stringify(proto) làm REST mapper; validate DTO rồi render camelCase/flatten wrapper.
REST body phải tuân `additionalProperties:false`, từ chối null/trường lạ trước chuyển protobuf;
service validate lại field/type/schema. Giới hạn transport không tạo validation nghiệp vụ mới.

Gateway tạo Idempotency-Key UUID và recovery 32 byte CSPRNG base64url không padding,
43 ký tự `^[A-Za-z0-9_-]{43}$` khi client không gửi cặp header cũ. Cặp cũ nếu
cung cấp phải đầy đủ và hợp lệ. Sau 202, client giữ token từ response để lookup;
operationId đơn thuần không cấp quyền. Không có cặp proof cũ thì POST lặp sau
mất response là request mới, chịu unique contact; không hứa replay 201.
Field/parameter sai được xử lý theo **từng endpoint**, không thêm 400 vào endpoint không có 400:
lookup thiếu/sai định dạng recovery →401 REGISTRATION_RECOVERY_INVALID;
operation ID không tồn tại hoặc không được phép lookup →404 REGISTRATION_NOT_FOUND (không tiết lộ trạng thái).
API01 chỉ liệt kê 401/404/429/503/default cho lookup. Chủ dự án đã chốt ngày 2026-10-03:
`operationId` sai validation 1–128 trả 404 `REGISTRATION_NOT_FOUND`, không tiết lộ trạng thái.
Đây là quyết định handler local trên cặp status/errorCode đã có, không thay OpenAPI.

## Success, status và lỗi

- RegisterResponse.created chỉ sau Identity commit SUCCEEDED, xác nhận đúng Account+Customer; →201 Account đã tạo, không login.
- RegisterResponse.processing.operation chỉ PROCESSING đã persist; retry_after_seconds bắt buộc ≥1.
  →202 body operation, Gateway dựng Location `/v1/auth/customer-registrations/{operationId}` với ID URL-encoded,
  Retry-After từ response, `Registration-Recovery-Token` từ proof Gateway vừa tạo,
  Cache-Control no-store. Không trả 202 khi chưa chứng minh durable operation.
- Lookup gRPC OK →HTTP200 cho cả ba trạng thái; 200 lookup không có nghĩa registration thành công.
  SUCCEEDED trả result snapshot 201 đã lưu; FAILED chỉ lỗi an toàn cuối cùng, không raw request/secret.
- Login gRPC OK →200 sau tạo Session. Sai account/password đều INVALID_CREDENTIALS chung;
  ACCOUNT_NOT_ACTIVE/REGISTRATION_IN_PROGRESS chỉ sau mật khẩu đúng. Driver chưa duyệt vẫn login được.
- Mọi response REST, gồm lỗi, có Cache-Control no-store. HTTP429 có Retry-After nguyên ≥1 từ limiter/error detail.

RPC lỗi dùng gRPC status và `cab.gateway.v1.FacadeErrorDetail` trong google.rpc.Status.details.
`error` có shape ErrorResponse; auth failure bắt buộc auth_origin END_USER hoặc SERVICE.
Không có HTTP code trong protobuf. `gateway-customer-mapping.json` liệt kê cặp status/errorCode theo từng endpoint:

| Endpoint | HTTP lỗi và errorCode → gRPC |
|---|---|
| register | 400 VALIDATION_ERROR→INVALID_ARGUMENT; 401 REGISTRATION_RECOVERY_INVALID→UNAUTHENTICATED; 409 CONTACT_CONFLICT/IDEMPOTENCY_CONFLICT→ALREADY_EXISTS, IDEMPOTENCY_KEY_EXPIRED/REGISTRATION_FAILED→FAILED_PRECONDITION; 429 RATE_LIMIT_EXCEEDED→RESOURCE_EXHAUSTED; 503 SERVICE_UNAVAILABLE→UNAVAILABLE |
| registration lookup | 401 REGISTRATION_RECOVERY_INVALID→UNAUTHENTICATED (thiếu/sai định dạng token); 404 REGISTRATION_NOT_FOUND→NOT_FOUND (token đúng định dạng nhưng sai, operation không tồn tại, không thuộc loại đăng ký Customer, hoặc hết cửa sổ tra cứu); 429 RATE_LIMIT_EXCEEDED→RESOURCE_EXHAUSTED; 503 SERVICE_UNAVAILABLE→UNAVAILABLE |
| login | 400 VALIDATION_ERROR→INVALID_ARGUMENT; 401 INVALID_CREDENTIALS→UNAUTHENTICATED; 403 ACCOUNT_NOT_ACTIVE→PERMISSION_DENIED; 409 REGISTRATION_IN_PROGRESS→FAILED_PRECONDITION; 429 RATE_LIMIT_EXCEEDED→RESOURCE_EXHAUSTED; 503 SERVICE_UNAVAILABLE→UNAVAILABLE |
| account me | 401 UNAUTHENTICATED→UNAUTHENTICATED; 403 ACCOUNT_NOT_ACTIVE→PERMISSION_DENIED; 429 RATE_LIMIT_EXCEEDED→RESOURCE_EXHAUSTED; 503 SERVICE_UNAVAILABLE→UNAVAILABLE |
| customer lookup | 400 VALIDATION_ERROR→INVALID_ARGUMENT; 401 UNAUTHENTICATED→UNAUTHENTICATED; 403 FORBIDDEN/ACCOUNT_NOT_ACTIVE→PERMISSION_DENIED; 404 CUSTOMER_NOT_FOUND→NOT_FOUND; 429 RATE_LIMIT_EXCEEDED→RESOURCE_EXHAUSTED; 503 SERVICE_UNAVAILABLE→UNAVAILABLE |

Downstream internal reason ACCOUNT_INACTIVE phải map sang API01 ACCOUNT_NOT_ACTIVE; RATE_LIMITED sang RATE_LIMIT_EXCEEDED.
Service mTLS/policy failure (auth_origin SERVICE hoặc TLS handshake failure) →503 SERVICE_UNAVAILABLE,
không 401 user. UNAVAILABLE/DEADLINE_EXCEEDED/CANCELLED do dependency/transport →503; không giả lỗi user/404.
Quá tải dependency không map429 user limiter. Cặp status/reason sai, thiếu detail hoặc response sai schema →503 fail closed/alert.
Gateway bug local INTERNAL/DATA_LOSS dùng default HTTP5xx của API01, ErrorResponse an toàn;
API01 không liệt kê mã errorCode cụ thể cho mọi bug default, slice không tự bổ sung enum REST.

## Deadline, retry và outcome chưa biết

Deadline facade là giới hạn transport riêng trong policy: Register4000ms, Lookup1000ms, Login2000ms,
GetMyAccount1000ms, GetCustomer3000ms (đủ hai hop Identity). Không phải thời hạn operation/retention.
Deadline con dùng min(policy nội bộ, budget còn lại trừ100ms), không còn budget thì không gọi thêm.
Read retry tối đa hai lần chỉ UNAVAILABLE trong tổng budget, jitter50–150ms; không retry auth/schema/validation lỗi.
Register/Login không tự retry ở Gateway: client cũ có cặp key/token có thể replay;
client mới mất response không có proof replay, gửi lại có thể gặp CONTACT_CONFLICT;
login không có idempotency key trong API01, timeout có thể đã tạo Session nên không hứa exactly-once hoặc tự tạo Session thứ hai.

Timeout không rollback transaction đã commit. Register chỉ trả202 khi nhận được response hợp lệ chứng minh durable PROCESSING;
transport timeout không kèm bằng chứng thì503; client mới không có proof nên
không thể lookup operation từ 503, retry chịu unique contact. Worker vẫn phục
hồi operation đã commit mà không tạo Account/Customer thứ hai.
Không tự suy 201/202 từ việc socket đóng, không tự bù/xóa Account từ Gateway.
Receipt registration không persist success response login chứa raw token; registration worker chỉ dùng evidence đã bảo vệ.

## Public retention khác evidence nội bộ

- Theo API01 register: operation PROCESSING/bằng chứng phục hồi giữ đến terminal; public lookup thêm7 ngày sau terminal.
  Replay của client cũ với đúng token/key/body sau cửa sổ →409 IDEMPOTENCY_KEY_EXPIRED;
  GET sau cửa sổ →404 REGISTRATION_NOT_FOUND.
  Sai token khi POST key đã có →401; GET sai token/không tồn tại/sai loại/expired đều404; không lộ record tồn tại.
- Retention đề xuất API01 được dùng làm baseline đặc tả theo nhiệm vụ này, không tự chạy TTL/migration.
  contracts/RPC giữ receipt/saga/generation/tombstone nội bộ suốt MVP; public hết lookup không được xóa evidence.
  Giữ digest/tombstone tối thiểu không PII để không tái tạo cùng key; không tự purge key/digest hay compensation fence.
- API01 đã nêu status sau public expiry; không cần đặt mã lỗi mới.
  **D08 còn thiếu chính sách dọn tombstone sau MVP và cách kết thúc/archive evidence chứa PII**;
  trước nhiệm vụ cleanup/production phải chốt riêng. Không chặn công việc đặc tả hiện tại và không coi7 ngày là quyền xóa saga.

## Kiểm chứng

`python contracts/tools/validate.py` compile toàn bộ proto, giữ coverage34 nội bộ và thêm5 facade/policy riêng;
gọi `validate_facade.py` để kiểm tra mapping API01, descriptor/presence, DTO roundtrip/schema và các negative case.
Các fixture là dữ liệu synthetic phục vụ static contract check, không runtime mock service/integration.
Kiểm tra mTLS, deny caller, quyền/Session, transaction/idempotency/concurrency/recovery phải chạy khi có implementation.
Không sửa requirements đã pin để có kết quả xanh.
