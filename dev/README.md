# Customer demo trên máy

## Rà 30 mục và Health/Trip ERROR (2026-10-12)

Vận hành thường ngày từ Git root: `docker compose up -d`; source đổi thì
`docker compose up -d --build`. V4 Trip migration được chạy bằng job riêng
`docker compose run --rm --no-deps migrate-trip` trong lần nâng cấp hiện tại;
không chạy lại để sửa dữ liệu hoặc dùng `down -v`. Kiểm tra bằng `docker compose
ps`, `node dev/health-http.mjs` và các request Postman nhập tay ở
`dev/GRADING-CHECKS.md`. Script `node dev/booking-http-e2e.mjs
resolve-incident` là opt-in, tạo riêng Customer/Booking/Trip tổng hợp và đóng
chuyến đó; không chạy trên Trip/hồ sơ của người dùng. JourneyMetrics còn
PENDING cho rà soát thủ công, không tự xác nhận hoặc thay giá đã chốt.

## Rating MVP trong Compose (2026-10-12)

Nâng cấp bộ Compose đã có **một lần** từ Git root: `node dev/compose/setup-rating.mjs`
để tạo riêng `cab_rating`, role migration/runtime và cursor key local được ignore;
tiếp theo `node dev/compose/prepare.mjs` và `docker compose up -d --build`.
Các lần sau chỉ cần `docker compose up -d`. Không chạy Node dev song song,
không dùng `down -v`; Rating không publish cổng host. Kiểm tra bằng
`docker compose ps` và `docker compose logs --tail=100 rating-service`.

Import `dev/postman/CAB-Rating-Manual.postman_collection.json`. Collection
dùng URL trực tiếp `http://127.0.0.1:33201`, không có environment/script.
Customer đăng nhập lấy `accessToken`, hoàn tất Trip thật theo collection
Booking/Trip rồi lấy `tripId` từ `GET /v1/trips?limit=20` hoặc kết quả Driver
chấp nhận offer. POST `/v1/trips/{tripId}/rating` với `score` nguyên 1–5 và
`comment` tùy chọn tối đa 1000 ký tự trước trim; cùng nội dung trả lại 201/cùng
ratingId, nội dung khác trả 409. GET cùng route cho Customer chủ Trip, Driver
lịch sử hoặc Operator; Driver xem `/v1/drivers/me/ratings`, Operator xem
`/v1/operations/ratings`. Trip COMPLETED được đánh giá dù Payment chưa SUCCESS.
Không có chỉnh/xóa, điểm trung bình, xếp hạng, sự kiện Rating hoặc thông báo
Rating trong MVP. Postman GUI chưa được agent chạy.

Fixture HTTP opt-in riêng: `node dev/booking-http-e2e.mjs rating` tạo Customer
và Trip synthetic mới, để CASH PENDING khi gửi Rating rồi kiểm tra quyền/replay;
`node dev/booking-http-e2e.mjs rating-read` đọc lại sau restart. Credential
fixture nằm ở `.secrets/customer-dev/` đã ignore, không dùng TaiXeDemo1.
`node test/rating-postgres.mjs` chạy PostgreSQL disposable riêng; cần Docker
CLI trong PATH. Test này không thay cho HTTP end-to-end.

## Booking → Trip → Payment trong Compose (2026-10-12)

Từ Git root, với database/secret đã thiết lập, chạy `docker compose up -d`.
Nếu đây là lần đầu nâng cấp bộ cũ chưa có Booking, chạy một lần
`node dev/compose/setup-booking.mjs`, tiếp theo `node dev/compose/prepare.mjs`
và `docker compose up -d --build`. Không chạy bộ Node dev song song, không dùng
`down -v`. `docker compose ps` phải báo chín app cùng PostgreSQL/RabbitMQ/MongoDB
healthy; xem `docker compose logs --tail=100 <service>` khi cần.

