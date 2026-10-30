# Trạng thái bàn giao CAB

## 2026-10-30 — Sửa Gateway không lên sau cấu hình Driver demo

Postman GET `/health` báo `ECONNREFUSED 127.0.0.1:33201` vì Gateway ở trạng thái
`created`, chưa có listener. Compose chờ Driver healthy; Driver listener/DB/broker
đạt nhưng hai worker không ghi heartbeat. Nguyên nhân đã xác minh: `environment`
riêng của `driver-service` trong Compose thay thế environment của anchor `x-app`,
làm mất `CAB_HEALTH_DIR`. Đã thêm lại `/cab-health`, chỉ recreate Driver rồi
khởi động Booking/Gateway/nearby helper đang chờ, không build hoặc reset dữ liệu.
Driver probe `listener/database/broker/workers` đều true; Gateway, Booking và
toàn bộ app/hạ tầng hiện healthy. HTTP thật GET `/health` trả 200 `UP`, `/ready`
trả 200 `READY`. Chưa chạy Postman GUI; người dùng có thể bấm Send lại.

## 2026-10-30 — Driver ONLINE/OFFLINE không cần gửi GPS trong Compose demo

Theo lựa chọn của chủ dự án, Postman câu 23 chỉ GET profile/version, PUT
`driverStatus: AVAILABLE` (thao tác gọi là ONLINE), GET version mới rồi PUT
`OFFLINE`. Khi GPS thiếu/cũ, Driver service trong Compose development tự ghi
tọa độ mẫu `10.7769,106.7009` cùng transaction bật AVAILABLE. Production
vẫn cần GPS thật mới trong 30 giây. Dispatch vẫn yêu cầu vị trí mới tối đa
30 giây; vị trí mẫu không tự gia hạn, không phải GPS thiết bị. BUSY vẫn là
trạng thái nội bộ khi Driver đang nhận chuyến; client không được tự đặt BUSY.
Không đổi protobuf, migration, quyền hoặc dữ liệu người dùng.

Build/typecheck/test:built PASS; validator 557 checks/15 proto PASS; image
Linux 79/79 test PASS. HTTP thật qua Gateway với Driver synthetic mới:
đăng ký/duyệt, bật AVAILABLE **không gọi location**, xuất hiện trong nearby
ở điểm mẫu, tắt OFFLINE và GET profile xác nhận: PASS. Driver container
healthy, image `sha256:a2cb068d2013c724fc5112117900e2d494b2e0b32314c7fd39d0e54742659fbd`;
Gateway READY. Chưa chạy Postman GUI, chưa kiểm thử chu kỳ quá 30 giây với
Driver D của người dùng.

## 2026-10-30 — Trip hoàn thành trước Payment

Theo quyết định mới của chủ dự án, Trip từ `PICKED_UP` qua `IN_PROGRESS` rồi
`COMPLETED` không đòi Payment. Payment mới chỉ được tạo sau Trip `COMPLETED`;
`CASH` do Driver được gán xác nhận sau chuyến, `DEMO_TRANSFER` do Customer chủ
chuyến giả lập kết quả sau chuyến. PricingSnapshot vẫn chốt trước Booking và
không đồng nghĩa đã thanh toán. Payment legacy đã tạo trước thay đổi vẫn đọc và
replay theo receipt; không xóa/sửa dữ liệu cũ. RPC `GetTripPaymentDecision` giữ
để tương thích nhưng Trip không còn gọi khi chuyển trạng thái.

Build/typecheck/test:built PASS; Vitest trong image Linux 79/79; validator
557 facade checks, 15 proto, 41 internal + 52 facade policies PASS; test Trip
PostgreSQL tạm và mTLS PASS. HTTP qua Compose với Customer/Driver synthetic
riêng: Payment mới trước hoàn thành trả 409 `TRIP_NOT_PAYABLE`; Trip chuyển
`IN_PROGRESS` và `COMPLETED` khi chưa có Payment; sau đó tạo Fare/Payment
6.625 VND, replay cùng key, confirm CASH hoặc DEMO_TRANSFER SUCCESS và
Notification đúng một lần đều PASS. `trip-service` và `payment-service` chạy
healthy cùng image `sha256:828c371c05ede6961d9925b2dc8c52562d528d3d03ab3bfe7ba568e5f33256e1`;
Gateway `/ready` trả READY. Lần chạy harness CASH đầy đủ dừng vì tracking GPS
`UNAVAILABLE` sau khi đã chuyển `IN_PROGRESS`; resume riêng đã hoàn thành Trip
và Payment CASH PASS. Pha `post-trip-cash` tách riêng cũng PASS từ Booking mới
đến Payment SUCCESS. Chưa xác định nguyên nhân GPS, không coi tracking PASS.
Chưa chạy Postman GUI.

## 2026-10-29 — Body hủy Trip rút gọn cho Customer Postman 18

Theo yêu cầu chủ dự án, Customer có thể gọi `POST /v1/trips/{tripId}/cancel`
với body chỉ `reason`. Gateway đọc Trip có kiểm tra quyền để lấy version,
gán `CHANGE_OF_PLANS`, rồi gọi RPC CancelTrip với expectedVersion; Trip vẫn
khóa dữ liệu, kiểm tra version, quyền và trạng thái như trước. Dạng đầy đủ
expectedVersion/reasonCode/reason tiếp tục dùng được cho DRIVER/OPERATOR và
các lý do khác. Không đổi proto hoặc bảng dữ liệu. OpenAPI, hướng dẫn mục 18
và Postman collection đã cập nhật.

Build Gateway PASS; typecheck toàn repo PASS; validator hợp đồng PASS 557
kiểm tra/15 proto; Gateway HTTP test trong image Linux PASS 4/4, gồm body rút
gọn, dạng cũ và field thừa. Gateway image đang chạy
`sha256:38f639da5f0ff2801f2ef5522a5b6efeddad0d89270d4c5474bf6115c5f28b36`
healthy/READY. HTTP thật với body rút gọn nhưng không token trả 401; chưa hủy
Trip người dùng để thử đường thành công, chưa chạy Postman GUI.

## 2026-10-29 — Driver Postman ưu tiên tại điểm đón demo

Booking của người dùng `674ba05c-9e4d-4b68-bb3b-dc0207ef4917` đã phát offer
ban đầu cho Driver ID `2023b0e2-d4a5-4762-843a-9e492a8906b7` thuộc fixture
`cab-nearby-37de8de2d753012f@example.test`, không phải
`driver@example.test`. Xác minh qua HTTP: Driver Postman ID
`23411fa8-d14f-4ef8-a4ff-14165a540c8c` đang OFFLINE sau Trip hoàn tất;
Driver OFFLINE không được Dispatch chọn. Không sửa offer/Booking đã commit.

Đã sửa script chuẩn bị fixture để Driver Postman ở đúng điểm đón mẫu và các
Driver demo khác vẫn ở trong bán kính nhưng xa hơn. Đưa Driver Postman về
AVAILABLE qua API; test HTTP với Customer/Booking riêng xác nhận offer chọn
đúng ID, Driver đọc được offer và Notification được giao, sau đó hủy Booking
thử qua API. Sidecar Compose demo nay tự cập nhật GPS và đưa riêng Driver
Postman từ OFFLINE về AVAILABLE sau khi Trip giải phóng; BUSY vẫn bị bỏ qua,
không thay logic Dispatch/Driver production. Kiểm thử thực tế đặt OFFLINE qua
API rồi quan sát tự trở lại AVAILABLE; chạy lại live Booking regression PASS.
Sidecar image `sha256:b7818c77274cf2966696a21cc5f21466cd29b7e7042452efce43dc73b1bb0898`
healthy. Booking người dùng cần hủy qua API nếu còn PENDING rồi tạo Booking
mới để nhận initialOffer mới; không dùng tripRequestId cũ. Chưa chạy Postman GUI.

## 2026-10-29 — GPS hai tọa độ trong Compose demo

Theo quyết định của chủ dự án, `PUT /v1/drivers/me/location` cho phép body chỉ
có `latitude`, `longitude` khi Gateway chạy development và bật
`CAB_DEMO_GPS_SERVER_TIME_ENABLED=1`. Gateway gắn thời điểm nhận làm
`recordedAt` trước RPC hiện có; Driver vẫn xác thực, lưu mẫu, kiểm tra timestamp
và trả `recordedAt`/`receivedAt`. Request có `recordedAt` vẫn dùng quy tắc cũ.
Production hoặc demo tắt cờ vẫn bắt buộc thời gian thiết bị; lối tắt demo không
chứng minh độ mới mẫu tại thiết bị. Không đổi proto, Driver service hay dữ liệu.

Build và typecheck PASS trên host; validator hợp đồng PASS (557 kiểm tra, 15
proto). Vitest Windows bị chặn ở SWC native binding/cache trước khi chạy;
test HTTP Gateway trong image Linux PASS 3/3, gồm cờ tắt, bật và production.
Đã cập nhật riêng Gateway Compose và gửi HTTP thật bằng Driver demo: login
thành công, PUT body hai tọa độ thành công, `locationUpdated=true`, hai mốc
thời gian trả về nằm trong cửa sổ request; Gateway image đang chạy
`sha256:9b935052238f4453b93a0a74a69d1c65ccab9217bc3ae601032779bd98961b87`
healthy/READY. Đây là
kiểm tra HTTP tự động, chưa phải Postman GUI.

## 2026-10-29 — Postman 17.1 thiếu Payment CASH trước IN_PROGRESS

Chủ dự án gửi HTTP 503 khi Driver chuyển Trip
`addb2dec-0f7d-4237-809b-8acf2c3da2db` từ PICKED_UP sang IN_PROGRESS.
HTTP read-only xác nhận Trip thuộc `driver@example.test` và Customer L,
PICKED_UP/version 3; GET Payment theo Trip trả 404 PAYMENT_NOT_FOUND.
Điều kiện hợp đồng API04 yêu cầu CASH PENDING hoặc DEMO_TRANSFER SUCCESS trước
khi bắt đầu chuyến. Code Trip trước đây gộp Payment NOT_FOUND thành
OWNER_NOT_FOUND, khiến Gateway trả 503. Đã sửa riêng
`OwnerClients.paymentDecision` để Payment NOT_FOUND có xác thực chuyển thành
409 PAYMENT_NOT_READY; lỗi transport/không xác minh được vẫn 503.

`npm.cmd run build`, `npm.cmd run typecheck`, `npm.cmd run test:built` PASS;
full Vitest trong image không network/mount PASS 77/77. Trip container image
`sha256:99efc8dc76620a86aab11697571d1ccb6c4c333dddbadf6976de442de91b1089`
healthy. HTTP thực gửi lại đúng PATCH khi Payment vẫn thiếu trả
409 PAYMENT_NOT_READY; GET Trip sau đó vẫn PICKED_UP/version 3. Chưa tạo Payment,
chưa bắt đầu Trip thay người dùng, chưa chạy Postman GUI. Hướng dẫn mục 17.0
nhấn mạnh Customer chủ Trip phải tạo Payment CASH trước bước IN_PROGRESS.

Trong lúc Trip đang PICKED_UP, Driver demo thứ sáu BUSY làm sidecar GPS trước
đây unhealthy dù năm Driver khác vẫn đủ điều kiện. Đã sửa sidecar chỉ cập nhật
GPS cho Driver AVAILABLE, chấp nhận BUSY/OFFLINE hợp lệ và vẫn yêu cầu ít nhất
năm Driver được làm mới trước khi ghi heartbeat. Image sidecar mới
`sha256:22484fee1787bad4ffcae1277711e1dcc0843643fb4bd6ab71592b97a59db5ea`
healthy khi Driver thứ sáu BUSY; Nearby qua OPERATOR trả 200/5. Cả 14 thành
phần Compose healthy, Gateway `/ready` 200 READY. Không đổi trạng thái Driver
đang chở khách hoặc Payment.

## 2026-10-29 — Giải phóng Driver demo để tiếp tục Postman 15–16

Chủ dự án báo Booking `30ed6e13-3e59-4678-ad95-2c84148cd5f8` đã gửi offer
cho Driver khác dù đăng nhập `driver@example.test`. Xác minh qua API: Driver
demo ID `23411fa8-d14f-4ef8-a4ff-14165a540c8c` ở BUSY do Trip
`9eb8ea29-c0e7-4839-86b6-a0432ae395d9` đang DRIVER_ASSIGNED, version 1;
Payment chưa tồn tại. Nearby loại Driver BUSY, nên việc chọn ứng viên khác là
đúng logic, không phải lỗi token hoặc thứ tự khoảng cách. Theo quyết định rõ
của chủ dự án, đã hủy đúng Trip cũ qua `POST /v1/trips/{tripId}/cancel` bằng
token Driver, reasonCode OTHER; Trip/hủy được giữ trong lịch sử. Closure báo
driverRelease và customerRelease CONFIRMED. Driver về OFFLINE theo hợp đồng,
sau đó cập nhật GPS và đổi AVAILABLE qua Gateway với expectedVersion thực tế.
Không sửa DB trực tiếp, không reset/xóa dữ liệu.

GET Nearby bằng OPERATOR đặt tại điểm đón demo trả Driver này đứng đầu;
HTTP regression tạo Booking synthetic mới rồi hủy qua API PASS: initialOffer
chọn đúng Driver, offer đọc được và một Notification được phát. Sidecar GPS
healthy, Gateway `/ready` 200 READY. Booking người dùng đã tạo trước đó giữ
nguyên; cần POST Booking mới để lấy tripRequestId mới. Chưa chạy Postman GUI.

## 2026-10-29 — URL Nearby ngắn cho Postman mục 13

Giữ endpoint và quyền API03 hiện có; OPERATOR đã được phép, CUSTOMER vẫn được
phép. URL demo rút còn `GET /v1/drivers/nearby?latitude=10.78&longitude=106.7`.
Gateway dùng mặc định `radiusKm=1`, `limit=20`. HTTP thật qua Gateway với token
OPERATOR trả 200, năm Driver, `radiusKm=1`, `limit=20`, `hasMore=false`.
Hướng dẫn Postman, grading checks, README và collection thủ công đã cập nhật;
thêm `&limit=2` riêng nếu cần chứng minh phân trang. Không sửa service hoặc
contract, không build/redeploy, chưa chạy Postman GUI.

## 2026-10-28 — Offer Booking tối đa 2 phút cho Postman mục 16

