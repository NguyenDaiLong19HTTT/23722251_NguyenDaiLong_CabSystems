# CAB System — Thiết kế kiến trúc và module nghiệp vụ

**Phiên bản tài liệu:** 1.2  
**Trạng thái:** Thiết kế đồng bộ theo rubric; các quyết định còn mở được liệt kê tại mục 15.4  
**Giai đoạn dự án:** Thiết kế, chưa triển khai backend

## 1. Mục tiêu và phạm vi

Tài liệu xác định:

- Trách nhiệm của từng dịch vụ và module nghiệp vụ.
- Quyền sở hữu dữ liệu và quy tắc cập nhật dữ liệu.
- Quan hệ giữa SRS, hợp đồng API và mô hình lưu trữ.
- Cách bảo đảm tính nhất quán khi nhiều yêu cầu xảy ra đồng thời.
- Cách phục hồi công việc sau lỗi và chống xử lý trùng.
- Kiến trúc triển khai phục vụ phạm vi MVP và rubric chấm project.
- Những quyết định cần hoàn tất trước khi triển khai phần phụ thuộc.

Tài liệu được đối chiếu với:

- `srs.md` phiên bản 1.2.
- Tám tài liệu trong `API-Document`, phiên bản 1.2.0.
- `CAB_Test_Cases_ver_1.xlsx`: 16 sheet, 398 ca kiểm thử.
- `PHIEU_CHAM_PROJECT.pdf`: 30 tiêu chí chấm.

Bộ kiểm thử có 394 ca đang áp dụng và 4 ca được giữ để truy vết nhưng đã đánh dấu OUT_OF_SCOPE hoặc SUPERSEDED.

Trong các ca đang áp dụng, 11 ca được đánh dấu NEEDS_DECISION do còn phụ thuộc lựa chọn nhà cung cấp OTP hoặc thanh toán và hợp đồng tích hợp cụ thể.

Tất cả ca kiểm thử hiện giữ trạng thái NOT_RUN. Các mô tả Expected Result và Required Evidence là kết quả mong đợi và minh chứng cần thu thập, không phải kết quả thực thi.

Việc tài liệu đã được commit không đồng nghĩa hệ thống đã được triển khai, vượt qua kiểm thử hoặc đạt điểm rubric.
### 1.1. Phạm vi nghiệp vụ MVP

Hệ thống hỗ trợ:

1. Tài khoản và phiên đăng nhập.
2. Đặt xe.
3. Tìm và phân công tài xế.
4. Thực hiện, theo dõi và xử lý sự cố chuyến đi.
5. Cấu hình giá, tính cước và thanh toán.
6. Đánh giá.
7. Thông báo trong ứng dụng.
8. Quản lý tài xế, phương tiện và giám sát vận hành.
Các chức năng bổ sung để đáp ứng rubric:

9. Tài xế tự đăng ký bằng số điện thoại, xác thực OTP và gửi thông tin cá nhân/phương tiện để xét duyệt.
10. Điều hành viên xem, duyệt hoặc từ chối hồ sơ đăng ký tài xế; tài xế nhận kết quả.
11. Tra cứu thông tin khách hàng và tài xế theo mã, có kiểm tra quyền trên đối tượng.
12. Liệt kê tài xế có thể nhận chuyến trong bán kính 1 km, hỗ trợ giới hạn kết quả và phân trang.
13. Liệt kê booking của khách hàng, hỗ trợ giới hạn kết quả và phân trang.
14. Trình diễn hệ thống qua API Gateway, Docker Compose, RabbitMQ và các endpoint kiểm tra sức khỏe.
15. Kiểm chứng bảo vệ dữ liệu lưu trữ, phân quyền, JWT, SQL injection, XSS, rate limiting và idempotency.

Các chức năng trên là phạm vi thiết kế cần triển khai và kiểm thử; chưa được đánh dấu hoàn thành.

Báo cáo cơ bản thuộc phạm vi tùy chọn đã nêu trong SRS.

### 1.2. Các chức năng chưa thuộc MVP

- Đặt xe theo lịch, đi chung hoặc nhiều điểm dừng.
- Nhiều vai trò trên cùng một Account.
- Khuyến mãi, giá tăng theo nhu cầu và phí hủy.
- Hoàn tiền tự động.
- Tự động tính tiền cho chuyến bị gián đoạn.
- Tự động thay tài xế trong cùng một Trip.
- Thông báo nghiệp vụ qua email, SMS hoặc push chưa thuộc MVP. Riêng SMS phục vụ OTP đăng ký tài xế thuộc phạm vi tích hợp cần thiết. Môi trường kiểm thử có thể dùng bộ giả lập OTP được ghi rõ; không coi giả lập là bằng chứng đã tích hợp SMS thực tế.
- Tự khôi phục mật khẩu.
- Hệ thống xếp hạng, thưởng hoặc phạt tài xế theo điểm đánh giá.

Các yêu cầu còn cần quyết định được liệt kê ở cuối tài liệu.

## 2. Quyết định kiến trúc

### 2.1. Mục tiêu kiến trúc

Hệ thống được thiết kế để trình diễn:

- API Gateway là cửa vào của các ứng dụng khách.
- Các dịch vụ có tiến trình, hợp đồng giao tiếp và quyền sở hữu dữ liệu riêng.
- Giao tiếp đồng bộ qua HTTP nội bộ.
- Giao tiếp bất đồng bộ qua RabbitMQ.
- Khởi chạy bằng Docker Compose.
- Kiểm tra sức khỏe từng thành phần.
- Khôi phục công việc sau lỗi và chống xử lý trùng.

Rubric không quy định số lượng microservice hoặc yêu cầu một database server vật lý cho từng dịch vụ.

Phương án CAB gồm ba dịch vụ nghiệp vụ: CAB Core, Rating và Notification. CAB Core được tổ chức thành các module nội bộ. Phương án này không được mô tả là tám microservice độc lập.

### 2.2. Thành phần và quyền sở hữu

| Thành phần | Trách nhiệm | Dữ liệu |
|---|---|---|
| API Gateway | Định tuyến, xác thực đầu vào, giới hạn request, correlationId, health tổng hợp | Redis phục vụ rate limit; không sở hữu dữ liệu nghiệp vụ |
| CAB Core API | Identity, Booking, Dispatch, Trip, Fare & Payment, Operations & Fleet | cab_core |
| CAB Core Worker | Điều phối, xử lý thời hạn, tính cước, công việc thanh toán, phát outbox | cab_core |
| Rating Service | Tạo và truy vấn đánh giá | cab_rating |
| Notification Service | Nhận sự kiện, tạo hộp thư, đánh dấu đọc | cab_notification |
| RabbitMQ | Truyền sự kiện giữa các dịch vụ | Queue/message được cấu hình lưu bền vững |
| PostgreSQL | Lưu ba database với tài khoản truy cập riêng | cab_core, cab_rating, cab_notification |
| Redis | Bộ đếm rate limit dùng chung giữa các Gateway; cache có thể tái tạo | Không lưu duy nhất dữ liệu nghiệp vụ quan trọng |

CAB Core API và CAB Core Worker là hai tiến trình của cùng một dịch vụ nghiệp vụ. Chúng cùng dùng database cab_core.

Rating và Notification không truy cập trực tiếp cab_core. CAB Core không ghi vào database của hai dịch vụ này.

Ba database có thể đặt trên cùng PostgreSQL server khi chạy local. Cách này giảm tài nguyên nhưng vẫn có chung rủi ro khi server PostgreSQL ngừng hoạt động; chưa phải hạ tầng chịu lỗi độc lập.

### 2.3. Luồng truy cập

Client → API Gateway → dịch vụ nghiệp vụ.

Các callback/webhook từ nhà cung cấp bên ngoài cũng đi qua Gateway, sau đó chuyển đến CAB Core.

Chỉ Gateway công bố cổng HTTP của ứng dụng ra máy host. Các dịch vụ nghiệp vụ, PostgreSQL, Redis và RabbitMQ hoạt động trong mạng nội bộ Docker, không công bố cổng trong cấu hình chạy bài mặc định.

Các endpoint đăng ký, đăng nhập, OTP và webhook được miễn user token theo từng hợp đồng, nhưng vẫn đi qua Gateway và có cơ chế kiểm tra phù hợp.