Import `dev/postman/CAB-Booking-Trip-Payment-Manual.postman_collection.json`.
Mọi URL dùng trực tiếp `http://127.0.0.1:33201`, không cần environment hay
script. Tạo Customer và Driver MOTORBIKE riêng bằng collection đăng ký/OTP;
Operator duyệt Driver, Driver bật AVAILABLE (ONLINE) trong Compose demo mà không
cần gửi GPS riêng: Driver service đặt vị trí mẫu ở điểm đón nếu GPS thiếu/cũ.
Vị trí mẫu chỉ mới trong 30 giây và chỉ dùng cho demo; muốn Dispatch chọn Driver
sau đó thì làm mới vị trí hoặc bật lại theo version mới. Riêng
`driver@example.test` trong fixture Postman được sidecar demo đưa về AVAILABLE
sau khi Trip trước đã giải phóng và giữ ở đúng điểm đón mẫu; khi BUSY, Dispatch
vẫn chọn Driver khác. Đăng nhập
hai bên, chép Bearer token bằng tay. Tạo Booking đúng tuyến demo pickup
`10.7769,106.7009` → destination `10.7869,106.7109`; Booking 201 đã có
PricingSnapshot 1.250 m = 6.625 VND. Nếu 202, tra operation cho đến SUCCEEDED.
Driver mở offer, chấp nhận, tra assignment nếu 202 rồi lấy Trip ID và version.

Driver chuyển ARRIVED_PICKUP → PICKED_UP → IN_PROGRESS → COMPLETED mà chưa cần
Payment. Giá đã chốt trong PricingSnapshot từ lúc Booking; sau COMPLETED,
Customer tạo Payment trên Trip thật với `Idempotency-Key` riêng và
`{"paymentMethod":"CASH"}` hoặc `{"paymentMethod":"DEMO_TRANSFER"}`. Sau khi
tạo Payment mới GET Fare/Payment; GET Fare trước đó có thể trả 409 FARE_NOT_READY.
Cờ demo-result có trên **Gateway và
Payment** khi `NODE_ENV=development` và `CAB_DEMO_PAYMENT_RESULT_ENABLED=1`;
production hoặc tắt cờ sẽ từ chối. Dùng `paymentId`, `currentAttemptId`,
`version`, `amount` từ response để gửi SUCCESS/FAILED đúng số tiền; FAILED
cần retry với version/key mới. Trong Compose demo, Driver gửi GPS mới bằng
`PUT /v1/drivers/me/location` chỉ với `latitude` và `longitude`; Gateway gắn
thời điểm nhận khi `NODE_ENV=development` và `CAB_DEMO_GPS_SERVER_TIME_ENABLED=1`.
Production vẫn bắt buộc `recordedAt` do thiết bị gửi. Customer GET tracking;
sau COMPLETED, đúng Driver xác nhận CASH với key riêng. Payment và
Trip có trạng thái riêng. Hủy sau SUCCESS giữ Payment SUCCESS và đặt
`requiresReview=true`, không hoàn tiền tự động. Không gửi client
Idempotency-Key ở API ngoài Payment. Postman GUI chưa được chạy bởi agent.

Fixture opt-in riêng, không chạm TaiXeDemo1: `node dev/booking-http-e2e.mjs
prepare` tạo 5 Customer/5 Driver và lưu credential dưới `.secrets/customer-dev/`
đã ignore. Các pha `cash`, `transfer`, `failed-retry`, `unpaid-cancel`, `pages`,
`nearby`, `audit`, `incident`, `race` dùng HTTP thật và có thể tạo Booking/Trip/Payment mới; chỉ
chạy khi chủ động cần dữ liệu thử. Pha `paid-cancel` chỉ kiểm tra Payment đã
tạo từ luồng cũ trước khi Trip hủy; không tạo Payment mới trước Trip COMPLETED
theo quy tắc hiện tại. Riêng câu 13 Postman dùng năm Driver demo được container
`nearby-demo-gps` làm mới GPS tự động; xem `dev/GRADING-CHECKS.md`.
Các fixture Booking khác vẫn cần làm mới GPS bằng `prepare`/`nearby` trước
kiểm thử dispatch; vị trí cũ không đủ điều kiện. `node test/booking-postgres.mjs`
và `node test/trip-postgres.mjs` dùng PostgreSQL container thử nghiệm tách biệt,
không phải bằng chứng Postman GUI hay toàn bộ E2E.
Pha `incident` tạo Driver synthetic thứ sáu và một Trip ERROR chưa đóng; Driver
được gán giữ reservation/BUSY theo contract. Năm Driver synthetic khác vẫn có
thể tìm thấy sau khi làm mới GPS. Muốn khôi phục/đóng ERROR cần Operations API
ở bước sau; không sửa trực tiếp DB để giải phóng fixture.

## Manual Postman registration (Compose, no environment required)

Import `dev/postman/CAB-Customer-Manual-Phone.postman_collection.json` and
`dev/postman/CAB-Driver-Manual-OTP.postman_collection.json` for request order
without environment variables or scripts. Replace the sample phone with an
unused `0` plus nine digits. Customer requests use the same domestic phone in
registration and phone login; Driver OTP verification returns `verifiedPhone`
in that format. Identity uses the equivalent `+84` value internally for HMAC
lookup, so valid historical `+84` contacts remain unique without rewriting DB.
Existing overlength `+84` contacts with ten digits after the country code are
returned unchanged when read. They cannot be converted to ten domestic digits
without guessing or dropping a digit; new requests still require `0` plus
nine digits. Existing accounts can continue to log in by email.