Theo yêu cầu mới của chủ dự án, Booking mới chụp cấu hình offer 120 giây
thay cho 30 giây khi bắt đầu dispatch. Hạn tìm Driver chung vẫn 180 giây;
`expiresAt` luôn là thời điểm sớm hơn giữa hạn offer và hạn tìm chung.
Booking/offer cũ giữ cấu hình và `expiresAt` đã lưu, không cập nhật dữ liệu cũ.
SRS, API02/API03, hướng dẫn Postman và kiểm thử HTTP tạo offer đã cập nhật.
`npm.cmd run build`, `npm.cmd run typecheck`, `npm.cmd run test:built` PASS;
validator Compose PASS (15 proto, 41 RPC nội bộ/52 facade, 557 checks);
full Vitest trong image không network/mount PASS 77/77. Image Booking mới
`sha256:78faec4fc3a282c9fada30bdd9a593deae10deadb1fb2734837981f311bdde29`
đã triển khai riêng và healthy. `node dev/booking-create-offer-http.mjs` qua
Gateway thật PASS: offer đầu có `expiresAt - sentAt` trong khoảng 119–120 giây,
đúng Driver demo đọc được, một Notification qua RabbitMQ/MongoDB; Booking thử
đã hủy qua API. Chưa thao tác Postman GUI, chưa thử accept sau 30 giây trên
Booking thật để giữ Driver demo AVAILABLE cho người dùng.

## 2026-10-28 — Driver demo riêng cho Postman mục 16

Qua Gateway thật đã tạo `driver@example.test` bằng mật khẩu do chủ dự án chọn,
OTP demo, đăng ký hồ sơ MOTORBIKE và Operator duyệt APPROVED; Driver chuyển
AVAILABLE. ID: `23411fa8-d14f-4ef8-a4ff-14165a540c8c`. Mật khẩu chỉ lưu
trong `.secrets/customer-dev/driver_question16_password` và fixture GPS local
đã ignore; không đưa vào Git, image hoặc log. Sidecar `nearby-demo-gps` giờ
duy trì GPS cho sáu Driver; năm Driver cũ vẫn trong bán kính 1 km, điểm GPS
của Driver cũ từng trùng chính xác điểm đón được dịch 11 m để Driver mới
đứng gần nhất cho tuyến demo.

`node dev/prepare-driver-accept-postman.mjs` PASS; sidecar build/recreate riêng
và healthy. GET Nearby qua Gateway bằng Operator trả 200/6, Driver mới đứng
đầu với 0 m. `CAB_EXPECTED_DEMO_DRIVER_ID=... node dev/booking-create-offer-http.mjs`
PASS trên HTTP thật: POST Booking 201 chọn đúng Driver mới, Driver đọc được
offer, một Notification qua RabbitMQ/MongoDB; Booking thử nghiệm đã hủy qua API.
Chưa chạy Postman GUI hoặc nhận offer bằng tay; cần tạo Booking mới vì offer
thử nghiệm đã bị hủy.

## 2026-10-28 — POST Booking trả tiến trình/offer đầu tiên cho mục 15

Theo quyết định chủ dự án trong phiên, `POST /v1/bookings` vẫn lưu snapshot
Booking PENDING bất biến, nhưng sau commit thử đẩy riêng Booking qua Dispatch.
Response 201 có `dispatchStatus`; `initialOffer` chỉ có khi offer PENDING đã
commit cùng outbox, gồm tripRequestId/driverId/status/sentAt/expiresAt.
Không có offer thì không báo giả đã gửi; worker bền vững tiếp tục. Customer
thấy ID Driver ứng viên trước phân công theo quyết định này; Driver vẫn phải
dùng token của chính mình để accept. Không thêm RPC/quyền mới, không sửa
migration hoặc quy tắc offer 30 giây. API02, facade proto, Gateway, Booking,
hướng dẫn câu 15/16 và Postman collection đã cập nhật.

`npm.cmd run build`, `npm.cmd run typecheck`, `npm.cmd run test:built` PASS.
Validator container read-only PASS 15 proto, 41 internal/52 facade, 557 checks.
Host `npm.cmd test` bị chặn bởi SWC native binding cache; chạy cùng full suite
trong image, network none, tmpfs cache: **77/77 PASS**. Hai lượt HTTP thật qua
Gateway/mTLS/PostgreSQL: POST 201 có initialOffer PENDING, đúng Driver đọc
được offer; lượt sau xác nhận một Notification qua RabbitMQ/MongoDB; Booking
test được hủy qua API. Gateway và Booking image đang chạy
`sha256:3833ff3fc0ac847acf1a8823cb4997a0ed14f30d6271cd1678ac54ceba1e1c9b`;
14 thành phần CAB đang healthy. Chưa chạy Postman GUI. Booking cũ được chủ
dự án nêu `a862f590-d980-4c25-9512-337c30712d43` đã đi đến
NO_DRIVER_FOUND với 5 offer EXPIRED; cần tạo Booking mới khi thao tác mục 15.

## 2026-10-28 — Customer L có 5 Booking cho Postman mục 14

Theo yêu cầu chủ dự án, đã tạo Customer `dailong@gmail.com` bằng mật khẩu
được chỉ định (chỉ lưu file ignored local), rồi qua Gateway tạo và hủy năm
Booking thật cho tuyến demo MOTORBIKE. Không viết trực tiếp DB, không giữ
Trip hoặc Driver của fixture này hoạt động. HTTP thật: Customer login 200,
GET `/v1/bookings?limit=2` duyệt 2/2/1 và từng chi tiết có cùng customerId;
OPERATOR bị 403 ở danh sách; Nearby OPERATOR vẫn 200/5 Driver. Chưa chạy
Postman GUI. Hướng dẫn nhập tay ở `dev/GRADING-CHECKS.md`; fixture nội bộ
ở `.secrets/customer-dev/grading_customer_l.json` đã ignore.

## 2026-10-28 — Nearby demo tự duy trì GPS cho Postman câu 13

Theo yêu cầu thao tác chỉ bằng URL và token OPERATOR, đã tạo năm Driver demo
riêng qua Gateway OTP → đăng ký → Operator duyệt → AVAILABLE. Credential chỉ
lưu tại `.secrets/customer-dev/nearby-demo/drivers.json` đã ignore. Không đổi
TaiXeDemo1 hoặc các Driver fixture Booking cũ. Compose `nearby-demo-gps` chạy
chỉ trong cấu hình development rõ ràng, dùng token của chính năm Driver để
gửi GPS giả lập qua Gateway mỗi 12 giây; không thay logic 30 giây, không sửa
API/protobuf/policy. Không publish thêm cổng hoặc đưa credential vào image.

`docker compose config --quiet` PASS; image `cab/demo-node:24.19.0` được build
lại thành `sha256:59e72d260ca37b957ec41ad5bacd7c328e6ccc4ab403624203802a506d33c12e`.
Container `cab-nearby-demo-gps-1` healthy; các container app/hạ tầng CAB khác
vẫn healthy. Qua Gateway thật, OPERATOR login rồi GET Nearby `limit=5` trả
200, năm item đều thuộc fixture riêng, kể cả sau khi đợi quá 30 giây và sau
`docker compose stop/up` riêng container GPS. Chưa chạy Postman GUI; chưa
kiểm tra stop/up toàn bộ Compose trong lượt này. Hướng dẫn URL và điều kiện
demo tại `dev/GRADING-CHECKS.md`.

## 2026-10-28 — Health details công khai theo quyết định mới

`GET /health/services` không còn yêu cầu Operator JWT; Gateway trả báo cáo
12 thành phần từ snapshot probe cho mọi caller. Chỉ có name/status/checkedAt/
reasonCode chuẩn hóa; không đọc hoặc công khai credential/host nội bộ.
`/health` và `/ready` giữ semantics cũ. API07, hướng dẫn Postman và tracker
đã được đối chiếu theo quyết định này. Build Docker, `npm.cmd run typecheck`,
Linux Vitest 77/77, `test:built` 8 context và validator 15 proto/41 internal+
52 facade policy PASS. HTTP Compose trên Gateway mới: `/health` 200, `/ready`
200, anonymous `/health/services` 200/12 UP; header Bearer sai vẫn 200.
Gateway image `sha256:b2a9d3362c6d0434e689a8b85e80dcbada3fffc6fb5f15fcb6d12dc90656cf7d`.
Postman GUI chưa chạy.

## 2026-10-28 — Đổi mật khẩu RabbitMQ admin cho demo local

Theo yêu cầu chủ dự án, đã đổi mật khẩu `cab_dev_admin` trên RabbitMQ và đồng
bộ secret local đã ignore cùng ba bản sao cho Payment/Trip/Booking broker
setup; không ghi giá trị vào repo. Management API xác thực bằng credential mới
trả 200 với tag administrator; cả 13 container healthy và Gateway `/ready`
200. Mật khẩu publisher/consumer, volume và dữ liệu RabbitMQ không đổi.

## 2026-10-28 — RabbitMQ Management UI cho demo local

RabbitMQ management plugin đã chạy ở cổng 15672 trong container nhưng Compose
chưa publish ra host. Publish riêng `127.0.0.1:15672:15672` để xem UI local;
AMQPS 5671 vẫn nội bộ, volume/credential không thay. Xem README để lấy
username và đường dẫn mật khẩu local, không ghi giá trị vào repo/báo cáo.
Sau `docker compose up -d --no-deps rabbitmq`, HTTP host `127.0.0.1:15672`
trả 200; RabbitMQ healthy, `check_running`/`check_port_connectivity` đạt,
Gateway `/ready` 200. Các app khác vẫn healthy. Chưa thao tác đăng nhập UI.

## 2026-10-14 — Compose tự phục hồi chứng chỉ dev khi mở lại

Gateway Login 503 sau Docker restart đã được tái hiện: chứng chỉ client Gateway
cũ có thời hạn 86.401 giây, vượt mức tối đa 86.400 giây và bị gRPC
`Service certificate rejected`. `cert-renewer` cũ chỉ kiểm tra còn hạn.
`cert-init.mjs` giờ cấp workload bằng mốc UTC tường minh (bắt đầu lùi 1 phút,
kết thúc sau 23 giờ 50 phút), xác minh CA, URI SAN, EKU, khóa khớp và thời
hạn trước khi thay file. Chứng chỉ hiện có sai chính sách được gia hạn ngay
khi cert-renewer khởi động; chu kỳ kiểm tra mỗi giờ và ngưỡng gia hạn dưới
12 giờ vẫn giữ. Healthcheck kiểm tra cùng giới hạn; Gateway không còn READY
với chứng chỉ caller trên đĩa sai chính sách. Transport không nới giới hạn.

Booking/Payment/Trip/Rating dừng exit 0 sau `compose stop`; lần `up` trước đó
ba broker setup job thoát 1 lúc RabbitMQ vẫn đang boot. Rabbit `ping` đã báo
healthy trước khi ứng dụng/listener sẵn sàng. Compose healthcheck giờ đòi
`check_running` và `check_port_connectivity`; các setup job chạy lại exit 0.
Lần build/rollout hiện tại: chín app, PostgreSQL, RabbitMQ, MongoDB và
cert-renewer chạy; `/ready` 200, Operator Login 200, `/accounts/me` 200.
Sau `docker compose stop` rồi `docker compose up -d`, các kiểm tra trên lại
đạt. Aggregate row count Identity/Customer/Driver/Booking/Trip/Payment/Rating
trước/sau là 102/55/44/18/10/7/2. Không seed/reset hoặc đổi credential.

Kiểm tra biên chứng chỉ: đúng 24 giờ được nhận, 24 giờ + 1 giây bị từ chối.
CA/container tạm riêng đã chứng minh cấp chín leaf đúng giới hạn, giữ leaf
còn tốt, healthcheck từ chối leaf 86.401 giây và leaf sắp hết hạn, gia hạn
chúng rồi launcher khởi động lại Gateway child để nạp leaf mới. Đã quan sát
gia hạn Gateway thật lúc rollout từ 86.401 giây sang 85.860 giây. Docker
image app mới `sha256:098477e8daac4a27dbacbfe3aae49682494917e04e626e7db3740c1bf198071c`;
`docker compose build cert-renewer` đã chạy build toàn workspace, Docker
`npm run typecheck`, `npm test -- --reporter=dot` (77/77), `npm run test:built`
(8 context) đều PASS. `node --test test/compose-cert-policy.mjs` (3/3) và
`node test/compose-cert-renewal.mjs` PASS. Chưa theo dõi một chu kỳ chạy qua
đêm. Postman GUI chưa chạy; HTTP/Compose không được ghi thành GUI PASS.

## 2026-10-12 — Rà 30 mục và chuẩn bị Postman thủ công

Giữ nhánh `feat/customer-foundation`, HEAD nền `c5314ec` và mọi thay đổi local;
không commit/push hoặc reset dữ liệu. Tracker hiện hành đã gom đủ 30 mục;
tracker cũ chỉ còn ở `grading-tracker-history.md`. Driver theo ID chỉ lộ
driverId/fullName cho Driver chủ, Customer có Trip lịch sử và OPERATOR;
Nearby kiểm tra 5 Driver, biên 999/1001 m, OFFLINE và GPS cũ trên fixture
tổng hợp. Booking POST limiter demo 30/phút/peer chặn trước gRPC; thử tải
adapter tạm Linux 1.200 request/0,998 s = 1.202,4 req/s (Windows
1.200/2,614 s = 459 req/s). Đây là harness một tiến trình, không phải tải
end-to-end Compose; Linux phát cảnh báo MaxListeners do Supertest concurrency
48, không có bằng chứng rò rỉ sau khi context đóng.
Payment replay HTTP và SQL đọc-only xác nhận một Fare/Payment/Attempt, hai
receipt, một SUCCESS outbox, không có FAILED outbox; late FAILED không hạ
SUCCESS. Audit dữ liệu xác nhận Argon2id, ciphertext/nonce/tag/HMAC và key
không nằm trong image. SQLi login 400/401 không đổi Account/Session; Rating
trả comment dạng JSON text, chưa có frontend để kiểm chứng contextual encoding.

Health API đã triển khai `/health`, `/ready`, `/health/services`. Probe từ
healthcheck container có timeout 5 giây, snapshot tối đa 25 giây trong volume
`cab_cab_health`; worker chỉ ghi heartbeat sau vòng xử lý thành công. Gateway
đọc snapshot, không mở pool DB theo từng HTTP request. API07 được điều chỉnh
cho Compose demo một Gateway: 12 thành phần gồm PostgreSQL/RabbitMQ/MongoDB,
không có Redis; limiter hiện nằm trong tiến trình Gateway. `health.spec.ts`
kiểm tra probe thành công, lỗi và stale trong thư mục tạm; HTTP Compose thực
trả `/health` 200, `/ready` 200, OPERATOR `/health/services` 200/12 UP, thiếu
token 401, Customer 403. Lúc Gateway vừa được recreate, `/ready` trả 503
trước khi snapshot đầu tiên đến rồi trả 200; đây là fail-closed warmup.

