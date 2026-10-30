# Kế hoạch triển khai CAB

## 2026-10-30 — Postman Driver ONLINE/OFFLINE

Compose demo đã có vị trí mẫu khi Driver APPROVED/xe ACTIVE bật AVAILABLE
nhưng GPS thiếu/cũ. JSON công khai vẫn là `AVAILABLE/OFFLINE`; ONLINE là nhãn
thao tác, BUSY nội bộ được giữ. Driver mới chỉ có 30 giây để xuất hiện trong
Dispatch từ mẫu này; nếu thao tác Booking muộn, làm mới vị trí hoặc bật lại
theo version hiện tại. Production giữ xác minh GPS thiết bị. Bước tiếp theo:
chủ dự án chạy Postman GUI câu 23 theo hướng dẫn đã rút gọn, rồi tiếp tục
các câu Booking với vị trí mới; không coi mẫu GPS là bằng chứng tracking thật.

## 2026-10-30 — Thứ tự Trip rồi Payment cho demo

Đã áp dụng quyết định nghiệp vụ mới: Driver đưa Trip qua
`ARRIVED_PICKUP → PICKED_UP → IN_PROGRESS → COMPLETED` mà không cần Payment;
Customer tạo Payment từ Trip đã hoàn thành, rồi Driver xác nhận CASH hoặc
Customer mô phỏng DEMO_TRANSFER. PricingSnapshot vẫn do Payment cấp trước
Booking để chốt số tiền; Fare/Payment chỉ phát hành sau chuyến. Hợp đồng
OpenAPI/RPC và Postman đã cập nhật, không sửa migration đã áp dụng.

Đã kiểm chứng build, typecheck, validator, 79 test, PostgreSQL+mTLS và HTTP
Compose cho hai phương thức thanh toán. Bước tiếp theo: chủ dự án chạy Postman
GUI theo thứ tự mới; điều tra riêng tracking GPS `UNAVAILABLE` trong một lần
chạy harness CASH, không dùng kết quả resume Trip/Payment để tuyên bố tracking
PASS. Các ghi chép lịch sử bên dưới phản ánh hợp đồng tại thời điểm cũ.

## 2026-10-14 — Vận hành Compose sau sửa chứng chỉ

Quy trình demo hằng ngày: mở Docker Desktop, từ Git root chạy
`docker compose up -d`, đợi `/ready` 200 READY, đăng nhập lấy token mới,
thực hành Postman, cuối ngày `docker compose stop`. Source đổi mới dùng
`docker compose up -d --build`. `cert-renewer` cấp/gia hạn workload dưới
24 giờ, launcher nạp chứng chỉ mới; healthcheck phải fail closed nếu leaf
caller không đạt. Broker setup phụ thuộc healthcheck RabbitMQ có app và
listener thực sự sẵn sàng. Không reset data/volume, không seed hằng ngày.

Kiểm chứng đã làm gồm CA tạm/near-expiry/launcher reload và Compose stop/up
thật với dữ liệu giữ nguyên. Sau này quan sát thêm một chu kỳ gia hạn tự nhiên
qua đêm; không dùng việc chưa quan sát đó để phủ nhận các kiểm thử mô phỏng.

## 2026-10-12 — Sau rà 30 mục

Bảng hiện hành đủ 30 dòng ở `grading-tracker.md`; hướng dẫn Postman nhập tay
ở `dev/GRADING-CHECKS.md`. Health demo dùng probe container có hạn sử dụng,
heartbeat worker và 12 thành phần gồm MongoDB thay Redis theo quyết định chủ
dự án. Đã chạy `/health`, `/ready`, `/health/services` qua Compose và harness
probe lỗi/cũ tách biệt. Nếu triển khai nhiều Gateway, phải thiết kế limiter
chia sẻ và dependency tương ứng trước khi gọi là readiness production.

Trip ERROR giờ có V4 migration mới, OPERATOR restore/close, audit/receipt,
outbox và closure/release; HTTP/DB synthetic đã đạt. Tiếp theo: chủ dự án
thực hành Postman GUI, nhất là Booking–Trip–Payment–Rating và Health/Driver
theo ID; ghi lại status/response. D03 đã chọn rà soát JourneyMetrics thủ công:
giữ PENDING/REVIEW_REQUIRED, sau demo cần thiết kế thao tác OPERATOR xác nhận
và provenance GPS; không chốt ngưỡng tự động hoặc tính lại giá. Bổ sung test
fault-injection restart closure trên project riêng khi cần, không dừng hạ
tầng demo. Mục 29 đo 1.202,4 req/s trên adapter Linux tạm (Windows 459),
chưa có benchmark end-to-end Compose theo môi trường chấm. Metadata gRPC 8 KiB
và hardening đa instance vẫn trong backlog.

## 2026-10-12 — Sau Rating MVP

Mục 20 đã có Rating service/DB/migration/facade và HTTP Gateway→gRPC mTLS→
Identity/Trip→PostgreSQL thật. POST từ Customer chủ Trip COMPLETED, GET theo
đúng quyền, Driver/Operator list; Payment CASH PENDING không chặn. Replay
cùng nội dung, conflict khác nội dung và DB unique/concurrency đã kiểm chứng.
Tiếp theo: chủ dự án chạy Postman GUI với collection Rating nhập tay; sau đó
mới kiểm tra fault-injection nhiều instance và backup/restore cho toàn hệ.
Giữ Trip ERROR và D03/JourneyMetrics trong backlog riêng; không biến Rating
thành điều kiện thanh toán hoặc triển khai ranking/Rating Notification.

Thiết lập Rating một lần: `node dev/compose/setup-rating.mjs`,
`node dev/compose/prepare.mjs`, `docker compose up -d --build` từ Git root.
Vận hành thường ngày: `docker compose up -d`; không reset database/volume.

## 2026-10-12 — Sau tích hợp Booking/Trip/Payment demo

Luồng CASH, DEMO_TRANSFER, FAILED→retry, hủy sau trả tiền, 5 Driver/5 Booking
phân trang và Notification đã chạy qua HTTP Gateway và các owner service thật
trong Compose `cab`; xem `status.md`. Giữ kiến trúc database-per-service,
PricingSnapshot do Payment cấp, assignment/closure có fence, receipt và
outbox; không rút điều kiện để tạo success giả. Giữ các migration V1/V2/V3
đã áp dụng bất biến, chỉ thêm migration mới khi có thay đổi schema được review.
Ca hai HTTP accept đồng thời cùng offer đã đạt một Trip sau khi sửa replay
reservation JSONB; kiểm tra này vẫn cần lặp dưới fault-injection nhiều instance.