From the Git root, run `docker compose up -d`; the Gateway is at
`http://127.0.0.1:33201`. In a blank Postman tab choose **POST**, enter
`http://127.0.0.1:33201/v1/auth/register`, set Body > raw > JSON and use:

```json
{"fullName":"CAB Demo Customer","email":"new-unique@example.test","phone":"0912345678","password":"<choose-a-test-password>"}
```

Use your own unused email and a 10-digit Vietnamese phone beginning with 0. Postman sends
`Content-Type: application/json`; no Authorization, Idempotency-Key or
Registration-Recovery-Token is needed. A completed registration returns
`201` with Account and customerId. A durable incomplete registration
returns `202 PROCESSING`, `Location`, `Retry-After` and a
`Registration-Recovery-Token` **response header**. Copy the Location
after `http://127.0.0.1:33201` into a GET tab and enter that token in
the request header. Do not put it in the URL or share it. GET 200 with
`SUCCEEDED` contains the saved Account result; wait Retry-After if
`PROCESSING`. Missing proof returns 401; wrong proof returns 404.
If the initial response is lost, a fresh POST can get 409
`CONTACT_CONFLICT` because the prior operation may have committed.
It cannot be treated as a rollback or as proof of the old result.

For Driver, import
`dev/postman/CAB-Driver-Manual-OTP.postman_collection.json` or use blank
Postman tabs. It contains literal loopback URLs, JSON bodies and no environment
or scripts. Use `POST /v1/auth/driver-registration/otp` with
`{"phone":"0912345679"}` after replacing the sample phone with a new one.
The demo response `202` contains `challengeId` and `otp`; copy both from
the response JSON into request 2. Do not share or log the OTP.
POST the challengeId and OTP to
`/v1/auth/driver-registration/otp/verify`, then copy
`verificationToken` into the submit JSON body. POST
`http://127.0.0.1:33201/v1/driver-applications` with raw JSON:

```json
{"verificationToken":"<from-verify>","fullName":"CAB Demo Driver","email":"new-driver@example.test","password":"<choose-a-test-password>","licenseNumber":"NEW-UNIQUE-LICENSE","vehicle":{"plateNumber":"NEW-UNIQUE-PLATE","vehicleType":"MOTORBIKE"}}
```

No Idempotency-Key header is required for submit. If it returns 202, GET
the returned Location with `Driver-Registration-Token:
<verificationToken>` as the only proof header. Reusing the consumed
verificationToken in another POST returns 409
`VERIFICATION_TOKEN_USED`; do not request another Account with it.
After 201/SUCCEEDED, login to read the own pending application.
OPERATOR review requires expectedVersion and expectedDriverVersion; Driver
availability requires expectedVersion. Neither needs a client
Idempotency-Key. Gateway supplies an internal command key to Driver.

The Compose demo sets `NODE_ENV=development` and
`CAB_DEMO_OTP_RESPONSE_ENABLED=1` on Identity and Gateway. This is the only
configuration that includes `otp` in the 202 JSON; disabling the flag on
either app, or running with `NODE_ENV=production`, omits it. The code is
random and tied to the returned challenge, expires after five minutes,
allows five failed attempts, and remains one-use. Existing dev CLI OTP
retrieval remains available when response exposure is disabled. Never copy
an OTP, verification token or password into logs or a shared collection.

The older environment-based examples below are for the legacy Node runner
and optional paired-header replay. Do not start that runner alongside Compose.


**Đường chạy demo hiện tại:** từ Git root dùng `docker compose up -d` cho project `cab`;
đọc [README gốc](../README.md) để xem thiết lập một lần, volume/backup, Postman, OTP,
stop/up và rollback. Các lệnh `dev:start*` bên dưới mô tả runner Node **cũ** để
tham chiếu/rollback; không chạy đồng thời với app trong project `cab` vì sẽ có hai
publisher/consumer và tranh cổng.

## Driver demo opt-in (giữ nguyên Customer)

Driver sử dụng cùng PostgreSQL dev server/volume, database `cab_driver` riêng với
`driver_migration`/`driver_runtime` riêng. `dev:setup` chỉ tạo các secret/certificate
Driver **còn thiếu**, không ghi đè CA/secret/DB hiện có. Sau khi mở Docker Engine,
từ Git root chạy:

```powershell
$env:CAB_DEV_DOCKER = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'
npm.cmd run dev:setup
npm.cmd run db:generate
npm.cmd run build
npm.cmd run dev:up
npm.cmd run dev:migrate
npm.cmd run dev:seed:driver
npm.cmd run dev:start
```

`dev:seed:driver` là opt-in và có thể chạy lại: Driver ghi hồ sơ/xe/assignment
trong một transaction của `cab_driver`, rồi Identity ghi Account DRIVER trong
`cab_identity`. Nếu bước Identity lỗi, chạy lại cùng manifest để hoàn tất; không
đòi transaction xuyên DB. Seed để Driver APPROVED, OFFLINE, Vehicle ACTIVE; đây
là dữ liệu dev, không mở chức năng xét duyệt công khai. Mật khẩu demo và thông
tin synthetic chỉ ở `.secrets/customer-dev/driver_demo_password` và
`driver_seed.json` đã ignore. Sao chép email từ manifest và password từ file
vào **Postman environment local**, không in/commit/export giá trị đã điền.

Nếu bộ app CAB cũ vẫn giữ các cổng mặc định, **giữ nguyên bộ đó** và mở bộ app
mới trên cổng loopback khác trong terminal mới:

```powershell
$env:CAB_DEV_DOCKER = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'
$env:CAB_DEV_IDENTITY_GRPC_PORT = '50161'
$env:CAB_DEV_CUSTOMER_GRPC_PORT = '50162'
$env:CAB_DEV_DRIVER_GRPC_PORT = '50163'
$env:CAB_DEV_GATEWAY_PORT = '33101'
npm.cmd run dev:start
```

Khi dùng bộ cổng này, đặt `baseUrl=http://127.0.0.1:33101` trong environment.
Import `dev/postman/CAB-Driver-Demo.postman_collection.json` và environment
placeholder `dev/postman/CAB-Customer-Demo.postman_environment.json`.
Biến `driverToken`/`driverId` và `accessToken`/`customerId` tách nhau. Gửi:
Driver Login → Account → Driver Profile → một GPS mới → AVAILABLE → đọc lại
Profile → OFFLINE. GPS phải mới trong 30 giây trước AVAILABLE; gửi lại request
GPS nếu thao tác Postman bị chậm. ON/OFF có `expectedVersion` và key riêng;
replay phải giữ nguyên key **và body**. Để bắt đầu chu kỳ ON/OFF mới, đọc lại
Profile rồi dùng version hiện tại trong request availability.

`node dev/driver-smoke.mjs prepare` kiểm tra login/profile/GPS/AVAILABLE/replay;
sau khi restart bốn app (không dừng PostgreSQL), `node dev/driver-smoke.mjs check`
kiểm tra AVAILABLE còn lưu rồi chuyển OFFLINE. `node dev/driver-auth-negative.mjs`
kiểm tra Customer không gọi được route Driver; `node dev/smoke.mjs` kiểm tra lại
năm route Customer. Các script dùng `CAB_DEMO_BASE_URL` nếu cổng Gateway khác
mặc định. Đó là HTTP/network/DB test, không phải Postman GUI.
`node dev/driver-boundary.mjs` kiểm tra GPS cũ bị từ chối trước mutation,
receipt nội bộ không chấp nhận cùng key với payload khác, rồi đưa Driver về OFFLINE.

Điểm GPS hiện chỉ lưu vị trí mới nhất và mẫu/envelope bền vững tại Driver để
kiểm tra freshness; không có worker gửi Trip, bản đồ, dispatch hay tính cước.
Chưa có Booking/Trip/reservation thực trong lát cắt này, nên điều kiện không có
Trip hoạt động chưa được kiểm chứng với hệ thống Trip. Không dùng kết quả demo
để khẳng định availability đã sẵn sàng cho dispatch production.

Môi trường này chạy PostgreSQL 17.11 trong Docker với volume bền vững, còn Gateway,
Identity, Customer và Driver chạy bằng Node.js trên máy. PostgreSQL và Gateway chỉ bind
loopback. `dev:setup` tạo project Compose riêng, secret và certificate mTLS trong
`.secrets/customer-dev/` (đã ignore). Lệnh này không ghi đè file đã tồn tại.
Không đưa thư mục đó, Postman environment đã điền, hoặc token vào Git/chat.

Từ root repo, dùng Node 24.19+ và npm 11.17+, mở Docker Engine rồi chạy:

```powershell
npm.cmd ci
npm.cmd run db:generate
npm.cmd run build
npm.cmd run dev:setup
npm.cmd run dev:up
npm.cmd run dev:migrate
npm.cmd run dev:start
```

Giữ cửa sổ `dev:start` mở. Gateway nghe tại `http://127.0.0.1:33001`.
Import `dev/postman/CAB-Customer-Demo.postman_collection.json` và
`dev/postman/CAB-Customer-Demo.postman_environment.json`, chọn environment.
Điền email/phone chưa đăng ký và password thử nghiệm; tạo UUID mới cho
`idempotencyKey`, token ngẫu nhiên URL-safe 32 byte (base64url, 43 ký tự) cho
`recoveryToken`. Giữ cùng key/token/body khi retry một registration. Đừng export
environment đã chứa password hoặc access token. Gửi lần lượt Register, Lookup
khi Register trả 202, Login, Me, Customer. Collection lưu operationId từ 202,
accountId/customerId từ 201 hoặc Lookup SUCCEEDED, và accessToken từ Login.
202 nghĩa là operation PROCESSING đã commit; dùng `Location`/`Retry-After` để
tra cứu, không diễn giải timeout thành rollback.

Nếu Register trả 201, bỏ qua request Lookup vì response 201 không công bố
operationId. Nếu trả 202, gửi Lookup với cùng recovery token; lặp lại sau
`Retry-After` cho đến `SUCCEEDED` rồi gửi Login. `FAILED` là kết quả cuối,
không tiếp tục Login bằng registration đó. Các giá trị accountId/customerId
được lưu vào environment từ 201 hoặc Lookup SUCCEEDED; Login lưu accessToken.

Để khởi động lại **project dev hiện có**, từ Git root (không chạy lại
`dev:setup`, không xóa volume/secret):

```powershell
# Docker Desktop CLI của máy này; nếu docker.exe đã nằm trong PATH thì bỏ dòng này.
$env:CAB_DEV_DOCKER = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'
npm.cmd run db:generate
npm.cmd run build
npm.cmd run dev:up
npm.cmd run dev:migrate
npm.cmd run dev:start
```

`Ctrl+C` dừng bốn app. `npm.cmd run dev:stop` chỉ dừng container PostgreSQL của
project này; không xóa volume hay secret. Để restart, chạy `dev:up`,
`dev:migrate` (deploy lại không áp migration cũ), rồi `dev:start`. Migration
không chạy tự động khi app boot. Certificate dev có hạn 24 giờ; khi hết hạn
gia hạn bằng lệnh dưới đây, không tắt xác minh mTLS.

Nếu `dev:start` báo workload certificate hết hạn, kiểm tra không in credential:

```powershell
npm.cmd run dev:diagnose
npm.cmd run dev:certs:renew
npm.cmd run dev:diagnose
npm.cmd run build
npm.cmd run dev:start
```

`dev:diagnose` thử `SELECT` bằng **runtime role** của cả ba service và xác minh
CA/chứng chỉ/SAN; migration deploy thành công không thay thế kiểm tra này.
`dev:certs:renew` tạo bộ key/cert workload 24 giờ mới ký bởi CA dev hiện có,
chỉ chuyển manifest chọn bộ mới sau khi xác minh; giữ nguyên CA, key/cert cũ,
database và volume. Chạy lệnh này khi app đã dừng rồi restart cả bốn app.
Không chia sẻ thư mục `.secrets/customer-dev/` hoặc output có OTP/credential.
Runner chỉ in “All selected CAB apps are ready” sau khi mỗi app mở listener;
nếu một app fail hoặc hết thời gian chờ, runner dừng các child của chính lượt
đó và trả exit code khác 0. Nếu CA hết hạn, renewal từ CA cũ sẽ bị từ chối;
không bỏ kiểm tra TLS để tiếp tục.

Kiểm tra tự động trên HTTP/gRPC thật (không phải Postman GUI): khi app đang chạy,
`node dev/smoke.mjs`, `node dev/scenarios.mjs`,
`node dev/customer-scenarios.mjs`, `node dev/profile-negative.mjs`. Hai script
`dev/recovery-prepare.mjs` và `dev/recovery-check.mjs` dùng cùng case/secret
thử nghiệm trong `.secrets/customer-dev/` để kiểm tra mất Customer và restart;
xem source script trước khi chạy quy trình dừng/khởi động các app tương ứng.
`npm.cmd run db:verify` dùng project PostgreSQL **tạm riêng**, không dùng hoặc
cleanup volume dev.