Trip ERROR có migration mới `202610120004_error_resolution.sql` (V1–V3 giữ
checksum), facade OPERATOR và RPC nội bộ Driver chỉ cho Trip kiểm tra điều kiện
restore. RESTORE xác minh Account ACTIVE, Driver APPROVED/BUSY, xe ACTIVE và
assignment/guard BOUND rồi CAS Trip.version; CLOSE giữ ERROR, ghi closeReason,
resolve tất cả Incident OPEN, audit/receipt/outbox/ClosureOperation trong cùng
transaction. Worker giải phóng đúng reference; VEHICLE_BREAKDOWN khóa xe
INACTIVE và Driver OFFLINE. HTTP trên Customer/Booking/Trip tổng hợp: role
Customer/Driver 403, token thiếu 401, version cũ 409, restore/replay và
close/replay 200; DB audit thấy 2 Incident RESOLVED, 2 audit/receipt, mỗi
event một bản, 1 closure CONFIRMED. Notification TRIP_RECOVERED và
TRIP_CLOSED_ABNORMALLY mỗi loại một bản. Không sửa Trip hoặc hồ sơ người dùng.
`migrate-trip` chạy lại chỉ kiểm checksum, không áp lại V4.

Kiểm tra cuối: `npm.cmd run build`, `npm.cmd run typecheck`, Docker Linux
`npm test` 77/77, `npm run test:built` 8 context, validator 15 proto/41 RPC
nội bộ/52 facade/557 static checks PASS. HTTP health, Driver theo ID,
Rating read, Trip ERROR và audit DB nói trên PASS. D03 chọn giữ
JourneyMetrics PENDING/REVIEW_REQUIRED để rà soát thủ công; thao tác xác nhận
chưa triển khai, không tự tính lại cước. Chưa chạy Postman GUI; test dependency
lỗi health chỉ mô phỏng snapshot trong harness riêng, chưa tắt hạ tầng thật.
Metadata gRPC 8 KiB và các giới hạn transport/hardening khác tiếp tục backlog.
Compose đang chạy: Gateway dùng image
`sha256:2f7958b08961b7994b846ed809f9ca9afb4629daa0ed946992d9308318934d3b`;
Identity, Driver, Trip dùng image
`sha256:4fe463d7afdb25de784262896ad1369e343382e37b006d442258181e3a45da7c`;
Customer, Notification, Payment, Booking, Rating dùng image trước
`sha256:fab652471e876ce76c0d8f07686e575dab4f8459faece1c5a1934d571278b5bf`.
Cả chín app, PostgreSQL, RabbitMQ, MongoDB và cert-renewer đều running/healthy;
không chạy Node dev song song. Đổi source tiếp theo dùng `docker compose up -d
--build`; vận hành thường ngày vẫn `docker compose up -d` từ Git root.

## 2026-10-12 — Rating MVP đã chạy qua Gateway và Trip thật

Thêm rating-service NestJS/TypeScript, database `cab_rating` riêng, migration
`202610120001_rating.sql`, role migration/runtime tách biệt, gRPC mTLS và
facade policy default deny. Identity đã bind VerifyRatingUserIdentity; Trip
GetTripRatingContext cho Customer chủ chuyến, Driver lịch sử và Operator theo
quyền đối tượng hiện hành. Rating chỉ ghi cho Customer chủ Trip COMPLETED,
không đòi Payment SUCCESS. Score nguyên 1–5; comment tùy chọn tối đa 1000 ký
tự trước trim, rỗng sau trim thành không có comment. UNIQUE(trip_id), advisory
lock và transaction cùng rating/receipt/audit giữ một đánh giá mỗi Trip; cùng
nội dung chuẩn hóa replay 201/cùng ratingId, khác nội dung 409. Chưa có sửa/xóa,
điểm trung bình, ranking hay Rating Notification vì hợp đồng không yêu cầu.

HTTP trên Compose `cab`: Customer synthetic thứ chín tạo Booking mới, Driver
nhận và Trip hoàn tất qua service thật khi Payment CASH vẫn PENDING. POST Rating
201, GET 200, replay 201/cùng ID, khác nội dung 409. Chuyến chưa hoàn tất hoặc
CANCELLED 409; Customer khác đọc/tạo 404; Driver/Operator tạo 403; token
thiếu/sai 401. Driver đọc list và Operator lọc theo Trip ID trả Rating đúng.
Stop/start riêng rating-service rồi GET lại cùng ID PASS. Nearby và audit
Booking/Trip/Payment/Notification cũ sau triển khai PASS; dữ liệu/volume cũ
được giữ. Không dùng test principal giả cho bằng chứng HTTP này.

`npm.cmd run build`, `npm.cmd run typecheck`, `npm.cmd run test:built` PASS;
Linux Vitest 74/74 PASS. Validator PASS 15 protobuf, 39 internal + 50 facade
RPC policy, 550 static checks. `node test/rating-postgres.mjs` PASS trên
PostgreSQL disposable: validation, runtime DDL denial, replay/conflict,
concurrent unique, audit một lần và rollback khi audit lỗi. `migrate-rating`
exit 0; chín app cùng PostgreSQL/RabbitMQ/MongoDB healthy, app image
`sha256:411cd57b1beacd57796c30be3861943f3c5f38dc9ef666720663d90713f20edb`.
Postman GUI chưa chạy. Chưa kiểm chứng Rating dưới fault-injection nhiều
instance; Trip ERROR/D03 JourneyMetrics vẫn là tồn đọng riêng.

## 2026-10-12 — Booking → Trip → Payment → Notification chạy qua service thật

Trên nhánh `feat/customer-foundation`, Booking có DB/role/migration riêng,
Customer activity guard, Driver reservation và GPS handoff, dispatch offer
có deadline/receipt, assignment saga gọi Trip Prepare/Activate, outbox AMQPS.
Trip tracking trả Driver/Vehicle đã xác minh qua owner RPC, vị trí chỉ từ
Driver được gán, dừng chia sẻ khi Trip đóng; incident chuyển ERROR và lưu
history/receipt/outbox. Payment đối chiếu PricingSnapshot bất biến không phụ
thuộc thứ tự khóa JSON của PostgreSQL/protobuf. Notification consumer nhận
Booking/Trip/Payment event với recipient và nguồn được kiểm tra, ghi MongoDB
idempotent. Gateway trả trang rỗng `items: []` đúng khi protobuf không truyền
`repeated` rỗng. Hai truy vấn Prisma advisory lock của Customer/Driver được
sửa để trả kiểu giải mã được, vẫn giữ khóa trong transaction.
Booking cũng so sánh reservation JSONB theo cấu trúc khi replay đồng thời;
PostgreSQL không giữ thứ tự key trong JSONB. Ca HTTP hai request accept cùng
offer đã từng khiến assignment COMPENSATED; sau sửa, cả hai trả cùng một Trip,
chỉ một assignment tồn tại, và cancel/closure giải phóng hai reservation owner.

Bằng chứng HTTP trên Compose `cab` (Gateway 33201, gRPC mTLS, PostgreSQL,
RabbitMQ AMQPS, MongoDB thật): fixture opt-in đã tạo 8 Customer và 6 Driver
MOTORBIKE riêng, giữ TaiXeDemo1; ít nhất 5 Driver hiện trong 1 km qua cursor size 2,
vị trí xa trả danh sách rỗng 200. 14 Booking synthetic đã được tạo: 1
NO_DRIVER_FOUND do GPS hết mới và 2 ca accept cạnh tranh lỗi trước khi sửa,
5 Booking của cùng Customer được hủy và đọc qua phân trang size 2,
6 Booking được gán Trip thật (gồm ca accept cạnh tranh đạt). CASH:
giá 1.250 m = 6.625 VND, Payment replay cùng key, confirm sớm 409, Trip qua
ARRIVED_PICKUP/PICKED_UP/IN_PROGRESS/COMPLETED, GPS assigned lên LIVE,
confirm CASH sau COMPLETED thành SUCCESS một lần, tracking STOPPED sau đóng.
DEMO_TRANSFER PENDING/FAILED bị chặn trước IN_PROGRESS; retry FAILED tạo
attempt mới, SUCCESS đúng tiền cho phép tiếp tục. Một Trip đã thanh toán rồi
hủy trước khởi hành giữ Payment SUCCESS và `requiresReview=true`. Driver được
gán báo Incident OPEN, Trip sang ERROR chưa đóng, closure trả 409 và giữ
reservation. Notification TRIP_COMPLETED/PAYMENT_SUCCESS/PAYMENT_FAILED/
TRIP_CANCELLED/TRIP_ERROR được đọc đúng
Customer theo reference ID, mỗi event cần thiết một bản; đọc Booking của
Customer khác trả 404, Driver tạo Booking trả 403. Đây là HTTP tích hợp demo
thật, không phải Postman GUI hoặc fault-injection tách biệt.
GET closure của bốn Trip đã đóng (ba COMPLETED, một CANCELLED) đều trả
`SUCCEEDED` sau release Customer/Driver; Trip ERROR chưa đóng trả 409.

Kiểm tra cuối: `npm.cmd run build`, `npm.cmd run typecheck`, `npm.cmd run
test:built` PASS; Linux Vitest 74/74 PASS. Contract validator PASS 14 proto,
39 RPC nội bộ + 46 facade, 546 kiểm tra tĩnh. `node test/booking-postgres.mjs`
và `node test/trip-postgres.mjs` PASS trên PostgreSQL disposable, gồm CAS,
receipt, JSONB reservation replay, incident ERROR và Payment gate; test-only principal ở harness đó
không được dùng làm bằng chứng HTTP. Migration/broker jobs Compose exit 0,
tám app và PostgreSQL/RabbitMQ/MongoDB healthy. Lượt build sạch Dockerfile
chuẩn đầu gặp npm registry `ECONNRESET`; lượt chạy lại đã PASS `npm ci`,
Prisma generate và build toàn workspace từ lockfile. Không đổi dependency.
`docker compose up -d` sau đó PASS: tám app cùng image sạch
`sha256:411742a260dbfaede9214bb6ea786a201208392fa142121012b8d497ce8618a0`,
PostgreSQL/RabbitMQ/MongoDB giữ container và dữ liệu cũ, migration/broker setup
exit 0, tất cả service healthy. HTTP `nearby` và `audit` sau restart PASS, xác
nhận bốn Trip/Payment và Notification còn nguyên. Lệnh thường ngày
`docker compose up -d` không cần cài dependency.

Giới hạn: chưa chạy Postman GUI, chưa có môi trường full-stack tách biệt để
fault-injection/restart concurrency, chưa triển khai/kiểm chứng Operations
khôi phục/đóng ERROR. JourneyMetrics hiện PENDING; D03 chưa chốt
thuật toán/ngưỡng CONFIRMED/REVIEW_REQUIRED. Rating chưa triển khai. Metadata
gRPC 8 KiB và các giới hạn transport cũ vẫn trong backlog; health và các
kiểm tra trên không thay thế security review toàn hệ thống.

## 2026-10-10 — Trip slice và Payment gate; Booking runtime vẫn thiếu

Trip service đã có `cab_trip` cùng role migration/runtime tách biệt, migration
V1 (preparation/tombstone, Trip, history, receipt, closure, outbox, route
point) và V2 bổ sung JourneyMetrics PENDING. Nest quản lý một pool/ứng dụng;
không migrate lúc boot. Trip facade có GET list/detail/closure, PATCH status,
POST cancel qua Gateway mTLS. `PrepareTrip`/`ActivateTrip`/bù dùng RPC có
receipt và kiểm tra snapshot Booking, guard Customer, reservation Driver; đây
là điểm tích hợp cho Booking, **chưa có Booking runtime** để kích hoạt chuyến.
TripPreparation.ACTIVE công bố DRIVER_ASSIGNED, chưa bắt đầu chở khách.

Trip ghi start-check intent cục bộ, hỏi Payment qua mTLS ở PICKED_UP →
IN_PROGRESS, rồi khóa/CAS lại Trip; CASH PENDING hoặc DEMO_TRANSFER SUCCESS
mới được qua. Hủy/PICKED_UP tranh chấp trên Trip row; hủy commit tạo closure
với Payment fence PENDING và worker retry cùng ID. Payment fence sau SUCCESS
chỉ đặt requiresReview, không refund. Closure worker gọi Customer/Driver
release qua RPC hiện có, nhưng hai owner handler guard/reservation chưa được
triển khai trong demo; không báo closure SUCCEEDED giả. JourneyMetrics chỉ
PENDING, Fare giữ nguyên ở Payment. Outbox Trip có publisher AMQPS và binding
Notification; chưa có Trip event thật trong demo vì thiếu activation Booking.

Bằng chứng hiện tại: `npm.cmd run build`, `npm.cmd run typecheck`, 70/70 Vitest,
`npm.cmd run test:built` PASS; Docker validator 13 proto, 37 internal/32 facade,
532 facade checks PASS. `node test/trip-postgres.mjs` PASS trên PostgreSQL 17.11
container tự hủy: receipt/tombstone, CAS, concurrency, outbox, Nest boot/close
hai lần không còn connection; Payment ledger thật ở DB riêng qua mTLS gRPC
với test-only Identity principal/owner context: chuyển khoản PENDING/FAILED bị
chặn, SUCCESS và CASH PENDING được phép. CASH confirm trước COMPLETED
bị chặn, sau COMPLETED ghi SUCCESS một lần và replay không ghi thêm; thanh toán
SUCCESS rồi hủy vẫn SUCCESS nhưng cần rà soát, fence replay không ghi thêm.
`test/trip-transport.spec.ts`
chứng minh caller-policy Trip→Payment và Gateway không gọi Trip nội bộ.
Đây không phải HTTP Booking–Trip–Payment end-to-end. Postman GUI chưa chạy.
Compose migration Trip V1 xác nhận checksum và V2 đã áp dụng bằng job exit 0;
Trip/Gateway chạy image mới `sha256:f0c51fa576c5e8c9d7833432c5a7d46e89f508fdc6e57dc0411586a8e7d3fe2d`,
đều healthy. `node dev/trip-http-smoke.mjs` qua Gateway thật: anonymous 401,
OPERATOR list 403, Trip không tồn tại 404 qua gRPC mTLS. Không tạo Trip giả.

