# gRPC mTLS và caller-policy — bằng chứng transport

Cập nhật 2026-10-02 (Asia/Saigon). Network integration trên loopback thật, không DB/broker/ORM.
Đã sửa thiếu giới hạn unary 1 MiB sau review độc lập; phiên hiện tại 35/35 tests đạt.
Giữ ESM, Node 24.19.0, NestJS 12.1.2, TypeScript 6.0.3, Vitest 5.0.3/Supertest 7.3.0.
Thêm grpc-js **1.14.5** và proto-loader **0.8.1**, pin/lock local.
grpc-js 1.14.5 sửa getAuthContext để không nhận certificate chưa xác thực là đã xác thực
([release chính thức](https://github.com/grpc/grpc-node/releases/tag/@grpc%2Fgrpc-js@1.14.5)).

## Thiết kế URI SAN và policy

Node mặc định đối chiếu DNS/IP và không đối chiếu URI SAN như hostname.
Dùng callback checkServerIdentity thực hiện đối chiếu chính xác một URI
spiffe://cab.local/service/<expected-service>. CA/chain và hạn certificate vẫn do TLS kiểm tra
trước callback; rejectUnauthorized luôn true, không override hostname để lách SAN.
Đây là endpoint identity verification theo CAB, không coi địa chỉ dial là service identity.
[Node TLS](https://nodejs.org/api/tls.html#tlscheckserveridentityhostname-cert) mô tả rõ custom
callback cho URI và việc callback chỉ chạy sau các kiểm tra CA.
Source grpc-js đã cài được đọc tại build/src/channel-credentials.js để xác minh callback được chuyển
thẳng vào tls.connect; không chỉ suy từ comment VerifyOptions.
Callback còn kiểm tra serverAuth EKU, không CA leaf, thời hạn tối đa 24h và thời gian hiện tại.
Một URI duy nhất, định dạng chính xác; SAN bị quote/escape hoặc nhiều URI bị từ chối để tránh parse mơ hồ.
Fixture URI-only và sai URI server đã kiểm chứng qua network.

ServerCredentials.createSsl với tham số thứ ba true yêu cầu client cert.
Interceptor chỉ đọc getAuthContext().sslPeerCertificate.raw sau khi transportSecurityType=ssl;
grpc-js 1.14.5 chỉ trả peer khi socket.authorized. Interceptor kiểm tra clientAuth EKU,
hạn/tối đa 24h, URI SAN và full method trước khi gọi next, nên chưa đi vào handler.

Namespace chọn policy một lần, không fallback:
- /cab.gateway.v1.* → contracts/gateway-customer-policy.json, kiểm tra ownerService.
- /cab.internal.v1.* → contracts/rpc-policy.json, owner theo service trong full method.
- Method/caller không có entry hoặc namespace/owner sai → PERMISSION_DENIED.
- Thiếu/sai URI caller → UNAUTHENTICATED sau handshake.
- Metadata x-service-name, scope, role, x-cab-caller không tham gia quyết định.

Các method chưa đăng ký được grpc-js trả UNIMPLEMENTED trước dispatch, không gọi handler
và không được coi là bằng chứng auth thành công. Ca method thiếu policy trong harness
**có đăng ký** để chứng minh interceptor thực sự trả PERMISSION_DENIED trước handler.

Server cấu hình connection age 8 phút, grace 30 giây; grpc-js có jitter +/-10%,
giới hạn cấu hình tối đa 9.3 phút dưới 10 phút. Chưa chạy kiểm thử chờ hết connection age;
chưa kiểm chứng rotate trước 2h, CA overlap/revocation/serial deny/terminate khi lộ key.

## Production wiring và phần test-only

- packages/grpc-transport là thư viện infrastructure, không phải ứng dụng thứ tư hoặc business model.
  Ba app trong services giữ nguyên. Build thư viện trước app qua thứ tự workspaces.
  Library giữ TLS/URI verifier, interceptor, loader policy/proto và shutdown.
- IdentityGrpcTransport/CustomerGrpcTransport là Nest provider thật, constructor DI config thật.
  main → bootstrapNetwork → provider.start bind mTLS, onModuleDestroy đóng listener.
  Production bootstrap/config đã được gọi trong test bằng certificate test mới tạo.
  app.close đóng listener, kiểm tra TCP sau close nhận ECONNREFUSED.
- GatewayGrpcClients là provider thật: connect với expected service cố định theo caller,
  credentials mTLS; onModuleDestroy đóng tất cả channel. Test assert SHUTDOWN sau app.close.
  Chưa nối provider vào REST handler hoặc outbound business use case Identity/Customer.
- Production server đăng ký definition từ protobuf **gốc**, không copy, với implementation rỗng;
  grpc-js chỉ trả UNIMPLEMENTED sau service auth. Không có handler test trong production.
- test/transport.spec.ts lắp riêng handler tăng bộ đếm rồi trả UNIMPLEMENTED, không trả response
  Account/Session/Customer/register giả. Synthetic method/no-policy/unknown-package và server hết hạn
  là negative fixture chỉ trong harness; không sửa proto/policy.
- Production bootstrap cần <SERVICE>_GRPC_BIND và <SERVICE>_{CA,CERT,KEY}_FILE
  như .env.example của Identity/Customer. Không auto-load .env, không default plaintext hoặc default key.
  Chỉ đọc path workload được cấu hình khi chạy bootstrapNetwork; phiên test chỉ đọc file mới tạo.
  Domain vẫn không import framework/transport. Không có business success, DB, ORM hoặc migration.

## Chạy kiểm tra

Từ Git root, với dependencies local:

~~~powershell
npm.cmd install --cache .cache/npm --no-audit --no-fund
npm.cmd run build
npm.cmd run typecheck
npm.cmd test -- --reporter=verbose
npm.cmd run test:built
# Khi chỉ cần transport, vẫn build library trước:
npm.cmd run test:transport -- --reporter=verbose
~~~

Lệnh thực tế đã chạy: cài grpc-js@1.14.5/proto-loader@0.8.1 bằng --save-exact trong workspace,
npm.cmd install để liên kết library; build/typecheck; test -- --reporter=verbose; test:built;
test:transport -- --reporter=verbose được chạy ở lần harness đầu (18 test), sau đó phiên mTLS full test gồm
**24 ca transport + 4 smoke = 28/28**, 5 file, exit 0 sau các bổ sung/rá soát cuối.
Build/typecheck exit 0; test:built exit 0 cho ba app.
Các smoke cũ giữ nguyên assertion, vẫn kiểm tra metadata và DI qua Nest container.

Vitest/SWC cần chạy ngoài sandbox Windows hiện tại do ERR_SWC_NATIVE_CACHE owner/DACL đã quan sát
ở phiên scaffold; chỉ nâng quyền thực thi lệnh test cần thiết. Không sửa ACL, ExecutionPolicy, trust store,
pin/runner/assertion hoặc security toàn máy. Build/typecheck chạy trong sandbox.
npm cảnh báo postinstall SWC/protobufjs chưa được approve; native loader và toàn bộ tests vẫn chạy đạt,
không bật allow-scripts toàn bộ.

OpenSSL có sẵn được tìm qua PATH; trên Windows có fallback tìm usr/bin/openssl.exe tương đối với Git
đang dùng. Phiên này OpenSSL 3.5.7. Có thể đặt CAB_TEST_OPENSSL tới executable **đã có**;
không cài global. Helper tạo CA riêng và leaf RSA2048/SHA256 đúng EKU/URI trong mkdtemp của OS,
leaf hợp lệ 24h; cert hết hạn có ngày cố định trong quá khứ chỉ dùng negative test.
Không log certificate/key, không cài CA vào trust store. Cleanup chỉ xóa exact temp directory tự tạo,
kiểm tra absolute path nằm dưới temp root; afterAll assert thư mục không còn tồn tại.

Listener bind 127.0.0.1:0. Client dial localhost:<port> để SNI không là IP (grpc-js cảnh báo RFC6066
nếu dùng IP làm SNI); endpoint identity vẫn là URI SAN. Deadline unary 2500ms,
beforeAll PKI 30s, shutdown graceful 1s rồi forceShutdown, channel luôn close trong finally/afterAll.

## Expected / actual

A = UNIMPLEMENTED(12), handler test tăng đúng 1: service-auth đã qua, chưa kiểm tra nghiệp vụ/user.
T = UNAVAILABLE(14), lỗi TLS/transport, handler không tăng.
U = UNAUTHENTICATED(16), URI caller không hợp lệ, handler không tăng.
D = PERMISSION_DENIED(7), policy deny, handler không tăng.
Mỗi ca deny assert status **và** bộ đếm không tăng; không chỉ đọc message hoặc đếm class.

| Tình huống | Expected | Actual | Kết quả |
|---|---|---|---|
| Gateway → Identity Login, CA/EKU/URI đúng | A | 12, handler +1 | PASS |
| Gateway → Customer GetCustomer, CA/EKU/URI đúng | A | 12, handler +1 | PASS |
| Gateway → RegisterCustomer | A | 12, handler +1 | PASS |
| Gateway → GetCustomerRegistration | A | 12, handler +1 | PASS |
| Gateway → GetMyAccount | A | 12, handler +1 | PASS |
| Identity → Customer ProvisionCustomer | A | 12, handler +1 | PASS |
| Customer → Identity VerifyUserIdentity | A | 12, handler +1 | PASS |
| Facade/internal đăng ký ở owner sai | D | 7 cho cả hai, handler +0 | PASS |
| Không client certificate, vẫn kiểm tra đúng URI server | T | 14, URI verifier server đạt, handler +0 | PASS |
| Plaintext client → mTLS listener | T | 14, handler +0 | PASS |
| Client certificate từ CA lạ | T | 14, handler +0 | PASS |
| Server certificate từ CA lạ | T | 14, handler +0 | PASS |
| Server CA đúng nhưng URI sai service đích | T | 14, handler +0 | PASS |
| Client certificate hết hạn | T | 14, handler +0 | PASS |
| Server certificate hết hạn | T | 14, handler +0 | PASS |
| Client certificate chỉ có serverAuth EKU | T | 14, handler +0 | PASS |
| Client thiếu URI SAN, có DNS SAN | U | 16, handler +0 | PASS |
| Client có hai URI SAN | U | 16, handler +0 | PASS |
| rating-service hợp lệ nhưng không có quyền facade | D | 7, handler +0 | PASS |
| Gateway gọi ProvisionCustomer | D | 7, handler +0 | PASS |
| Gateway gọi CancelCustomerProvision | D | 7, handler +0 | PASS |
| Metadata giả caller/role/scope để provisioning | D | 7, handler +0 | PASS |
| Registered method facade không có policy | D | 7, handler +0 | PASS |
| Registered method package không được biết | D | 7, handler +0 | PASS |
| Identity không được lấy quyền nội bộ dùng facade | D | 7, handler +0 | PASS |
| Production bootstrap mTLS + default unimplemented, Gateway internal denied | 12 facade / 7 internal | 12 / 7 | PASS |
| Shutdown | Listener đóng, channel SHUTDOWN, tiến trình kết thúc | ECONNREFUSED, SHUTDOWN, Vitest exit 0 | PASS |
| Temporary PKI cleanup | Temp directory không còn | existsSync=false | PASS |

Bảng liệt kê assertion/tình huống, không phải số test: một test kiểm tra nhiều hop,
và shutdown/cleanup được kiểm tra trong lifecycle của suite.

## Giới hạn và bước sau

Đã kiểm chứng **network mTLS/service caller-policy** và production transport providers/bootstrap.
Application-context smoke độc lập không mở listener; network suite có listener thật.
Chưa xác minh JWT/Session/Account, object authorization, correlation/user metadata validation/8KiB,
HTTP error mapping/ErrorDetail, rate limit, mutation/deadline/retry semantics hoặc provisioning thật.
Policy userContext=required không được coi là JWT đã verify: production method hiện UNIMPLEMENTED.

Không đổi OpenAPI, business proto, facade/internal policy, static validator/schema/fixtures.
Không chạy lại contract validator vì các file ảnh hưởng hợp đồng không đổi trong nhiệm vụ này;
PASS static phiên facade trước vẫn là bằng chứng riêng.
Chưa chứng minh deployment/network isolation, certificate issuer rotation/revocation hoặc DB/broker.
Bước nhỏ tiếp theo: quyết định ORM/migration với kiểm chứng persistence được giao riêng;
chốt operationId malformed HTTP/errorCode trước handler lookup. Sau đó giao handler/user-auth và
registration/recovery trên persistence thật, không lấy transport PASS làm business PASS.

## Regression giới hạn unary 1 MiB — 2026-10-02

Review độc lập phát hiện request 2 MiB vẫn vào handler do hai factory chưa cấu hình max message length.
Đã sửa createClient và createServer trong packages/grpc-transport/src/index.ts với
grpc.max_send_message_length và grpc.max_receive_message_length cùng 1_048_576 byte.
Đây là giới hạn protobuf body đã serialize cho từng message, gồm field tag/varint/UTF-8,
không phải JavaScript string.length hoặc tổng request+response.
[grpc-js options](https://github.com/grpc/grpc-node/blob/master/packages/grpc-js/README.md#supported-channel-options)
và source grpc-js 1.14.5 đã cài xác nhận tên option và kiểm tra send/receive.
Không đổi contract, policy, dependency/version/lockfile hoặc test mTLS/policy hiện có.

test/fixtures/payload-probe.proto là schema diagnostic test-only, không phải nguồn business proto thứ hai.
test/payload.spec.ts dùng codec này tại path Login đã được policy cho phép để thử transport với caller
Gateway hợp lệ. Echo response chỉ là diagnostic trong harness; không fake Account/Session hoặc
LoginResponse thành công trong production. Một phía dùng factory production, phía đối diện dùng
grpc-js test-only với send/receive 4 MiB và cùng mTLS/URI verifier/caller interceptor.
Do đó không nhầm client tự chặn request với server chặn request.

| Kiểm tra | Protobuf body | Peer đối diện | Actual | Kết quả |
|---|---:|---|---|---|
| Request + response đúng biên | 1_048_576 byte mỗi message | Client/server đều 1 MiB | OK diagnostic; response bằng request, handler 1 | PASS |
| Client send | 1_048_577 byte | Server 4 MiB | RESOURCE_EXHAUSTED(8), handler 0 | PASS |
| Server receive | 1_048_577 byte | Client 4 MiB | RESOURCE_EXHAUSTED(8), handler 0 | PASS |
| Server receive, tái hiện review | 2_097_152 byte | Client 4 MiB | RESOURCE_EXHAUSTED(8), handler 0 | PASS |
| Server send response | 1_048_577 byte | Client receive 4 MiB | RESOURCE_EXHAUSTED(8), không nhận response; handler 1 | PASS |
| Client receive response | 1_048_577 byte | Server send 4 MiB | Control client 4 MiB nhận response; client production nhận code 8, không response | PASS |
| Unicode khác số ký tự | 524_288 JS code units → 1_048_580 protobuf byte | Client 4 MiB | Server receive code 8, handler 0 | PASS |

Test đo byteLength bằng serializer thật; đúng biên 1 MiB được assert cho cả request và response.
Lần đầu 6 assertion diagnostic mới sai vì giả định message lỗi chung. Đã đối chiếu source pin:
client-send báo Attempted to send..., receive báo kích thước body,
server-send so response.length - 5 với limit nhưng hiển thị response.length có header gRPC 5 byte.
Test hiện assert diagnostic chính xác từng phía, status 8, response vắng và counter handler;
không nới limit hoặc giảm assertion cũ. Kích thước hiển thị trong lỗi không thay đổi giới hạn body.

Lệnh đã chạy trong phiên: npm.cmd run build; npm.cmd run typecheck;
npm.cmd test -- --reporter=verbose; npm.cmd run test:built.
Build/typecheck exit 0, full test cuối 6 file **35/35** (28 cũ + 7 payload), exit 0;
ba built context/metadata/DI/close PASS. Vitest chạy ngoài sandbox vì SWC ACL như phiên trước,
không sửa bảo mật máy. test:transport nay bao gồm cả transport.spec.ts và payload.spec.ts;
chạy từ Git root sau build library. Không chạy lại contract validator vì inputs hợp đồng không đổi.

**Metadata tổng 8 KiB chưa được cấu hình/kiểm chứng theo contract**.
Các mục JWT/Session/object authorization, HTTP error mapping/detail, correlation metadata,
rotation/revocation/connection-age runtime, deployment và DB/business vẫn chưa thực hiện/kiểm chứng.
Payload PASS không đồng nghĩa đã bảo vệ đầy đủ transport.