Tiếp theo cho cùng slice: chạy Postman GUI theo collection nhập tay; dựng
project tích hợp tách biệt để fault-injection/restart và kiểm tra race/timeout
toàn tuyến, đối chiếu closure/release và dedupe Notification sau retry.
HTTP Incident/ERROR đã chạy trên dữ liệu synthetic riêng; Operations
khôi phục/đóng ERROR cần đúng contract và quyết định D03 cho JourneyMetrics
CONFIRMED/REVIEW_REQUIRED trước khi đánh dấu mục Trip đầy đủ. Chạy lại full
`docker compose up -d --build` sau khi source đổi; build sạch Dockerfile
chuẩn đã chạy lại PASS `npm ci`/generate/build từ lockfile sau lỗi registry
`ECONNRESET` ở lượt đầu, không thay dependency.
Sau đó mới xét Rating theo kế hoạch sau, không triển khai trong slice này.

Chạy thường ngày từ Git root: `docker compose up -d`; source đổi thì
`docker compose up -d --build`. Fixture HTTP opt-in:
`node dev/booking-http-e2e.mjs prepare`, rồi các pha `cash`, `transfer`,
`failed-retry`, `paid-cancel`, `pages`, `nearby`, `audit`, `incident`, `race`. Chỉ dùng tài khoản
synthetic; không chạy bộ Node dev song song, không reset dữ liệu/volume.

## 2026-10-10 — Sau nền tảng Trip/Payment

Giữ Trip migration V1/V2 đã áp dụng bất biến. Hoàn tất Booking theo API02/03:
Payment PricingSnapshot trước Booking, guard Customer và reservation Driver
có BOUND/tombstone/release RPC thực, AssignmentSaga gọi Trip Prepare/Activate
với cùng ID và snapshot. Không tạo endpoint public để tự cấp Trip. Sau đó
kiểm thử HTTP Gateway với Booking thật, CASH/DEMO_TRANSFER và closure release
qua hai owner, outbox→RabbitMQ→MongoDB, retry/restart/race; chỉ khi đó mới
đánh giá tiêu chí 15–19. Trước demo Trip tracking, cần Driver bàn giao mẫu GPS
bền vững gắn đúng tripId/assignmentId và Trip trả profile/vehicle qua owner
RPC; thêm Incident/ERROR, Metrics CONFIRMED và kiểm chứng Notification.
Rating để sau Booking/Trip/Payment. Không dùng harness principal/Booking trong
Compose runtime.

## 2026-10-09 — Payment trước Trip, rồi Booking và Rating

Payment source và Compose đã có PricingSnapshot cố định, Fare/Payment/Attempt,
receipt/idempotency, kết quả DEMO_TRANSFER/CASH, outbox và publisher AMQPS.
PostgreSQL riêng, contract và Gateway đã kiểm tra tĩnh/DB độc lập; HTTP có
token fail closed 503 khi thiếu Trip/Booking. Không dùng kết quả harness làm
bằng chứng tích hợp các owner service. Bước kế tiếp đúng thứ tự: triển khai
Trip owner với GetTripPaymentContext, gọi Payment.GetTripPaymentDecision trước
PICKED_UP → IN_PROGRESS và điều kiện CASH/DEMO_TRANSFER khi bắt đầu chở khách,
sau đó hoàn thiện Booking với GetBookingPaymentContext và
PricingSnapshot Payment cấp. Chỉ sau đó mới kiểm thử Payment qua HTTP/AMQPS
đầy đủ, list attempts HTTP, hủy sau SUCCESS cần xử lý thủ công và Rating. Không
đổi giá Trip theo GPS sau chuyến; không dùng mock trong runtime để lấy PASS.

## 2026-10-09 — Booking dependency gate

The isolated Identity eligibility and Driver discovery/nearby source is a
foundation, not a Booking MVP release. Before a Booking 201 can be built,
select the authoritative Payment pricing contract and an approved fare table;
API02 does not permit Booking to invent `PricingSnapshot`. Before Driver
accept/assignment can be completed, provide the Trip activation owner required
by API03. Keep both questions separate from the 1 km candidate search.

After those decisions: implement service-owned Booking DB/migration and
durable create/dispatch/cancel operations, Customer guard and Driver
reservation fencing, offer/accept state machine, outbox to RabbitMQ and
Notification, read/list paging, and recovery. Then run concurrency/HTTP
integration against isolated fixtures, migrate existing demo safely, deploy
the relevant Compose images and verify health/image IDs. Do not mark rubric
13–16 or 18 complete from static validation or unit tests. Do not deploy the
current partial source as a Booking release.

## 2026-10-08 - Domestic-phone cutover completed with legacy read exception

The approved temporary rule is deployed in Identity and Gateway: new phone
input is strict domestic, convertible stored `+84` renders domestic, and the
61 overlength stored contacts remain unchanged on read and accessible via
email login. No data repair or migration was run. The deployed Gateway also
accepts Driver review and availability without client Idempotency-Key while
the owner keeps internal receipts/CAS. Candidate and live HTTP regressions,
final image 65/65 tests, build/typecheck and contract validation passed; see
status for details. Next, perform manual Postman GUI checks against
`http://127.0.0.1:33201` using new test applicants; reserve TaiXeDemo1 for
the user's own review flow. Keep a later task for deciding how to handle the
61 anomalous legacy contacts if uniform domestic output is required.

## 2026-10-08 - Payment-only client Idempotency-Key

The current Gateway implementation accepts Driver review and availability
without a client key, while sending a generated UUID to the Driver owner for
its existing command receipt. Keep expectedVersion/expectedDriverVersion,
role/state checks, unique constraints, one-use OTP/proofs and event dedupe.
API02/API04/API07/API08 and manual Driver collections have removed the client
header requirement; API05 Payment remains the sole API that requires it.
Read current application/Driver state after an uncertain response before
issuing a new versioned command. The real Compose network regression and
Linux full suite passed; see status for evidence. Do not infer a public replay
guarantee from the server-generated command key.