Chưa có: Booking owner/guard/reservation activation thật, GPS handoff/tracking,
Incident/ERROR và confirmed metrics, closure release thật/Notification Trip
thật, HTTP Trip success. Giữ metadata gRPC 8 KiB và các backlog transport khác;
không coi slice này đã hoàn thành mục phiếu chấm 17–18 hay Payment 19.

## 2026-10-09 — Payment MVP độc lập, Compose đã có service; liên kết Trip/Booking còn chặn

Quyết định chủ dự án: chỉ MOTORBIKE cho request mới, giữ STANDARD/PREMIUM/VAN
legacy để đọc; 5.300 VND/km, không mở cửa/phí phút/giá tối thiểu; quãng đường
tuyến demo 1.250 m do server giữ, tổng 6.625 VND ROUND_HALF_UP một lần. Snapshot
giá bất biến được cấp trước Booking, không phải Payment hoặc bằng chứng Booking.
Fare/Payment chỉ tạo sau khi Payment xác minh Trip/Booking/owner qua RPC; hai
owner service này chưa triển khai nên HTTP Payment có token trả 503, không tạo
Fare/Payment giả. TripPreparation.ACTIVE là kích hoạt phân công, không phải bắt
đầu chở khách. CASH chờ đúng Driver xác nhận sau Trip COMPLETED;
DEMO_TRANSFER chỉ nhận kết quả từ endpoint dev có quyền. RPC Trip→Payment
`GetTripPaymentDecision` đã định nghĩa/triển khai độc lập, cho CASH PENDING
hoặc DEMO_TRANSFER SUCCESS qua khi không cần review; Trip chưa gọi RPC này.
SUCCESS không đồng
nghĩa Trip COMPLETED. Hủy sau SUCCESS cần review thủ công, chưa có Trip để
kiểm chứng luồng này.

Source mới có `payment-service` riêng, migration `cab_payment`, runtime/migration
role tách biệt, gRPC mTLS với policy facade/nội bộ, Gateway Payment facade, DB
receipt/attempt/outbox, publisher AMQPS và Compose broker ACL. `cab_payment`
được tạo cộng thêm; các DB/volume cũ không reset. Payment, Gateway, Identity,
Driver và các app cũ đã healthy sau cutover. `node dev/compose/verify-payment-role.mjs`
PASS quyền runtime; `dev/payment-http-smoke.mjs` PASS 401/503 fail closed.
`dev/smoke.mjs` PASS năm Customer endpoint 201/200/200/200/200;
`dev/driver-registration-smoke.mjs prepare` PASS với MOTORBIKE synthetic;
`dev/motorbike-legacy-smoke.mjs` PASS đọc xe legacy không đổi.

Trên PostgreSQL 17.11 tmpfs riêng: migration áp một lần rồi checksum replay,
snapshot/route/replay, tính số nguyên, tạo Payment đồng thời, sai amount,
demo disabled, SUCCESS/FAILED/retry/late attempt, CASH sau COMPLETED và outbox
PASS bằng harness với owner context synthetic. Đây không phải tích hợp thật
Payment–Booking–Trip hoặc Notification event từ Payment trên runtime. `build`,
`typecheck`, 67/67 Vitest, `test:built`, validator 12 proto/37 internal/27 facade
PASS. Postman GUI chưa chạy. API05 list attempts có source/cursor độc lập,
chưa có HTTP với Payment thật vì thiếu Trip/Booking. Provider webhook/reconcile,
review khi Trip hủy sau SUCCESS và end-to-end Payment→Notification chưa có
bằng chứng hoàn chỉnh; không đánh dấu Payment rubric hoàn tất.

Image thực chạy ở lần kiểm tra cuối: Gateway/Payment
`sha256:e8e84d2796109afbc552fc09a72c2905e844ae9a920ed9df004e382f9433d05c`
healthy; Identity/Driver
`sha256:9a4dfd7db7bf2ae5b32f20c395837978067b60ce5db541b2b1373fbb34651e09`
healthy; Customer/Notification vẫn image trước và healthy. Hai PostgreSQL
tmpfs test-only `cab-payment-check-20261009` và `cab-payment-v2-check-20261009`
đã dừng, không có volume; Compose `cab` tiếp tục chạy. HTTP Gateway mới:
Payment anonymous 401, attempts ID không tồn tại 404, Fare/create thiếu
Trip/Booking 503; không có Postman GUI PASS.

## 2026-10-09 — Booking MVP: dependency decision pending, partial foundation only

The current Compose project `cab` still runs the pre-Booking five app images.
No Booking service, Booking database, offer, assignment, cancellation, Booking
notification or five-Booking fixture has been deployed. Rubric items 13–16
and 18 remain unverified. Postman GUI has not run.

Source now wires Identity `VerifyAccountEligibility`, Driver
`FindDispatchCandidates` (approved/AVAILABLE, active vehicle, fresh GPS,
exact-distance radius and Identity account check), and an API03 Driver nearby
facade with a proposed Driver-owned 30-second paging snapshot migration.
The nearby migration was exercised on an isolated PostgreSQL 17.11 tmpfs
container with a runtime role; it has **not** been applied to demo data or
deployed. `npm.cmd run db:generate`, `build`, `typecheck`, `test` (67/67),
`test:built` and read-only Docker contract validation passed in the local
workspace. These are not HTTP/Compose Booking tests.
The proposed nearby snapshot has no purge job yet; it must be bounded before
production or long-running demo use.

API02 requires Payment-authoritative immutable pricing before a 201 Booking;
API03 requires a confirmed active Trip before accept can return 200 and Booking
can become DRIVER_ASSIGNED. Payment and Trip are explicitly outside this
request, and 5,300 VND/km is only a proposal. Owner decisions on these
boundaries are pending. No unapproved fare, fake Payment/Trip success, or
Booking 201/assignment has been introduced. The existing data, image,
containers, volumes and TaiXeDemo1 remain untouched.

## 2026-10-08 - Approved legacy-phone read exception; Compose cutover complete

The owner approved retaining the 61 existing `+84` contacts with ten digits
after the country code exactly as stored when they are read. New phone input
remains `^0[0-9]{9}$`; valid stored `+84` plus nine digits renders as the
equivalent domestic number. No digit was dropped, no DB/volume/secret was
rewritten, and overlength legacy phone is not accepted for new requests or
phone login. Existing legacy accounts can still log in by email. Duplicate
lookup for valid domestic/`+84` equivalents retains one canonical HMAC value.
API01/API07/API04 distinguish read exceptions from strict request phone;
facade docs and dev README document the exception.

Host build/typecheck, four built Nest contexts, pinned contract validator
(466 facade checks, 11 proto files, 34 internal + 18 facade RPC policy
coverage, OpenAPI) PASS. Final Linux image full suite PASS 65/65. A prior run
failed one JWT test because changing the final base64url character sometimes
left the signature bytes unchanged; that assertion now changes a signature
byte and the unchanged security expectation passes. Windows Vitest remains
blocked by the pre-existing SWC native-cache ownership error.

Real HTTP through temporary candidate Gateway/Identity/Driver app containers,
mTLS gRPC and existing PostgreSQL PASS: legacy overlength Operator email login
and exact unchanged phone response; new domestic Customer register/read,
email and phone login, contact conflict and invalid phone rejection; keyless
APPROVED/REJECTED review and AVAILABLE/OFFLINE, wrong versions/roles denied,
and rejected Driver denied AVAILABLE. The candidate containers were removed
and original app containers restored before cutover. Only Identity and Gateway
were then recreated under Compose; both now run image
`sha256:1f94d3f2e33a4d703858aef2a46de7192f2c1b547cdcf890e0d7fd580a4dde27`
and are healthy. Customer, Driver and Notification remain on
`sha256:2d9a84dfc91f89403afc48405e1c471b97760be1094559f64b4cad7db7b07b76`.
The same HTTP regression passed directly against the running Compose apps.
PostgreSQL, RabbitMQ, MongoDB and volumes were not recreated; TaiXeDemo1 was
not used for review. Postman GUI has not been run.

The older sections below record the pre-decision deployment gate and prior
container state; this section supersedes that gate for the chosen temporary
read exception. The 61 values remain anomalous and need a later data-quality
decision if domestic output becomes mandatory for historical accounts.

## 2026-10-08 - Client Idempotency-Key only for Payment

API Gateway no longer requires a client `Idempotency-Key` for Driver
application review or Driver availability. It creates a per-command UUID when
the optional legacy header is absent and passes that key only to the Driver
facade. Driver's transactional receipt, CAS versions, role and state checks
remain unchanged. API02/API04/API07/API08 no longer declare the client header;
API05 Payment retains it. Manual Driver Postman collections no longer send it.
Without a stable client key, a repeated public command is a new command and
must use the current version; an unknown outcome requires reading current
state before retry. This does not remove owner-side event deduplication.

Evidence: host `npm.cmd run build`, `npm.cmd run typecheck`, and
`npm.cmd run test:built` PASS. Pinned contract validator PASS (466 facade
checks, 11 proto files, 34 internal and 18 facade RPC policies, OpenAPI).
Linux image `npm test` PASS 64/64; Windows Vitest blocked by its existing SWC
native-cache owner error. `node dev/headerless-driver-network-smoke.mjs`
PASS against real Compose Gateway, mTLS gRPC and PostgreSQL using temporary
app containers: keyless APPROVED/REJECTED reviews, AVAILABLE/OFFLINE, wrong
version 409, wrong role 403, duplicate reviewed application 409 and rejected
Driver AVAILABLE denial 409. The original three app containers were restored
healthy; data and volumes were not reset. Postman GUI was not run.

The candidate image contains the pending domestic-phone change described
below. The restored demo app containers still run the previous image; routine
Compose recreation remains gated on the legacy-phone decision. The network
test used a pre-cutover Operator session and new valid domestic-phone test
applicants, so it does not settle that separate data compatibility issue.

## 2026-10-07 - Vietnamese domestic phone format (deployment pending legacy decision)

Source now accepts only `^0[0-9]{9}$` at Customer registration, Driver OTP
request and phone login. A shared `@cab/phone-number` helper converts this to
the existing `+84` lookup/HMAC/encrypted storage representation; account,
registration snapshot, OTP verification and Driver application mappers return
domestic form. Email login, OTP demo response, one-use proof and keyless
registration remain unchanged. API01/API07/API04, facade docs, fixtures,
manual Postman collections and smoke generators were updated.

Host build/typecheck and built context tests PASS. Linux image build,
typecheck, 64/64 Vitest tests and four built contexts PASS. Pinned contract
validator PASS (466 facade checks, 11 protobuf files, 34 internal and 18 facade
policy RPCs, OpenAPI parse). Windows Vitest was blocked by SWC native cache
ownership; the Linux test run is the current automated evidence. Read-only
audit against the existing Identity DB found 65 Accounts: 4 convertible
`+84` contacts, 61 `+84` values with ten digits after the prefix (one too
many), zero other unsupported values, zero digest mismatches or duplicate
canonical values among the convertible group. Existing Operator/Driver seed
manifests contain `+84` plus ten digits, which has no equivalent in the new
10-digit public format. No data/secret/volume was changed. The new image has
been built but the running Compose apps have not been replaced: fail-closed
rendering would disrupt these historical demo accounts. The candidate image
is also tagged `cab/phone-candidate:2026-10-07`; the Compose image tag now
points to the new build, so avoid `docker compose up -d` until the legacy
handling decision and cutover are complete. HTTP/Postman validation
against the new app version is pending a reviewed policy for those invalid
historical values. Do not infer HTTP PASS from build/unit/static validation.

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


## 2026-10-06 — chuyển demo sang project Compose `cab`

- Root `compose.yaml` chạy Gateway, Identity, Customer, Driver, Notification,
  PostgreSQL 17.11, RabbitMQ 4.2.9, MongoDB 8.0.30; `cert-renewer` và ba migration
  job là phần setup thực tế. Node/npm giữ 24.19.0/11.17.0; Prisma generate chạy
  trong Linux build. Migrations không chạy trong AppModule. Các runtime chỉ nhận
  credential đúng service; policy/mTLS và AMQPS giữ nguyên.
- Cutover đã đối chiếu external volume theo tên thật, gồm Mongo `configdb` ẩn danh.
  Rabbit node trước/sau là `rabbit@95a48b840782`; queue chính 0 pending, DLQ 5.
  Backup bốn volume sau khi dừng app/server cũ, cùng secret/CA, nằm tại
  `.secrets/cab-cutover-backups/` (ignored); bốn archive kiểm tra đọc được.
  Baseline trước app mới: 51 Account (48 ACTIVE, 3 SUSPENDED), 28 Customer,
  19 Driver application (10 APPROVED, 7 REJECTED, 2 SUBMITTED), 32 Notification.
- Project cũ `cab-customer-dev-bdb8a430-c2b7-466e-ab77-7b509be16898` giữ các
  container dừng, không xóa volume. Nhóm `cab-bootstrap-test-*` và
  `cab-notification-harness-*` không bị dừng/xóa. Mongo harness có 4 notice thử
  nghiệm riêng; không trộn với 32 notice của Mongo demo chính.
- Image build, TypeScript typecheck PASS; full Vitest Linux 55/55 và built-context
  4 app PASS. Host Vitest BLOCKED trước khi chạy test do Windows Application Control/
  SWC native cache, không đổi quyền hệ thống. `docker compose up -d --wait` đạt
  healthy cho 8 thành phần chạy, migration job exit 0. Existing Customer/Driver/
  Operator HTTP và rejected Driver AVAILABLE 409 PASS. Inbox rỗng lộ lỗi Gateway
  503 vì protobuf không phát repeated field rỗng; mapping đã sửa trả `[]` và HTTP
  kiểm tra 200. Flow Driver mới qua API → review → outbox → Rabbit → Mongo →
  Notification list/read/owner PASS; sau flow Account 52, Driver application 20,
  outbox 38 (trước 36), Mongo notice/inbox 34 (trước 32). Fixture local cũ giữ
  nguyên; test Linux dùng bản sao secret giới hạn trong thư mục ignored.
- Chưa gọi Postman GUI PASS, chưa coi healthcheck bằng mTLS + DB/broker ping là
  toàn bộ business readiness hay production deployment. Docker Desktop nút Start
  chưa kiểm chứng. Chứng chỉ workload 24h được renew theo giờ và launcher restart
  app khi đổi; broker cert 30 ngày cần broker restart bằng Compose sau renewal.