Giới hạn mốc này: rate limit 30/phút/IP/route là bộ nhớ của một Gateway,
không đồng bộ giữa instance và reset khi restart. Outbox được ghi cùng
transaction; Driver publisher RabbitMQ và Notification consumer được mô tả ở mục dưới. Không có refresh/logout,
rotation key, purge PII hoặc triển khai production. D08 retention PII production
và rollout/backup certificate/secret cần thiết kế riêng. Chỉ coi HTTP/gRPC/DB
integration đạt khi script tương ứng thực sự PASS; Nest context smoke riêng
không chứng minh network.

## Demo đăng ký/xét duyệt Driver (mục 21–23)

Từ Git root, với project dev đã tạo trước đó, giữ nguyên volume/secret và chạy:

```powershell
$env:CAB_DEV_DOCKER = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'
npm.cmd run db:generate
npm.cmd run build
npm.cmd run dev:up
npm.cmd run dev:migrate
npm.cmd run dev:seed:operator
npm.cmd run dev:start
```

Nếu cổng mặc định đang do ứng dụng khác dùng, chỉ chọn bốn cổng loopback trống trước `dev:start`, ví dụ:

```powershell
$env:CAB_DEV_IDENTITY_GRPC_PORT='50261'
$env:CAB_DEV_CUSTOMER_GRPC_PORT='50262'
$env:CAB_DEV_DRIVER_GRPC_PORT='50263'
$env:CAB_DEV_GATEWAY_PORT='33201'
npm.cmd run dev:start
```

Chỉnh `baseUrl` trong Postman environment theo cổng Gateway vừa chọn. `dev:seed:operator` là opt-in và chạy lại an toàn. Email OPERATOR nằm trong `.secrets/customer-dev/operator_seed.json`, mật khẩu trong `.secrets/customer-dev/operator_demo_password`; chỉ xem cục bộ, điền vào environment cá nhân, không export/chia sẻ. Seed Driver cũ vẫn dùng `npm.cmd run dev:seed:driver` nếu cần demo cũ.

Import environment mẫu `dev/postman/CAB-Customer-Demo.postman_environment.json`, giữ hai collection Customer/Driver cũ và import thêm `dev/postman/CAB-Driver-Registration.postman_collection.json`, `dev/postman/CAB-Driver-Rejection.postman_collection.json`. Mẫu chỉ chứa placeholder. Tạo phone nội địa Việt Nam 10 chữ số bắt đầu bằng 0, email, license, plate mới cho mỗi applicant; password đủ mạnh; review dùng expectedVersion và expectedDriverVersion, availability dùng expectedVersion; không cần client Idempotency-Key. Điền `operatorEmail`/`operatorPassword` cục bộ. Đừng export environment sau khi nhận OTP, verification token, JWT hoặc điền password.

Collection approval: gửi request 1, lấy `driverChallengeId`, rồi **chỉ trong dev** đọc OTP bằng `npm.cmd run dev:otp -- <driverChallengeId>` từ Git root. Lệnh in OTP trên terminal cục bộ và không tồn tại trong production; không chụp/chia sẻ output. Điền `driverOtp`, gửi 2–3. Nếu 3 trả `202 PROCESSING`, dùng request 4 với cùng key/proof tới `SUCCEEDED` trước khi tiếp tục; nếu trả `201`, bỏ qua 4. Sau đó 5–14 theo thứ tự. Request 11 duyệt nhưng Driver vẫn `OFFLINE`; 13 bật ONLINE (`driverStatus: AVAILABLE`), Compose demo đặt vị trí mẫu nếu GPS thiếu/cũ; 14 tắt `OFFLINE`. Không chạy lại submit với key cũ và payload khác; replay chỉ dùng cùng key/body.

Collection rejection: dùng applicant thứ hai và request 1–3; 4 chỉ khi submit trả 202. `operatorToken` từ request 7 collection approval vẫn hợp lệ, hoặc login Admin lại. Gửi 5–9 để Driver xem lý do từ chối. Sau đó `PUT /v1/drivers/me/availability` với `driverStatus=AVAILABLE`, token của applicant bị từ chối và version hiện tại phải trả `409`; tương tự hồ sơ `SUBMITTED`. Chưa có luồng gửi lại hồ sơ sau từ chối.