Next: resolve the separate legacy-phone data cutover gate, then rebuild/recreate
only affected demo apps and repeat the full HTTP smoke with historical accounts.
Do not implement Payment as part of this simplification.

## 2026-10-07 - Phone-format cutover gate

Implementation and static checks for domestic Vietnamese phone are complete.
Canonical lookup stays `+84` plus nine digits, preserving correctly formed
historic encrypted contacts and HMAC claims without migration. A read-only
database audit found 61 existing contacts outside this equivalence class,
including the seeded Operator/Driver phone values. Do not guess a digit to
remove, rewrite those records or deploy a public mapper that would return 503
for them. Decide a data-correction/exception policy after reviewing a
non-sensitive collision audit and correct source numbers. Then test existing
seed login, new Customer/Driver registration and OTP, duplicate conflict,
invalid input, and owner authorization through the real Compose Gateway;
recreate only affected apps and retain all volumes. Run the pinned validator
and Linux full suite again only if source/contracts change after this point.

## 2026-10-07 - Driver OTP shown only in explicit Compose demo mode

The Identity owner now returns the actual six-digit code for its committed
Driver OTP challenge through optional facade protobuf field 7. Gateway maps it
to optional REST `otp` only when both processes have
`NODE_ENV=development` and `CAB_DEMO_OTP_RESPONSE_ENABLED=1`.
The root Compose demo sets both values only on Identity and Gateway.
Flag disabled or `NODE_ENV=production` omits the field. The code is random
per challenge; expiry remains five minutes, resend limit one minute, five
failed attempts, and verification one-use. DB retains keyed digest and
encrypted dev delivery payload, not plaintext. No migration or permission
change was needed. The previous keyless Customer/Driver registration behavior
remains intact. Manual Postman collection
`dev/postman/CAB-Driver-Manual-OTP.postman_collection.json` uses literal
loopback URLs and no environment/script.

Evidence: host build/typecheck PASS; pinned contract validator PASS (11 proto,
34 internal + 18 facade policy RPCs, 466 static facade checks, OpenAPI parse);
Linux image full Vitest 55/55 PASS; built Nest contexts 4/4 PASS. Real HTTP
through Compose Gateway/mTLS/PostgreSQL: OTP returned on 202 and verified
against its own challenge (200), Driver keyless submit 201; wrong/expired and
five-attempt locked challenge 400, resend 429, verified OTP replay 409.
Temporarily recreated only Identity/Gateway with demo flag 0: 202 omitted
`otp`; then production NODE_ENV with flag 1: 202 omitted `otp`.
A first omission test contacted Gateway before health readiness and failed at
the socket; it was repeated with Compose `--wait` and both modes passed.
The original demo Compose configuration was restored in a finally block and
a fresh HTTP 202 again contained a six-digit OTP (value never printed).
Previous simplified Customer and Driver HTTP regressions and test:built passed.
No Postman GUI run was claimed. No existing data, credentials, volume or
container outside the two app replacements was reset/deleted.


## 2026-10-07 - simplified manual Customer/Driver registration

On branch feat/customer-foundation, HEAD c5314ec, existing local work preserved.
Customer POST /v1/auth/register now needs JSON body only. Gateway creates an
internal UUID idempotency key and 32-byte recovery token; a durable 202 returns
the token in Registration-Recovery-Token response header. Lookup still requires
the token; operationId alone never authorizes it. The old paired headers remain
optional for legacy replay. Driver POST /v1/driver-applications no longer needs
a client Idempotency-Key; Gateway creates an internal key, while OTP
verificationToken remains one-use. Driver lookup checks the original proof,
and checks an old key if one was supplied. Unique contact/license constraints
and stable internal operation/command IDs remain in the owners. Review,
availability, Notification and other idempotency/CAS contracts were not changed.

Verified against the existing cab Compose project, real Gateway/gRPC mTLS/DB:
new Customer registration 201, duplicate phone/email 409 CONTACT_CONFLICT,
concurrent same data one success and one 409, login/Me/profile 200; stopped
only Customer service, received durable 202 and server proof, lookup missing
proof 401/wrong proof 404/correct proof PROCESSING 200, restarted same service,
then SUCCEEDED 200. New Driver keyless submit 201, proof-only operation lookup
200, missing/wrong proof 401/404, consumed token reuse 409
VERIFICATION_TOKEN_USED, login and own SUBMITTED application 200. Legacy
Customer five-route smoke, legacy Driver OTP/replay/review/availability, and
Notification approved own-inbox/read/owner checks all passed. A separate
Driver-service outage attempt returned 503 rather than 202 within the current
facade deadline. It was not counted as a Driver 202 PASS; Driver service was
restarted. A 503 or lost response without an operation ID/old key cannot be
looked up by the new client; server recovery continues and duplicate constraints
prevent a second account. This usability limit remains to review.

Host build, typecheck, typecheck:db and test:built passed. Host Vitest could not
start due Windows SWC native cache ownership; 55/55 passed in the rebuilt Linux
image. Pinned read-only contract validator passed 11 protobuf, 34 internal +
18 facade policy RPCs, 463 facade checks, event fixtures and OpenAPI parse.
No Postman GUI run was claimed. Only Identity and Gateway Compose containers
were recreated; Customer/Driver were stopped and restarted solely for bounded
recovery checks. No database, broker, volume or existing demo credential was
reset. Registration probe data is synthetic and separate from demo accounts.


## Đường chạy demo đã chọn (2026-10-06)

Root `compose.yaml` là đường chạy chính của slice đã triển khai: năm app riêng,
PostgreSQL/RabbitMQ/MongoDB và migration/certificate jobs. Một lần chuẩn bị scoped
runtime secret bằng `node dev/compose/prepare.mjs`; từ đó `docker compose up -d`
khởi động bộ demo, `up -d --build` khi source đổi, `stop` giữ dữ liệu. External
volume đã xác minh được tái dùng, không có service giả cho Booking/Trip/Payment/
Rating. Bộ Node host cũ chỉ giữ để rollback, không chạy song song.

Bằng chứng migration/HTTP/AMQPS/Notification sau cutover nằm trong `status.md` và
baseline ignored. Bước kỹ thuật tiếp theo: kiểm chứng khôi phục từ bốn archive trên
môi trường riêng; chuẩn hóa bootstrap trên máy trắng với volume được map có kiểm
chứng; kiểm chứng nút Docker Desktop Start và broker certificate reload/restart.
Không đánh dấu các nghiệp vụ ngoài slice là hoàn thành vì đóng gói.