- `docker compose stop` rồi `docker compose up -d` trên bộ mới PASS: chín container
  đang chạy đều healthy, ba migration job exit 0, credential Customer/Driver/Operator
  và thông báo đã đọc vẫn dùng được. Hai outbox mới đều có `published_at`, hai inbox
  job `DONE`, hai notice có event ID khác nhau; Mongo có 0 nhóm event/recipient trùng.
  Sau restart Account 52, Customer 28, Driver application 20, Notice/Inbox 34;
  Rabbit queue chính 0 pending và DLQ 5. Runner Node host cũ không còn process.
  Lệnh OTP dev một-off qua Compose đã trả mã sáu chữ số (không in giá trị trong
  báo cáo). Full Vitest Linux cuối 55/55, built-context 4/4, typecheck host và
  Linux image build PASS. Cả ba migration job sau restart báo `No pending migrations
  to apply`. Image không chứa `.secrets` và có đủ ba Prisma client Linux đã build.
  Không chạy lại contract validator vì không sửa input
  hợp đồng/policy/protobuf.


## Mốc 2026-10-05 — Driver review Notification dev

Đã thêm notification-service (MongoDB riêng), Driver outbox publisher RabbitMQ AMQPS, Gateway facade GET/PATCH `/v1/notifications`, protobuf/policy riêng, Compose overlay và collection Postman. Driver review/outbox cùng transaction cũ; migration mới chỉ thêm cột claim/retry/published và grant cho runtime role. Broker dùng confirm+mandatory, consumer ACK sau inbox Mongo bền vững; unique `(eventId,recipientAccountId,channel)` giữ một thông báo khi replay. Invalid event được lưu mã hóa trong quarantine và phát tới DLQ; lần đầu kiểm tra phát hiện BSON Binary khác Buffer, đã sửa rồi chạy lại PASS. Không có SMS/email/push.

Project CAB dev hiện có PostgreSQL trên 55439; RabbitMQ 56791 và MongoDB 55440 được tạo thêm trong cùng project với volume riêng. Các container `cab-bootstrap-test-*` không bị thao tác. Bằng chứng hiện tại: `dev:notification:up` healthy; `dev:migrate` áp Driver migration V4; `dev:start:notification` báo đủ năm app ready trên 33201/50261–50264; review approval/rejection + notification-smoke (own/read/replay/cross-owner/pagination/auth) PASS; duplicate event, malformed quarantine/DLQ PASS; competing review chỉ một outbox event PASS. `build`, `typecheck`, validator hợp đồng PASS ở các mốc chạy tương ứng; cần ghi kết quả full suite cuối lượt bên dưới. Postman GUI và review độc lập chưa chạy.

Kiểm tra cuối lượt: `npm.cmd run build`, `npm.cmd run typecheck`, `npm.cmd run test` (10 file/55 test, gồm fixture event opaque ID), `npm.cmd run test:built` (bốn context cũ), validator Docker read-only (11 proto/34 nội bộ/18 facade, 463 assertion facade) PASS. `node dev/smoke.mjs` năm endpoint Customer, Driver review/rejection, Notification approved/rejected, replay/DLQ, race outbox và auth negative đều PASS trên HTTP/mTLS/PostgreSQL/RabbitMQ/MongoDB thật. Một lượt Notification smoke mới đầu tiên gặp GET 503 nhất thời khi đọc tài khoản khác; truy vấn sau đó và lượt tạo hồ sơ mới đạt 200. Chưa xác định nguyên nhân riêng của 503; không suy đây là PASS ổn định tuyệt đối. Vitest chạy ngoài sandbox vì SWC cache bị sandbox từ chối SID/DACL, không thay quyền hệ thống.

Fault injection trên project `cab-notification-harness-*` riêng PASS: broker stop trước review → review 200, đúng một outbox event chưa publish; broker restart → publisher confirm và một Notification. Mongo stop trước reject → review 200 và outbox đã publish vào RabbitMQ; consumer/app group restart sau Mongo hồi phục → một Notification, đúng chủ, không nhân đôi. Harness dùng cổng/volume riêng, hai container đã stop nhưng giữ volume; broker/Mongo/PG dev và `cab-bootstrap-test-*` không bị stop. Chưa chứng minh backup/restore, deployment production, exactly-once hay đầy đủ bảo mật transport. Metadata 8 KiB và rate limiter phân tán vẫn ở backlog. Các phần Booking/Trip/Payment/Rating chưa triển khai.

Cập nhật ngày 2026-10-03 (Asia/Saigon). Customer demo đủ năm endpoint và Driver
demo profile/vehicle/GPS tối thiểu/availability đã PASS qua HTTP Gateway → gRPC
mTLS → PostgreSQL dev thật; xem các mốc cuối tài liệu. Prisma được chọn có điều
kiện cho Identity/Customer và được dùng trong Driver slice. Metadata 8 KiB có
regression riêng; các giới hạn production vẫn được ghi rõ ở phần cuối.

## Repository và local

- Git root là `23722251_NguyenDaiLong_CabSystems/` trong workspace `Cab_sys/`; workspace ngoài không phải Git root.
- Branch hiện tại: `feat/customer-foundation`, tạo an toàn bằng `git switch -c feat/customer-foundation origin/main`.
- Commit nền/HEAD: `c5314ece78506047c85e9aeb4e836d2dc9453f84` — merge PR #2 về contracts 1.3.
- Đã `git fetch origin` thành công ngoài sandbox sau lỗi kết nối trong sandbox; origin/main đã cập nhật trước tạo nhánh.
- Nhánh feat chưa tồn tại khi kiểm tra; origin/main không tracked ba file hướng dẫn nên chuyển nhánh không ghi đè chúng.
  Giữ nguyên ba file local từ nhánh trước `docs/internal-contracts-v1.3-fix`/`8eb9700`, sau đó sửa trong phạm vi được giao.
- Bằng chứng: `git rev-parse --show-toplevel`, `git branch --show-current`, `git log -1`, `git status --short`.
  Trước nhiệm vụ facade chỉ có ba file hướng dẫn untracked. Đầu phiên scaffold đã có một file tracked sửa
  (validate.py) và chín file untracked từ phiên facade; bảo toàn các thay đổi đó. Phiên scaffold không fetch/switch nhánh.
- AGENTS.md root được tạo ở lần thiết lập trước; lúc đó không thấy hướng dẫn áp dụng ở thư mục cha.
- Inventory qua `rg --files --hidden` (loại `.git` và artifact nhị phân): SRS, thiết kế, tám OpenAPI YAML,
  contracts/proto/events/policy và Python validator. Đây là inventory trước scaffold.
  Hiện có ba workspace ứng dụng và một workspace thư viện infrastructure grpc-transport,
  source/config/test và lockfile; hiện thêm Compose, Prisma schema/client/migration **probe thử nghiệm**,
  chưa có ORM/schema/migration nghiệp vụ.
- Workbook hiện diện: `CAB_Test_Cases_ver_1.3.xlsx`; chưa đọc vì nhiệm vụ này không cần phân tích ca kiểm thử.
  Không đọc bản v1 hoặc thay Execution Status.

## Môi trường và bằng chứng

| Hạng mục | Kết quả quan sát | Lệnh/bằng chứng và giới hạn |
|---|---|---|
| OS/shell thực tế | Windows, Windows PowerShell Desktop 5.1.26100.9444 | `$PSVersionTable`, RuntimeInformation.OSDescription: Windows 10.0.26200; đây là version hệ thống, không suy edition marketing |
| WSL | Có distro `docker-desktop` | `wsl --list --quiet` thành công khi khảo sát ngoài sandbox; không xác nhận distro dev Linux riêng |
| Git | 2.55.0.windows.5 | `git --version` và các lệnh metadata repository |
| Node.js | v24.19.0 | `node --version`; build/typecheck/test scaffold đạt với dependencies đã pin |
| npm | 11.17.0 qua npm.cmd | `npm.cmd --version`; `npm --version` bị ExecutionPolicy chặn npm.ps1. Không đổi policy |
| Docker Desktop | Đã cài và đang chạy | `Get-Process` thấy Docker Desktop, com.docker.backend/build; chỉ kiểm tra process, không khởi động ứng dụng |
| Docker CLI | 29.8.0, build 88096ef | Chạy executable từ thư mục cài đặt sau khảo sát chỉ đọc ngoài sandbox; `docker` chưa có trong PATH phiên mặc định |
| Docker Compose | v5.5.1 | Executable Docker với `compose version`; hiện có Compose PostgreSQL probe profile test riêng |
| Docker Engine | 29.8.0, phản hồi được | Docker `info --format '{{.ServerVersion}}'`; không in info/config chứa credentials, không start container |
| VS Code | 1.140.0, x64; process Code đang chạy | `code.cmd --version`; có log phụ crashpad Access denied trong sandbox, lệnh vẫn trả version |
| Postman | Chưa xác minh cài đặt/khả năng chạy | Không thấy process Postman ở thời điểm khảo sát; việc này không chứng minh chưa cài |
| Python/protoc validator | Chạy được trong container checker tạm | Host chưa resolve Python trong PATH; container Python 3.13.7 cài đúng requirements vào tmpfs rồi chạy validator; không cài toàn máy |
| Framework/test runner | NestJS 12.1.2, TypeScript 6.0.3, Vitest 5.0.3, Supertest 7.3.0, ESM | Đã chọn cho scaffold; npm workspaces và package-lock.json; SWC 1.16.13/unplugin-swc 2.0.0 emit metadata |
| ORM/DB schema/migration | Prisma 7.10.0, PG 17.11 probe; 14/14 PASS | Schema/client/migration thử nghiệm riêng Identity/Customer; chưa chọn ORM toàn hệ thống hoặc tạo schema nghiệp vụ; không mở broker |

Docker/WSL đọc trong sandbox ban đầu bị hạn chế; khảo sát ngoài sandbox được phép đã xác minh CLI/Engine/Compose.
Phiên dev sau cần bảo đảm terminal resolve Docker CLI (hoặc dùng đường dẫn cài đặt cục bộ), dùng `npm.cmd` trên shell hiện tại.
Không lưu đường dẫn cài đặt cá nhân/credential vào tài liệu này.

## Nguồn và kiểm tra

- Khảo sát SRS/thiết kế, tám YAML (ownership, REST paths/security/schema, tiến trình), README/RPC/SECURITY/EVENTS,
  bảy proto, policy, hai event schema/topology/23 fixture và `contracts/tools/validate.py`/requirements/VALIDATION.
- Lần thiết lập trước: Node.js kiểm tra tĩnh giới hạn, JSON parse được policy và 26 file trong events (hai schema, topology, 23 fixture).
  Scan tên RPC trong bảy proto khớp chính xác 34 method của policy, `default=deny`.
- Scan văn bản YAML: 75 operation trong `paths`; 1 summary report ngoài MVP → 74 operation MVP.
  Tổng 80 occurrence `operationId` tính cả extension nội bộ; không coi các extension là route public.
- Nhiệm vụ facade chỉ đọc lại AGENTS/status/plan, API01 và Identity/Customer/security/RPC/validator liên quan;
  không đọc lại workbook/toàn bộ repository. API01 là baseline REST được chủ dự án chỉ định cho facade này.
- Kết quả phiên facade trước: **PASS** `python contracts/tools/validate.py`, exit code 0:
  8 proto compile; coverage chính xác 34 RPC nội bộ + 5 facade bằng hai policy tách biệt;
  358 kiểm tra facade (route/schema/security/status/error mapping, typed presence/enums, protobuf wire roundtrip,
  negative DTO/header/policy và fail-closed service auth/timeout); hai schema, 23 fixture, 21 negative event checks,
  parity API06 và parse đủ tám YAML giữ nguyên assertion cũ.
- Chạy bằng container Python 3.13.7-slim-bookworm, image digest
  `sha256:adafcc17694d715c905b4c7bebd96907a1fd5cf183395f0ebc4d3428bd22d92d`.
  Chỉ bind contracts/API-Document read-only; root filesystem read-only, cap-drop ALL, no-new-privileges,
  tmpfs /tmp, không Docker socket/credential/volume. Pip cài trong tmpfs đúng pin requirements, không đổi phiên bản.
- Lỗi thử đầu: native rpds không map được shared object trên tmpfs; thêm `exec` cho tmpfs nạp .so rồi validator đạt.
  Một lần gọi kiểm tra bị gián đoạn, không nhận là kết quả; đã thu lại stdout/exit code cuối đầy đủ.
- Runner tham khảo: `contracts/tools/validate-in-docker.ps1` (nhận DockerExecutable nếu CLI ngoài PATH).
  Phiên facade trước chạy lệnh Docker tương đương trực tiếp, không đổi ExecutionPolicy hoặc ép chạy script bị policy chặn.
  Dùng Python sẵn có với requirements phù hợp hoặc runner ở shell cho phép script để tái hiện;
  runner không cài backend, dependency checker cần network nếu chưa có trong container tạm.
- `contracts/VALIDATION.md` vẫn là bằng chứng lịch sử riêng. Chưa chạy OpenAPI semantic validator,
  runtime business, mTLS/ACL deployment, DB isolation, integration/concurrency/chaos, provider hay metrics test.
  Static witness không chứng minh side effect/authorization/transaction thật.
- Kiểm tra cuối: diff với origin/main xác nhận REST/SRS/thiết kế/34 proto nội bộ/policy/events/requirements không đổi;
  whitespace sạch; PowerShell runner parse hợp lệ; UTF-8/link nội bộ đạt, AGENTS dưới 150 dòng,
  status không có đường dẫn ổ đĩa cá nhân tuyệt đối. Working tree: 1 file tracked sửa (validate.py), 9 file untracked,
  gồm ba file hướng dẫn bảo toàn từ phiên trước; chưa stage/commit.

## Đã chốt và còn mở

Đã chốt theo yêu cầu chủ dự án/thiết kế: Node.js, tám MS + Gateway riêng, DDD, PostgreSQL database/credential riêng,
REST ngoài/gRPC đồng bộ/RabbitMQ event, Redis hỗ trợ, role CUSTOMER/DRIVER/OPERATOR và ownership hiện có.
contracts chốt mTLS/SAN/allowlist, receipt 2 giây (D07), Saga/fencing (D06), event/ACL/version (D09),
baseline giữ bằng chứng nội bộ suốt MVP (một phần D08). Đây là quyết định thiết kế, chưa kiểm chứng runtime.