Gateway không công khai route /internal/*.

Giao tiếp giữa các dịch vụ đi trực tiếp qua mạng nội bộ, có xác thực danh tính dịch vụ. Quy tắc “mọi request qua Gateway” được áp dụng cho request từ client và bên ngoài hệ thống; không bắt các message RabbitMQ đi qua HTTP Gateway.

### 2.4. Trách nhiệm Gateway

Gateway thực hiện:

- Định tuyến đến đúng dịch vụ.
- Kiểm tra token trên endpoint cần đăng nhập.
- Kiểm tra trạng thái Account/Session qua CAB Core.
- Áp dụng rate limit theo IP, tài khoản và loại endpoint.
- Giới hạn kích thước request, thời gian chờ và số kết nối.
- Tạo hoặc chuẩn hóa correlationId.
- Loại bỏ các header giả mạo danh tính do client tự gửi.
- Giữ nguyên raw payload cần thiết cho kiểm tra chữ ký webhook.
- Không tự động retry các request ghi khi chưa có cơ chế idempotency bảo vệ.

Dịch vụ đích vẫn phải kiểm tra quyền trên đối tượng. Việc request đã qua Gateway không thay thế phân quyền nghiệp vụ.

Gateway không trực tiếp tính cước, phân công tài xế hoặc cập nhật trạng thái thanh toán.

### 2.5. Giao tiếp đồng bộ

Rating Service gọi CAB Core qua HTTP nội bộ để lấy ngữ cảnh đánh giá:

- Trip có tồn tại không.
- Customer sở hữu Trip là ai.
- Driver lịch sử của Trip là ai.
- Trip đã COMPLETED chưa.

CAB Core xác thực danh tính dịch vụ và chỉ trả các trường cần thiết.

Rating Service kiểm tra Customer đang gọi có đúng là chủ chuyến, sau đó ghi Rating và kết quả idempotency trong transaction của cab_rating.

Trip COMPLETED là trạng thái kết thúc, không được chuyển ngược. Điều này giúp điều kiện đánh giá đã xác nhận không bị thay đổi bởi một thao tác khôi phục Trip sau đó.

Nếu không xác minh được điều kiện do CAB Core lỗi hoặc timeout, không tạo Rating; trả lỗi tạm thời phù hợp. Không suy đoán từ dữ liệu do client gửi.

Đề xuất timeout mỗi lời gọi nội bộ là 2 giây, có cấu hình. Chỉ retry có giới hạn đối với thao tác đọc hoặc thao tác đã được bảo vệ chống lặp.

### 2.6. Giao tiếp bất đồng bộ

CAB Core ghi OutboxEvent trong cùng transaction với thay đổi nghiệp vụ.

CAB Core Worker phát sự kiện sang RabbitMQ. Notification Service nhận sự kiện và tạo thông báo trong database của mình.

Các sự kiện tiêu biểu:

- BOOKING_RECEIVED.
- DRIVER_ASSIGNED.
- TRIP_REQUEST_RECEIVED.
- TRIP_CANCELLED.
- TRIP_COMPLETED.
- PAYMENT_SUCCESS.
- PAYMENT_FAILED.
- PAYMENT_UNKNOWN.
- DRIVER_APPLICATION_APPROVED.
- DRIVER_APPLICATION_REJECTED.

Notification bị lỗi không làm rollback Booking, Trip, Payment hoặc kết quả duyệt hồ sơ đã commit.

Sự kiện có thể được giao nhiều lần. Consumer phải chống xử lý trùng; không tuyên bố giao đúng một lần chỉ vì đã dùng RabbitMQ.

### 2.7. Phạm vi transaction

Các nghiệp vụ nhận chuyến, hủy chuyến, chuyển trạng thái Driver, xử lý sự cố và khóa Account được giữ trong CAB Core để có thể dùng transaction trong cab_core.

Không có transaction PostgreSQL dùng chung giữa cab_core, cab_rating và cab_notification.

Mỗi dịch vụ có outbox, inbox, idempotency và audit tương ứng với trách nhiệm của mình.

Không giữ transaction database trong khi chờ HTTP nội bộ, OTP provider, bản đồ hoặc payment provider.

### 2.8. Tổ chức source code dự kiến

Repository tổ chức theo monorepo:

- services/api-gateway
- services/cab-core
- services/rating-service
- services/notification-service
- packages/contracts
- infra/postgres
- infra/rabbitmq
- postman
- tests
- docs
- compose.yaml
- .env.example
- .gitignore

Trong services/cab-core, chia các module:

- identity
- booking
- dispatch
- trip
- billing
- operations-fleet

Mỗi dịch vụ có cấu hình build, Dockerfile, cấu hình chạy và kiểm thử riêng. CAB Core có entrypoint API và Worker riêng.

packages/contracts chỉ chứa hợp đồng dùng chung, schema sự kiện hoặc kiểu dữ liệu trao đổi. Không dùng thư mục này để cho các dịch vụ chia sẻ repository truy cập database.

Đây là cấu trúc dự kiến; không khẳng định các thư mục đã được tạo.

### 2.9. Docker Compose

Cấu hình chạy bài có tám container thường trực:

1. api-gateway
2. cab-core-api
3. cab-core-worker
4. rating-service
5. notification-service
6. postgres
7. redis
8. rabbitmq

Migration và seed là tác vụ chạy một lần, không được tính thành dịch vụ nghiệp vụ thường trực.

Mỗi thành phần có healthcheck phù hợp. Ứng dụng có retry kết nối khi khởi động và khi phụ thuộc khởi động lại; thứ tự start container không thay thế readiness.

Database và RabbitMQ dùng volume lưu bền vững. Redis được cấu hình theo yêu cầu rate limit; mất dữ liệu Redis không được làm mất Booking, Trip hoặc Payment.

Cấu hình xem RabbitMQ Management chỉ bật trong profile debug và giới hạn trên localhost, có tài khoản riêng. Không mở mặc định các cổng quản trị ra mạng ngoài.

### 2.10. Giới hạn và đánh đổi

CAB Core còn chứa nhiều module, vì luồng nhận/hủy chuyến cần giữ tính nhất quán mạnh.

Rating và Notification có thể build, chạy và cập nhật riêng, nhưng vẫn phụ thuộc các hợp đồng với CAB Core.

Thiết kế này thể hiện giao tiếp giữa các dịch vụ thực sự, đồng thời tránh đưa transaction phân tán vào luồng phân công tài xế ở phiên bản đầu.

Nếu sau này bắt buộc tách Booking, Dispatch, Trip và Fleet thành các dịch vụ riêng, phải thiết kế thêm cơ chế giữ chỗ, điều phối, phục hồi và xử lý trạng thái trung gian trước khi thay đổi hợp đồng API.

## 3. Ngôn ngữ và quy tắc chung

#### 3.1. Danh tính và vai trò

| Thuật ngữ | Ý nghĩa |
|---|---|
| Account | Danh tính đăng nhập dùng chung |
| Customer | Hồ sơ khách hàng liên kết Account |
| Driver | Hồ sơ tài xế liên kết Account |
| Operator | Hồ sơ điều hành viên liên kết Account |
| Session | Phiên đăng nhập có thời hạn và khả năng thu hồi |
| Role | CUSTOMER, DRIVER hoặc OPERATOR |

MVP áp dụng một vai trò cho mỗi Account. Role do máy chủ xác định; người dùng không được tự nâng quyền.

Đăng ký khách hàng tạo Account có role CUSTOMER và hồ sơ Customer tương ứng.

Đăng ký tài xế thực hiện theo một luồng thống nhất:

1. Yêu cầu OTP cho mục đích DRIVER_REGISTRATION.
2. Xác minh OTP và nhận verificationToken.
3. Gửi hồ sơ cá nhân và thông tin phương tiện qua POST /driver-applications.
4. Tạo Account DRIVER có accountStatus=ACTIVE, Driver có approvalStatus=PENDING_APPROVAL và driverStatus=OFFLINE, cùng DriverApplication có status=SUBMITTED.
5. OPERATOR xét duyệt hồ sơ qua endpoint review.

Account DRIVER chưa được duyệt hoặc có hồ sơ bị từ chối vẫn được đăng nhập để xem dữ liệu thuộc quyền của mình khi Account ACTIVE và Session còn hiệu lực.

Tài xế chưa APPROVED không được bật AVAILABLE hoặc nhận chuyến.

Ở phiên bản hiện tại, OPERATOR không tạo trực tiếp Account DRIVER qua POST /operations/drivers. Đường dẫn /operations/drivers chỉ cung cấp thao tác đọc đã định nghĩa trong API 07.

Quyết định xét duyệt chỉ thực hiện qua POST /operations/driver-applications/{applicationId}/review. Không bổ sung đường cập nhật approvalStatus độc lập để bỏ qua kiểm tra hồ sơ.

Account OPERATOR được cấp qua quy trình quản trị riêng, không thông qua đăng ký công khai.
### 3.2. Trạng thái độc lập

| Đối tượng | Trạng thái |
|---|---|
| Account | ACTIVE, INACTIVE, SUSPENDED |
| Xét duyệt Driver | PENDING_APPROVAL, APPROVED, REJECTED |
| Hoạt động Driver | AVAILABLE, BUSY, OFFLINE |
| Vehicle | ACTIVE, INACTIVE |
| Booking | PENDING, FINDING_DRIVER, DRIVER_ASSIGNED, NO_DRIVER_FOUND, CANCELLED |
| DispatchProcess | SEARCHING, DRIVER_FOUND, NO_DRIVER_AVAILABLE, CANCELLED |
| TripRequest | PENDING, ACCEPTED, REJECTED, EXPIRED, CANCELLED |
| Trip | DRIVER_ASSIGNED, ARRIVED_PICKUP, PICKED_UP, IN_PROGRESS, COMPLETED, CANCELLED, ERROR |
| Payment/PaymentAttempt | PENDING, PROCESSING, SUCCESS, FAILED, UNKNOWN |
| IncidentRecord | OPEN, RESOLVED |
| Notification deliveryStatus | PENDING, SENT, FAILED |

Không dùng MATCHING, ASSIGNED hoặc ARRIVING làm trạng thái thay thế trong mô hình này.

### 3.3. Điều kiện được phân công chuyến

Tài xế chỉ được chọn khi:

- Account ACTIVE.
- Hồ sơ APPROVED.
- Driver AVAILABLE.
- Có xe được phân công hợp lệ và xe ACTIVE.
- Loại xe phù hợp.
- GPS còn mới.
- Trong phạm vi tìm kiếm.
- Không có Trip đang hoạt động.

Read model hoặc Redis chỉ hỗ trợ tìm ứng viên. Trước khi chấp nhận phân công, hệ thống kiểm tra lại điều kiện trên dữ liệu có thẩm quyền.

### 3.4. Định nghĩa công việc đang hoạt động

Đối với khách hàng:

- Booking PENDING hoặc FINDING_DRIVER đang chiếm quyền đặt xe.
- Booking đã phân công chuyển quyền đó sang Trip tương ứng.
- Trip chưa đóng vẫn là công việc đang hoạt động.
- Trip ERROR chưa có closedAt vẫn đang hoạt động.
- Trip đã đóng nhưng Payment chưa SUCCESS không ngăn khách đặt chuyến mới.

Booking giữ DRIVER_ASSIGNED sau khi Trip hoàn tất hoặc bị hủy. Không dùng riêng trạng thái Booking để kết luận khách còn đang đi xe.

3.5. Đối chiếu thuật ngữ với rubric
Thuật ngữ trong rubric	Thuật ngữ trong CAB
Admin	OPERATOR
Ride/Trip	Trip
Review	Rating
Ride CANCELED	Trip CANCELLED
Payment COMPLETED	Payment SUCCESS
Driver Online	Driver AVAILABLE hoặc BUSY; chỉ AVAILABLE được nhận chuyến mới
Driver Offline	Driver OFFLINE


API và database dùng thống nhất thuật ngữ CAB. Tài liệu demo ghi rõ bảng tương ứng; không tạo hai trạng thái khác tên nhưng cùng ý nghĩa trong một đối tượng.
Trip COMPLETED không tự đồng nghĩa với Payment SUCCESS.
## 4. Ranh giới và quyền sở hữu dữ liệu

| Module | Trách nhiệm chính | Dữ liệu sở hữu |
|---|---|---|
| Identity | Account, xác thực, phiên, hồ sơ dùng chung | Account, Customer, Operator, Session |
| Booking | Tiếp nhận và hủy yêu cầu trước phân công | BookingRequest, CustomerActivityGuard |
| Dispatch | Chọn ứng viên, gửi đề nghị, nhận/từ chối | DispatchProcess, TripRequest |
| Trip | Vòng đời chuyến, GPS, lịch sử và sự cố | Trip, TripStatusHistory, DriverLocation, TripRoutePoint, JourneyMetrics, IncidentRecord |
| Fare & Payment | Giá, cước, các lần thanh toán, đối soát | PricingConfig, Fare, Payment, PaymentAttempt, ProviderEvent |
| Rating | Đánh giá của khách cho chuyến | Rating |
| Notification | Hộp thư, công bố và trạng thái đọc | Notification, công việc giao thông báo |
| Operations & Fleet | Hồ sơ tài xế, xe, phân công xe, góc nhìn vận hành | Driver, Vehicle, VehicleAssignment, các read model vận hành |
### Nơi triển khai và database của từng module

| Module | Dịch vụ triển khai | Database |
|---|---|---|
| Identity | CAB Core | cab_core |
| Booking | CAB Core | cab_core |
| Dispatch | CAB Core | cab_core |
| Trip | CAB Core | cab_core |
| Fare & Payment | CAB Core | cab_core |
| Operations & Fleet | CAB Core | cab_core |
| Rating | Rating Service | cab_rating |
| Notification | Notification Service | cab_notification |

IdempotencyRecord, OutboxEvent, InboxReceipt, BackgroundJob và AuditLog thuộc dịch vụ sử dụng chúng. Không tạo một bảng hạ tầng chung cho phép mọi dịch vụ ghi trực tiếp.

Liên kết khác database dùng ID và hợp đồng giao tiếp; không có khóa ngoại xuyên database.

Các cấu trúc kỹ thuật gồm:

- IdempotencyRecord.
- OutboxEvent.
- InboxReceipt.
- BackgroundJob.
- AuditLog.

Chúng hỗ trợ các nghiệp vụ đã có, không tự tạo ra chức năng công khai mới.

### 4.1. Dữ liệu không được sở hữu trùng

- fullName, email, phone và thông tin xác thực thuộc Account.
- Driver không có bộ email/phone có thể sửa độc lập với Account.
- Trạng thái Trip thuộc Trip.
- Trạng thái Payment thuộc Fare & Payment.
- IncidentRecord thuộc Trip vì việc mở/giải quyết sự cố liên quan trực tiếp tới trạng thái chuyến.
- Operations được quyền thực hiện một số thao tác, nhưng không trở thành nơi sở hữu mọi dữ liệu.

### 4.2. Phân công xe

VehicleAssignment lưu quan hệ phân công hiện hành và lịch sử:

- Một Driver có tối đa một phân công chưa kết thúc.
- Một Vehicle có tối đa một phân công chưa kết thúc.
- Driver.vehicleId và Vehicle.assignedDriverId trong API có thể được dựng từ phân công hiện hành.
- Không duy trì hai liên kết có thể cập nhật độc lập rồi hy vọng chúng luôn khớp.

Thay xe phải đi qua một nghiệp vụ thống nhất, cập nhật phân công và version của các đối tượng liên quan.

## 5. Mô hình dữ liệu

### 5.1. Identity

| Entity | Thuộc tính chính |
|---|---|
| Account | accountId, fullName, emailEncrypted, phoneEncrypted, emailLookupHash, phoneLookupHash, passwordHash, role, accountStatus, version, createdAt, updatedAt |
| Customer | customerId, accountId |
| Operator | operatorId, accountId |
| Session | sessionId, accountId, refreshTokenHash, expiresAt, revokedAt, createdAt, rotatedAt |
| OtpChallenge | challengeId, phoneEncrypted, phoneLookupHash, purpose, codeDigest, expiresAt, failedAttempts, verifiedAt, invalidatedAt |
| PhoneVerification | verificationId, challengeId, phoneLookupHash, tokenDigest, expiresAt, consumedAt |

#### Chuẩn hóa và bảo vệ dữ liệu tài khoản

- Chuẩn hóa email bằng trim và lowercase trước khi tạo giá trị tra cứu.
- Chuẩn hóa phone về E.164 trước khi tạo giá trị tra cứu.
- emailEncrypted và phoneEncrypted lưu dữ liệu đã mã hóa.
- emailLookupHash và phoneLookupHash là HMAC của giá trị chuẩn hóa, dùng khóa tra cứu riêng.
- Không dùng hash không khóa cho dữ liệu dễ dò như số điện thoại.
- Đặt ràng buộc duy nhất trên emailLookupHash và phoneLookupHash.
- Không lưu thêm normalizedEmail hoặc normalizedPhone dạng rõ trong database.
- Giá trị email/phone rõ chỉ được giải mã ở thao tác có quyền.
- Password không được tự trim.
- Password được lưu dưới dạng passwordHash, không lưu plaintext.
- Customer.accountId và Operator.accountId duy nhất.
- Mỗi hồ sơ phải phù hợp với role của Account.

#### Phiên đăng nhập

- Không lưu refresh token dạng rõ.
- Refresh luân chuyển token nhưng không kéo dài thời hạn tuyệt đối của Session.
- Logout thu hồi phiên hiện tại.
- Đổi mật khẩu hoặc khóa Account thu hồi toàn bộ phiên liên quan.
- Việc access token chưa hết hạn không thay thế kiểm tra Account và Session.

#### OTP đăng ký tài xế

Các thông số dưới đây là cấu hình thiết kế đề xuất của CAB, không phải con số do rubric quy định:

- OTP được tạo ngẫu nhiên an toàn, có sáu chữ số, hiệu lực năm phút.
- Mỗi challenge cho tối đa năm lần nhập sai.
- Gửi lại sau tối thiểu 60 giây.
- OTP cũ bị vô hiệu hóa khi phát hành OTP thay thế.
- codeDigest dùng cơ chế có khóa bí mật để giảm nguy cơ dò ngoại tuyến khi database bị lộ.
- Không ghi OTP vào log hoặc trả OTP trong API công khai.

Sau khi xác minh OTP thành công:

- Cấp một verification token ngắn hạn.
- Token gắn với phone và purpose đăng ký tài xế.
- Token chỉ được sử dụng một lần.
- Database chỉ lưu digest của verification token.
- Tạo tài khoản tài xế phải tiêu thụ verification token trong cùng transaction tạo hồ sơ.

OTP provider được gọi ngoài transaction database.

Bộ giả lập OTP chỉ bật trong môi trường test; không dùng OTP cố định trong cấu hình triển khai.

Driver.accountId do Fleet quản lý. Việc tạo Account DRIVER và Driver profile phải hoàn tất nhất quán trong CAB Core.

### 5.2. Booking

| Entity | Thuộc tính chính |
|---|---|
| BookingRequest | bookingId, customerId, pickup, destination, vehicleType, note, bookingStatus, pricingVersionId, pricingSnapshot, driverId, tripId, cancellation, createdAt, updatedAt |
| CustomerActivityGuard | customerId, bookingId, tripId, updatedAt |

CustomerActivityGuard có một bản ghi cho mỗi khách đang có công việc hoạt động.

Quy tắc:

- Tạo Booking phải giành được quyền hoạt động của Customer.
- Tạo Trip không tạo một quyền hoạt động thứ hai; nó tiếp tục quyền của Booking.
- Hủy Booking hoặc kết thúc tìm tài xế không thành công giải phóng quyền.
- Trip đóng hợp lệ giải phóng quyền.
- Mọi lần giải phóng phải kiểm tra đúng bookingId/tripId đang giữ quyền.
- Sự kiện cũ không được giải phóng quyền của chuyến mới.

PricingSnapshot là bản sao bất biến của giá tại thời điểm chấp nhận Booking.

### 5.3. Dispatch

| Entity | Thuộc tính chính |
|---|---|
| DispatchProcess | dispatchProcessId, bookingId, dispatchStatus, attemptCount, attemptedDriverIds, startedAt, deadlineAt, configSnapshot, driverId, tripId, endedAt, failureReason, updatedAt |
| TripRequest | tripRequestId, bookingId, dispatchProcessId, driverId, status, sentAt, expiresAt, resolvedAt, rejectReason, closureReason, tripId |

Ràng buộc:

- Một DispatchProcess cho mỗi Booking.
- Một TripRequest chỉ gửi cho một Driver.
- Tối đa một đề nghị PENDING trong một tiến trình tại một thời điểm.
- Một Driver không được lặp lại trong danh sách đã thử của cùng tiến trình.
- expiresAt không vượt deadlineAt.
- Khởi động lại Worker không đặt lại deadline hoặc số lượt.
- ACCEPTED, REJECTED, EXPIRED và CANCELLED được lưu bền vững.

Không dùng việc Redis xóa key hết hạn làm bằng chứng duy nhất rằng đề nghị đã EXPIRED. TTL là cơ chế hết hạn dữ liệu cache; trạng thái nghiệp vụ phải được ghi nhận bởi xử lý có kiểm tra điều kiện.

### 5.4. Trip và sự cố

| Entity | Thuộc tính chính |
|---|---|
| Trip | tripId, bookingId, customerId, driverId, vehicleId, pickup, destination, vehicleType, tripStatus, version, arrivedAt, pickedUpAt, startedAt, completedAt, closedAt, closeReason, statusBeforeError, cancellation, createdAt, updatedAt |
| TripStatusHistory | historyId, tripId, version, previousStatus, newStatus, actorType, actorId, changedAt, reason |
| IncidentRecord | incidentId, tripId, issueType, description, status, reportedByAccountId, createdAt, resolutionAction, resolutionNote, resolvedByAccountId, resolvedAt |
| DriverLocation | driverId, latitude, longitude, recordedAt, receivedAt |
| TripRoutePoint | pointId, tripId, driverId, latitude, longitude, recordedAt, receivedAt |
| JourneyMetrics | tripId, metricsVersion, distanceKm, durationMinutes, qualityStatus, calculationMethodVersion, confirmedAt, reviewReason |

Ràng buộc:

- Trip.bookingId duy nhất.
- Một Driver có tối đa một Trip chưa đóng.
- Một Vehicle có tối đa một Trip chưa đóng.
- Trip ERROR chưa đóng vẫn giữ tài xế.
- Không đưa mọi điểm GPS vào TripStatusHistory.
- Cập nhật GPS không làm tăng version của trạng thái Trip.
- Incident mới trong Trip đang ERROR không ghi lịch sử ERROR → ERROR.
- Giải quyết ERROR phải xét toàn bộ Incident OPEN hiện tại.
- Đóng bất thường giữ ERROR và có closedAt; không giả thành COMPLETED.

### 5.5. Fare & Payment

| Entity | Thuộc tính chính |
|---|---|
| PricingConfig | pricingVersionId, vehicleType, currency, baseFare, pricePerKm, pricePerMinute, effectiveFrom, reason, createdByAccountId, createdAt |
| Fare | fareId, tripId, pricingVersionId, pricingSnapshot, metricsVersion, distanceKm, durationMinutes, baseAmount, distanceAmount, timeAmount, totalAmount, currency, calculatedAt |
| Payment | paymentId, tripId, fareId, customerId, amount, currency, method, paymentStatus, currentAttemptId, requiresReview, version, paidAt, confirmedByAccountId, createdAt, updatedAt |
| PaymentAttempt | attemptId, paymentId, attemptNumber, method, amount, currency, status, provider, merchantReference, providerTransactionId, failureCode, failureMessage, confirmedByAccountId, createdAt, updatedAt, resolvedAt |
| ProviderEvent | provider, providerEventId, attemptId, receivedAt, verifiedResult, processingStatus, evidenceReference |

Quy ước thuộc tính thanh toán:

- Payment.method phản ánh phương thức của currentAttemptId.
- PaymentAttempt.method lưu phương thức của từng lần thanh toán.
- confirmedByAccountId là accountId của DRIVER xác nhận đã nhận đủ tiền mặt; không phải driverId hoặc accountId của OPERATOR.
- confirmedByAccountId chỉ có khi đã ghi nhận xác nhận tiền mặt hợp lệ.
- paidAt chỉ có khi Payment SUCCESS.
- Các trường tùy chọn chưa có giá trị được bỏ khỏi response theo API 05.
- provider, merchantReference và providerTransactionId áp dụng theo hợp đồng thanh toán online; không tạo giá trị giả cho giao dịch CASH.

Ràng buộc:

- Một Fare cho mỗi Trip.
- Một Payment cho mỗi Fare và Trip.
- attemptNumber duy nhất trong một Payment.
- Không có hai lần thanh toán đang hoạt động đồng thời.
- UNKNOWN vẫn chặn lần thanh toán mới.
- Merchant reference ổn định cho cùng một Attempt.
- Provider transaction ID được kiểm tra duy nhất trong phạm vi nhà cung cấp phù hợp.
- Payment SUCCESS không bị hạ xuống FAILED hoặc UNKNOWN.
- requiresReview không được tự xóa khi nhận một sự kiện lặp.
- Giá và cước đã chốt không được cập nhật đè.

Số tiền trung gian và đơn giá dùng kiểu số thập phân chính xác. Tổng thanh toán VND là số nguyên sau khi làm tròn. PostgreSQL cung cấp kiểu `NUMERIC` cho các giá trị cần độ chính xác thập phân; không dùng float để tính tiền.

Công thức MVP:

`totalAmount = baseFare + distanceKm × pricePerKm + durationMinutes × pricePerMinute`

Chỉ làm tròn tổng cuối cùng đến đồng, nửa lên đối với số không âm.

Không có discountAmount hoặc phí hủy trong công thức MVP.

### 5.6. Rating

| Entity | Thuộc tính chính |
|---|---|
| Rating | ratingId, tripId, customerId, driverId, score, comment, createdAt |

Ràng buộc:

- tripId duy nhất.
- score là số nguyên từ 1 đến 5.
- Chỉ Customer sở hữu Trip được tạo.
- Trip phải COMPLETED.
- Không phụ thuộc Payment SUCCESS.
- Driver được đánh giá là Driver của Trip lịch sử.
- MVP chưa sửa/xóa Rating.

Điểm đánh giá trung bình, xếp hạng và điểm thưởng tài xế nằm ngoài phạm vi phiên bản hiện tại.

Không có yêu cầu triển khai DriverRatingSummary hoặc API averageScore trong baseline 1.2. Ca kiểm thử tương ứng đã được đánh dấu OUT_OF_SCOPE.

Nếu bổ sung sau này, phải cập nhật SRS, API và test case trước khi triển khai. Dữ liệu tổng hợp phải được dựng từ Rating và không thay thế các bản ghi đánh giá gốc.

### 5.7. Notification

| Entity | Thuộc tính chính |
|---|---|
| Notification | notificationId, eventId, recipientAccountId, eventType, referenceType, referenceId, channel, title, message, deliveryStatus, isRead, readAt, createdAt, publishedAt, updatedAt |

Ràng buộc:

- Unique trên eventId, recipientAccountId, channel.
- MVP chỉ có IN_APP.
- Người dùng không tự cung cấp message hoặc trạng thái gửi.
- SENT nghĩa là đã công bố bền vững trong hộp thư.
- isRead độc lập với deliveryStatus.
- readAt chỉ ghi lần đánh dấu đọc đầu tiên.
- Hộp thư người dùng chỉ trả SENT thuộc tài khoản đăng nhập.
- Công bố lại hoặc gửi lại sự kiện không đặt isRead về false.
- Sắp xếp theo publishedAt, sau đó notificationId giảm dần.
Kết quả duyệt hồ sơ tạo thông báo IN_APP cho Account DRIVER tương ứng qua:

- DRIVER_APPLICATION_APPROVED.
- DRIVER_APPLICATION_REJECTED.

Các sự kiện này dùng referenceType=DRIVER_APPLICATION.

Các eventType và referenceType trên phải được bổ sung vào API Notification.

Thông báo được tạo từ kết quả nghiệp vụ đã commit, không lấy quyết định xét duyệt do client tự cung cấp.
### 5.8. Operations & Fleet

| Entity | Thuộc tính chính |
|---|---|
| Driver | driverId, accountId, licenseNumberEncrypted, licenseLookupHash, approvalStatus, rejectionReason, driverStatus, version, createdAt, updatedAt |
| Vehicle | vehicleId, plateNumber, normalizedPlateKey, vehicleType, vehicleStatus, version, createdAt, updatedAt |
| VehicleAssignment | assignmentId, driverId, vehicleId, startedAt, endedAt, assignedByAccountId |
| DriverApplication | applicationId, driverId, submittedVehicleDetails, status, version, submittedAt, reviewedAt, reviewedByAccountId, rejectionReason |
| Operational read models | Các góc nhìn danh sách tài khoản, chuyến, thanh toán và báo cáo |

#### Ràng buộc dữ liệu

- Driver.accountId duy nhất.
- Giấy phép được chuẩn hóa trước khi tạo licenseLookupHash.
- licenseNumberEncrypted lưu giá trị giấy phép đã mã hóa.
- licenseLookupHash dùng HMAC với khóa tra cứu riêng và có ràng buộc duy nhất.
- API chỉ trả giá trị giấy phép rõ khi người gọi có quyền.
- normalizedPlateKey duy nhất.
- Thay phân công xe chỉ khi tài xế OFFLINE và không có chuyến hoạt động.
- Xe đang phục vụ chuyến không được đổi thông tin hoặc phân công.
- Duyệt hồ sơ không tự bật AVAILABLE.
- Chuyển Account về ACTIVE không khôi phục Session cũ hoặc tự bật AVAILABLE.

#### Hồ sơ đăng ký tài xế

DriverApplication.status gồm:

- SUBMITTED.
- APPROVED.
- REJECTED.

Luồng đăng ký:

1. Xác minh số điện thoại bằng OTP.
2. Gửi thông tin cá nhân, giấy phép và phương tiện.
3. Tạo Account DRIVER, Driver PENDING_APPROVAL/OFFLINE và DriverApplication SUBMITTED trong cùng transaction.
4. Tài xế đăng nhập được nhưng chưa đủ quyền bật nhận chuyến.
5. OPERATOR duyệt hoặc từ chối hồ sơ.
6. Hệ thống ghi kết quả và phát sự kiện thông báo.

Thông tin xe khai báo chưa được coi là Vehicle ACTIVE hoặc VehicleAssignment hợp lệ.

Khi duyệt:

- Kiểm tra giấy phép, biển số và các ràng buộc phân công.
- Tạo hoặc liên kết Vehicle hợp lệ.
- Tạo VehicleAssignment trong cùng transaction duyệt.
- Không chuyển xe đang thuộc tài xế khác hoặc đang có chuyến bằng thao tác duyệt hồ sơ.
- Giữ Driver OFFLINE sau khi duyệt thành công.

Khi từ chối:

- Bắt buộc có lý do.
- Driver giữ OFFLINE.
- Ghi người xét duyệt và thời điểm xét duyệt.

Cập nhật DriverApplication và Driver.approvalStatus phải nhất quán. Không duy trì hai API xét duyệt với quy tắc khác nhau.

#### Truy vấn vận hành

Các danh sách vận hành của CAB Core đọc qua giao diện truy vấn của module sở hữu trong cab_core.

Dữ liệu Rating và Notification được lấy qua dịch vụ tương ứng, không JOIN trực tiếp vào database của dịch vụ khác.

## 6. Ánh xạ API vào module

Tất cả đường dẫn dưới đây nằm dưới `/v1`.

| Nhóm API | Module xử lý |
|---|---|
| `/auth/*`, `/accounts/me` | Identity |
| `/bookings` và thao tác xem/hủy Booking | Booking |
| `/bookings/{id}/dispatch*`, `/trip-requests/*`, `/drivers/me/trip-requests` | Dispatch |
| `/trips`, trạng thái, tracking, hủy và Incident của Trip | Trip |
| `/drivers/me/location` | Trip — phần vị trí |
| Fare, Payment, PaymentAttempt, webhook, retry, confirm-cash, reconcile | Fare & Payment |
| `/trips/{id}/rating`, `/drivers/me/ratings`, `/operations/ratings` | Rating |
| `/notifications*` | Notification |
| `/drivers/me`, `/drivers/me/availability`, quản lý Driver/Vehicle | Operations & Fleet |

Các endpoint vận hành được phân công tiếp như sau:

| Endpoint vận hành | Nơi sở hữu nghiệp vụ |
|---|---|
| GET /operations/accounts | Identity |
| PATCH /operations/accounts/{accountId}/status | Identity, phối hợp Dispatch/Fleet trong thao tác khóa |
| GET /operations/driver-applications | Fleet |
| GET /operations/driver-applications/{applicationId} | Fleet |
| POST /operations/driver-applications/{applicationId}/review | Fleet phối hợp Identity trong CAB Core |
| GET /operations/drivers và GET /operations/drivers/{driverId} | Fleet |
| Quản lý Vehicle và phân công xe | Fleet |
| GET /operations/trips | Trip |
| GET/POST /operations/incidents | Trip |
| POST /operations/trips/{tripId}/resolve-error | Trip, phối hợp Fleet và Booking |
| GET/POST /operations/pricing | Fare & Payment |
| GET /operations/payments | Fare & Payment |
| GET /operations/reports/summary | Operations — truy vấn báo cáo |

Không có POST /operations/drivers trong hợp đồng hiện tại. Việc tạo Account DRIVER và Driver được thực hiện qua POST /driver-applications sau khi xác minh OTP.

Tiền tố /operations thể hiện nhóm người được sử dụng, không có nghĩa mọi dữ liệu nằm trong cùng một module Operations.
### 6.1. API bổ sung theo rubric

Ngoại trừ ba endpoint health ở gốc Gateway, các endpoint nghiệp vụ dưới đây nằm dưới /v1.

| Endpoint đề xuất | Mục đích | Nơi xử lý |
|---|---|---|
| GET /customers/{customerId} | Tra cứu khách hàng theo mã | Identity trong CAB Core |
| GET /drivers/{driverId} | Tra cứu tài xế theo mã | Fleet trong CAB Core |
| GET /drivers/nearby | Danh sách tài xế gần tọa độ | Dispatch phối hợp Fleet/Trip |
| GET /bookings | Danh sách booking của khách đăng nhập | Booking |
| POST /auth/driver-registration/otp | Yêu cầu OTP đăng ký tài xế | Identity |
| POST /auth/driver-registration/otp/verify | Xác minh OTP | Identity |
| POST /driver-applications | Gửi hồ sơ đăng ký bằng verification token | Identity phối hợp Fleet |
| GET /driver-applications/me | Xem hồ sơ của tài xế đăng nhập | Fleet |
| GET /operations/driver-applications | Danh sách hồ sơ cần xử lý | Fleet |
| GET /operations/driver-applications/{applicationId} | Xem chi tiết hồ sơ | Fleet |
| POST /operations/driver-applications/{applicationId}/review | Duyệt hoặc từ chối | Fleet phối hợp Identity |
| GET /health | Kiểm tra Gateway còn hoạt động | Gateway |
| GET /ready | Kiểm tra khả năng phục vụ của hệ thống | Gateway |
| GET /health/services | Xem tình trạng từng thành phần | Gateway |

Các endpoint trong bảng đã được mô tả trong bộ API Document phiên bản 1.2.0.

Bảng này trình bày trách nhiệm xử lý. Hợp đồng request/response, security, mã lỗi và quy tắc idempotency được đối chiếu với YAML tương ứng. Nếu có khác biệt, phải sửa đồng bộ tài liệu trước khi triển khai, không tự chọn một cách hiểu.

API đăng ký tài xế là luồng có kiểm soát bằng verification token, không yêu cầu người đăng ký đã có user access token.

Role được máy chủ quyết định là DRIVER; client không được tự chọn OPERATOR.

POST /driver-applications cần idempotency gắn với danh tính xác minh:

- Phát lại hợp lệ trả kết quả đã lưu trước khi kiểm tra token đã consumed.
- Token đã dùng không cho phép tạo hồ sơ khác.
- Cùng key nhưng nội dung khác trả 409.

API review yêu cầu:

- Role OPERATOR.
- Idempotency-Key.
- expectedApplicationVersion.
- Quyết định APPROVE hoặc REJECT.
- REJECT bắt buộc có lý do.

API hiện tại không cung cấp thao tác sửa approvalStatus qua một endpoint chỉnh sửa Driver thông thường.

Mọi quyết định APPROVE hoặc REJECT phải đi qua POST /operations/driver-applications/{applicationId}/review, với cùng kiểm tra quyền, phiên bản hồ sơ, điều kiện phương tiện, audit và outbox.

### 6.2. Quyền xem hồ sơ theo mã

GET /customers/{customerId}:

- CUSTOMER chỉ xem hồ sơ của mình.
- OPERATOR được xem theo quyền vận hành.
- Không cho CUSTOMER liệt kê hoặc đọc hồ sơ người khác bằng cách đổi ID.

GET /drivers/{driverId}:

- DRIVER xem hồ sơ của mình.
- OPERATOR xem theo quyền vận hành.
- CUSTOMER chỉ xem thông tin tài xế tối thiểu khi có quan hệ chuyến phù hợp.
- Không trả giấy phép, email, số điện thoại hoặc hồ sơ xét duyệt trong dữ liệu công khai.

Sai role đối với chức năng trả 403.

Với đối tượng không thuộc phạm vi người gọi, có thể dùng 404 theo quy ước bảo vệ dữ liệu đã thống nhất.

### 6.3. Danh sách tài xế gần vị trí

GET /drivers/nearby nhận:

- latitude.
- longitude.
- radiusKm.
- limit.
- cursor.

Đề xuất radiusKm mặc định là 1; kịch bản chấm dùng đúng 1 km.

Chỉ trả tài xế:

- Account ACTIVE.
- APPROVED.
- AVAILABLE.
- Có xe ACTIVE phù hợp.
- GPS còn mới.
- Không có Trip đang hoạt động.

Sắp xếp theo distanceMeters tăng dần, sau đó driverId.

Không công khai tọa độ chính xác, số điện thoại hoặc giấy phép; có thể trả khoảng cách gần đúng và thông tin xe tối thiểu.

Phân trang dùng một kết quả tìm kiếm có thời hạn hoặc cursor gắn với snapshot, tránh thay đổi vị trí làm lặp hoặc bỏ sót hàng giữa các trang.

Cursor hết hạn phải yêu cầu tìm lại.

Bán kính endpoint tra cứu và bán kính điều phối là hai cấu hình khác nhau.

Có thể giữ phạm vi điều phối 5 km đã đề xuất, nhưng demo theo rubric phải thể hiện được truy vấn 1 km và không trả tài xế ngoài phạm vi đó.

Kết quả nearby không giữ chỗ tài xế. Khi accept vẫn phải kiểm tra lại điều kiện từ dữ liệu có thẩm quyền.

### 6.4. Danh sách booking

GET /bookings trả booking của Customer đang đăng nhập, không nhận customerId tùy ý từ client.

Hỗ trợ:

- bookingStatus.
- limit.
- cursor.

Sắp xếp createdAt giảm dần rồi bookingId giảm dần.

Đề xuất limit mặc định 20, tối đa 100.

Trả nextCursor khi còn dữ liệu.

Danh sách chứa cả booking đã kết thúc hoặc đã phân công. Không giới hạn vào booking đang hoạt động.

### 6.5. Quy tắc Gateway

Định tuyến Rating và Notification đến dịch vụ riêng. Các route còn lại đi CAB Core.

Các route cụ thể như /drivers/me, /drivers/nearby và /trips/{tripId}/rating phải được phân biệt với route theo ID hoặc route Trip tổng quát.

Các API nội bộ hiện có như dispatch, reconcile và tạo notification chỉ được gọi trong mạng nội bộ bằng danh tính dịch vụ; không mở cho client chỉ vì có cùng tiền tố /v1.

Lời gọi HTTP và message đều truyền correlationId.

## 7. Transaction và các bất biến quan trọng
Các transaction phối hợp Identity, Booking, Dispatch, Trip, Billing và Fleet trong mục này chạy trên cab_core.

Rating và Notification dùng transaction riêng trong database của mình.

Không gọi HTTP hoặc gửi message và coi đó là một phần của transaction database.

Transaction không thay thế việc thiết kế khóa và ràng buộc duy nhất.

Các ca sử dụng phải:

1. Xác thực danh tính và quyền.
2. Kiểm tra idempotency nếu endpoint yêu cầu.
3. Mở transaction.
4. Khóa các bản ghi điều phối liên quan theo thứ tự thống nhất.
5. Đọc lại điều kiện nghiệp vụ.
6. Cập nhật dữ liệu, lịch sử, audit và outbox.
7. Ghi kết quả idempotency.
8. Commit rồi mới trả thành công.

Không giữ transaction mở trong khi chờ người dùng, bản đồ hoặc nhà cung cấp thanh toán.

### 7.1. Tạo Booking

Trong một transaction:

- Kiểm tra Account/Session hợp lệ.
- Giành CustomerActivityGuard.
- Chọn phiên bản giá đang có hiệu lực.
- Tạo Booking PENDING với pricingSnapshot.
- Tạo công việc điều phối bền vững.
- Ghi sự kiện BOOKING_RECEIVED.
- Ghi kết quả idempotency.

Chỉ trả 201 sau commit.

Hai khóa khác nhau từ cùng Customer vẫn phải đi qua ràng buộc CustomerActivityGuard.

### 7.2. Nhận chuyến

Trong một transaction:

- Khóa Booking, tiến trình, đề nghị và các tài nguyên liên quan.
- Kiểm tra đề nghị thuộc Driver đang gọi.
- Kiểm tra thời hạn bằng thời gian máy chủ.
- Kiểm tra Booking chưa hủy hoặc phân công.
- Kiểm tra lại Account, hồ sơ, xe, trạng thái và GPS.
- Chuyển TripRequest thành ACCEPTED.
- Tạo đúng một Trip.
- Chuyển Booking thành DRIVER_ASSIGNED.
- Chuyển Dispatch thành DRIVER_FOUND.
- Chuyển Driver thành BUSY.
- Gắn Trip vào CustomerActivityGuard.
- Vô hiệu hóa đề nghị cạnh tranh.
- Ghi lịch sử, audit và outbox.

Chỉ trả 200 khi transaction đã commit.

Hủy Booking và nhận chuyến phải tranh chấp trên cùng bản ghi điều phối. Không được có hai kết quả thành công mâu thuẫn.

### 7.3. Hoàn tất hoặc hủy Trip

Trong một transaction:

- Kiểm tra người gọi, expectedVersion và trạng thái hiện tại.
- Áp dụng chuyển trạng thái hợp lệ.
- Ghi timestamp, lịch sử và version.
- Đóng Trip khi phù hợp.
- Giải phóng CustomerActivityGuard nếu nó vẫn trỏ đúng Trip.
- Giải phóng tài xế khỏi Trip.
- Đặt AVAILABLE chỉ khi vẫn đủ điều kiện; nếu không thì OFFLINE.
- Ghi sự kiện/công việc tiếp theo.

COMPLETED tạo công việc tính cước, nhưng không đợi nhà cung cấp bên ngoài và không tự xác nhận thanh toán.

### 7.4. Ghi nhận và giải quyết sự cố

Tạo Incident và đưa Trip vào ERROR nằm trong cùng transaction.

Nếu Trip đã ERROR:

- Giữ nguyên statusBeforeError.
- Thêm Incident.
- Tăng version.
- Không ghi chuyển trạng thái ERROR → ERROR.

Giải quyết sự cố:

- Kiểm tra expectedTripVersion.
- Khóa Trip và tập Incident đang mở.
- Khôi phục đúng trạng thái trước ERROR hoặc đóng bất thường.
- Cập nhật toàn bộ Incident OPEN liên quan.
- Cập nhật Driver và CustomerActivityGuard khi đóng.
- Ghi audit và sự kiện.

Incident mới phát sinh đồng thời phải làm yêu cầu dùng version cũ bị từ chối.

### 7.5. Khóa Account

Thao tác khóa:

- Đổi accountStatus.
- Thu hồi các Session.
- Chặn phân công mới.
- Vô hiệu hóa đề nghị nhận chuyến chưa chấp nhận của Driver.
- Giữ BUSY nếu Driver còn Trip hoạt động; nếu không thì OFFLINE.
- Không tự hủy hoặc hoàn tất Trip.
- Trả các công việc đang hoạt động để điều hành viên xử lý.

Thao tác khóa Account và nhận chuyến phải kiểm tra lại cùng trạng thái Account trong transaction. Không chỉ dựa vào bản sao trong cache.

### 7.6. Đăng ký, duyệt tài xế và phân công xe

#### Đăng ký tài xế

POST /driver-applications không yêu cầu user access token nhưng bắt buộc verificationToken và Idempotency-Key.

Trước khi trả kết quả replay:

- Kiểm tra cấu trúc request.
- Xác định verificationToken qua digest và bằng chứng xác minh đã lưu.
- Đối chiếu đúng token, Idempotency-Key, thao tác và nội dung request.
- Không cho phép chỉ biết Idempotency-Key là đọc được kết quả đăng ký.

Nếu có kết quả thành công đã lưu và request khớp, trả lại kết quả đó trước khi áp dụng kiểm tra token đã consumed hoặc hết hạn sau lần đăng ký thành công.

Ngoại lệ replay chỉ trả kết quả cũ; không cho phép tạo tài khoản khác. Key mới với token đã sử dụng bị từ chối theo API 07.

Với yêu cầu tạo mới, thực hiện trong một transaction của cab_core:

1. Khóa và kiểm tra PhoneVerification đúng mục đích DRIVER_REGISTRATION, còn hạn và chưa consumed; kiểm tra lại idempotency để xử lý request đồng thời.
2. Lấy phone từ bằng chứng xác minh; không nhận phone hoặc role do client tự khai báo.
3. Kiểm tra dữ liệu cá nhân, thông tin phương tiện và tính duy nhất của email, phone, licenseNumber.
4. Tạo Account role=DRIVER, accountStatus=ACTIVE.
5. Tạo Driver approvalStatus=PENDING_APPROVAL, driverStatus=OFFLINE và chưa có vehicleId.
6. Tạo DriverApplication status=SUBMITTED, lưu snapshot hồ sơ cùng thời điểm xác minh phone.
7. Đánh dấu PhoneVerification đã consumed.
8. Ghi outbox DRIVER_APPLICATION_SUBMITTED.
9. Lưu kết quả idempotency liên kết với bằng chứng xác minh.
10. Commit trước khi trả 201.

Chưa tạo Vehicle hoặc VehicleAssignment từ thông tin xe khai báo. Các bản ghi xe chính thức được tạo hoặc liên kết khi xét duyệt APPROVE.

Account, Driver, DriverApplication, trạng thái tiêu thụ token, outbox và kết quả idempotency phải cùng thành công hoặc cùng thất bại.

Không tự cấp access token hoặc refresh token trong response đăng ký. Người đăng ký đăng nhập qua API Auth sau khi tạo thành công.

Không lưu verificationToken hoặc mật khẩu dạng rõ trong bản ghi idempotency, audit hoặc log.

#### Xét duyệt hồ sơ

Thực hiện trong một transaction:

1. Kiểm tra quyền OPERATOR và idempotency.
2. Khóa DriverApplication, Driver và dữ liệu xe liên quan.
3. Kiểm tra expectedApplicationVersion.
4. Cập nhật quyết định xét duyệt.
5. Tạo hoặc liên kết Vehicle/VehicleAssignment hợp lệ khi APPROVE.
6. Cập nhật Driver.approvalStatus và version.
7. Giữ Driver OFFLINE.
8. Ghi audit và outbox thông báo.
9. Commit trước khi trả thành công.

Các yêu cầu duyệt lặp không tạo thêm xe, phân công hoặc thông báo.

REJECT bắt buộc có lý do.

#### Phân công xe

Phân công xe phải cập nhật VehicleAssignment, Driver.version và Vehicle.version trong cùng transaction.

Không cho phép tình huống API báo thành công nhưng chỉ một phía Driver hoặc Vehicle đã được cập nhật.

## 8. Idempotency, công việc nền và sự kiện

### 8.1. IdempotencyRecord

Thông tin chính:

- accountId hoặc danh tính dịch vụ.
- operation và đường dẫn đã chuẩn hóa.
- idempotencyKey.
- requestDigest.
- trạng thái xử lý.
- HTTP status và kết quả đã ghi nhận.
- resourceId.
- createdAt, completedAt.

Ràng buộc duy nhất theo danh tính, operation và khóa.

Quy tắc:

- Cùng khóa/cùng nội dung: trả kết quả trước đó.
- Cùng khóa/khác nội dung: 409.
- Đang xử lý: phản hồi đúng hợp đồng, không tạo thao tác thứ hai.
- Phát lại hợp lệ được kiểm tra trước expectedVersion.
- Không lưu mật khẩu, token hoặc toàn bộ request nhạy cảm dạng rõ.
- Bản ghi chống trùng phải có khả năng phục hồi sau khi tiến trình khởi động lại.

Một số endpoint có khóa nghiệp vụ tự nhiên, như accept theo tripRequestId hoặc đánh dấu đọc theo notificationId; áp dụng đúng quy tắc của API tương ứng.
#### Idempotency đối với thanh toán

Với request thanh toán, client gửi lại phải dùng cùng Idempotency-Key.

Một payload giống nhau nhưng dùng key mới không đủ để xác định request lặp; các ràng buộc Payment/Attempt vẫn phải ngăn thu trùng.

- Cùng key và nội dung: trả HTTP status/body đã lưu.
- Cùng key nhưng nội dung khác: trả 409.
- Phải xác thực quyền trước khi trả dữ liệu từ bản ghi idempotency.
### 8.2. Transactional outbox

Khi nghiệp vụ thành công, hệ thống ghi OutboxEvent trong cùng transaction với dữ liệu nghiệp vụ.

CAB Core Worker đọc outbox sau commit, phát message tới RabbitMQ và sử dụng publisher confirms.

Chỉ đánh dấu đã phát sau khi broker xác nhận và message không bị trả lại do không có route phù hợp.

Lỗi hoặc mất xác nhận được retry bằng cùng eventId.

Một sự kiện gồm:

- eventId ổn định.
- eventType.
- schemaVersion.
- producer.
- aggregateType và aggregateId.
- aggregateVersion hoặc revision của nguồn.
- occurredAt.
- correlationId.
- recipientAccountIds nếu sự kiện có người nhận xác định từ nghiệp vụ.
- Payload tối thiểu cần thiết.

Nếu Worker lỗi sau khi gửi nhưng trước khi đánh dấu hoàn tất, sự kiện có thể được gửi lại. Thiết kế phải chấp nhận và xử lý được điều đó.
### 8.3. Inbox và chống xử lý trùng

Notification Service tiếp nhận sự kiện từ RabbitMQ vào inbox bền vững trong cab_notification.

eventId phải duy nhất trên toàn hệ thống, bằng namespace nguồn hoặc cơ chế tương đương. Inbox của Notification đặt ràng buộc duy nhất theo eventId.

consumerName có thể được lưu để truy vết nhưng không thay thế ràng buộc chống trùng eventId của inbox Notification.

Trong một transaction tiếp nhận:

- Xác minh nguồn sự kiện, phiên bản schema và nội dung.
- Ghi sự kiện vào inbox.
- Ghi công việc xử lý bền vững để tạo thông báo cho các người nhận hợp lệ.

Consumer chỉ ACK sau khi transaction trên commit, hoặc sau khi xác nhận đây là sự kiện trùng hợp lệ đã được lưu trước đó.

Nếu tiến trình lỗi sau commit nhưng trước ACK, lần giao lại phải nhận diện được sự kiện cũ và không tạo công việc trùng.

Cùng eventId nhưng khác nội dung chuẩn hóa là xung đột. Không ghi đè sự kiện đã lưu; phải giữ bằng chứng trong khu vực lỗi hoặc DLQ bền vững.

Worker xử lý inbox để tạo và công bố Notification. Mỗi thông báo có khóa chống trùng eventId + recipientAccountId + channel.

Nếu việc xử lý nhiều người nhận bị gián đoạn, phải tiếp tục được phần chưa hoàn tất mà không tạo lại thông báo đã có.

Không chỉ đánh dấu “đã nhận” rồi ACK khi chưa lưu đủ dữ liệu và công việc để phục hồi.

### 8.4. BackgroundJob

Công việc nền có:

- jobId và loại công việc.
- Khóa nghiệp vụ.
- Thời điểm cần chạy.
- Số lần thử.
- Trạng thái.
- Thời điểm hết quyền xử lý của Worker.
- Lỗi gần nhất đã được loại bỏ dữ liệu nhạy cảm.

Worker khác có thể tiếp tục công việc khi Worker trước mất kết nối. Bản thân thao tác xử lý vẫn phải idempotent.

Thời hạn của TripRequest được xác định từ expiresAt/deadlineAt đã lưu, không phụ thuộc Worker có chạy đúng giây hay không.

### 8.5. Thông báo

Một sự kiện nghiệp vụ có thể tạo nhiều thông báo cho các người nhận hợp lệ khác nhau.

Khóa chống trùng:

`eventId + recipientAccountId + channel`

Công bố thông báo phải ghi nội dung, publishedAt và SENT nhất quán.

Lỗi cập nhật realtime không biến thông báo đã có trong hộp thư thành FAILED.

Lỗi thông báo không đảo ngược Booking, Trip hoặc Payment.
Kết quả duyệt hồ sơ tạo thông báo IN_APP cho Account DRIVER tương ứng qua:

- DRIVER_APPLICATION_APPROVED.
- DRIVER_APPLICATION_REJECTED.

Các sự kiện này dùng referenceType=DRIVER_APPLICATION.

Các eventType DRIVER_APPLICATION_APPROVED, DRIVER_APPLICATION_REJECTED và referenceType=DRIVER_APPLICATION đã được mô tả trong API Notification phiên bản 1.2.0.

Producer, consumer và test case phải sử dụng cùng hợp đồng sự kiện. Không tự đổi tên event hoặc tạo một đường gửi HTTP thay thế luồng RabbitMQ.

Thông báo được tạo từ kết quả nghiệp vụ đã commit, không lấy quyết định xét duyệt do client tự cung cấp.
### 8.6. Cấu hình RabbitMQ và phục hồi

Cấu hình đề xuất:

- Dùng topic exchange bền vững cab.events.
- Queue thông báo: cab.notification.events.
- Message được cấu hình persistent.
- Producer dùng publisher confirms và kiểm tra lỗi định tuyến.
- Consumer dùng manual acknowledgement.
- Consumer ghi inbox và công việc xử lý bền vững trong cùng transaction của cab_notification.
- Chỉ ACK sau commit hoặc sau khi xác nhận message trùng hợp lệ đã được tiếp nhận.
- Worker tạo và công bố Notification từ công việc đã lưu; không bắt buộc hoàn tất công bố hộp thư trước ACK.
-- Inbox Notification nhận diện sự kiện trùng theo eventId duy nhất; nội dung chuẩn hóa phải khớp với sự kiện đã lưu.
- Lỗi tạm thời được retry có khoảng chờ; đề xuất tối đa năm lần.
- Lỗi vượt giới hạn hoặc payload không hợp lệ chuyển dead-letter queue để kiểm tra.
- Không requeue tức thì vô hạn.
- Replay từ dead-letter queue giữ eventId gốc để chống trùng.
- Tài khoản RabbitMQ được giới hạn quyền publish/consume theo dịch vụ.

Khi RabbitMQ dừng:

- Nghiệp vụ đã commit vẫn được giữ trong database.
- Sự kiện chưa phát nằm ở outbox.
- Khi broker hoạt động lại, Worker phát tiếp.

Bằng chứng demo cần có:

1. Message được publish.
2. Message được consumer xử lý.
3. Một tình huống giao lặp nhưng không tạo dữ liệu trùng.
4. Một tình huống phục hồi sau lỗi.

Chỉ khởi động container RabbitMQ chưa đủ chứng minh IPC hoạt động.
## 9. GPS, tracking và dữ liệu tính cước

### 9.1. Tách ba loại dữ liệu

| Loại dữ liệu | Mục đích |
|---|---|
| DriverLocation | Vị trí mới nhất của tài xế |
| TripRoutePoint | Các mẫu hành trình gắn với một chuyến |
| TripStatusHistory | Lịch sử thay đổi trạng thái nghiệp vụ |

Không thể dùng một bản ghi vị trí mới nhất để tính quãng đường thực tế của cả chuyến.

### 9.2. Tiếp nhận vị trí

- Driver được xác định từ Account đăng nhập.
- Kiểm tra phạm vi tọa độ và recordedAt.
- receivedAt do máy chủ ghi.
- Bản ghi cũ hơn không ghi đè vị trí mới.
- Cùng recordedAt nhưng khác tọa độ là xung đột.
- Gửi GPS không tự đặt Driver AVAILABLE.
- Không tăng version của trạng thái Trip chỉ vì vị trí thay đổi.

Khi gắn điểm vào hành trình:

- Máy chủ xác định Trip của Driver.
- Kiểm tra thời gian của mẫu có thuộc giai đoạn di chuyển của Trip.
- Không gắn mẫu cũ của chuyến trước vào chuyến mới.
- Ghi nhận nguồn và thời điểm để phục vụ đánh giá chất lượng dữ liệu.

### 9.3. Theo dõi

Tracking trả trạng thái:

- LIVE.
- STALE.
- UNAVAILABLE.
- STOPPED.

Khi Trip đã đóng:

- Không trả vị trí trực tiếp của Driver.
- Không tiếp tục theo dõi Driver trên chuyến khác.
- Không cung cấp ETA đang hoạt động.

ETA chỉ áp dụng khi Driver đang đến điểm đón và có nguồn dữ liệu phù hợp. Không có dữ liệu phải thể hiện không khả dụng, không giả thành 0 giây.

### 9.4. JourneyMetrics và chốt Fare

JourneyMetrics là dữ liệu nội bộ dùng để xác nhận quãng đường và thời gian trước khi phát hành Fare.

Các trạng thái chất lượng dự kiến:

- PENDING: chưa hoàn tất xử lý hoặc chưa đủ dữ liệu để kết luận.
- CONFIRMED: dữ liệu đã đáp ứng tiêu chí xác nhận được phê duyệt.
- REVIEW_REQUIRED: dữ liệu thiếu, bất thường hoặc cần xử lý theo quy trình rà soát.

Các nguyên tắc đã thống nhất:

- Thời gian chuyến dựa trên startedAt và completedAt theo hợp đồng Trip.
- Khôi phục Trip sau ERROR không đặt lại startedAt.
- Không lấy khoảng cách đường thẳng giữa điểm đón và điểm đến thay cho quãng đường thực tế.
- Không cộng mọi mẫu GPS chưa kiểm tra rồi mặc nhiên coi là dữ liệu đủ tin cậy để thu tiền.
- Không thay quãng đường hoặc thời gian còn thiếu bằng số 0.
- Fare sử dụng PricingSnapshot đã chốt cho Booking.
- Fare lưu metricsVersion được dùng khi tính.
- Fare đã phát hành không bị âm thầm sửa theo dữ liệu GPS hoặc biểu giá mới.
- Chỉ phát hành Fare cuối cùng khi Trip COMPLETED và JourneyMetrics đủ điều kiện CONFIRMED.
- Chỉ tạo Payment khi đã có Fare hợp lệ.

Phần chưa chốt trước khi triển khai tính cước:

1. Phương pháp dựng quãng đường từ chuỗi điểm hành trình và việc có sử dụng dịch vụ định tuyến hay không.
2. Tiêu chí phát hiện, loại bỏ hoặc xử lý mẫu GPS nhảy vị trí, sai thứ tự, mất mẫu và bất thường.
3. Ngưỡng chất lượng cụ thể cho phép chuyển JourneyMetrics sang CONFIRMED.
4. Cách xử lý thời gian và quãng đường trong giai đoạn Trip gặp sự cố.
5. Quy trình rà soát dữ liệu REVIEW_REQUIRED, gồm người có quyền, dữ liệu được phép bổ sung, bằng chứng và audit.
6. Cách tạo phiên bản metrics mới và xử lý yêu cầu tính lại trước khi Fare được phát hành.

Các quyết định trên phải được mô tả và bổ sung ca kiểm thử trước khi triển khai phần phụ thuộc. Tài liệu hiện chưa xác nhận một thuật toán tính quãng đường cụ thể.

Khi dữ liệu chưa đủ điều kiện:

- Trip vẫn giữ COMPLETED.
- Fare chưa sẵn sàng.
- Không tạo Fare bằng 0 để bỏ qua lỗi.
- Không tạo Payment hoặc yêu cầu thu tiền.

Dữ liệu JourneyMetrics giả lập chỉ dùng trong môi trường kiểm thử có ghi rõ. Kết quả kiểm thử bằng dữ liệu giả lập không chứng minh thuật toán xử lý GPS thực tế đã hoàn thiện.

## 10. Tích hợp thanh toán

### 10.1. Không giữ transaction trong lúc gọi nhà cung cấp

Luồng thanh toán điện tử:

1. Trong transaction, tạo Payment/Attempt và merchantReference.
2. Ghi công việc gửi sang nhà cung cấp.
3. Commit.
4. Worker gọi nhà cung cấp bên ngoài transaction.
5. Ghi nhận kết quả đã xác minh.

Việc database đã commit không chứng minh nhà cung cấp đã thu tiền, và ngược lại.

### 10.2. Timeout và kết quả chưa rõ

Nếu không xác định được nhà cung cấp đã xử lý hay chưa:

- Giữ thông tin Attempt và merchantReference.
- Đánh dấu UNKNOWN theo hợp đồng.
- Không tạo Attempt khác.
- Đối soát bằng truy vấn có thẩm quyền.
- Không suy luận FAILED chỉ vì hết thời gian chờ.

Nếu không có API truy vấn phù hợp, giữ trạng thái chưa rõ và chuyển sang quy trình rà soát; không tự thu lại.

### 10.3. Webhook

Webhook phải:

- Xác thực nguồn và chữ ký theo raw payload.
- Kiểm tra merchantReference/transaction reference.
- Kiểm tra amount và currency.
- Chống trùng theo sự kiện nhà cung cấp.
- Kiểm tra trạng thái và version hiện tại.
- Lưu bền vững trước khi xác nhận đã tiếp nhận theo giao thức provider.

Redirect từ trình duyệt không phải bằng chứng thanh toán.

SUCCESS muộn hoặc dữ liệu mâu thuẫn phải được giữ bằng chứng và đánh dấu requiresReview. Không tự ghi đè lịch sử hoặc thực hiện hoàn tiền chưa có trong MVP.

Hợp đồng cụ thể của webhook còn phụ thuộc việc lựa chọn nhà cung cấp.

### 10.4. Tiền mặt

Tạo Payment có method=CASH chỉ ghi nhận nghĩa vụ thanh toán ở trạng thái PENDING; không đồng nghĩa tài xế đã nhận tiền.

Chỉ DRIVER được gán cho Trip, có Account và Session hợp lệ, được xác nhận đã nhận đủ tiền qua API confirm-cash.

Máy chủ xác định người xác nhận từ danh tính đăng nhập. Request không được tự cung cấp amount hoặc confirmedByAccountId.

Với yêu cầu xác nhận mới:

- Kiểm tra quyền trên Trip và Payment.
- Kiểm tra Idempotency-Key, expectedVersion và trạng thái hiện tại.
- Kiểm tra attempt hiện tại là CASH và đủ điều kiện xác nhận.
- Từ chối khi requiresReview=true hoặc có điều kiện ngăn xác nhận theo API 05.

Trong cùng transaction của cab_core:

- Cập nhật Payment và PaymentAttempt thành SUCCESS.
- Ghi paidAt của Payment và resolvedAt của PaymentAttempt.
- Ghi confirmedByAccountId là accountId của DRIVER xác nhận.
- Cập nhật version và các thời điểm liên quan.
- Ghi audit, outbox và kết quả idempotency.

Replay hợp lệ phải kiểm tra quyền hiện tại rồi trả HTTP status/body đã lưu trước khi áp dụng lại điều kiện version hoặc trạng thái đã thay đổi sau lần thành công.

Replay không ghi lại paidAt, không tăng version và không tạo thêm sự kiện hoặc lần thanh toán.

Xác nhận tiền mặt không đổi trạng thái Trip hoặc Driver.

OPERATOR không được xác nhận tiền mặt thay tài xế và không có API cưỡng chế Payment thành SUCCESS.
### 10.5. Kịch bản thanh toán online theo rubric

Phải chọn ít nhất một nhà cung cấp thanh toán có môi trường sandbox và tài liệu tích hợp phù hợp.

Luồng demo:

1. Hoàn thành Trip.
2. Có JourneyMetrics và Fare hợp lệ.
3. Customer tạo yêu cầu thanh toán online.
4. Hệ thống tạo Payment/Attempt và merchantReference ổn định.
5. Customer thực hiện thanh toán trên sandbox của nhà cung cấp.
6. Callback/webhook đi qua Gateway đến CAB Core.
7. Hệ thống xác minh nguồn, chữ ký, số tiền, tiền tệ và mã tham chiếu.
8. Payment chuyển SUCCESS; paidAt được ghi.
9. API đọc kết quả thể hiện chuyến đã thanh toán thông qua Payment liên kết.
10. Gửi lại callback và request cũ không tạo lần thu tiền mới.

Trip vẫn giữ COMPLETED sau thanh toán; không thêm trạng thái Trip PAID.

Không dùng việc client tự gửi paymentStatus=SUCCESS hoặc redirect trình duyệt để chứng minh đã thanh toán.

Nếu mới dùng provider giả lập, phải ghi rõ đó là kiểm thử tích hợp giả lập; chưa coi là đã hoàn thành tích hợp sandbox bên ngoài.

## 11. Lựa chọn cơ sở dữ liệu và chỉ mục

### 11.1. Ba database theo dịch vụ

| Database | Dữ liệu |
|---|---|
| cab_core | Identity, Booking, Dispatch, Trip, Billing, Fleet và hạ tầng của CAB Core |
| cab_rating | Rating, idempotency, audit và hạ tầng của Rating Service |
| cab_notification | Notification, inbox, job và hạ tầng của Notification Service |

Mỗi dịch vụ dùng database role riêng, không có quyền đọc/ghi database khác.

Có thể chạy cả ba database trên một PostgreSQL server trong môi trường local.

Không sử dụng cross-database query để thay thế IPC.

Khóa ngoại chỉ áp dụng bên trong database tương ứng.

Các ID trỏ sang dịch vụ khác phải được kiểm tra qua hợp đồng hoặc sự kiện có nguồn đáng tin cậy.

### 11.2. Ràng buộc quan trọng

| Dữ liệu | Ràng buộc |
|---|---|
| Account | Unique emailLookupHash, phoneLookupHash |
| Customer/Operator/Driver | Unique accountId trong hồ sơ tương ứng |
| Driver | Unique licenseLookupHash |
| PhoneVerification | Chỉ được consumed một lần |
| DriverApplication | Gắn với Driver; bản MVP chỉ có một hồ sơ đăng ký ban đầu cho mỗi Driver |
| CustomerActivityGuard | Primary key customerId |
| DispatchProcess | Unique bookingId |
| TripRequest | Không có hai đề nghị PENDING của cùng tiến trình |
| Trip | Unique bookingId; tối đa một Trip chưa đóng cho mỗi Driver/Vehicle |
| VehicleAssignment | Unique Driver và Vehicle trong các phân công chưa kết thúc |
| PricingConfig | Unique vehicleType + effectiveFrom |
| Fare | Unique tripId |
| Payment | Unique fareId và tripId |
| PaymentAttempt | Unique paymentId + attemptNumber |
| Rating | Unique tripId; score trong 1..5 |
| Notification | Unique eventId + recipientAccountId + channel |
| InboxReceipt | Unique consumerName + eventId |
| IdempotencyRecord | Unique danh tính + operation + key |

Các ràng buộc được thực hiện trong database của dịch vụ sở hữu dữ liệu.

Không thay thế các ràng buộc này bằng thao tác “SELECT thấy chưa có rồi INSERT” đơn thuần.

### 11.3. Chỉ mục truy vấn

- Booking theo customerId và createdAt.
- Trip theo customerId/driverId và createdAt.
- Trip hoạt động theo closedAt và trạng thái.
- TripRequest theo driverId, status và expiresAt.
- Notification theo recipientAccountId, deliveryStatus, publishedAt và notificationId.
- Rating theo driverId, createdAt và ratingId.
- Payment theo paymentStatus/requiresReview và createdAt.
- Công việc nền theo trạng thái và thời điểm cần chạy.

Chỉ mục thực tế phải được kiểm tra bằng dữ liệu và truy vấn của hệ thống, không thêm mọi tổ hợp một cách mặc định.

### 11.4. Redis

Redis được dùng cho bộ đếm rate limit dùng chung giữa các tiến trình Gateway.

Cache vị trí hoặc kết quả nearby là tùy chọn và phải tái tạo được từ dữ liệu có thẩm quyền.

Không dùng Redis làm nơi duy nhất lưu:

- Booking.
- TripRequest và kết quả accept/reject.
- Trip và lịch sử.
- Incident.
- Fare/Payment.
- Kết quả idempotency quan trọng.

Khi Redis không khả dụng, các endpoint cần giới hạn để ngăn lạm dụng như login, OTP và tạo Booking trả lỗi tạm thời 503 theo chính sách fail-closed.

Không âm thầm bỏ toàn bộ giới hạn.

Mất Redis không được làm mất dữ liệu nghiệp vụ đã commit trong PostgreSQL.

## 12. Bảo mật và vận hành

### 12.1. Phân quyền

Kiểm tra cả:

- Tài khoản.
- Session.
- Role.
- Quyền trên đối tượng cụ thể.

Ví dụ, role CUSTOMER không cho phép xem Trip của mọi khách hàng.

API nội bộ xác thực danh tính dịch vụ và quyền cụ thể. Không dùng user token thay service token.

Khi Worker gọi trực tiếp giao diện module trong cùng ứng dụng, phải có danh tính và quyền công việc nội bộ tương ứng; không giả làm một OPERATOR.

### 12.2. Quản lý cấu hình và bí mật

- Giá trị bí mật được cung cấp qua môi trường chạy hoặc nơi quản lý bí mật.
- Không commit file chứa mật khẩu database, khóa ký hoặc secret provider.
- Tách môi trường phát triển, kiểm thử và triển khai.
- Dữ liệu seed là dữ liệu giả.
- Không ghi token hoặc raw thông tin thanh toán nhạy cảm vào log.
#### Quy tắc quản lý cấu hình trong repository

Repository cần có:

- .gitignore loại trừ .env, .env.*, secrets, private keys và file dữ liệu cục bộ.
- Ngoại lệ cho .env.example chỉ chứa tên biến và giá trị minh họa không bí mật.
- .dockerignore ngăn đưa secret vào image.

Secret được cấp lúc chạy; không hardcode trong Dockerfile, Compose hoặc source code.

Khóa mã hóa, khóa tra cứu HMAC, khóa JWT và credential provider được tách mục đích.

Khi có nghi ngờ lộ secret, phải kiểm tra cả file đang theo dõi và lịch sử Git.

Thêm .gitignore không xóa bí mật đã commit trước đó.

### 12.3. Audit và quan sát hệ thống

Mỗi thao tác quan trọng cần correlationId để theo dõi qua API, Worker và dịch vụ ngoài.

Theo dõi ít nhất:

- Độ trễ API.
- Công việc nền quá hạn.
- Outbox chưa xử lý.
- Đề nghị nhận chuyến quá hạn chưa được chốt.
- Payment UNKNOWN hoặc requiresReview.
- Thông báo FAILED.
- Trip ERROR chưa đóng.

Audit nghiệp vụ cần được lưu bền vững. Log kỹ thuật không thay thế AuditLog.

### 12.4. Healthcheck

| Endpoint qua Gateway | Quyền | Kết quả |
|---|---|---|
| GET /health | Không cần đăng nhập; nội dung tối thiểu | 200 khi tiến trình Gateway còn hoạt động |
| GET /ready | Không cần đăng nhập; nội dung tối thiểu | 200 khi các thành phần bắt buộc sẵn sàng; 503 khi chưa sẵn sàng |
| GET /health/services | OPERATOR | Danh sách thành phần và healthy/degraded/unavailable; 503 nếu thành phần bắt buộc không sẵn sàng |

Danh sách kiểm tra gồm:

- CAB Core API.
- CAB Core Worker.
- Rating Service.
- Notification Service.
- PostgreSQL.
- Redis.
- RabbitMQ.

Mỗi dịch vụ có liveness và readiness nội bộ.

Gateway tổng hợp với timeout hữu hạn; không chờ vô hạn khi một thành phần lỗi.

Worker có heartbeat và thời điểm tiến triển gần nhất. Tiến trình tồn tại nhưng không xử lý công việc không đủ để kết luận khỏe.

Readiness thất bại không khiến mọi handler tự động trả lỗi. Các chức năng độc lập vẫn có thể được phục vụ nếu còn đủ phụ thuộc.

Ví dụ, xem Trip có thể hoạt động khi Notification đang lỗi.

Tình trạng provider thanh toán được báo riêng. Provider lỗi không làm API xem hồ sơ hoặc xem chuyến bị coi là mất dữ liệu.

Health response không chứa:

- Mật khẩu.
- Connection string.
- Khóa.
- Token.
- Stack trace.

### 12.5. Sao lưu và phục hồi

Sao lưu dữ liệu nghiệp vụ cùng thông tin cần phục hồi công việc nền và chống trùng.

Sau phục hồi:

- Quét công việc chưa hoàn tất.
- Xử lý đề nghị đã quá expiresAt.
- Không đặt lại deadline điều phối.
- Đối soát Attempt có kết quả chưa rõ.
- Không phát sinh lần thu tiền mới chỉ vì dữ liệu tiến trình bị gián đoạn.

Mục tiêu sao lưu và kiểm thử phục hồi thực hiện theo SRS. Chưa có kết quả phục hồi thực tế ở giai đoạn thiết kế.
### 12.6. Bảo vệ dữ liệu lưu trữ

Mật khẩu được băm bằng Argon2id với salt riêng; không mã hóa theo cách có thể giải ngược.

Email, số điện thoại và số giấy phép được mã hóa ở tầng ứng dụng bằng thuật toán mã hóa có xác thực, đề xuất AES-256-GCM với thư viện chuẩn.

Mỗi lần mã hóa dùng nonce phù hợp. Dữ liệu lưu gồm:

- Ciphertext.
- Nonce.
- Authentication tag.
- keyVersion.

Khóa không nằm trong database chứa ciphertext.

Môi trường local dùng secret file nằm ngoài Git, chỉ cấp cho dịch vụ cần thiết.

Phải có cách xoay khóa, lưu keyVersion và kiểm thử đọc dữ liệu cũ sau xoay khóa.

Giá trị tra cứu dùng HMAC với khóa riêng; không tạo cột plaintext phụ để phục vụ tìm kiếm.

Audit, log, event và outbox không được sao chép dữ liệu nhạy cảm dạng rõ một cách không cần thiết.

Kịch bản chấm:

1. Đọc trực tiếp bảng bằng tài khoản database không có khóa ứng dụng.
2. Xác nhận không nhìn thấy password, email, phone hoặc giấy phép dạng rõ.
3. Chứng minh API có quyền vẫn hoạt động.

Bảo vệ này không có nghĩa mọi trường trong database đều đã được mã hóa hoặc hệ thống vẫn an toàn khi cả database và khóa ứng dụng cùng bị lộ.

### 12.7. Chống SQL injection

- Dùng truy vấn tham số hóa.
- Không ghép input trực tiếp vào SQL.
- Các trường sort hoặc tên cột động phải qua danh sách cho phép.
- ORM không thay thế quy tắc an toàn khi viết raw query.
- Database role của dịch vụ chỉ có quyền cần thiết.

Payload email "' OR 1=1 --" không đăng nhập được và không làm lộ lỗi SQL.

Phản hồi 400 hoặc 401 theo bước kiểm tra.

### 12.8. Chống XSS

Tên, ghi chú và nhận xét được xử lý như văn bản; MVP không cho phép người dùng soạn HTML.

API trả JSON với Content-Type phù hợp.

Khi hiển thị lên giao diện:

- Encode dữ liệu theo ngữ cảnh.
- Không đưa nội dung người dùng vào innerHTML.
- Không coi JSON escaping là bằng chứng đủ để ngăn XSS trên giao diện.

Kịch bản kiểm tra gửi chuỗi <script>alert('hack')</script> qua API và xác minh nơi hiển thị không thực thi script.

Postman kiểm tra hợp đồng API. Kiểm tra thực thi cần bổ sung trình duyệt hoặc kiểm thử giao diện.

### 12.9. JWT và truy cập trái phép

- Kiểm tra chữ ký bằng thuật toán nằm trong danh sách cho phép.
- Kiểm tra issuer, audience, thời hạn và Session.
- Không chấp nhận token chỉ vì có thể decode payload.
- Token bị sửa sub/role nhưng không có chữ ký hợp lệ trả 401.
- Token hợp lệ nhưng sai role của chức năng trả 403.
- Kiểm tra quyền sở hữu dữ liệu sau kiểm tra role.
- User token không thay service token.
- Account bị khóa hoặc Session bị thu hồi không tiếp tục dùng được chỉ vì access token chưa hết hạn.

### 12.10. Rate limiting

Giới hạn được áp dụng tại Gateway và có kiểm soát nghiệp vụ tại dịch vụ đích.

Cấu hình khởi đầu đề xuất:

- Login: giới hạn theo IP và định danh đăng nhập.
- OTP: giới hạn theo IP, số điện thoại và challenge.
- Tạo Booking: tối đa 10 request/phút/tài khoản.
- Có giới hạn tổng thể theo IP, kích thước body và số kết nối.

Ngưỡng cụ thể được cấu hình và điều chỉnh sau đo kiểm.

Vượt ngưỡng trả 429 và Retry-After.

Kịch bản hơn 1.000 request/giây trong rubric là tải kiểm chứng. Cần đo:

- Số phản hồi 429.
- Độ trễ.
- Tài nguyên sử dụng.
- Khả năng phục vụ sau đợt tải.

Chưa có kết quả đo thì không tuyên bố hệ thống đã chịu được mức tải này.

Các header xác định IP từ proxy chỉ được tin khi đến từ proxy được cấu hình tin cậy.
## 13. Báo cáo và dữ liệu tổng hợp

Báo cáo cơ bản dùng định nghĩa:

- Số chuyến: theo Trip.createdAt.
- Chuyến hủy: Trip CANCELLED trong cùng tập chuyến của kỳ.
- Tỷ lệ hủy: cancelledTrips / totalTrips.
- Không có Trip: tỷ lệ trả null.
- Không tìm được tài xế: chỉ số Booking riêng.
- Doanh thu ghi nhận: Payment SUCCESS theo paidAt.
- PaymentAttempt không được cộng như một Payment riêng.
- CASH PENDING không được tính là đã thu.

Trong bản đầu, báo cáo phải đọc dữ liệu theo một ảnh chụp nhất quán.

Nếu tách dịch vụ và dùng projection:

- Mỗi đối tượng tổng hợp phải có khóa duy nhất theo nguồn.
- Sự kiện lặp không được cộng số tiền lần nữa.
- Xử lý version để không ghi đè bằng sự kiện cũ.
- Chỉ công bố snapshotAt mà nguồn dữ liệu đã được tổng hợp đầy đủ.
- Chưa đủ dữ liệu thì không dùng số 0 thay cho dữ liệu thiếu.

## 14. Lộ trình phát triển kiến trúc

### 14.1. Kiến trúc của bản nộp

Bản nộp triển khai:

- CAB Core.
- Rating Service.
- Notification Service.

Các dịch vụ giao tiếp qua HTTP nội bộ và RabbitMQ. Truy cập từ ngoài đi qua Gateway.

Notification và Rating đã thuộc phạm vi tách dịch vụ của thiết kế này, không còn là bước tùy chọn sau MVP.

### 14.2. Các bước thiết kế và xây dựng

1. Đồng bộ SRS, API và test case theo rubric.
2. Chốt hợp đồng OTP, hồ sơ tài xế, dữ liệu tính cước và payment sandbox.
3. Tạo cấu trúc source, cấu hình môi trường và migration.
4. Xây các module CAB Core và kiểm thử các transaction quan trọng.
5. Xây Rating, Notification, IPC và xử lý lỗi.
6. Bổ sung Gateway, Compose, healthcheck và bảo mật.
7. Chuẩn bị dữ liệu demo, Postman collection và bằng chứng theo 30 tiêu chí.

### 14.3. Tách thêm dịch vụ trong tương lai

Chỉ tách Booking, Dispatch, Trip, Fleet hoặc Billing khi đã thiết kế:

- Quyền sở hữu dữ liệu sau tách.
- Giữ chỗ Customer/Driver/Vehicle.
- Tranh chấp accept/cancel.
- Điều phối nhiều bước và thao tác bù.
- Phục hồi khi mất phản hồi hoặc coordinator lỗi.
- Chống xử lý lặp.
- Cách thể hiện trạng thái trung gian trên API.

Saga không tạo transaction nguyên tử trên nhiều database.

Nếu việc tách làm thay đổi phản hồi 200 thành 202 hoặc cần thêm trạng thái chờ, phải sửa SRS, API và test case trước.
## 15. Đối chiếu kiểm thử và các điểm cần chốt

### 15.1. Các kiểm thử bảo vệ kiến trúc

| Rủi ro | Test case tiêu biểu |
|---|---|
| Hai Booking hoạt động của cùng khách | TC-BOOKING-023 |
| Hủy và nhận chuyến cùng thắng | TC-BOOKING-024 |
| Một Driver nhận hai Trip | TC-DISPATCH-024 |
| Khởi động lại làm tăng thời gian tìm tài xế | TC-DISPATCH-023 |
| Phát lại accept đặt BUSY trở lại | TC-DISPATCH-025 |
| Ghi đè bằng version cũ | TC-TRIPSTATUS-021 |
| Khôi phục ERROR đặt lại startedAt | TC-TRIPSTATUS-026 |
| Lộ GPS chuyến mới cho khách cũ | TC-TRACKING-023 |
| CASH được coi thành công trước xác nhận | TC-PAYMENT-003, TC-PAYMENT-021 |
| UNKNOWN vẫn cho thu lại | TC-PAYMENT-023 |
| Callback lặp làm tăng doanh thu | TC-PAYMENT-025 |
| Rating phụ thuộc thanh toán thành công | TC-RATING-024 |
| Sự kiện lặp tạo thông báo trùng | TC-NOTIF-023 |
| Một xe gán cho hai tài xế | TC-ADMIN-023 |
| Khóa Account tự làm kết thúc chuyến | TC-ADMIN-028 |

Các test case hiện đều NOT_RUN. Tài liệu không khẳng định hệ thống đã vượt qua các kiểm thử này.

### 15.2. Ma trận bằng chứng theo rubric

| Tiêu chí | Nội dung cần chứng minh |
|---|---|
| 1 | Cấu trúc source, trách nhiệm từng dịch vụ/module |
| 2 | .gitignore, .env.example; không có secret trong file được commit |
| 3 | Định tuyến, xác thực và rate limit tại Gateway |
| 4 | Rating gọi CAB Core qua HTTP; Core phát sự kiện cho Notification qua RabbitMQ |
| 5 | Compose chạy đủ container và liệt kê được tình trạng |
| 6 | /health, /ready, /health/services phản ánh tình trạng thực |
| 7 | RabbitMQ có publish/consume, retry và xử lý message lặp |
| 8 | Client gọi được qua Gateway; không có cổng backend công khai |
| 9 | Đăng ký Customer thành công, sau đó đăng nhập được |
| 10 | Login cấp token hợp lệ |
| 11 | Tra cứu Customer theo mã, có token và kiểm tra quyền |
| 12 | Tra cứu Driver theo mã, có token và kiểm tra quyền |
| 13 | Tìm tài xế trong 1 km, giới hạn và phân trang; loại tài xế không đủ điều kiện |
| 14 | Có ít nhất năm Booking của Customer để kiểm tra danh sách và phân trang |
| 15 | Tạo Booking, chuyển tìm tài xế, phát offer |
| 16 | Driver nhận offer, accept tạo Trip và khách nhận thông tin tài xế |
| 17 | Chuyển trạng thái đúng thứ tự, cập nhật vị trí, hoàn thành |
| 18 | Hủy chuyến hợp lệ có lý do, trạng thái và thông báo đúng |
| 19 | Thanh toán online qua sandbox, callback xác minh, Payment SUCCESS |
| 20 | Rating lưu đúng Trip/Customer/Driver |
| 21 | OTP, gửi hồ sơ tài xế và trạng thái chờ duyệt |
| 22 | Xem hồ sơ, duyệt/từ chối và tài xế nhận kết quả |
| 23 | Driver bật/tắt nhận chuyến đúng điều kiện |
| 24 | Password hash, dữ liệu nhạy cảm mã hóa, có quản lý khóa |
| 25 | SQL injection không vượt đăng nhập hoặc lộ dữ liệu |
| 26 | Nội dung XSS không thực thi tại nơi hiển thị |
| 27 | JWT bị sửa bị từ chối 401 |
| 28 | Customer gọi chức năng riêng của Driver bị từ chối 403 |
| 29 | Vượt giới hạn trả 429; ghi nhận kết quả kiểm thử tải |
| 30 | Replay payment trả kết quả cũ, không thêm giao dịch hoặc thu trùng |

Ma trận trên mô tả bằng chứng cần chuẩn bị, không phải kết quả kiểm thử đã đạt.
### 15.3. Dữ liệu demo

Chuẩn bị tối thiểu:

- Customer A và B để kiểm tra quyền sở hữu.
- Driver đã duyệt và Driver đang chờ duyệt.
- Một OPERATOR.
- Ít nhất năm Driver có trạng thái/điều kiện khác nhau.
- Trong tập Driver, có ít nhất hai người đủ điều kiện trong 1 km để kiểm tra phân trang.
- Có Driver ngoài 1 km, Driver OFFLINE/BUSY và Driver có GPS cũ để kiểm tra bộ lọc.
- Ít nhất năm Booking thuộc Customer A.
- Thêm Booking của Customer B để kiểm tra không lộ dữ liệu.
- Trip tại các trạng thái cần cho accept, hủy, hoàn tất và đánh giá.
- Payment có SUCCESS, FAILED hoặc UNKNOWN phục vụ các tình huống liên quan.

Dữ liệu là dữ liệu giả.

Timestamp GPS được làm mới khi bắt đầu demo. Không dùng vị trí cũ rồi tự bỏ điều kiện freshness để cho kiểm thử đạt.

Postman collection tổ chức thành ba nhóm theo ba phần rubric.

Các biến môi trường gồm:

- Gateway URL.
- Token.
- ID đối tượng.
- Idempotency-Key.

Không commit token thật.
### 15.4. Baseline thiết kế và quyết định còn mở

#### Nội dung đã được cụ thể hóa trong baseline 1.2

- Ba dịch vụ nghiệp vụ: CAB Core, Rating và Notification.
- CAB Core API và CAB Core Worker là hai tiến trình của cùng dịch vụ CAB Core.
- API Gateway là cửa vào cho HTTP request từ bên ngoài; giao tiếp nội bộ tuân theo hợp đồng xác thực dịch vụ.
- Ba database cab_core, cab_rating và cab_notification có quyền truy cập riêng.
- Luồng thông báo nghiệp vụ sử dụng transactional outbox, RabbitMQ và inbox bền vững.
- Tài xế đăng ký qua OTP và DriverApplication; OPERATOR xét duyệt qua endpoint review.
- Không có POST /operations/drivers để tạo tài xế trực tiếp trong phiên bản hiện tại.
- Độ mới GPS tính từ recordedAt đã được kiểm tra; ngưỡng MVP là 30 giây. Không dùng receivedAt của lần gửi lại để làm mẫu cũ trở thành mới.
- Booking không chấp nhận điểm đón và điểm đến có cùng cặp tọa độ. Hai chuỗi địa chỉ giống nhau không tự thay thế kiểm tra tọa độ.
- fullName được trim hai đầu và phải có ít nhất một ký tự không phải khoảng trắng; nội dung được xử lý như văn bản.
- Điểm trung bình/xếp hạng tài xế và tìm kiếm tài khoản theo keyword nằm ngoài phạm vi API hiện tại.
- Payment SUCCESS tương ứng ý nghĩa thanh toán COMPLETED trong rubric; Trip COMPLETED là trạng thái độc lập.
- Người xác nhận tiền mặt được lưu bằng confirmedByAccountId.

Các nội dung trên phải được giữ thống nhất giữa SRS, API, thiết kế dữ liệu và kiểm thử. Không tiếp tục liệt kê chúng như những lựa chọn chưa xác định.

#### Quyết định còn mở trước khi xây phần phụ thuộc

| Hạng mục | Nội dung phải chốt | Phần bị ảnh hưởng |
|---|---|---|
| Nhà cung cấp OTP | Nhà cung cấp/kênh gửi, tài khoản thử nghiệm, hợp đồng gửi, kết quả gửi, timeout, retry và giới hạn; cách phân biệt giả lập với tích hợp bên ngoài | Đăng ký tài xế qua OTP |
| Thanh toán sandbox | Nhà cung cấp, phương thức hỗ trợ, tạo/tra cứu giao dịch, chữ ký và payload webhook, acknowledgement, idempotency, timeout và đối soát | Thanh toán online và chống thu tiền trùng |
| JourneyMetrics | Thuật toán xác nhận quãng đường, chất lượng GPS, xử lý mất mẫu/sự cố và quy trình REVIEW_REQUIRED theo mục 9.4 | Tính cước và tạo Payment |
| Chính sách vận hành | Hoàn thiện cấu hình retry/backoff theo từng loại công việc, thời hạn lưu dữ liệu, thời hạn giữ bằng chứng chống trùng, xoay khóa, sao lưu và phục hồi | Worker, outbox/inbox, bảo mật và khả năng phục hồi |

Các thông số đã được quy định trong API hoặc SRS phải được giữ nguyên cho đến khi có thay đổi được duyệt. Việc hoàn thiện cấu hình vận hành không được âm thầm thay đổi hợp đồng nghiệp vụ.

Không dùng việc đổi tên trường hoặc thêm mô tả để coi các quyết định còn mở là đã hoàn tất.

#### Trạng thái bộ kiểm thử

CAB_Test_Cases_ver_1.xlsx hiện có:

- 16 sheet.
- 398 ca kiểm thử.
- 394 ca đang áp dụng.
- 4 ca OUT_OF_SCOPE hoặc SUPERSEDED, giữ lại để truy vết.
- 11 ca NEEDS_DECISION trong các ca đang áp dụng.
- Tất cả ca có Execution Status=NOT_RUN.
- Sheet Rubric Mapping đối chiếu đủ 30 tiêu chí.

Các ca NEEDS_DECISION gồm:

- Thanh toán: TC-PAYMENT-004, TC-PAYMENT-007, TC-PAYMENT-008, TC-PAYMENT-015, TC-PAYMENT-017, TC-PAYMENT-024, TC-PAYMENT-025, TC-PAYMENT-026 và TC-PAYMENT-037.
- OTP bên ngoài: TC-DREG-030.
- Kiểm chứng không thu tiền trùng xuyên suốt hệ thống và nhà cung cấp: TC-SEC-018.

Danh sách 11 ca trên phản ánh những ca đã được đánh dấu trong workbook; không thay thế danh sách quyết định kiến trúc còn mở. Đặc biệt, JourneyMetrics vẫn cần đặc tả và ca kiểm thử thuật toán cụ thể.

Sau khi chốt nhà cung cấp hoặc quy tắc còn thiếu:

1. Cập nhật SRS, thiết kế và API bị ảnh hưởng.
2. Cụ thể hóa Preconditions, Test Data, Expected Result và Required Evidence.
3. Chuyển Design Status sang DEFINED khi ca đã đủ đặc tả.
4. Giữ Execution Status=NOT_RUN cho đến khi thực sự chạy.
5. Chỉ ghi PASS hoặc FAIL dựa trên kết quả thực tế và minh chứng.

Có ca kiểm thử liên kết không đồng nghĩa đã đạt tiêu chí rubric. Kết luận nghiệm thu phải dựa trên triển khai và bằng chứng thực thi.
## 16. Tài liệu kỹ thuật tham khảo

- [PostgreSQL — Transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html): nguyên tắc cập nhật toàn bộ hoặc không cập nhật trong transaction.
- [PostgreSQL — Numeric Types](https://www.postgresql.org/docs/current/datatype-numeric.html): kiểu số nguyên, số thập phân chính xác và số dấu phẩy động.
- [Redis — EXPIRE](https://redis.io/docs/latest/commands/expire/): cơ chế hết hạn key, được phân biệt với việc chốt trạng thái nghiệp vụ.

Các quyết định phân chia module, quyền sở hữu dữ liệu và phạm vi MVP là đề xuất riêng cho CAB System.