## Mốc Notification Driver (2026-10-05)

Driver review/outbox → RabbitMQ confirm/mandatory → Notification inbox MongoDB → IN_APP thông báo đã triển khai và có smoke HTTP Gateway/mTLS/PostgreSQL/RabbitMQ/MongoDB thật cho APPROVED/REJECTED. GET/PATCH Notification dùng facade riêng, Identity VerifyUserIdentity và object filter tại Mongo. Postman collection mới đi cùng collection Driver cũ. Vận hành dev dùng `dev:notification:setup`, `dev:notification:up`, `dev:migrate`, `dev:start:notification`; xem `dev/README.md`.

Harness project riêng đã thử broker mất trước review rồi phục hồi, Mongo gián đoạn và consumer restart: outbox/notification không mất và không trùng trong hai tình huống đã chạy. Tiếp theo kiểm tra restore/backup, quyền broker/Mongo, limit tài nguyên và transient 503 đã quan sát một lần ở GET Notification; chưa có kiểm chứng production. Không dùng container `cab-bootstrap-test-*` hoặc dừng broker/DB dev đang dùng. Không mở rộng sang Booking/Trip/Payment/Rating trong mốc này. Metadata gRPC 8 KiB vẫn là backlog.

Ngày cập nhật: 2026-10-03. Customer demo đã có Gateway, Identity coordinator,
Customer adapter, crypto, Session, dev PostgreSQL bền vững và Postman placeholder.
Quyết định bổ sung ba field vào `GetAccountContact` đã được chủ dự án duyệt;
HTTP smoke đủ năm route, contract validator và full tests đều đạt trên lần chạy
mới. Xem mốc cuối tài liệu để phân biệt demo hiện có với production còn thiếu.
Các quyết định và điểm chưa đồng bộ có bằng chứng nằm ở [status.md](status.md).

## Stack scaffold đã chọn; persistence còn đề xuất

| Thành phần | Đề xuất và lý do | Điều kiện chốt |
|---|---|---|
| Node.js + TypeScript | Node 24.19.0 thực tế; TypeScript 6.0.3 theo Nest 12, types Node 24.19.0 | Đã chọn cho scaffold; build/typecheck đạt |
| NestJS | 12.1.2; module/DI, HTTP adapter và lifecycle transport gRPC; domain vẫn là TypeScript thuần | Chủ dự án chọn NestJS; mTLS network kiểm chứng với test certificate, chưa deployment |
| npm workspaces | npm 11.17.0; đúng ba workspace, lockfile chung, build theo service | Đã chọn cho scaffold; không chia sẻ business model |
| Prisma | 7.10.0 pin CLI/client/adapter-pg; mỗi service có schema/client riêng ở infrastructure | Đã chọn có điều kiện cho Identity/Customer: 14/14 probe + 6/6 lifecycle thật PASS; chưa duyệt mọi service |
| ORM thay thế | Chưa cài/chuyển ORM khác trong thử nghiệm này | Prisma được chọn có điều kiện cho hai service; không dùng ORM entity làm domain entity |
| Migration | SQL riêng service, migration role riêng; probe dùng migrate deploy, không schema sync/reset | V1→V2/replay/fresh/failure probe đạt; upgrade schema nghiệp vụ/forward fix/restore/drift còn phải kiểm chứng |
| Vitest + Supertest | Vitest 5.0.3, Supertest 7.3.0; SWC 1.16.13/unplugin-swc 2.0.0 emit metadata | Đã chọn; 35/35 smoke/mTLS/payload và 20/20 PostgreSQL probe/lifecycle đạt, không đổi runner |
| PostgreSQL, RabbitMQ, Redis | Đã chốt vai trò trong thiết kế; Compose local phục vụ tích hợp thật | Ghim phiên bản/image digest sau duyệt và xác minh; không `latest` |