Facade cho đúng năm endpoint đã đặc tả trong package `cab.gateway.v1`, allowlist chỉ `api-gateway` qua mTLS,
policy default deny riêng; user token/recovery token tách service identity. Không thay 34 RPC/policy nội bộ.
Chủ dự án cho phép dùng API01 hiện có làm baseline facade trong nhiệm vụ này, không phải tự phê duyệt toàn bộ API/stack.

Chủ dự án đã chọn Node.js + TypeScript + NestJS, npm workspaces và Vitest/Supertest cho scaffold.
Phiên bản pin và ESM là lựa chọn kỹ thuật scaffold đã kiểm tra, không quyết định ORM hoặc production deployment.
Chưa chốt: ORM/migration; facade cho các endpoint ngoài slice,
HTTP/errorCode của operationId lookup sai validation; OTP D01, payment D02, metrics D03, thông số/giao diện D10,
PII/provider retention/backup/rotate key thuộc D08. Kế hoạch nêu lý do đề xuất, không biến chúng thành yêu cầu bắt buộc.

## Điểm chưa đồng bộ cần quyết định trước phần phụ thuộc

| Vị trí nguồn | Khác biệt/gap và ảnh hưởng | Xử lý đề xuất, chưa tự sửa |
|---|---|---|
| SRS FR28/UC22/AC21; thiết kế §6.9; API01 ghi bản xem trước | Lịch sử nguồn chưa đồng bộ về duyệt 202/operation | Nhiệm vụ hiện tại đã chỉ định baseline API01 cho facade; giữ 201/202/recovery như REST, không tự coi mọi D05/endpoint đã hoàn tất |
| API01 register dòng 183–187; contracts/RPC §Lưu giữ | Public replay/lookup thêm 7 ngày sau terminal, internal evidence suốt MVP; status sau expiry đã có: POST đúng bằng chứng 409 IDEMPOTENCY_KEY_EXPIRED, GET404 | Đã tách rõ trong mapping; không purge saga/receipt/tombstone khi hết public lookup. D08 cleanup sau MVP/PII còn mở |
| API01 lookup path operationId 1–128, responses chỉ 200/401/404/429/503/default | Chưa quy định rõ HTTP/errorCode khi path ID sai validation; không có 400 | Đã hỏi chủ dự án, chưa có quyết định ghi nhận; facade đặc tả input hợp lệ, không tự gán 400/404 cho malformed path; chốt trước handler validation tương ứng |
| API05 §Quy tắc tính cước dòng 47–49; contracts/RPC §Pricing/Fare; trip.proto FareContext | API05 nhắc lấy snapshot Booking theo bookingId; contracts trả pricing snapshot bất biến trong Trip.GetFareContext, không có RPC Payment→Booking lấy giá | Xác nhận đường dữ liệu giá trước Fare; không tự thêm RPC/đọc chéo DB hay dùng giá hiện hành |
| Thiết kế §15/§16/§17, SRS quyết định mở, ghi chú D04/D07/D09 trong YAML; thiết kế §18 và contracts | Một số đoạn cũ vẫn nói hợp đồng nội bộ chưa chốt; §18/contracts đã bổ sung quyết định. Facade và kiểm chứng runtime vẫn thiếu | Đọc bổ sung §18 khi xác định trạng thái, ghi phần nào đã đặc tả/phần nào chưa; không dùng lịch sử để phủ nhận contracts hiện có |
| SRS §4.5/B10 và API cấu hình; contracts/RPC ReserveDriver dùng GPS <=30s | SRS coi ngưỡng là đề xuất; hợp đồng RPC ghi cụ thể 30s. Ảnh hưởng eligibility/concurrency test khi triển khai dispatch | Xác nhận baseline thông số trước phần Driver/Booking, không âm thầm thay ngưỡng contracts |

Giữ nguyên SRS/thiết kế/OpenAPI, bảy proto và policy nội bộ, event schema/fixture/topology/requirements.
Phiên facade chỉ thêm facade riêng và mở rộng validator để tách policy; không ghi gap thành nghiệp vụ mới.

## File thay đổi và bước tiếp theo

- Cập nhật ba file hướng dẫn; AGENTS chuyển trạng thái nhất thời sang status và làm rõ quyền trong nhiệm vụ.
- Thêm `contracts/proto/cab/gateway/v1/customer_facade.proto`, `gateway-customer-policy.json`,
  `gateway-customer-mapping.json`, `GATEWAY-CUSTOMER.md`, `tools/validate_facade.py`, `tools/validate-in-docker.ps1`;
  sửa `contracts/tools/validate.py` để compile toàn bộ và kiểm tra policy tách biệt, giữ assertion event hiện có.
- Phiên facade trước không cài dependency backend; phiên scaffold này chỉ cài local trong repo.
  Không cài global/ORM, đổi ExecutionPolicy, start hệ thống, chạy migration,
  commit/push/reset/clean/stash hoặc xóa thay đổi local/volume. Container checker --rm chỉ loại container tạm không volume.
- Đã scaffold đúng services/api-gateway, services/identity-service và services/customer-service:
  main/module/config riêng, domain/application/infrastructure/interfaces, không business model/repository giả.
  Ở phiên scaffold Gateway HTTP chưa có năm handler; Identity/Customer entry chỉ context, gRPC listener đóng,
  config tham chiếu contracts/proto/cab/gateway/v1/customer_facade.proto gốc, không copy.
- Thêm manifests/lockfile, tsconfig base/build/test, vitest.config.ts, test/setup.ts,
  test/built-context.mjs, .gitignore (node_modules/dist/cache/secret; không ignore contracts/lockfile).
  Chỉ sửa prose GATEWAY-CUSTOMER.md để rõ operation không tồn tại/không thuộc đăng ký Customer/hết cửa sổ tra cứu;
  không đổi OpenAPI/protobuf/policy hoặc gán mã HTTP cho operationId sai validation.
- npm.cmd install --cache .cache/npm --no-audit --no-fund: exit 0, 178 packages local.
  npm cảnh báo postinstall SWC chưa approved; native package vẫn load và tests chạy đạt, không bật script toàn bộ.
- npm.cmd run build và npm.cmd run typecheck: exit 0 cho ba app và typecheck test/config.
  npm.cmd test: exit 0, 4 file/4 test; ba context resolve config thật qua constructor metadata,
  đóng context trong finally; một HTTP smoke Supertest kiểm tra năm route chưa triển khai trả 404.
  Supertest dùng HTTP listener tạm do nó quản lý; không mở listener gRPC/DB.
- Lần chạy Vitest trong sandbox bị ERR_SWC_NATIVE_CACHE do owner/DACL (cache mặc định và thử cache repo);
  chạy cùng lệnh ngoài sandbox đạt, không giảm assertion/đổi runner/version hoặc thay ACL/ExecutionPolicy.
  Đây là giới hạn sandbox Windows hiện tại, không phải lỗi metadata/DI.
- npm.cmd run test:built: exit 0, ba output tsc boot/resolve metadata/DI/close trên Node 24.19.0.
  npm.cmd run test --workspace @cab/identity-service: exit 0, 1/1 context smoke;
  các workspace có script test tương tự và build/typecheck riêng.
- Không chạy lại contract validator trong phiên scaffold: chỉ prose hợp đồng thay đổi,
  OpenAPI/protobuf/policy/mapping/schema/fixture/validator giữ nguyên so với đầu phiên.
  Kết quả static phiên trước không được báo thành runtime integration PASS.
- Harness mTLS/caller-policy đã hoàn tất ở phiên transport, xem bằng chứng cập nhật bên dưới.
- Các phiên sau bắt đầu từ bàn giao này, xác minh git status mới, đọc phần nguồn cần cho nhiệm vụ;
  không phải đọc lại toàn lịch sử hoặc mở workbook khi chưa cần.

## Phiên transport mTLS/caller-policy

- Giữ nhánh feat/customer-foundation/HEAD c5314ece; không fetch/switch/stash/reset/clean/commit/push,
  giữ mọi thay đổi local trước phiên. Không sửa business proto, OpenAPI hoặc quyền policy.
- Thêm packages/grpc-transport (thư viện infrastructure, không thêm app thứ tư):
  grpc-js 1.14.5 (getAuthContext đã sửa xác thực peer), proto-loader 0.8.1 pin/lock local;
  các version ESM/scaffold khác giữ nguyên.
- TLS client giữ rejectUnauthorized=true, trust CA/chain/time và callback kiểm tra exact URI SAN server,
  serverAuth EKU/leaf/lifetime<=24h; không bỏ endpoint identity verification hoặc dùng hostname override.
  Server yêu cầu client cert, đọc trusted auth context, kiểm tra URI/EKU/time và policy full method trước handler.
  Namespace facade/internal chọn riêng, deny mặc định, không fallback hoặc tin caller/role/scope metadata.
- Identity/Customer main gọi bootstrapNetwork với TLS/config bắt buộc; provider Nest bind listener thật,
  app.close đóng listener. Gateway provider mTLS quản lý client và đóng channel.
  Production bootstrap đã được kiểm tra với TLS files mới tạo trong temp; không đọc secret hiện có.
  Production chỉ có default UNIMPLEMENTED, không dùng handler test.
- test/certificates.ts tạo CA/leaf bằng OpenSSL có sẵn, đúng EKU/SAN và hạn 24h, temp directory riêng;
  test/transport.spec.ts dùng gRPC server/client thật, port loopback động, counter handler + UNIMPLEMENTED.
  Fixture sai URI/CA/EKU/expiry, metadata giả, unknown method/package chỉ nằm trong harness.
  CA không cài vào trust store; private key không log/Git; cleanup temp có kiểm tra absolute path và assertion.
- Kết quả cuối: npm.cmd run build, npm.cmd run typecheck đều exit 0;
  npm.cmd test -- --reporter=verbose: 5 file, 28/28 test (24 network + 4 smoke), exit 0;
  npm.cmd run test:built: ba output tsc context/metadata/DI/close PASS, exit 0.
  Các assertion smoke cũ giữ nguyên. Vitest chạy ngoài sandbox theo giới hạn SWC ACL đã xác định,
  không đổi ACL/ExecutionPolicy/trust store hoặc pin/runner để xanh.
- Mọi ca deny assert status và handler không tăng. Production lifecycle kiểm tra TCP ECONNREFUSED,
  channel SHUTDOWN, Vitest kết thúc; temp PKI không còn sau suite.
  Ca không client cert sử dụng cùng URI verifier và assert server identity đã được kiểm tra,
  không nhầm lỗi DNS SAN của fixture là bằng chứng server yêu cầu client cert.
- Hướng dẫn chạy, expected/actual/PASS từng ca, source chính thức và ranh giới production/harness:
  [grpc-transport.md](grpc-transport.md).
- Không chạy lại static contract validator vì không đổi inputs/validator. Static PASS trước vẫn riêng.
  Chưa verify JWT/Session/Account/object authorization, REST error mapping/detail, 8KiB/correlation metadata,
  DB/ORM/business/deployment. Connection age cấu hình 8 phút + jitter/grace dưới 10 phút;
  chưa test chờ reconnect hoặc rotate/revocation/CA overlap.
- Tiếp theo: nhiệm vụ persistence/ORM/migration riêng rồi handler/user-auth/registration;
  chốt malformed operationId HTTP/errorCode trước lookup handler. Không nhận transport PASS là business PASS.

## Sửa giới hạn payload sau review độc lập — 2026-10-02

- Đọc RPC.md §Ngữ nghĩa chung và GATEWAY-CUSTOMER.md: unary receive/send tối đa 1 MiB.
  createClient/createServer trước phiên thiếu option; review chứng minh 2 MiB tới test handler.
- Cả hai factory nay cấu hình grpc.max_send_message_length và grpc.max_receive_message_length
  rõ ràng 1_048_576 byte. Không sửa contract, policy, ORM/nghiệp vụ hoặc pin/lockfile.
- Thêm test/payload.spec.ts và diagnostic proto test/fixtures/payload-probe.proto:
  đo protobuf serializer.byteLength, không số ký tự; giữ nguyên test/transport.spec.ts và smoke cũ.
  Peer test-only 4 MiB cô lập từng giới hạn client/server, vẫn mTLS/caller-policy thật.
  Fixture/codecs/echo chỉ trong harness; production không có business success giả.
- 7 regression đạt: exact 1 MiB request+response qua; client send vượt 1 byte chặn;
  server receive vượt 1 byte và 2 MiB đều code 8/handler 0; server send và client receive
  response vượt 1 byte bị từ chối; Unicode có JS length nhỏ hơn limit nhưng protobuf vượt limit bị chặn.
- Build/typecheck exit 0; full test cuối 35/35 (28 cũ + 7 mới), 6 file, exit 0;
  test:built ba context PASS. Full Vitest chạy ngoài sandbox theo giới hạn SWC ACL đã biết.
  Lần đầu 6 assertion diagnostic mới sai format/framing; đã sửa theo source grpc-js 1.14.5
  với exact message/status/size/counter, không nới giới hạn hoặc assertion cũ.
- test:transport script bao gồm hai suite mTLS/policy và payload.
  Bảng expected/actual và hướng dẫn: [grpc-transport.md](grpc-transport.md).
- Metadata tổng 8 KiB chưa được cấu hình/kiểm chứng theo contract; các phần user auth,
  HTTP mapping, issuer rotation/revocation, deployment/DB/business vẫn còn mở.
  Không nhận payload PASS thành bảo vệ đầy đủ transport; không chạy lại static validator khi inputs không đổi.
- Giữ nhánh feat/customer-foundation/HEAD c5314ece và mọi local; không commit/push/reset/clean.

## Probe Prisma/PostgreSQL thật — 2026-10-02

- Đọc AGENTS/status, source/config/DI/tests và xác nhận bốn option payload 1 MiB đang có;
  giữ nhánh/HEAD và toàn bộ thay đổi local. Không sửa contracts/OpenAPI/protobuf/policy/validator.
- Docker Engine 29.8.0 phản hồi; kiểm tra ps/volume chỉ đọc trước/sau. Các container người dùng
  thuộc cab-bootstrap-test và volume có sẵn được giữ nguyên, không dùng làm DB target.
- Pin stable Prisma CLI/client/adapter-pg 7.10.0, pg/@types/pg 8.23.1 local và lockfile;
  giữ Node 24.19.0, ESM, TS 6.0.3, Nest/Vitest/SWC đã pin. PostgreSQL 17.11-bookworm pin digest.