Các status kỳ vọng: OTP request 202, verify 200, submit 201 hoặc operation bền vững 202, lookup 200, login/profile/list/detail/review/GPS/availability hợp lệ 200. OTP sai/hết hạn 400, resend quá sớm 429, replay cùng challenge/proof không được tạo hồ sơ thứ hai, role không đúng 403, review cạnh tranh một bên 409. Test tự động tương ứng: `node dev/driver-registration-smoke.mjs prepare|review|prepare-reject|reject|prepare-race|race|roles|check`, `node dev/driver-otp-negative.mjs`, `node dev/driver-auth-negative.mjs`; `node dev/driver-registration-recovery.mjs prepare|check` cần tắt/chạy lại **chỉ Driver app của lượt test**, xem script trước khi chạy. Các lệnh này dùng Gateway, mTLS và PostgreSQL dev thật nhưng không thay thế thao tác Postman GUI.

Giới hạn: OTP chỉ delivery bằng CLI dev, không SMS. Review approval hiện hỗ trợ xe mới ghi trong hồ sơ, chưa nhánh chọn `vehicleId` đã có. Driver registration outage phục hồi tiến lên; compensation đầy đủ sau partial Driver provision cần kiểm chứng riêng. Rate limiter in-memory từng Gateway instance; metadata gRPC 8 KiB và các việc hardening transport/rotation/retention production vẫn nằm backlog.

## Notification từ kết quả duyệt Driver (RabbitMQ + MongoDB)

Các lệnh sau chạy từ Git root, trong PowerShell mới. Chỉ dùng project dev có `project` trong `.secrets/customer-dev/`; script kiểm tra Docker Compose project label trước khi thao tác. `dev:notification:up` chỉ thêm RabbitMQ và MongoDB của project đó, giữ volume sau stop/start; không đụng `cab-bootstrap-test-*`. Không chia sẻ `.secrets/customer-dev/`.

```powershell
$env:CAB_DEV_DOCKER = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'
$env:CAB_DEV_IDENTITY_GRPC_PORT='50261'
$env:CAB_DEV_CUSTOMER_GRPC_PORT='50262'
$env:CAB_DEV_DRIVER_GRPC_PORT='50263'
$env:CAB_DEV_NOTIFICATION_GRPC_PORT='50264'
$env:CAB_DEV_GATEWAY_PORT='33201'
npm.cmd run dev:diagnose
npm.cmd run dev:notification:setup
npm.cmd run dev:notification:up
npm.cmd run dev:migrate
npm.cmd run build
npm.cmd run dev:start:notification
```

Giữ terminal app mở. Runner chỉ báo ready sau khi năm app khởi động; mTLS và runtime DB vẫn bắt buộc. Nếu chứng chỉ workload hết hạn, dừng terminal app của chính bạn, chạy `npm.cmd run dev:certs:renew`, `npm.cmd run dev:notification:setup`, `npm.cmd run dev:diagnose`, build rồi start lại. Broker dùng AMQPS loopback `127.0.0.1:56791`; MongoDB dùng loopback `127.0.0.1:55440`; không có cổng public. `dev:notification:stop` chỉ dừng hai container Notification sau khi app đã dừng bằng Ctrl+C; `dev:stop` dừng PostgreSQL riêng. Không dùng `down -v`; volume `cab_rabbit_data`/`cab_notification_data` và PostgreSQL volume thuộc project Compose vẫn giữ.

Import environment `dev/postman/CAB-Customer-Demo.postman_environment.json` cùng collection hiện có `CAB-Driver-Registration.postman_collection.json`, `CAB-Driver-Rejection.postman_collection.json` và mới `CAB-Notification.postman_collection.json`. Đặt `baseUrl=http://127.0.0.1:33201`. Operator email lấy từ `.secrets/customer-dev/operator_seed.json` trường `email`; password từ `.secrets/customer-dev/operator_demo_password`, chỉ nhập trong Postman local. Tạo hai applicant riêng: phone nội địa Việt Nam 10 chữ số bắt đầu bằng 0/email/license/plate mới; không cần Idempotency-Key cho review hoặc availability. Đọc trạng thái/version hiện tại trước khi thử lại sau timeout; không export environment sau khi chứa password, OTP, token.