Đối chiếu tài liệu chính thức ngày khảo sát: [NestJS gRPC](https://docs.nestjs.com/microservices/grpc),
[NestJS testing](https://docs.nestjs.com/fundamentals/testing),
[Prisma transactions](https://www.prisma.io/docs/orm/fundamentals/transactions).
Việc các công cụ hỗ trợ transport/test/transaction là cơ sở lựa chọn; đánh giá phù hợp CAB là đề xuất của dự án.
Direct dependency pin chính xác trong manifests và package-lock.json; không dùng tag latest hoặc CLI global.
Chọn **ESM nhất quán** (`type: module`, NodeNext, import tương đối .js). Nest 12 dùng ESM;
Node 24.19.0 đáp ứng runtime và Vitest 5. TypeScript chọn 6.0.3 theo baseline Nest 12,
không tự nhảy lên TypeScript 7. SWC chỉ transform test; tsc chịu trách nhiệm build/typecheck.
Nguồn: [Nest 12 migration](https://docs.nestjs.com/migration-guide),
[Vitest requirements](https://vitest.dev/guide/), [Nest Vitest/SWC](https://docs.nestjs.com/recipes/swc);
version/engines/peerDependencies được đối chiếu npm registry ngày 2026-10-01.

### Cách dự kiến xử lý persistence và test

Node.js + TypeScript + NestJS + npm workspaces và Vitest/Supertest đã được chủ dự án chọn cho scaffold.
Prisma chỉ nằm ở infrastructure, mỗi service có client/schema/migration riêng. Dự kiến:

- Transaction: ghi business change + receipt/job/outbox bằng cùng transaction client, không mở transaction con riêng
  hoặc giữ transaction trong lúc gọi gRPC/provider. Chọn isolation/timeout cùng phiên bản ORM; xử lý serialization/deadlock
  bằng retry có giới hạn và cùng định danh. API transaction giữa Prisma major hiện khác nhau, không sao chép lệnh v7 sang v8.
- CAS: UPDATE theo ID + expectedVersion + state và tăng version, kiểm tra đúng một affected row;
  v7 có conditional updateMany; adapter phiên bản khác dùng query tương đương, không check-then-write.
- Khóa hàng: SELECT ... FOR UPDATE tham số hóa trong cùng transaction/connection qua raw query adapter;
  thứ tự khóa nhất quán, timeout hữu hạn. Không dùng query raw unsafe hay RPC khi đang giữ khóa.
- Partial unique index: ưu tiên SQL migration đã review cho “một quyền HELD/BOUND trên Driver/Vehicle” hoặc guard chưa RELEASED.
  Tài liệu Prisma v7 có `partialIndexes` ở Preview; không bật Preview mặc định hoặc suy hỗ trợ giống nhau ở mọi major.
  Kiểm tra index/predicate thực trong PostgreSQL và migration drift sau khi chọn version.
- Decimal: NUMERIC trong PostgreSQL, domain value object tính decimal/string; v7 có Prisma.Decimal ở adapter.
  Không chuyển sang Number cho tính tiền; xác minh precision/scale/roundtrip của phiên bản sẽ chọn.
- Migration SQL: per-service, lưu và review SQL (hoặc SQL artifact của tool major được chọn), không schema sync tự động.
  Migration role riêng; test apply trên DB rỗng và nâng cấp dữ liệu có sẵn, không reset/drop để vượt lỗi.

Vitest/Supertest đã được chọn: transform test phải tương thích legacy decorators và metadata DI của NestJS;
không suy rằng TypeScript config tự làm esbuild emit constructor metadata. Cân nhắc SWC theo hướng dẫn Nest,
`reflect-metadata`, token/@Inject tường minh cho port/interface, alias và ESM/CJS tương thích; typecheck riêng vì SWC không typecheck.
Test boot TestingModule có dependency thật để phát hiện metadata/DI sai, Supertest dùng app HTTP thật;
gRPC/mTLS/DB integration cần transport/DB thật. Nhiệm vụ facade trước chưa cài backend;
nhiệm vụ scaffold ban đầu không ORM/DB; phiên probe hiện tại được phép cài Prisma local và chạy
schema/migration thử nghiệm, không tạo schema nghiệp vụ hay dùng probe trong domain.

Nguồn chính thức được đọc ngày 2026-10-01: [Prisma v7 transaction/OCC](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions),
[raw queries](https://www.prisma.io/docs/orm/v7/prisma-client/using-raw-sql/raw-queries),
[Decimal](https://www.prisma.io/docs/orm/v7/prisma-client/special-fields-and-types),
[partial index Preview](https://docs.prisma.io/docs/orm/v7/prisma-schema/data-model/indexes),
[migration SQL](https://www.prisma.io/docs/orm/migrations/editing-a-migration),
[NestJS Vitest/SWC](https://docs.nestjs.com/recipes/swc).
Các primitive CAS/khóa/index đã qua probe PostgreSQL thật; áp dụng vào invariant CAB và schema nghiệp vụ
vẫn cần nhiệm vụ riêng sau quyết định ORM. Xem [prisma-postgres-probe.md](prisma-postgres-probe.md):
precision Decimal riêng 40, SQL partial index, quyền DML/runtime tách migration và giới hạn đã kiểm chứng.

## Các giai đoạn nhỏ

Mỗi hàng là một nhóm mục tiêu; tách tiếp thành nhiệm vụ nhỏ khi giao, không triển khai toàn bộ một hàng lớn trong một lần.

| Giai đoạn | Phạm vi | Phụ thuộc | Đầu ra | Tiêu chí hoàn thành |
|---|---|---|---|---|
| 0. Nền tảng và hợp đồng luồng đầu | Facade năm endpoint đã đặc tả theo baseline API01; stack scaffold đã chọn, Prisma có điều kiện cho Identity/Customer và còn gap path validation | API01, contracts SECURITY/RPC, status hiện tại | Package/policy facade riêng, mapping REST↔gRPC/error, DTO/presence và kiểm tra static | Compile/validator đạt, giữ 34 RPC nội bộ; chưa coi static là runtime integration hoặc mọi quyết định production đã chốt |
| 1. Nền tảng tối thiểu | Chỉ Gateway, Identity, Customer; lớp DDD, cấu hình placeholder, gRPC mTLS, probe, PostgreSQL với hai DB/role, Redis và RabbitMQ theo nhu cầu luồng | Giai đoạn 0, CLI Docker dùng được trong terminal, version pin | Scaffold ba ứng dụng, Compose giới hạn profile, migration riêng, scripts thực tế và kiểm tra IPC | Build chạy; RPC thật đúng caller/cert; runtime role không đọc/ghi chéo DB; chỉ Gateway publish cổng ứng dụng; không trả health UP giả |
| 2. Đăng ký Customer | POST /v1/auth/register và GET /v1/auth/customer-registrations/{operationId}; Account/RegistrationOperation, Provision/Get/CancelCustomerProvision | Nền tảng; API01 được duyệt; crypto/normalization và retention đã chốt | Account/Customer liên kết, operation/job bền vững, dedupe/recovery, compensation có tombstone, outbox ACCOUNT_PROVISIONED khi SUCCEEDED | 201 chỉ khi đủ hai bên; 202 chỉ operation đã persist; sai token không lộ trạng thái; concurrent/retry/crash không tạo trùng; chưa hoàn tất không login; phục hồi sau Customer outage |
| 3. Login và đọc hồ sơ | POST /v1/auth/login, GET /v1/accounts/me, GET /v1/customers/{customerId} | Đăng ký hoàn tất; facade Identity/Customer và verify/contact nội bộ | Session/token, kiểm tra quyền mỗi request, DTO tổng hợp qua Identity; kịch bản Postman không lưu secret | Đăng ký→login→profile chạy từ Gateway với hai DB thật; own profile 200, sai role 403, khác Customer 404, JWT sai 401, dependency lỗi 503; log/DB không lộ secret/PII rõ |
| 4. Vòng đời phiên | Refresh/logout/change-password/update Account; rate limit và bảo vệ dữ liệu mở rộng | Luồng đầu; chính sách Session/in-flight, giá trị MVP được duyệt | Rotation/revocation và cập nhật liên hệ tại Identity; kiểm thử SQL injection, JWT và quyền | Token cũ không tiếp tục cấp quyền; refresh đồng thời theo hợp đồng; cập nhật contact atomic; fail closed khi limiter lỗi; không thêm quên mật khẩu |
| 5. Driver onboarding | OTP→submit→review→online; thêm Driver, sau đó Notification phục vụ review/inbox | D01 provider; API07/facade; Identity provisioning, outbox/inbox/AMQPS và ACL | Driver/Application/VehicleAssignment, IN_APP qua broker; nearby 1 km có paging | Chưa duyệt không AVAILABLE; duyệt giữ OFFLINE; review/version/retry an toàn; message lặp không lặp notification; SMS mock được ghi riêng |
| 6. Booking tối thiểu | Thêm Payment phần Pricing trước; tạo/list/cancel Booking, Customer guard, dispatch/offer | Snapshot giá, D10 thông số; API02/03 và facade | Booking/operation, pricing capture bất biến, guard và offer bền vững | Hai key cùng Customer chỉ một quyền; list đúng chủ; broker/worker restart không mất công việc; cancellation fence cả acquire trễ |
| 7. Accept và Trip | Thêm Trip; reserve Driver/Vehicle, prepare/bind/activate/finalize; sau đó trạng thái, cancel/incident/closure và GPS | Giai đoạn 6; contracts Saga/fencing; facade API04/07 | Chuyến hợp lệ, closure worker, journey đúng khoảng lịch sử | Chỉ một assignment cho Driver/Vehicle; accept/cancel race có quyết định; activation mất phản hồi phục hồi phía trước; lệnh cũ không chạm chuyến mới; release tiếp tục sau restart |
| 8. Metrics và thanh toán | Xác nhận metrics→Fare→CASH; nhiệm vụ riêng tích hợp online sandbox/webhook/reconcile | D03 metrics trước Fare; D02 provider trước online; API05/facade | Fare decimal bất biến, Attempt/evidence, callback đã xác minh | UNKNOWN không mở charge mới; replay/callback trùng không thu thêm; đúng Driver lịch sử confirm CASH; có bằng chứng provider sandbox thật |
| 9. Rating và nghiệm thu | Thêm Rating; hoàn thiện notification/health, backup/restore, demo XSS và tải/rubric | Trip COMPLETED; contracts Identity/Trip; D08/D10 và các luồng liên quan | Rating, workbook v1.3 có actual evidence, Compose đủ tám MS và hạ tầng, kịch bản chấm | Rating không phụ thuộc Payment SUCCESS; đủ quyền/idempotency; ACL/DB isolation/chaos/replay/restore có kết quả thật; không nhận test static là runtime PASS |

Health nền tảng phản ánh đúng thành phần của profile đã chạy; chưa nghiệm thu health đủ tám MS khi mới có ba ứng dụng.
Tới baseline đầy đủ: Gateway + tám MS + PostgreSQL + Redis + RabbitMQ = 12 container nếu mỗi thành phần một container;
worker tách riêng tăng container, không tăng số service nghiệp vụ. Liveness không phụ thuộc toàn bộ hệ thống.

## Hợp đồng Gateway hiện tại và phạm vi còn thiếu

- Bộ bảy `.proto`/34 RPC nội bộ giữ nguyên. Facade năm endpoint có package `cab.gateway.v1` riêng,
  mô tả tại [GATEWAY-CUSTOMER.md](../../contracts/GATEWAY-CUSTOMER.md) và policy/mapping riêng.
- API YAML có 75 operation trong `paths`, trong đó báo cáo summary ngoài MVP: 74 operation MVP theo README contracts.
  Không lấy operation trong `x-internal-*` làm route public; health/provider cũng cần xử lý theo trách nhiệm riêng.
- Luồng đầu đã đặc tả register, registration lookup, login, account me, customer lookup;
  field/type/presence, caller Gateway qua mTLS, user/recovery context, deadline và lỗi theo từng endpoint.
  Các endpoint khác/health/provider còn thiếu facade; không mở rộng trong nhiệm vụ này.
- Downstream gọi Identity verify cho request được bảo vệ; Identity không cần gọi lại chính mình để verify user.
  Customer gọi VerifyUserIdentity/GetAccountContact theo policy hiện có, không join cab_identity.
- Thiết kế provider webhook giữ raw bytes/header xác minh; không dùng JSON tái serialize thay chữ ký gốc.
- Không mở `/internal/*`, không dùng Gateway để gọi Provision/compensation thay Identity coordinator.

## Quyết định cần chủ dự án chốt

1. Prisma 7/workflow migration được chọn có điều kiện cho Identity/Customer theo 14/14 probe,
   6/6 lifecycle và migration upgrade thật; chưa duyệt cho mọi service. NestJS + TypeScript,
   npm workspaces và Vitest/Supertest đã chọn cho scaffold.
2. API01 hiện được phép dùng làm baseline facade: 201/202/recovery và public replay 7 ngày tách evidence nội bộ suốt MVP.
   Còn chốt HTTP/errorCode khi path operationId lookup sai validation và D08 cleanup sau MVP; không tự thêm REST response.
3. D01 OTP và D02 payment provider/sandbox: adapter, chữ ký, timeout/retry, idempotency, acknowledgement, evidence.
4. D03 JourneyMetrics: thuật toán, chất lượng/mất mẫu, thời gian ERROR và review; không dùng đường thẳng hoặc 0 cho dữ liệu thiếu.
5. D10 và SRS §4.5/B10: thông số Dispatch/OTP/Session/rate limit, mục tiêu đo kiểm và giao diện XSS; không tự duyệt con số đề xuất.
6. D08 còn mở: PII/GPS/provider retention, backup/restore và xoay khóa; giữ baseline nội bộ contracts trong lúc chờ.

Mock chỉ phục vụ unit/contract test có nhãn và cấu hình riêng; không dùng mặc định deployment, không chứng minh DB/broker/provider thật.
Postman collection tương lai chỉ dùng biến tạm/placeholder; test được báo cáo theo FR/AC, lệnh, dữ liệu, actual result và bằng chứng.

## Scaffold hoàn tất và nhiệm vụ nhỏ tiếp theo

Đã có đúng ba app trong services/, mỗi app có main/module/config và bốn lớp DDD.
Domain/application chỉ có tài liệu ranh giới khi chưa có use case; không tạo port, repository hay entity giả.
Gateway có HTTP adapter và provider mTLS client, chưa có controller nghiệp vụ.
Identity/Customer có context smoke riêng và bootstrapNetwork mở mTLS gRPC bằng TLS config bắt buộc.
Proto-loader đọc protobuf gốc; chưa generated DTO hoặc triển khai business handlers.

Lệnh thực tế từ Git root: npm.cmd install --cache .cache/npm --no-audit --no-fund;
npm.cmd run build; npm.cmd run typecheck; npm.cmd test; npm.cmd run test:built.
Phiên scaffold: build/typecheck đạt; Vitest 4/4 test đạt với metadata constructor và singleton config qua container,
Supertest kiểm tra năm route chưa có handler trả 404; output tsc cũng boot/close ba context.
Test không mock dependency. SWC gặp ERR_SWC_NATIVE_CACHE do sandbox ACL; cùng npm.cmd test
đạt khi chạy ngoài sandbox, không đổi version/assertion/runner hoặc ACL.

Phần scaffold và mTLS/caller-policy network của giai đoạn 1 đã kiểm chứng trên loopback.
Thêm thư viện infrastructure grpc-transport (không thêm ứng dụng), pin grpc-js 1.14.5/proto-loader 0.8.1,
policy full method đúng namespace/owner; Gateway không có quyền provisioning/compensation nội bộ.
Phiên transport: build/typecheck đạt, 28/28 Vitest (24 network + 4 smoke) và ba built context đạt.
Production providers/bootstrap được dùng với certificate test; handler counter/UNIMPLEMENTED chỉ trong harness.
CA/EKU/URI/time sai, metadata giả, method/caller/owner/package không được phép bị deny trước handler.
Xem [grpc-transport.md](grpc-transport.md) cho expected/actual và cách chạy.
Chưa kiểm chứng deployment, issuer rotation/revocation, user auth/HTTP mapping, DB nghiệp vụ/broker.
Probe/DB/migration kỹ thuật đã kiểm chứng ở phiên riêng bên dưới.
Nhiệm vụ nhỏ tiếp theo: tạo schema/client nghiệp vụ Identity/Customer và review SQL/role; sau đó giao
handler/user-auth và registration/recovery, login/profile theo contracts;
chốt HTTP/errorCode của operationId sai validation trước handler lookup.

Review độc lập 2026-10-02 phát hiện factory thiếu giới hạn unary. Đã sửa send/receive 1 MiB
ở cả client/server; 7 regression cô lập bốn giới hạn bằng peer test-only 4 MiB và đo protobuf byte.
Build/typecheck, full 35/35 tests (giữ nguyên 28 cũ), ba built context đạt.
Metadata tổng 8 KiB còn chưa cấu hình/kiểm chứng; cần giao hardening metadata riêng,
cùng correlation/user context/error detail trước handler, không coi transport đã bảo vệ đầy đủ.
Chi tiết expected/actual ở [grpc-transport.md](grpc-transport.md).

## Persistence probe đã kiểm chứng; bước tiếp theo

Prisma 7.10.0 + PostgreSQL 17.11 thật: 14/14 (7 mỗi DB) đạt cho migration rỗng/replay,
transaction + outbox commit/rollback, CAS đồng thời, khóa hàng có bằng chứng catalog,
partial unique SQL index đồng thời, decimal exact và runtime DDL/cross-DB deny.
Build/typecheck, 35/35 test scaffold/transport và ba built context cũng đạt sau cài dependency probe.
Chi tiết nguồn/version/lệnh/expected/actual: [prisma-postgres-probe.md](prisma-postgres-probe.md).

Đề xuất giữ pattern per-service infrastructure/client/schema/migration, SQL review và runtime role tối thiểu.
Probe SQL/models/factory chưa gắn production DI; Compose tmpfs, runner, credentials/observer và test chỉ phục vụ
thử nghiệm. Không biến model probe thành Account/Customer hoặc chia sẻ model giữa service.
Decimal phải có precision/scale rõ: clone precision 40 trong probe sửa lỗi arithmetic mặc định precision 20;
không Number cho tiền và không coi precision probe là chính sách tiền nghiệp vụ đã duyệt.

1. Prisma/workflow SQL migration đã được chọn **có điều kiện** cho Identity/Customer, xem
   [identity-customer-persistence.md](identity-customer-persistence.md); chưa áp toàn bộ service.
2. Lifecycle provider infrastructure đã kiểm chứng trên client probe/DB thật; tiếp theo tạo schema/client
   nghiệp vụ riêng, review SQL/index/grant, rồi wire provider vào AppModule production với runtime role.
   Upgrade dữ liệu nghiệp vụ/custom SQL drift, forward fix/restore vẫn cần nhiệm vụ riêng.
3. Hardening metadata tổng 8 KiB và kiểm tra context/error riêng; JWT/Session/object authorization,
   HTTP mapping và rotation/revocation/deployment chưa được chứng minh bởi probe hoặc mTLS suite.
4. Sau nền tảng và các quyết định còn mở, mới giao handler nghiệp vụ theo contracts;
   chốt malformed operationId HTTP/errorCode trước lookup handler.

## Schema Identity/Customer và quyết định MVP local

[Thiết kế schema](identity-customer-schema-design.md) đã được cập nhật sau khi chủ dự án duyệt
UUID, contact reuse sau FAILED, Session 7 ngày, key ổn định và protocol coordinator. SQL/Prisma
V1 và AppModule production đã tạo; bằng chứng mới và bước tiếp theo ở mục ngay dưới. D08 retention
PII, metadata gRPC 8 KiB và HTTP/errorCode operationId sai validation vẫn thuộc backlog riêng.

## Production persistence V1 — trạng thái và bước kế tiếp

Các quyết định MVP local của chủ dự án đã được áp dụng vào
[schema design](identity-customer-schema-design.md): UUID ID server, contact reuse sau FAILED,
Session absolute 168 giờ, key tách mục đích/ổn định và coordinator protocol hiện có. SQL/Prisma
V1 riêng hai service và AppModule production đã được tạo; không trộn probe. Hướng dẫn lệnh/role,
scope smoke so với integration ở [identity-customer-persistence.md](identity-customer-persistence.md).

1. **V1 thử nghiệm đã đạt:** `npm.cmd run db:verify` trên Docker CLI ngoài sandbox áp V1 cho hai DB
   rỗng, 10/10 ca PostgreSQL thật PASS, deploy replay giữ ledger/data, project UUID cleanup PASS.
   Build/typecheck/full 35/35 và DB-free smoke cũng đạt. Review SQL + Prisma drift, backup/restore
   và rollout role trước production; upgrade từ schema nghiệp vụ cũ chưa tồn tại/chưa kiểm chứng.
2. Tiếp theo: tạo crypto adapter có
   key version theo mục đích, không sinh khóa tại boot. Rồi triển khai coordinator registration
   với CAS, mTLS RPC, tombstone/network restart test; chỉ sau đó làm REST handler/JWT/Session flow.
3. D08 retention PII production, metadata gRPC 8 KiB và HTTP/errorCode operationId sai validation
   tiếp tục ở backlog. Chưa có register/login Postman thành công; không tự báo đạt chức năng người dùng.

## Forward V2 sau review persistence V1

- Giữ V1 production bất biến; Identity/Customer thêm V2 SQL sửa CHECK `NULL`, giới hạn runtime DML theo ma trận và bảo vệ Session/claim/receipt/tombstone. Runner `db:verify` triển khai V1+V2 fresh, V1 có dữ liệu→V2, replay và V1 vi phạm→deploy fail/ledger failed; không dùng reset. PostgreSQL thật 14/14 integration PASS. Xem [hướng dẫn và ma trận quyền](identity-customer-persistence.md).
- Adapter Identity compensation được thử rollback bằng chính helper sau nhiều write, ngoài các SQL test trực tiếp. Login cần lookup claim hiện tại trước xác minh password, sau đó mới xét eligibility/Session/Account. Customer Provision/Cancel/receipt vẫn chưa có business adapter.
- Bước tiếp: review V2 và rollout/restore runbook, rồi crypto adapter theo key version, coordinator với network/restart/CAS, Customer business adapter, tiếp đến REST/JWT/Session. Metadata gRPC 8 KiB, D08 và HTTP error operationId sai validation vẫn riêng. Review độc lập mới đọc source, chưa chạy lại.
## 2026-10-03 — next demo gate

The five Gateway routes, Identity/Customer handlers, dev environment and Postman
placeholder artifacts are implemented. The immediate gate is the additive
`GetAccountContact` response decision for account status and creation/update
timestamps: apply only if approved, then validate proto/contract, rebuild, restart
the three dev apps, and rerun five-route HTTP smoke plus authorization/error tests.
Preserve the existing separate facade/internal policies and 34 internal method
coverage. Do not use current Account state to reconstruct registration replay;
the encrypted result snapshot remains authoritative.

Before handoff, rerun build/typecheck/full Vitest/built-context, contract validator
if protobuf changes, `db:verify` if migration/tests change, and real HTTP/mTLS
scripts. Keep actual PASS/BLOCKED distinct from source review. Stop only this
project's apps/container; retain dev volume/secret for repeatable demo. Then review
the existing coordinator compensation failure branch under a forced confirmed
Cancel and finish production concerns (D08, outbox publisher, key rotation,
multi-instance rate limit) in separate scopes.

## 2026-10-03 — demo gate đã đạt

`AccountContact` đã bổ sung status và hai timestamp Account theo quyết định chủ
dự án; không thay RPC/policy. Validator, build/typecheck, 49/49 test và HTTP smoke
đủ năm endpoint trên PostgreSQL thật/mTLS đều PASS. Bước dùng thử tiếp theo:
khởi động project dev cũ bằng `dev/README.md`, import hai file Postman, gửi
Register → Lookup nếu 202 → Login → Me → Customer. Chưa ghi Postman GUI PASS;
owner có thể xác minh trực tiếp bằng collection. Mốc production tiếp theo vẫn là
D08 PII retention, outbox publisher, key rotation, rate limit phân tán và
backup/rollout; không suy demo dev đã xử lý các phần đó.

## Driver demo slice — 2026-10-03

Chủ dự án chọn seed DRIVER và GPS tối thiểu qua API04 để đáp ứng freshness ≤30
giây của API07. Đã tạo `driver-service` với PostgreSQL riêng (trên cùng dev
server), hai migration Driver, runtime/migration role tách biệt, seed opt-in
Identity Account + Driver profile/vehicle, ba facade RPC/method policy, ba route
Gateway và Postman collection. Không thay 34 RPC nội bộ hoặc Customer REST.
Kiểm tra static/build/49 Vitest/4 Nest contexts cùng network HTTP→mTLS→PostgreSQL
và restart state đã đạt; chi tiết và giới hạn ở `status.md`/`dev/README.md`.

Tiếp theo cho demo CAB: review Postman GUI Driver/Customer trên dữ liệu dev, rồi
thiết kế Booking/Trip boundary trước khi dùng AVAILABLE cho dispatch. Khi thêm
Trip, phải xác minh không có chuyến đang hoạt động bằng giao thức/nguồn sở hữu
thực, không suy từ trạng thái Driver cục bộ. Theo quyết định chủ dự án cho các
slice sau: fare giả lập cố định từ giá đã lưu, chuyển khoản thành công mới đi,
tiền mặt do tài xế xác nhận, idempotent payment; Notification dùng MongoDB/in-app.
Các slice đó chưa triển khai. Production vẫn cần D08, outbox publisher, rotation,
rate limit phân tán và rollout/backup.

## Mốc Driver OTP và review cho demo tối thiểu — 2026-10-03

Mục 21–23 đã được mở rộng trên ba app sẵn có: Identity giữ OTP/Account/Session/operation và điều phối; Driver giữ application/profile/vehicle/review receipt; Gateway chỉ gọi facade qua mTLS. Migration Identity/Driver mới đã apply, không sửa lịch sử cũ. Bằng chứng network và giới hạn ở [status](status.md), lệnh chạy/Postman ở [dev README](../../dev/README.md). [Bảng 30 mục](grading-tracker.md) dùng để theo dõi phiếu chấm; các mục ngoài slice chưa được triển khai.

Bước gần nhất: người dùng chạy Postman GUI theo hai collection với dữ liệu dev riêng, đối chiếu 201/202/200/403/409/429 và xác nhận trải nghiệm demo. Sau đó hoàn thiện nhánh review với vehicleId có sẵn và kiểm chứng compensation partial provision; tách nhiệm vụ Notification/RabbitMQ, distributed rate limiter và production key/retention. Booking/Trip/Payment/Rating chưa bắt đầu. Theo quyết định chủ dự án, slice sau dùng giá cước giả lập cố định, payment giả lập có callback, chuyển khoản thành công trước Trip, CASH do Driver xác nhận, replay không thu trùng, hủy cơ bản nhưng chưa refund, Notification dùng MongoDB và RabbitMQ triển khai riêng. Các quyết định này chưa là implementation PASS.