- Thêm experiments/prisma-postgres: Compose profile test, runner tạo project UUID, port loopback động,
  tmpfs không volume bền vững, credentials sinh riêng/ignored/redacted; cleanup đúng project/secret đã tạo.
  Hai DB cab_identity/cab_customer, migration/runtime credential riêng; PUBLIC bị thu hồi,
  runtime không superuser/CREATEDB/CREATEROLE/DDL/TEMP hoặc CONNECT DB kia.
- Mỗi service có infrastructure/prisma-probe riêng: schema, generated client ignored, factory ESM,
  SQL migration và ba bảng probe kỹ thuật. Không import Prisma vào domain, không wire probe vào app,
  không tạo Account/Customer/Session, registration/login, ORM model chung hay migration nghiệp vụ.
- 14/14 test thật (7 mỗi DB) PASS: empty migration/replay không mất seed; transaction/outbox commit/rollback;
  concurrent CAS một thắng; FOR UPDATE tham số hóa/cùng PID với pg_blocking_pids; concurrent partial unique;
  decimal exact và runtime DDL/cross-DB deny SQLSTATE 42501. Barrier/latch/catalog và timeout hữu hạn,
  không mock/sleep để suy cạnh tranh, không db push/reset.
- Phát hiện Decimal mặc định precision 20 làm mất chữ số khi arithmetic trên NUMERIC(30,12) lớn;
  factory probe dùng clone precision 40/ROUND_HALF_UP riêng, exact addition + roundtrip PASS,
  không Number hoặc thay global precision. Chính sách tiền/domain value object chưa thiết kế.
- Lệnh cuối: probe:postgres và typecheck:probe exit 0; build/typecheck exit 0;
  npm.cmd test -- --reporter=verbose 35/35, 6 file, exit 0; test:built ba built DI context PASS.
  Pin/ignore/diff check đạt; inventory sau không còn project probe, container/volume trước giữ nguyên.
  Không chạy lại contract validator vì không sửa file ảnh hưởng; không nhận static cũ là kết quả mới.
- Báo cáo version/lệnh/expected/actual, lỗi đã sửa, cách chạy và phân biệt reusable pattern với harness:
  [prisma-postgres-probe.md](prisma-postgres-probe.md).
- Kết luận Prisma phù hợp có điều kiện cho primitive đã thử; **chưa duyệt ORM toàn hệ thống**.
  Còn upgrade schema có dữ liệu/custom SQL drift, forward fix/restore/backup, tải/failover/deadlock retry,
  PG TLS/credentials production, model và lifecycle adapter production. Metadata tổng 8 KiB,
  user auth/Session/object authorization, HTTP mapping và transport deployment vẫn ở backlog.
- Tiếp theo: review/chốt Prisma/workflow riêng Identity/Customer, rồi giao adapter production và
  migration upgrade; metadata 8 KiB là nhiệm vụ transport riêng. Không commit/push/reset/clean.

## Lifecycle persistence và migration upgrade — 2026-10-02

- Chủ dự án chọn Prisma có điều kiện cho Identity/Customer; review source chưa chạy lại vì ZIP thiếu
  cấu hình/cấu trúc repo, **không** coi review độc lập xác nhận PASS. Giữ nhánh feat/customer-foundation,
  HEAD c5314ece và mọi thay đổi local; không commit/push/reset/clean/switch.
- Không đổi pin/ESM/dependency. Provider `IdentityPersistence` và `CustomerPersistence` ở infrastructure,
  singleton theo Nest module sở hữu, chấp nhận đúng URL runtime role/database, pool PrismaPg sở hữu,
  timeout rõ; `$connect` + `SELECT 1` tại init, `$disconnect` tại destroy, lỗi không lộ credential.
  **Chưa đưa vào production AppModule** vì chưa có client/schema nghiệp vụ; test-only factory dùng probe.
- Migration V1 probe giữ nguyên. Thêm V2 SQL riêng/service: cột default tương thích dữ liệu cũ,
  bảng audit probe mới có CHECK/FK/grant runtime. Runner tạo DB V1→V2 với sentinel, fresh V1+V2,
  DB disposable với migration cố ý lỗi; không sửa lịch sử V1, không db push/reset.
- PostgreSQL 17.11 thật: cả hai service PASS giữ sentinel/partial unique, quyền runtime V2,
  replay giữ ledger/dữ liệu, fresh có cấu trúc tương đương, failure CLI nonzero + failed ledger +
  transactional DDL rollback + retry bị chặn. Prisma v7 CLI lần lỗi đầu trả PostgreSQL error,
  không giả định P3018; chứng cứ là exit/ledger/DB state.
- Lifecycle Nest container thật: 6/6 PASS (mỗi service: hai lần boot/query/close và PID biến mất;
  port lỗi fail trong hạn không lộ secret; migration role bị chặn). 14/14 probe cũ tiếp tục PASS;
  `probe:postgres` tổng 20/20, exit 0, cleanup project/secret riêng PASS.
- `npm.cmd run probe:generate`, `typecheck:probe`, `build`, `typecheck`,
  `npm.cmd test -- --reporter=verbose` 35/35 và `test:built` ba context đều PASS.
  Full test trong sandbox gặp SWC native cache ACL; chạy ngoài sandbox cùng lệnh PASS.
  Không chạy lại validator hợp đồng vì input/validator không đổi. Không sửa stack bảo mật toàn máy.
- Quyết định workflow, lệnh chạy và ranh giới production/harness:
  [identity-customer-persistence.md](identity-customer-persistence.md).
  Metadata 8 KiB và các gap transport/user auth còn backlog. Tiếp theo là schema nghiệp vụ riêng
  Identity/Customer, review migration/role/index và wire provider production sau đó.

## Bổ sung bằng chứng persistence và thiết kế schema — 2026-10-02

- Giữ nhánh feat/customer-foundation/HEAD c5314ece, pin và mọi thay đổi local;
  không sửa provider, migration probe V1/V2, contracts hoặc schema nghiệp vụ thực thi.
  Review ngoài mới đọc source, chưa chạy lại độc lập; không ghi thành independent PASS.
- Lifecycle test mới dùng wrapper đếm quanh Prisma client thật: mỗi Nest context factory/connect/disconnect
  1/1/1; URL migration sai không gọi factory; port lỗi disconnect đúng một lần, error không lộ secret.
  Hai lần boot/close mỗi service giữ ba transaction/connection đồng thời bằng barrier có timeout;
  PostgreSQL `pg_stat_activity` lọc `application_name` UUID riêng cho context thấy đủ cả ba,
  sau `app.close()` không còn connection nào mang nhãn đó.
- Migration harness so fresh với upgrade cả columns/indexes, CHECK/FK, NUMERIC precision/scale và
  grant SELECT/INSERT/UPDATE/DELETE của runtime; thao tác thật xác nhận CHECK/FK và bảng V2.
  V1/V2 SQL không sửa. Ca failed migration vẫn nonzero/ledger failed/retry blocked;
  rollback chỉ chứng minh cho SQL thử nghiệm có `BEGIN/COMMIT` tường minh.
- `npm.cmd run probe:postgres` exit 0, 20/20 PostgreSQL tests PASS, migration path hai service PASS,
  cleanup project thử nghiệm PASS. `npm.cmd run build`, `typecheck`, `typecheck:probe`,
  `npm.cmd test -- --reporter=verbose` 35/35, `test:built` ba context: PASS.
  Full suite chạy ngoài sandbox do giới hạn SWC ACL đã xác định; không đổi quyền/dependency.
- [identity-customer-schema-design.md](identity-customer-schema-design.md) đề xuất Account, Session,
  RegistrationOperation/step, Identity outbox/audit, Customer/provision/receipt/audit, transaction,
  idempotency, retention và ranh giới DB/application với nguồn cho từng quyết định.
  Còn chốt ID public, snapshot replay/PII D08, state nội bộ, predicate unique tombstone,
  key rotation/Session retention và operationId path sai validation trước migration nghiệp vụ.
- Chưa wire provider production, chưa tạo Prisma model/migration Account/Customer hoặc handler.
  Metadata gRPC tổng 8 KiB và các gap transport vẫn ở backlog. Không commit/push/reset/clean.
## 2026-10-02 — đặc tả schema Identity/Customer cho review migration

Đã làm rõ [thiết kế schema](identity-customer-schema-design.md) trên cơ sở RPC/API01/proto:
Customer receipt lưu bốn field `CustomerProvision` bất biến và replay lịch sử, tách `GetCustomerProvision`
đọc hiện trạng; unique operation/account/profile vô điều kiện và tombstone giữ suốt MVP. Bổ sung
ma trận Cancel/Provision muộn, HMAC key rotation (MVP giữ lookup key ổn định), snapshot 201 mã hóa,
internal phase/step với CAS và phục hồi restart. Phân biệt yêu cầu hợp đồng, lựa chọn kỹ thuật và
quyết định còn mở. Chưa tạo Prisma model/SQL migration nghiệp vụ, chưa wire AppModule, chưa triển
khai registration/login.

Các quyết định chủ dự án còn cần: biểu diễn public Account/Customer ID, reuse contact sau FAILED
với operation/ID mới, D08 retention/erasure PII và Session production; nếu yêu cầu Customer tự xác
nhận Identity finality thì cần review giao thức. HTTP/errorCode của operationId sai validation thuộc
handler sau. Metadata gRPC 8 KiB và các gap transport vẫn ở backlog.

Phiên này chỉ sửa tài liệu: **không chạy** build/typecheck/test/probe/full suite; kết quả lịch sử
20/20 probe, 35/35 full và built contexts trong status cũ không phải lần kiểm tra mới. Review ngoài
mới đọc source/assertion, chưa chạy lại test độc lập. Không commit/push.

## 2026-10-02 — production persistence V1 đã kiểm chứng trên PostgreSQL thử nghiệm

Chủ dự án đã duyệt MVP local: UUID Account/Customer server cấp (REST giữ opaque), contact reuse
chỉ sau FAILED/bù xác nhận với ID mới, Session absolute 7 ngày, key riêng/ổn định chưa rotation,
Identity CAS + Customer local fence, finalize worker được giải mã trong bộ nhớ để tạo snapshot mã hóa.
D08 PII production vẫn mở; không tự purge. [Thiết kế schema](identity-customer-schema-design.md)
và [hướng dẫn persistence](identity-customer-persistence.md) đã đồng bộ.

Đã thêm schema/client factory/SQL migration V1 **riêng** Identity và Customer. Identity dùng
`contact_claim` partial unique active, release trong transaction FAILED bằng helper persistence;
Account lịch sử giữ evidence nhưng login lookup chỉ qua claim active + SUCCEEDED/READY/ACTIVE.
Customer giữ UNIQUE operation/account/profile cả tombstone, receipt snapshot bốn field. Runtime
grant DML từng DB, không cấp quyền ledger/DDL. AppModule production nay đăng ký provider một lần;
boot đòi runtime DB, query khi init và đóng pool khi shutdown. Smoke/test:built dùng CoreModule
không DB rõ ràng, network harness vẫn dùng transport provider production; không giả production boot.

Lần chạy hiện tại: `db:generate` PASS hai client; `build`, `typecheck`, `typecheck:db` PASS;
full Vitest 35/35 PASS và `test:built` ba context PASS (CoreModule hai service). Vitest phải chạy
ngoài sandbox vì SWC native cache ACL, cùng lệnh/runner/assertion. Lần đầu `db:verify` bị
`spawnSync docker ENOENT` trong sandbox; tìm được Docker CLI ngoài sandbox, chạy lại trên project
UUID riêng: V1 hai DB fresh deploy PASS, 10/10 PostgreSQL tests PASS, deploy replay không áp lại,
ledger/data giữ nguyên, cleanup project PASS. Assertion có contact INACTIVE/SUSPENDED vẫn giữ
claim, Account FAILED không tạo Session, unique cạnh tranh, rollback release, Customer receipt
lịch sử/tombstone, CAS finalize/bù và production AppModule boot/query/close có quan sát connection.
Review độc lập trước đây vẫn chỉ đọc source,
chưa chạy lại. Không commit/push/reset/clean/stash/đổi nhánh.

Tiếp theo: review SQL/schema V1 và rollout role, rồi giao crypto + coordinator/network recovery + handler.
Register/login qua Postman vẫn chưa hoàn thành. Metadata 8 KiB và operationId validation HTTP gap
vẫn ở backlog.

## 2026-10-02 — forward V2 và regression persistence

Giữ nguyên migration production V1 và probe. Identity V2 sửa hai CHECK `NULL`, chặn claim chèn sẵn `released_at`, bất biến claim/Session và giới hạn UPDATE theo cột; Customer V2 giữ receipt/audit append-only, chặn xóa/đảo tombstone và sửa binding. Runtime role vẫn không có DDL/ledger/cross-DB. [Ma trận quyền và lệnh](identity-customer-persistence.md) ghi chi tiết. Helper Identity phân biệt lookup chủ claim hiện tại trước xác minh password và eligibility sau xác minh; compensation helper ghi rõ caller phải xác thực chứng cứ và query outcome nếu gọi lại sau commit.

Đã chạy `npm.cmd run db:generate`, `npm.cmd run build`, `npm.cmd run typecheck`, `npm.cmd run typecheck:db`: PASS. `npm.cmd run db:verify` trên PostgreSQL 17.11/project UUID riêng: fresh V1+V2, V1 có sentinel→V2, so constraint/trigger/grant/ledger, replay và dữ liệu V1 vi phạm bị chặn rõ bằng P3018/P0001: PASS; 14/14 integration PASS, project/container/network riêng đã cleanup. `npm.cmd test -- --reporter=verbose`: 35/35 PASS; `npm.cmd run test:built`: ba context PASS. Ca rollback gọi adapter `persistConfirmedCompensation` thật; các ca Customer vẫn là SQL/Prisma trực tiếp, chưa có adapter nghiệp vụ Customer. Review ngoài chưa chạy lại độc lập. Chưa coi HTTP/JWT/crypto/coordinator là PASS. Metadata gRPC 8 KiB, D08 retention và operationId validation HTTP vẫn ở backlog.
## 2026-10-03 — Customer demo implementation in progress

Branch `feat/customer-foundation`, base HEAD `c5314ec`; local changes preserved, no
commit/push/reset/clean/branch change. The owner chose malformed lookup operationId
→ HTTP 404 `REGISTRATION_NOT_FOUND`; `contracts/GATEWAY-CUSTOMER.md` now records it.
Independent review has read source only; it has not rerun these tests.