Thứ tự thao tác: Driver Registration 1–3, request 4 nếu nhận 202, rồi 5–11 để OPERATOR duyệt; lấy OTP cục bộ bằng `npm.cmd run dev:otp -- <driverChallengeId>` và nhập `driverOtp`. Sau khi duyệt, Notification 1 phải có `DRIVER_APPLICATION_APPROVED` đúng `newDriverApplicationId` (publisher/consumer có thể cần vài giây); Notification 2–3 đánh dấu đọc rồi xác nhận `readAt` không đổi. Dùng Driver Rejection 1–3 cho applicant khác, request 4 khi 202, 5–9 để từ chối; Notification 4 phải có `DRIVER_APPLICATION_REJECTED` và `rejectionReason`. Notification 5 dùng token applicant khác, trả 404; 6–7 kiểm tra cursor, 8 trả 401. Các request OTP/submit/review có body JSON và `Content-Type: application/json`; review dùng `Authorization: Bearer {{operatorToken}}` cùng `expectedVersion` và `expectedDriverVersion` hiện tại. Notification GET/PATCH không có body, dùng `Authorization: Bearer {{newDriverToken}}` hoặc `{{rejectedDriverToken}}`; PATCH không cần idempotency key. Collection dùng biến trong environment; OTP là giả lập CLI dev, không phải SMS.

Kiểm tra tự động khi app chạy: `node dev/driver-registration-smoke.mjs prepare`, `review`, `prepare-reject`, `reject`; sau đó `node dev/notification-smoke.mjs approved`, `rejected`, `node dev/notification-event-smoke.mjs`. `prepare-race`, `race`, `node dev/notification-review-atomicity.mjs` kiểm tra review cạnh tranh chỉ có một outbox event. Đặt `$env:CAB_DEMO_BASE_URL='http://127.0.0.1:33201'` nếu không dùng cổng mặc định. Các script đọc fixture/credential local được ignore và không in giá trị. Validator tĩnh, test unit, smoke HTTP và thao tác Postman GUI là bốn loại bằng chứng khác nhau; chưa có lần chạy Postman GUI độc lập ở mốc này.

Notification hiện chỉ IN_APP cho sự kiện hồ sơ Driver. Driver outbox giữ event khi broker lỗi, publisher confirm và mandatory trước khi đánh dấu published; consumer ACK sau khi lưu inbox bền vững, worker materialize có unique index và quarantine/DLQ cho event hỏng. Fault injection broker/Mongo đã chạy trên project harness riêng, không dừng tài nguyên dev đang dùng chung. Chưa kiểm chứng restore/backup, triển khai production, rate limiter phân tán hoặc metadata gRPC 8 KiB end-to-end.

### Harness fault injection đã chạy

Chạy `npm.cmd run dev:notification:setup` trước nếu chưa có marker project harness; script tạo marker một lần trong thư mục ignored và không ghi đè marker cũ.

Harness dùng `dev/notification-harness.compose.yaml`, project riêng được ghi trong `.secrets/customer-dev/notification_harness_project`, cổng AMQPS 56792 và MongoDB 55441, volume riêng giữ lại sau test. Khi muốn chạy lại, dừng **chỉ nhóm app của bạn** bằng Ctrl+C, không dừng PostgreSQL hoặc RabbitMQ/MongoDB dev; đặt `$env:CAB_DEV_NOTIFICATION_HARNESS_PROJECT=(Get-Content .secrets/customer-dev/notification_harness_project -Raw).Trim()` trong PowerShell, rồi `npm.cmd run dev:notification:up` và `npm.cmd run dev:start:notification` với cùng các biến cổng app. Lệnh up/start có kiểm tra project label. Chỉ dừng container harness sau khi app harness đã dừng bằng `npm.cmd run dev:notification:stop` trong shell vẫn còn biến project harness; lệnh này chỉ stop, không xóa volume. Xóa biến bằng `Remove-Item Env:CAB_DEV_NOTIFICATION_HARNESS_PROJECT` trước khi start lại nhóm demo.

Bằng chứng đã chạy: tạo applicant qua `driver-registration-smoke prepare`, dừng **broker harness** sau kiểm tra label, `review` vẫn 200 và `notification-fault-check.mjs unpublished` xác nhận đúng một review outbox chưa publish. Khôi phục broker harness, `notification-fault-check.mjs delivered` xác nhận publisher confirm và đúng một Notification. Với applicant khác, dừng **Mongo harness** sau kiểm tra label, `reject` vẫn 200, `notification-fault-check.mjs published rejected` xác nhận event đã vào broker. Dừng nhóm app harness, khôi phục Mongo harness và khởi động lại nhóm app; `notification-fault-check.mjs delivered rejected` cùng `notification-smoke.mjs rejected` xác nhận event không mất và không nhân đôi. Các lệnh Docker stop/start trực tiếp trong kiểm thử luôn kiểm tra `com.docker.compose.project` khớp marker trước khi thao tác; không dùng chúng trên project dev hoặc `cab-bootstrap-test-*`. Harness vẫn giữ dữ liệu trong volume để review, hai container đã stop sau lần chạy này.