Production source now has separate Identity/Customer persistence clients, encrypted
contact/snapshot, purpose-separated digests, Argon2id, signed access tokens,
Session validation, registration CAS/recovery/outbox, Customer Provision/Cancel
receipt/tombstone adapter, and five Gateway route handlers. The dev Compose project
uses a persistent PostgreSQL volume and distinct runtime/migration roles, plus
locally generated ignored keys and mTLS certificates. `dev/README.md` and Postman
placeholder collection/environment give the run sequence. Outbox is durable but
has no publisher. Rate limiting is single Gateway process memory.

Identity forward V3 guards Session after revocation; V1/V2 are unchanged. `db:verify`
ran on disposable real PostgreSQL: 14/14 PASS including fresh/upgrade V1→V2→V3,
trigger/function/column grants and two distinct invalid V1 fixtures. `npm.cmd run
build`, `typecheck`, `typecheck:db`, `test:built` PASS. `npm.cmd test -- --reporter=dot`
inside workspace sandbox was BLOCKED by SWC native cache ownership; the identical
command outside sandbox PASS 39/39. Real dev HTTP/mTLS/DB scripts passed for
replay/conflict/password/revoke/account lock, simultaneous contact registration,
Customer receipt/tombstone/Cancel-before-Provision, invalid token and other-object
denial, Customer outage→durable202→restart recovery and persistence after dev DB
stop/start. These scripts are not a Postman GUI run.

**Full five-endpoint demo is not yet PASS.** `GetCustomer` correctly fails closed
with 503 because `GetAccountContact` internal response lacks `account_status`,
`created_at`, and `updated_at`, required by API01 `CustomerProfile`. A specific
additive contract decision was requested from the owner; no proto/policy change
was made while awaiting it. `dev/smoke.mjs` reached this 503 after register/login/me.
The latest run exited nonzero at `503 !== 200`; it also emitted a Node async
handle assertion during process shutdown, which has not been reproduced or
diagnosed separately. The app processes and only this dev project's PostgreSQL
container were stopped after testing; its volume and ignored secret files remain.
Do not present that as a complete user flow. Local Python command was unavailable;
the pinned Docker checker ran instead and PASS: 8 protobuf files compiled,
34 internal + 5 facade RPC policy coverage, 358 facade static checks and existing
schema/fixture checks. The protobuf source has not changed in this turn so far.

Still open: D08 production PII retention, durable/distributed rate limiting,
RabbitMQ outbox publisher, refresh/logout, key rotation, broader caller/error
hardening and production rollout. The 8 KiB metadata limit now has a network
regression, but it alone does not prove complete transport protection.

## 2026-10-03 — AccountContact và đủ năm endpoint

Chủ dự án trả lời trực tiếp trong phiên: “Đồng ý bổ sung account_status,
created_at và updated_at vào response AccountContact của RPC nội bộ
GetAccountContact”. Field 1–6 giữ nguyên; field 7 là enum có presence,
8–9 là Timestamp từ Account của Identity. Không thêm RPC/quyền/caller.
Identity trả dữ liệu Account thật sau kiểm tra principal/purpose, Customer
kiểm tra đủ field/giá trị trước khi map CustomerProfile; INACTIVE/SUSPENDED
được giữ nguyên cho target mà OPERATOR có quyền đọc. Fixture/regression mới
kiểm tra protobuf roundtrip, thiếu/sai status/timestamp và wrong account.

Quyết định `operationId` sai validation →404 có nguồn **trực tiếp** từ message
`send_user_message_question_reply` của chủ dự án trước turn này: câu hỏi nêu
API01 chưa quy định và đề xuất `404 REGISTRATION_NOT_FOUND`; câu trả lời là
`404 REGISTRATION_NOT_FOUND (đề xuất)`. Đây không chỉ là lời kể trong báo cáo cũ.

Lần chạy này: `db:generate`, build, typecheck, typecheck:db, test:built PASS;
full Vitest 49/49 PASS; contract validator trong container read-only PASS
(8 protobuf, 34 internal + 5 facade policy, 365 facade checks). Project dev/volume
cũ được `dev:up` lại, `dev:migrate` cho cả hai DB báo no pending migrations;
không chạy `dev:setup`, không reset dữ liệu/secret. `node dev/smoke.mjs` PASS
**cả năm route** (register, lookup, login, me, Customer) qua HTTP/mTLS/DB thật;
script tra operationId của dữ liệu synthetic từ DB chỉ khi register trả 201 để
bảo đảm route lookup cũng được gọi. Mapping status và hai timestamp Customer
khớp Account Identity. `profile-negative.mjs`, `scenarios.mjs`,
`customer-scenarios.mjs` PASS trên network/DB thật, gồm token sai và Customer
đọc object khác bị chặn. Chưa chạy Postman GUI và review ngoài chưa rerun độc lập.
Sau kiểm thử đã dừng ba app và chỉ container PostgreSQL của project dev này;
volume/secret cũ còn nguyên. Smoke cuối ghi Register 201, Lookup 200,
Login 200, Me 200, Customer 200.

## 2026-10-03 — Driver demo cơ bản

Giữ branch `feat/customer-foundation`, HEAD nền `c5314ec`, toàn bộ local changes;
không commit/push/reset/clean. Chủ dự án cho phép GPS tối thiểu qua API04 để
thỏa điều kiện GPS ≤30 giây của API07 trước khi chuyển AVAILABLE. Driver mới có
database `cab_driver` và migration/runtime role riêng trên cùng PostgreSQL dev
server/volume; V1 Driver và V2 grant khóa hàng đã deploy. Identity sở hữu Account
DRIVER/Session; Driver sở hữu profile/vehicle/location/availability. Seed opt-in
theo từng service, chạy lại an toàn và không dùng transaction xuyên database.

Gateway có ba route `GET /v1/drivers/me`, `PUT /v1/drivers/me/location`,
`PUT /v1/drivers/me/availability` qua ba RPC `cab.gateway.v1.DriverFacadeService`
và policy facade exact-method. 34 RPC/policy nội bộ không mở quyền Gateway.
Driver kiểm tra user qua Identity và binding account/profile; availability có
expectedVersion, idempotency receipt, khóa hàng, GPS freshness và trạng thái
bền vững. Không có endpoint ID của tài xế khác trong slice. Không có
Booking/Trip/reservation, dispatch, worker GPS hay kiểm chứng no-active-Trip;
chưa thể coi AVAILABLE là đủ an toàn cho dispatch production.

`db:generate`, `build`, `typecheck`, `typecheck:db`, `test:built` PASS (4 Nest
context). Full Vitest 49/49 PASS **ngoài sandbox**; trong sandbox SWC native cache
bị DACL/owner chặn, không phải test assertion fail. Validator Docker pin/read-only
PASS: 9 proto compile, 34 internal + 8 facade RPC exact policy, 411 facade
checks, event fixtures và OpenAPI parse. Sandbox không thấy Docker CLI nên
validator chạy ngoài sandbox, không đổi ExecutionPolicy/quyền toàn máy.

PostgreSQL/mTLS/HTTP trên bộ cổng loopback riêng 50161–50163/33101: seed lần đầu
và rerun PASS; `driver-smoke.mjs prepare` PASS login/Account/profile/vehicle/GPS/
AVAILABLE/replay/token negatives; sau restart bốn app, `check` PASS trạng thái
AVAILABLE còn lưu, OFFLINE/replay/no-op. `driver-auth-negative.mjs` PASS Customer
bị 403 ở ba route Driver; `driver-db-isolation.mjs` PASS own DB DML, DDL/cross-DB
deny. `driver-boundary.mjs` PASS GPS cũ bị 409 không mutation, key trùng/payload
khác bị 409 và trả về OFFLINE. `dev/smoke.mjs` PASS năm route Customer
(201/200/200/200/200). Một lần
Customer registration trước khi sửa race đã FAILED khi hai Identity coordinator
chạy cùng dev DB; Customer receipt reread và Identity outcome query đã sửa, sau
đó smoke đạt. Chưa chạy Postman GUI. Bộ app thử nghiệm cổng 50161–50163/33101
đã dừng sau test. Listener cũ cổng mặc định 50061/50062/33001 và PostgreSQL
dev 55439 vẫn đang chạy khi bàn giao; không dừng app cũ hay xóa volume/secret.

Hướng dẫn khởi động/seed, Postman và giới hạn ở `dev/README.md`. Backlog cũ còn:
metadata/transport hardening ngoài regression 8 KiB, D08 retention, outbox
publisher, key rotation, rate limit phân tán, triển khai production.

## Driver registration/OPERATOR review demo — 2026-10-03

Đã mở rộng Identity/Driver/Gateway sẵn có cho OTP dev → proof một lần gắn phone/purpose → Identity điều phối đăng ký Driver → hồ sơ Driver `SUBMITTED`/`PENDING_APPROVAL` → OPERATOR list/detail/review → Driver xem kết quả. Không tạo service/auth flow song song. Thêm migration Identity `202610030002_driver_registration` và Driver `202610030003_driver_applications`; **cả hai đã áp dụng**, không sửa lại. Schema Customer migration cũ giữ nguyên; Driver seed cũ vẫn APPROVED. Identity Account/Session và Driver profile/application tách DB. Driver approval vẫn OFFLINE; cần GPS ≤30 giây và thao tác AVAILABLE riêng.

Bằng chứng lượt này: `db:generate`, `build`, `typecheck`, `typecheck:db`, `test:built` PASS; Vitest **49/49** PASS ngoài sandbox do cache SWC native DACL. Validator Docker pin/read-only PASS **10 proto**, **34 internal + 16 facade RPC** policy tách biệt, **450** static facade checks, schema/fixture/OpenAPI. HTTP trên Gateway 33201 → gRPC mTLS 50261–50263 → PostgreSQL dev 55439: OTP sai/đúng/reuse, hồ sơ pending/replay/key conflict, approved/rejected/race/version, DRIVER/CUSTOMER deny Admin, pending/rejected deny AVAILABLE, approved GPS→AVAILABLE→OFFLINE, restart persistence, Driver outage trả 202 rồi recovery SUCCEEDED/replay 201 đều PASS ở các script `dev/driver-registration-smoke.mjs`, `driver-otp-negative.mjs`, `driver-auth-negative.mjs`, `driver-registration-recovery.mjs`. `dev/smoke.mjs` Customer 5 route và `dev/driver-smoke.mjs` Driver cũ PASS. Sau build cuối, `driver-registration-smoke.mjs check` và `prepare` PASS, `driver-contact-regression.mjs` PASS 409 CONTACT_CONFLICT khi Customer dùng phone Driver. Những fixture synthetic lần đầu lỗi trong quá trình sửa vẫn được giữ, không reset dữ liệu.

Postman chỉ cung cấp collection và hướng dẫn; **chưa chạy GUI**. [Bảng 30 mục](grading-tracker.md) ghi trạng thái/bằng chứng/khoảng trống theo phiếu chấm. Nguồn chạy lại [dev README](../../dev/README.md). Lần chạy lại script Driver cũ: `check` đầu tiên gặp fixture đã OFFLINE từ lần trước (kỳ vọng AVAILABLE nên fail); `prepare` đầu tiên gặp GPS 400 chưa xác định nguyên nhân, lặp lại `prepare` rồi `check` PASS. Lần `check` cuối này **không có restart giữa hai lệnh**, nên chỉ lần restart thực hiện trước đó là bằng chứng restart. Nhóm app thử nghiệm mới đang chạy tại 50261–50263/33201 lúc ghi báo cáo; PostgreSQL dev 55439 giữ nguyên. Không dừng các process/volume khác của người dùng.

OTP delivery là CLI chỉ dành cho dev, không SMS; review result đọc qua API, chưa notification delivery. Approval hiện chỉ nhận xe mới trong hồ sơ, chưa nhánh chọn xe có sẵn. Chưa có Booking/Trip/Payment/Rating/Notification, broker, full compensation sau partial Driver provision, distributed limiter, key rotation/retention production hoặc transport hardening toàn diện (metadata gRPC 8 KiB nằm backlog). Không lấy PASS của smoke làm bằng chứng các phần đó.

## Chẩn đoán khởi động dev — 2026-10-04

`dev:start` tái hiện Customer/Driver/Identity `bootstrap failed` không có nguyên nhân; runner cũ in “started” ngay sau `spawn`. `dev:diagnose` xác nhận **cả ba runtime role** kết nối và `SELECT` đúng DB; CA còn hạn, nhưng bốn chứng chỉ workload đều hết 24 giờ. Code transport `certificateIdentity` từ chối chứng chỉ quá hạn trước khi bind mTLS. `dev:migrate` chỉ kiểm tra migration role nên không chứng minh runtime role hoặc cert.

Đã tạo `dev:certs:renew` cấp bộ workload key/cert mới ký bằng CA dev cũ vào thư mục ignored riêng, chỉ chọn sau khi kiểm tra cert/khóa, giữ bộ cũ và không đổi DB/volume. Runner chọn generation hoạt động, kiểm tra hạn/CA trước spawn và chỉ báo ready khi cả bốn entry point gửi IPC sau bootstrap/listen; failure/timeout dừng tất cả child do lượt đó tạo. Main log nguyên nhân từ allowlist an toàn, không in URL/credential/secret. Hướng dẫn ở [dev README](../../dev/README.md).

Bằng chứng: `dev:diagnose` trước renewal: runtime DB 3/3 PASS, CA valid, workload 4/4 expired. Sau renewal: runtime DB 3/3 PASS, CA/signature/URI SAN và hạn 4/4 PASS. `npm.cmd run build`, `npm.cmd run typecheck`, `npm.cmd run test:built` PASS; full Vitest **51/51** PASS (thêm 2 assertion không lộ credential). Start 50261–50263/33201: bốn listener ready; `node dev/smoke.mjs` PASS năm Customer endpoint, `node dev/driver-auth-negative.mjs` PASS JWT sửa 401 và phân quyền Driver/Admin, `node dev/driver-registration-smoke.mjs check` PASS qua Gateway/mTLS/PostgreSQL. Lỗi bind chủ đích trên bộ cổng 50361/50363/33301: runner exit 1, báo Identity chưa ready, dừng nhóm; `netstat` không còn listener ở ba cổng đó. Sau đó nhóm dev 50261–50263/33201 đã khởi động lại và vẫn chạy lúc ghi báo cáo; PostgreSQL project cũ healthy. Không đụng `cab-bootstrap-test-*`, không commit/push/reset/clean hoặc sửa migration.
