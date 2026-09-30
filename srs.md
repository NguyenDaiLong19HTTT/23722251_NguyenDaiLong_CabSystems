# Software Requirements Specification — CAB System

- Phiên bản tài liệu: 1.3 — Chuyển đổi chọn lọc sang kiến trúc tám microservice
- Phạm vi: MVP hệ thống đặt xe trực tuyến và các yêu cầu trình diễn theo rubric
- Chủ dự án: Nguyễn Đại Long
- Trạng thái: Đặc tả thiết kế; chưa xác nhận triển khai hoặc kiểm thử thành công

Tài liệu này xác định yêu cầu nghiệp vụ và hành vi cần đạt của CAB System. Công nghệ triển khai, cấu trúc mã nguồn, cấu trúc cơ sở dữ liệu vật lý và giao tiếp chi tiết giữa các dịch vụ được mô tả trong tài liệu thiết kế riêng.
Tài liệu được đối chiếu với PHIEU_CHAM_PROJECT.pdf gồm 30 tiêu chí và Micro_Service_Design phiên bản 1.3 về tám microservice. Bản này kế thừa SRS 1.2, giữ mã và nội dung nghiệp vụ còn phù hợp; chỉ điều chỉnh ranh giới dịch vụ, phối hợp phân tán và phạm vi đã được thống nhất.

Rubric xác định các nội dung cần chứng minh khi chấm. Những lựa chọn như số lượng dịch vụ, cách chia database, ngưỡng OTP và giới hạn request là đề xuất thiết kế của CAB, không mặc nhiên là thông số do giảng viên quy định.

API, test case và hướng dẫn demo phải được đồng bộ với các yêu cầu trong SRS này trước khi nghiệm thu.

Các yêu cầu hành vi trong SRS không tự tạo thêm endpoint, mã HTTP hoặc enum trong API hiện tại. Những hợp đồng mới, đặc biệt phản hồi cho tiến trình chưa hoàn tất, phải được đặc tả và duyệt ở API Document trước khi triển khai. Không coi việc sửa SRS là đã cập nhật mã nguồn hoặc kết quả kiểm thử.
## Quy ước tài liệu

| Tiền tố | Ý nghĩa |
|---|---|
| BG | Mục tiêu nghiệp vụ |
| BR | Yêu cầu nghiệp vụ |
| BP | Quy trình nghiệp vụ |
| FR | Yêu cầu chức năng |
| BRu | Quy tắc nghiệp vụ |
| NFR | Yêu cầu phi chức năng |
| UC | Use Case |
| AC | Tiêu chí chấp nhận |
| RQM | Ma trận truy xuất yêu cầu |

Quy ước:

- Các mã đã được sử dụng không được đổi ý nghĩa tùy theo từng mục.
- Trạng thái kỹ thuật được viết bằng chữ hoa và dùng thống nhất trong SRS, API, mô hình dữ liệu và test case.
- “Yêu cầu đặt xe”, “lời mời nhận chuyến” và “chuyến đi” là ba đối tượng khác nhau.
- Tài liệu đặc tả yêu cầu không được xem là bằng chứng chức năng đã được triển khai hoặc kiểm thử thành công.

---

# B1. Ngữ cảnh và vấn đề nghiệp vụ

## 1.1. Ngữ cảnh

Công ty ABC cung cấp dịch vụ vận chuyển hành khách và cần xây dựng CAB System để số hóa hoạt động đặt xe.

Hệ thống hỗ trợ khách hàng đặt xe, tự động tìm tài xế phù hợp, theo dõi chuyến, tính cước, thanh toán và đánh giá. Nhân viên vận hành sử dụng hệ thống để quản lý tài khoản, tài xế, phương tiện và xử lý sự cố.

## 1.2. Vấn đề cần giải quyết

| Vấn đề | Ảnh hưởng |
|---|---|
| Phân công tài xế thủ công | Khách chờ lâu, khó đáp ứng khi số yêu cầu tăng |
| Thông tin chuyến và vị trí không được cập nhật tập trung | Khách hàng và nhân viên khó biết chuyến đang ở đâu |
| Quản lý thanh toán rời rạc | Khó phân biệt chưa thanh toán, đã thanh toán và giao dịch chưa xác định |
| Thiếu quy trình xử lý ngoại lệ thống nhất | Chuyến có thể bị treo khi tài xế từ chối, mất kết nối hoặc gặp sự cố |
| Thiếu kiểm soát truy cập và lưu vết | Khó bảo vệ dữ liệu và xác định người thực hiện thay đổi |
| Hệ thống khó mở rộng | Việc bổ sung chức năng có thể ảnh hưởng nhiều thành phần |

## 1.3. Luồng nghiệp vụ tổng quát

Đăng nhập → tạo yêu cầu đặt xe → tìm tài xế → tài xế nhận chuyến → đến điểm đón → đón khách → thực hiện chuyến → hoàn thành → tính cước → thanh toán.

Sau khi chuyến hoàn thành, khách hàng có thể đánh giá và xem lịch sử.

Thông báo và giám sát vận hành diễn ra xuyên suốt quá trình.

---

# B2. Các bên liên quan và vai trò

## 2.1. Stakeholder

| Stakeholder | Vai trò và nhu cầu |
|---|---|
| Khách hàng | Đặt xe, theo dõi chuyến, thanh toán, xem lịch sử và đánh giá |
| Tài xế | Nhận hoặc từ chối lời mời, cập nhật vị trí, thực hiện chuyến và xác nhận thu tiền mặt |
| Nhân viên vận hành | Quản lý khách hàng, tài xế, phương tiện, biểu giá; giám sát chuyến và xử lý sự cố |
| Ban lãnh đạo | Theo dõi kết quả vận hành, số chuyến và số tiền đã thu |
| Nhà cung cấp thanh toán | Tiếp nhận giao dịch điện tử, trả kết quả và hỗ trợ tra cứu giao dịch |
| Nhà cung cấp bản đồ/định tuyến | Hỗ trợ tìm địa chỉ, xác định tuyến đường, khoảng cách và thời gian dự kiến khi tích hợp |
| Nhà cung cấp OTP/SMS | Gửi mã xác minh số điện thoại phục vụ đăng ký tài xế; cung cấp kết quả gửi và giới hạn tích hợp |

Ban lãnh đạo là bên liên quan, không mặc nhiên có tài khoản hoặc vai trò riêng trong MVP. Báo cáo có thể được nhân viên vận hành cung cấp.

## 2.2. Ma trận ảnh hưởng và quan tâm

| Stakeholder | Mức ảnh hưởng | Mức quan tâm | Cách phối hợp |
|---|---|---|---|
| Ban lãnh đạo | Cao | Cao | Xác nhận phạm vi và tiêu chí thành công |
| Nhân viên vận hành | Cao | Cao | Xác nhận quy trình quản lý và xử lý ngoại lệ |
| Khách hàng | Trung bình | Cao | Đánh giá trải nghiệm đặt xe và theo dõi |
| Tài xế | Trung bình | Cao | Đánh giá nhận chuyến, vị trí và thao tác thực hiện chuyến |
| Nhà cung cấp thanh toán | Cao trong phạm vi thanh toán | Trung bình | Thống nhất hợp đồng tích hợp và đối soát |
| Nhà cung cấp bản đồ | Trung bình | Trung bình | Thống nhất dữ liệu và giới hạn dịch vụ |
| Nhà cung cấp OTP/SMS | Cao trong phạm vi xác minh số điện thoại | Trung bình | Thống nhất hợp đồng gửi OTP, môi trường thử nghiệm và giới hạn dịch vụ |
## 2.3. Vai trò tài khoản trong MVP

| Vai trò | Quyền chính |
|---|---|
| CUSTOMER | Sử dụng các chức năng dành cho khách hàng trên dữ liệu của mình |
| DRIVER | Sử dụng các chức năng tài xế trên hồ sơ và chuyến được phân công |
| OPERATOR | Thực hiện chức năng vận hành được quy định trong MVP |

Mỗi tài khoản có một vai trò trong MVP.

Người dùng không được tự thay đổi vai trò. Vai trò OPERATOR không mặc nhiên được sửa mật khẩu người khác, sửa giao dịch đã thành công hoặc xóa nhật ký.
Account DRIVER ở trạng thái ACTIVE nhưng hồ sơ chưa APPROVED được đăng nhập để xem hồ sơ và kết quả xét duyệt của mình.

Tài xế chưa được duyệt không được bật AVAILABLE hoặc nhận chuyến.

Trạng thái Account, trạng thái xét duyệt hồ sơ và trạng thái hoạt động Driver là ba khái niệm riêng.
---

# B3. Mục tiêu nghiệp vụ

| Mã | Mục tiêu |
|---|---|
| BG01 | Số hóa quá trình tạo và quản lý yêu cầu đặt xe |
| BG02 | Tự động tìm và phân công tài xế phù hợp |
| BG03 | Cung cấp trạng thái và vị trí chuyến cho người được phép theo dõi |
| BG04 | Quản lý vòng đời chuyến và xử lý các trường hợp bất thường |
| BG05 | Tính cước và ghi nhận thanh toán chính xác, tránh thu tiền trùng |
| BG06 | Thông báo kịp thời các sự kiện quan trọng |
| BG07 | Hỗ trợ quản lý tài xế, phương tiện, biểu giá và hoạt động vận hành |
| BG08 | Bảo vệ tài khoản, dữ liệu và kiểm soát quyền truy cập |
| BG09 | Thu thập đánh giá để theo dõi chất lượng dịch vụ |

---

# B4. Phạm vi, giả định và ưu tiên

## 4.1. Trong phạm vi MVP bắt buộc

- Khách hàng tự đăng ký tài khoản.
- Tài xế xác thực số điện thoại bằng OTP, gửi thông tin cá nhân và phương tiện để đăng ký.
- Nhân viên vận hành xem, duyệt hoặc từ chối hồ sơ tài xế.
- Tài xế nhận kết quả xét duyệt.
- Khách hàng, tài xế và nhân viên vận hành đăng nhập.
- Xem hồ sơ, cập nhật thông tin được phép, đổi mật khẩu, làm mới phiên và đăng xuất.
- Tra cứu thông tin khách hàng và tài xế theo mã, có kiểm tra quyền trên đối tượng.
- Tài khoản tài xế được tạo qua luồng xác minh OTP và gửi hồ sơ đăng ký. Nhân viên vận hành xét duyệt hồ sơ; không tạo trực tiếp tài khoản tài xế qua một chức năng quản trị riêng trong phiên bản hiện tại.
- Quản lý hồ sơ tài xế, phương tiện và phân công xe.
- Tài xế chuyển trực tuyến/ngoại tuyến và cung cấp vị trí.
- Tra cứu tài xế đủ điều kiện trong bán kính 1 km, hỗ trợ giới hạn kết quả và phân trang.
- Khách hàng tạo yêu cầu đặt xe tức thời.
- Tìm tài xế, gửi lời mời, nhận/từ chối và xử lý hết hạn.
- Khách hàng xem danh sách Booking của mình, có giới hạn kết quả và phân trang.
- Theo dõi và cập nhật trạng thái chuyến.
- Hủy trước khi đón khách theo quy tắc.
- Ghi nhận sự cố và hỗ trợ xử lý.
- Quản lý biểu giá, tính cước sau chuyến.
- Thanh toán tiền mặt và tích hợp một nhà cung cấp thanh toán điện tử.
- Đánh giá tài xế sau chuyến hoàn thành.
- Thông báo trong ứng dụng.
- Xem lịch sử chuyến và trạng thái thanh toán.
- Kiểm soát truy cập và ghi nhật ký thao tác quan trọng.
- Kiểm tra sức khỏe hệ thống qua /health, /ready và /health/services.
- Trình diễn Gateway, giao tiếp giữa các dịch vụ, RabbitMQ và Docker Compose.
- Kiểm chứng bảo vệ dữ liệu lưu trữ, JWT, phân quyền, SQL injection, XSS, rate limiting và idempotency.

Trong môi trường học tập, tích hợp thanh toán điện tử sử dụng sandbox của nhà cung cấp.

Không coi phản hồi giả lập nội bộ là bằng chứng tích hợp thành công với nhà cung cấp thanh toán.

OTP có thể dùng bộ giả lập trong kiểm thử nội bộ, nhưng phải ghi rõ phạm vi giả lập. Không coi đó là bằng chứng đã tích hợp gửi SMS thực tế.

## 4.2. Chức năng ưu tiên sau luồng cốt lõi

- Tìm địa chỉ bằng dịch vụ bản đồ.
- Ước tính giá trước khi đặt xe.

Các chức năng bản đồ và ước tính trên được đặc tả để giữ thiết kế thống nhất, nhưng có thể triển khai sau luồng đặt xe đến thanh toán.

Báo cáo cơ bản được chuyển sang ngoài MVP của kiến trúc tám MS. BP13, FR22, UC16, AC14 và RQM15 vẫn được giữ để truy vết và làm đặc tả mở rộng, không phải điều kiện nghiệm thu bắt buộc của bản nộp hiện tại.

Đánh giá tài xế thuộc phạm vi bắt buộc của bản nộp vì được chấm tại tiêu chí 20; không còn được xếp là chức năng tùy chọn.

## 4.3. Ngoài phạm vi MVP

- Một tài khoản sử dụng đồng thời nhiều vai trò.
- Đặt xe theo lịch, ghép chuyến, nhiều điểm dừng.
- Khuyến mãi, ví nội bộ, định giá theo nhu cầu.
- Tính phí hủy và hoàn tiền tự động.
- Tự động tính cước cho chuyến kết thúc bất thường giữa hành trình.
- Quản lý lương và chia doanh thu cho tài xế.
- Báo cáo phân tích nâng cao.

- Analytics Service và báo cáo cơ bản trong bản nộp hiện tại; audit gốc vẫn bắt buộc ở từng dịch vụ.
- Điểm trung bình tài xế, bảng xếp hạng, hạng thành viên và hóa đơn điện tử có tính pháp lý/VAT chưa thuộc MVP.
- Khôi phục mật khẩu tự phục vụ qua email/SMS.
- Thông báo nghiệp vụ qua email, SMS hoặc push ngoài chức năng OTP đăng ký tài xế.
- Tích hợp nhiều nhà cung cấp OTP hoặc thanh toán trong cùng bản MVP.
- Tự động phân công lại tài xế cho một Trip đã được tạo.
- Quy trình tải và quản lý tệp ảnh giấy tờ chưa được đưa vào MVP; thông tin hồ sơ bắt buộc được nhập theo biểu mẫu.

## 4.4. Giả định vận hành

- Nhân viên vận hành kiểm tra hồ sơ tài xế và phương tiện trước khi cho phép nhận chuyến.
- Tài khoản OPERATOR được cấp bằng quy trình quản trị riêng; không có đăng ký OPERATOR công khai.
- Một tài xế chỉ sử dụng một phương tiện đang được chọn tại một thời điểm.
- Một phương tiện không phục vụ đồng thời nhiều tài xế.
- Mỗi khách hàng chỉ có tối đa một yêu cầu/chuyến đang hoạt động.
- Các ngưỡng ở mục 4.5 là đề xuất cho MVP, cần được duyệt trước khi dùng làm chuẩn nghiệm thu.
- Không thể suy ra khả năng vận hành thực tế chỉ từ các ngưỡng được ghi trong tài liệu.

## 4.5. Thông số đề xuất cho MVP

| Thông số | Giá trị đề xuất | Ý nghĩa |
|---|---:|---|
| Bán kính điều phối tài xế | 5 km | Phạm vi chọn ứng viên cho tiến trình tìm tài xế của Booking |
| Bán kính tra cứu tài xế gần vị trí | 1 km mặc định | Dùng cho chức năng danh sách tài xế gần tọa độ và kịch bản chấm tiêu chí 13 |
| Thời hạn một lời mời | 30 giây | Tính từ khi hệ thống phát hành lời mời |
| Số lời mời tối đa cho một Booking | 5 | Bao gồm lời mời đầu tiên |
| Thời gian tìm tài xế tối đa | 180 giây | Tính từ khi Booking bắt đầu FINDING_DRIVER |
| Chu kỳ gửi vị trí | 5 giây | Khi tài xế trực tuyến và thiết bị có kết nối |
| Ngưỡng vị trí cũ | 30 giây | Không dùng vị trí cũ hơn ngưỡng để ghép chuyến mới |
| Thời gian chờ khách trước khi báo vắng mặt | 5 phút | Tính từ thời điểm ARRIVED_PICKUP |
| Thời hạn access token | 15 phút | Không thay thế yêu cầu kiểm tra phiên bị thu hồi |
| Thời hạn phiên/refresh token | 7 ngày | Tính từ lần đăng nhập; làm mới token không kéo dài vô hạn phiên |
| Độ dài OTP | 6 chữ số | Mã ngẫu nhiên dùng để xác minh số điện thoại |
| Thời hạn OTP | 5 phút | Quá hạn phải yêu cầu mã mới |
| Số lần nhập sai OTP tối đa | 5 lần/challenge | Vượt ngưỡng làm challenge mất hiệu lực |
| Khoảng cách tối thiểu giữa hai lần gửi OTP | 60 giây | Áp dụng cùng các giới hạn theo IP và số điện thoại |
| Số bản ghi mặc định mỗi trang | 20 | Áp dụng cho danh sách Booking và tra cứu tài xế |
| Số bản ghi tối đa mỗi trang | 100 | Từ chối hoặc xử lý giới hạn vượt ngưỡng theo hợp đồng API |
| Giới hạn tạo Booking khởi đầu | 10 request/phút/tài khoản | Cấu hình đề xuất để kiểm chứng rate limiting, cần điều chỉnh sau đo kiểm |

Các cấu hình điều phối được ghi nhận theo từng tiến trình. Thay đổi cấu hình chỉ áp dụng cho tiến trình mới.
Bán kính tra cứu tài xế và bán kính điều phối là hai cấu hình khác nhau.

Kịch bản kiểm tra danh sách tài xế phải chứng minh truy vấn 1 km không trả tài xế ngoài phạm vi đó.

Các ngưỡng OTP, phân trang và rate limit là đề xuất của CAB. Việc ghi thông số trong SRS không thay thế phê duyệt và kiểm thử thực tế.
---

## 4.6. Phân công trách nhiệm trong kiến trúc tám MS

| Dịch vụ | Trách nhiệm nghiệp vụ | Yêu cầu chính |
|---|---|---|
| Identity & Access | Account, thông tin liên hệ chung, xác thực, OTP, Session và điều phối cấp phát tài khoản/hồ sơ | FR01, phối hợp FR23, FR26 |
| Customer | Hồ sơ Customer và quyền có tối đa một yêu cầu/chuyến đang hoạt động | FR26 và hỗ trợ FR02–FR03, FR19 |
| Driver & Fleet | Driver, hồ sơ xét duyệt, xe, phân công xe, vị trí mới nhất, giữ chỗ Driver/Vehicle | FR17, FR18, FR23, FR26; hỗ trợ FR04–FR07, FR24 |
| Booking | Booking và module Dispatch; chọn ứng viên, offer, điều phối phân công, lịch sử Booking | FR02–FR07, phần Booking của FR19, FR24, FR25 |
| Trip | Vòng đời chuyến, hành trình, tracking, Incident và JourneyMetrics | FR08, FR09, FR15, phần Trip của FR19, FR20; cung cấp dữ liệu cho FR10 |
| Payment | Biểu giá, Fare, Payment, PaymentAttempt và đối soát | FR10–FR12, FR21 |
| Rating | Đánh giá chuyến đã hoàn tất | FR16 |
| Notification | Hộp thư IN_APP, tiếp nhận sự kiện và công bố thông báo | FR13 |

Gateway cung cấp cửa vào, định tuyến và health tổng hợp theo FR27. Gateway, PostgreSQL, Redis và RabbitMQ không được tính vào tám MS nghiệp vụ.

Operations là nhóm quyền và chức năng, được phân về dịch vụ sở hữu dữ liệu, không tạo thêm Operations MS. Dispatch thuộc Booking; vị trí mới nhất thuộc Driver; điểm hành trình và metrics thuộc Trip. Analytics nằm ngoài MVP nhưng mỗi dịch vụ vẫn ghi audit nghiệp vụ.

Việc chia dịch vụ không làm thay đổi các quyền, enum hoặc điều kiện nghiệp vụ đang được giữ trong SRS. Chi tiết database, RPC và schema sự kiện nằm trong Micro_Service_Design và các hợp đồng liên quan.

---

# B5. Yêu cầu nghiệp vụ

| Mã | Yêu cầu |
|---|---|
| BR01 | Khách hàng có thể tạo và theo dõi yêu cầu đặt xe trực tuyến |
| BR02 | Hệ thống tự động tìm, mời và phân công tài xế phù hợp |
| BR03 | Người được phép có thể theo dõi trạng thái, tài xế, vị trí và ETA của chuyến |
| BR04 | Hệ thống quản lý thực hiện chuyến, hủy hợp lệ, lịch sử và sự cố |
| BR05 | Hệ thống xác định cước và ghi nhận thanh toán bằng tiền mặt hoặc điện tử |
| BR06 | Nhân viên vận hành quản lý và giám sát hoạt động của CAB |
| BR07 | Khách hàng có thể đánh giá tài xế sau khi hoàn thành chuyến |
| BR08 | Hệ thống quản lý tài khoản, phiên đăng nhập và quyền truy cập |
| BR09 | Hệ thống hỗ trợ tài xế đăng ký qua OTP, gửi hồ sơ, nhận kết quả xét duyệt; quản lý phương tiện và điều kiện sẵn sàng nhận chuyến |
| BR10 | Hệ thống gửi và quản lý thông báo cho các bên liên quan |
| BR11 | Hệ thống quản lý biểu giá và cung cấp thông tin cước minh bạch |

BR06 luôn là quản lý và giám sát vận hành. BR07 luôn là đánh giá tài xế.

---

# B6. Quy trình nghiệp vụ

| Mã | Quy trình | Các bước chính |
|---|---|---|
| BP01 | Đặt xe | Đăng nhập → nhập điểm đón/đến → chọn dịch vụ → kiểm tra hợp lệ → tạo Booking |
| BP02 | Tìm và phân công tài xế | Chọn ứng viên → tạo TripRequest → phản hồi → giữ quyền Customer/Driver/Vehicle → chuẩn bị và kích hoạt Trip → xác nhận kết quả; lỗi được đối soát và phục hồi trước khi thử ứng viên khác |
| BP03 | Thực hiện chuyến | Phân công → đến đón → đón khách → di chuyển → hoàn thành |
| BP04 | Tính cước và thanh toán | Chốt dữ liệu chuyến → tính cước → chọn phương thức → xử lý → ghi nhận kết quả |
| BP05 | Giám sát và xử lý sự cố | Phát hiện/tiếp nhận → ghi nhận → kiểm tra → xử lý theo quyền → lưu vết |
| BP06 | Đánh giá | Chọn chuyến hoàn thành → nhập điểm/nhận xét → kiểm tra quyền → lưu đánh giá |
| BP07 | Quản lý tài khoản | Tiếp nhận đăng ký/cấp tài khoản → tạo hồ sơ liên dịch vụ → xác nhận cấp phát hoàn tất → đăng nhập → quản lý hồ sơ và phiên → đăng xuất |
| BP08 | Quản lý và xét duyệt tài xế, xe | Xem hồ sơ → kiểm tra → duyệt/từ chối → tạo hoặc liên kết xe hợp lệ khi duyệt → thông báo kết quả → tài xế chủ động yêu cầu trực tuyến |
| BP09 | Hủy yêu cầu/chuyến | Yêu cầu hủy → phân xử với phân công đang chạy → kiểm tra trạng thái → ghi quyết định hủy hợp lệ → kết thúc lời mời → giải phóng đúng quyền Customer/Driver/Vehicle và thông báo |
| BP10 | Thông báo | Nhận sự kiện → xác định người nhận → tạo thông báo → gửi → ghi nhận trạng thái |
| BP11 | Quản lý biểu giá | Tạo phiên bản → kiểm tra → đặt thời điểm hiệu lực → áp dụng cho Booking mới |
| BP12 | Tra cứu lịch sử | Xác thực → xác định phạm vi dữ liệu → lọc/phân trang → xem chi tiết |
| BP13 | Báo cáo cơ bản — ngoài MVP, giữ để truy vết | Khi được duyệt mở rộng: chọn khoảng thời gian → tổng hợp dữ liệu có nguồn/độ mới rõ → hiển thị chỉ tiêu và cách tính |
| BP14 | Đăng ký tài xế | Nhập số điện thoại → yêu cầu OTP → xác minh → nhập thông tin cá nhân/xe → gửi hồ sơ → hoàn tất Account/Driver/DriverApplication qua tiến trình có chống trùng → chờ xét duyệt |
| BP15 | Tra cứu tài xế gần vị trí | Nhập tọa độ và bán kính → kiểm tra quyền/dữ liệu → lọc tài xế đủ điều kiện → sắp xếp khoảng cách → trả danh sách phân trang |
| BP16 | Theo dõi và phục hồi thao tác liên dịch vụ | Ghi mã tiến trình → thực hiện/tra cứu từng bước → trả trạng thái phù hợp → tiếp tục hoặc bù có điều kiện → xác nhận kết quả cuối và lưu vết |
---

# B7. Yêu cầu chức năng

## FR01 – Quản lý tài khoản và xác thực

- FR01.1: Khách hàng tự đăng ký bằng họ tên, email, số điện thoại và mật khẩu.
- FR01.2: Ba vai trò đăng nhập bằng email hoặc số điện thoại và mật khẩu.
- FR01.3: Người dùng xem và cập nhật các trường hồ sơ được phép.
- FR01.4: Người dùng đổi mật khẩu sau khi xác minh mật khẩu hiện tại.
- FR01.5: Người dùng làm mới phiên bằng refresh token hợp lệ.
- FR01.6: Người dùng đăng xuất và thu hồi phiên hiện tại.
- FR01.7: Hệ thống kiểm tra trạng thái tài khoản, vai trò và quyền đối với tài nguyên.

Identity sở hữu Account và Session; Customer sở hữu hồ sơ Customer. Đăng ký chỉ được xác nhận hoàn tất khi đã tạo và liên kết đủ Account và hồ sơ bắt buộc. Dữ liệu cấp phát nội bộ chưa hoàn tất không được sử dụng như tài khoản đã đăng ký thành công. Mất phản hồi phải cho phép tiếp tục cùng tiến trình, không tạo tài khoản hoặc hồ sơ thứ hai.

Trường hồ sơ chung như fullName, email và phone có một nơi có thẩm quyền tại Identity; các dịch vụ khác không duy trì bản có thể sửa độc lập. Role OPERATOR và quy tắc thu hồi phiên vẫn giữ nguyên.

## FR02 – Tạo yêu cầu đặt xe

Khách hàng nhập điểm đón, điểm đến và loại dịch vụ. Hệ thống kiểm tra dữ liệu và điều kiện tạo Booking.

## FR03 – Tiếp nhận và quản lý yêu cầu đặt xe

Hệ thống cấp bookingId, ghi nhận yêu cầu, chuyển sang tìm tài xế và cung cấp trạng thái hiện tại.

Yêu cầu gửi lại do lỗi mạng không được tạo Booking trùng khi cùng mã chống lặp.

Booking Service phối hợp Customer Service giữ quyền hoạt động của khách và Payment Service cung cấp snapshot giá. Chỉ xác nhận tạo Booking thành công khi các điều kiện bắt buộc đã được ghi nhận. Kết quả chưa rõ phải được tra cứu/phục hồi theo FR28; không giải phóng quyền khách hoặc tạo Booking mới chỉ vì timeout.

## FR04 – Tìm tài xế phù hợp

Hệ thống tìm tài xế theo vị trí mới nhất, trạng thái sẵn sàng, hồ sơ hợp lệ, phương tiện và loại dịch vụ.

## FR05 – Gửi và phản hồi lời mời

Hệ thống gửi TripRequest cho tài xế. Tài xế được chỉ định có thể nhận hoặc từ chối khi lời mời còn hiệu lực.

Nhận chuyến được Booking điều phối qua Driver, Customer và Trip. Chỉ công bố nhận thành công khi một Trip hợp lệ đã được kích hoạt, quyền Customer/Driver/Vehicle đã gắn đúng chuyến và kết quả phân công được lưu. Trip chuẩn bị nội bộ không phải Trip hoạt động. Khi mất phản hồi, tiếp tục cùng tiến trình thay vì nhận thêm chuyến hoặc giải phóng tài nguyên chưa xác minh.

## FR06 – Tìm tài xế thay thế

Hệ thống thử ứng viên khác khi lời mời bị từ chối, hết hạn hoặc tài xế không còn đủ điều kiện.

Nếu một lần phân công đã bắt đầu và kết quả chưa rõ, phải xác minh Trip/reservation và hoàn tất hoặc bù an toàn trước khi phân công ứng viên khác cho cùng Booking. Không coi timeout gRPC là tài xế từ chối.

## FR07 – Thông báo kết quả điều phối

Khách hàng nhận được kết quả tìm tài xế thành công hoặc không tìm được tài xế. Khi thành công, kết quả liên kết tới Trip được tạo.

## FR08 – Cập nhật trạng thái chuyến

Tài xế được phân công cập nhật chuyến đúng trình tự. Hệ thống lưu người thực hiện và thời điểm của mỗi thay đổi.

## FR09 – Theo dõi chuyến

Khách hàng và vận hành xem trạng thái, tài xế, xe, vị trí gần nhất và ETA khi có dữ liệu hợp lệ.

Vị trí cũ hoặc ETA không tính được phải được thể hiện rõ, không giả định bằng 0.

## FR10 – Tính cước thực tế

Trip COMPLETED kích hoạt quá trình xác nhận dữ liệu hành trình. Payment Service chỉ phát hành Fare khi Trip Service đã xác nhận JourneyMetrics đủ điều kiện CONFIRMED và có snapshot giá của Booking. Dữ liệu chưa đủ giữ Fare chưa sẵn sàng, không thay quãng đường/thời gian thiếu bằng 0 hoặc yêu cầu thanh toán.

## FR11 – Thanh toán

Khách hàng chọn tiền mặt hoặc phương thức điện tử được hỗ trợ.

Chọn tiền mặt chỉ tạo yêu cầu thanh toán; tài xế phải xác nhận đã thu đủ tiền.

## FR12 – Xử lý kết quả thanh toán

Hệ thống xác minh kết quả thanh toán điện tử, xử lý thông báo trùng, theo dõi từng lần thử và đối soát trường hợp chưa rõ kết quả.
Bản nộp phải thể hiện được luồng thanh toán online qua một nhà cung cấp sandbox, tiếp nhận callback/webhook và tra cứu kết quả đã xác minh.

Callback/webhook đi qua Gateway nhưng dùng cơ chế xác thực của nhà cung cấp, không dùng user token làm bằng chứng thanh toán.

Client gửi lại cùng yêu cầu thanh toán với cùng Idempotency-Key phải nhận kết quả đã lưu mà không tạo lần thu tiền mới.

Khi kết quả đã hoàn tất, replay trả kết quả cuối đã lưu. Nếu operation còn đang xử lý, chỉ phản hồi tình trạng đúng sự thật theo hợp đồng tiến trình đã được duyệt; không báo đã hoàn tất hoặc mở Attempt mới. Mã HTTP và cách tra cứu tình trạng phải được đặc tả đồng bộ tại API Document.

Trip giữ COMPLETED sau khi thanh toán thành công. Trạng thái đã thanh toán được xác định từ Payment liên kết, không thêm trạng thái Trip PAID.
## FR13 – Thông báo

Hệ thống tạo thông báo trong ứng dụng cho các sự kiện quan trọng, cho phép xem danh sách và đánh dấu đã đọc.
Thông báo bắt buộc gồm kết quả duyệt hoặc từ chối hồ sơ đăng ký tài xế.

Thông báo được tạo từ kết quả nghiệp vụ đã ghi nhận thành công.

Lỗi gửi thông báo không làm đảo ngược quyết định xét duyệt.

Các dịch vụ sở hữu nghiệp vụ phát sự kiện đã commit từ outbox của mình; Notification xác minh nguồn, lưu inbox/công việc bền vững và chống xử lý trùng trước khi công bố thông báo. Không yêu cầu một nguồn CAB_CORE duy nhất trong kiến trúc tám MS.

## FR14 – Quản lý dữ liệu vận hành

Nhân viên vận hành xem dữ liệu khách hàng, tài xế, xe, chuyến và thanh toán; cập nhật dữ liệu thuộc quyền được quy định.

Thay đổi trạng thái tài khoản được xử lý bởi thành phần sở hữu tài khoản.

Account thuộc Identity; hồ sơ Customer thuộc Customer; tài xế/xe/review thuộc Driver; chuyến và sự cố thuộc Trip; giá và thanh toán thuộc Payment. Tra cứu kết hợp qua hợp đồng dịch vụ hoặc projection được phép, không đọc chéo database. Audit được ghi tại dịch vụ thực hiện thao tác, không phụ thuộc Analytics.

## FR15 – Giám sát và xử lý sự cố

Nhân viên vận hành xem chuyến đang hoạt động, ghi nhận sự cố, theo dõi tiến trình xử lý và tra cứu nhật ký.

## FR16 – Đánh giá tài xế

Khách hàng của chuyến hoàn thành được gửi một đánh giá gồm điểm nguyên từ 1 đến 5 và nhận xét tùy chọn.


## FR17 – Quản lý hồ sơ tài xế và phương tiện

- FR17.1: OPERATOR xem danh sách hồ sơ tài xế, lọc theo trạng thái xét duyệt và xem chi tiết.
- FR17.2: OPERATOR duyệt hoặc từ chối hồ sơ; từ chối bắt buộc có lý do.
- FR17.3: Khi duyệt, hệ thống kiểm tra thông tin tài xế, giấy phép, phương tiện và ràng buộc phân công xe.
- FR17.4: Kết quả xét duyệt được lưu cùng người thực hiện, thời điểm và phiên bản dữ liệu.
- FR17.5: Kết quả xét duyệt được thông báo cho tài xế.
- FR17.6: OPERATOR quản lý phương tiện, phân công xe và ngừng cho phép nhận chuyến mới theo quyền.
- FR17.7 — Ngừng áp dụng: Chức năng OPERATOR cấp trực tiếp tài khoản tài xế không thuộc phạm vi phiên bản hiện tại. Việc tạo tài khoản tài xế thực hiện theo FR23 và UC17.

Mọi quyết định duyệt hoặc từ chối phải đi qua cùng nghiệp vụ xét duyệt hồ sơ. Không cho phép sửa trực tiếp approvalStatus bằng một chức năng chỉnh sửa Driver để bỏ qua kiểm tra hồ sơ.

Duyệt hồ sơ không tự chuyển Driver sang AVAILABLE.

Hồ sơ chưa được duyệt hoặc bị từ chối không được nhận chuyến.

Luồng đăng ký tài xế phải bảo đảm tính duy nhất của email, số điện thoại và giấy phép. Account DRIVER, Driver và DriverApplication phải được tạo nhất quán theo quy tắc tại FR23.

Thông tin xe khai báo trong hồ sơ chưa tạo ra phân công xe chính thức. Khi duyệt, hệ thống mới tạo hoặc liên kết Vehicle và VehicleAssignment hợp lệ.

## FR18 – Trạng thái hoạt động và vị trí tài xế

Tài xế yêu cầu trực tuyến/ngoại tuyến và gửi vị trí. Hệ thống tự quản lý trạng thái BUSY theo phân công chuyến.

Driver Service quản lý trạng thái và vị trí mới nhất. Trip Service lưu mẫu hành trình đã xác minh thuộc đúng Driver/Trip và giai đoạn. Mẫu GPS bàn giao trễ hoặc lặp không được gắn vào chuyến mới hay làm mẫu cũ thành mới. Reservation nội bộ có thể chặn nhận thêm chuyến trước khi kết quả BUSY cuối cùng được công bố.

## FR19 – Hủy Booking hoặc Trip

Khách hàng, tài xế hoặc vận hành thực hiện hủy theo điều kiện của từng đối tượng và trạng thái. Mọi lần hủy phải có lý do.

Booking Service phân xử hủy Booking với accept; Trip Service quyết định hủy Trip. Sau khi ghi quyết định hợp lệ, hệ thống giải phóng đúng quyền hoạt động và thông báo qua công việc bền vững. Nếu kết quả phân công chưa rõ, không trả hủy thành công giả hoặc giải phóng Driver đang có Trip.

## FR20 – Lịch sử chuyến

Khách hàng và tài xế xem danh sách, chi tiết các chuyến thuộc phạm vi của mình, gồm kết quả chuyến và thanh toán.

## FR21 – Biểu giá và cước dự kiến

- FR21.1: Nhân viên vận hành quản lý phiên bản biểu giá theo loại dịch vụ.
- FR21.2: Khách hàng có thể tìm địa chỉ và xem cước dự kiến khi chức năng bản đồ/ước tính được triển khai.
- Cước dự kiến phải được phân biệt với cước thực tế.

Payment Service là nguồn có thẩm quyền của PricingConfig; Booking lưu bản snapshot bất biến do Payment cung cấp cho yêu cầu được chấp nhận. Việc thay dịch vụ sở hữu biểu giá không làm đổi công thức, quy tắc hiệu lực hoặc quyền OPERATOR hiện có.

## FR22 – Báo cáo cơ bản

**Trạng thái: ngoài MVP của baseline tám MS; giữ nguyên mã và nội dung để truy vết, chỉ triển khai khi được duyệt mở rộng.** Báo cáo không phải điều kiện hoàn tất bản nộp hiện tại. Audit và giám sát kỹ thuật vẫn bắt buộc.

Nhân viên vận hành xem số chuyến, số chuyến hoàn thành/hủy và số tiền đã thu trong khoảng thời gian được chọn.
## FR23 – Đăng ký tài xế qua OTP

- FR23.1: Người chưa có tài khoản yêu cầu OTP cho số điện thoại đăng ký.
- FR23.2: Hệ thống kiểm tra định dạng số điện thoại và giới hạn gửi mã.
- FR23.3: Người đăng ký nhập OTP; hệ thống kiểm tra mã, thời hạn và số lần thử.
- FR23.4: Xác minh thành công cấp quyền gửi hồ sơ ngắn hạn, gắn với số điện thoại và mục đích đăng ký tài xế.
- FR23.5: Người đăng ký nhập thông tin cá nhân, email, mật khẩu, giấy phép và thông tin phương tiện.
- FR23.6: Hệ thống tạo Account DRIVER, Driver và hồ sơ đăng ký nhất quán.
- FR23.7: Tài xế xem hồ sơ và kết quả xét duyệt của mình sau khi đăng nhập.

Identity chịu trách nhiệm OTP, PhoneVerification, Account và tiến trình cấp phát; Driver chịu trách nhiệm Driver/DriverApplication. Tiêu thụ verification token và ghi tiến trình cấp phát phải được lưu nhất quán tại Identity; Driver tạo bộ hồ sơ nhất quán trong database của mình. Chỉ trả kết quả đăng ký hoàn tất sau khi đủ bộ dữ liệu liên kết; retry dùng cùng operationId và không tiêu thụ token lần thứ hai.

Kết quả đăng ký ban đầu:

- Account ACTIVE.
- Driver.approvalStatus=PENDING_APPROVAL.
- Driver.driverStatus=OFFLINE.
- DriverApplication.status=SUBMITTED.

Quyền xác minh số điện thoại chỉ dùng một lần để tạo hồ sơ. Gửi lại yêu cầu hợp lệ với cùng mã chống lặp không tạo tài khoản hoặc hồ sơ mới.

## FR24 – Tra cứu tài xế gần vị trí

Khách hàng đăng nhập hoặc OPERATOR được tra cứu tài xế gần một tọa độ hợp lệ.

Dữ liệu đầu vào gồm:

- Vĩ độ.
- Kinh độ.
- Bán kính tìm kiếm.
- Giới hạn kết quả.
- Thông tin phân trang.

Bán kính mặc định là 1 km.

Chỉ trả tài xế thỏa điều kiện BRu01; sắp xếp khoảng cách tăng dần, sau đó driverId.

Kết quả không công khai số điện thoại, email, giấy phép hoặc tọa độ chính xác của tài xế. Chỉ trả thông tin tối thiểu và khoảng cách gần đúng cần thiết.

Kết quả tra cứu không giữ chỗ tài xế và không bảo đảm tài xế vẫn đủ điều kiện ở thời điểm nhận chuyến.

## FR25 – Danh sách Booking của khách hàng

Khách hàng đăng nhập xem danh sách Booking của mình, gồm yêu cầu đang xử lý và yêu cầu đã kết thúc.

Hỗ trợ lọc theo trạng thái, giới hạn kết quả và phân trang.

Sắp xếp theo createdAt giảm dần, sau đó bookingId giảm dần.

Không cho phép đổi customerId trong request để đọc Booking của khách khác.

Danh sách Booking được phân biệt với lịch sử Trip tại FR20: Booking không tìm được tài xế vẫn phải xuất hiện dù chưa từng có Trip.

## FR26 – Tra cứu hồ sơ theo mã

- FR26.1: CUSTOMER xem hồ sơ Customer của mình theo customerId.
- FR26.2: DRIVER xem hồ sơ Driver của mình theo driverId.
- FR26.3: OPERATOR xem hồ sơ Customer/Driver theo quyền vận hành.
- FR26.4: CUSTOMER có quan hệ chuyến phù hợp được xem thông tin tài xế tối thiểu cần cho chuyến.

Biết mã định danh không đồng nghĩa có quyền xem dữ liệu.

Thông tin trả về phụ thuộc quyền của người gọi; không dùng một response chứa toàn bộ dữ liệu cá nhân cho mọi vai trò.

## FR27 – Kiểm tra sức khỏe hệ thống

Hệ thống cung cấp qua Gateway:

- GET /health: kiểm tra Gateway còn hoạt động.
- GET /ready: kiểm tra các thành phần bắt buộc đã sẵn sàng.
- GET /health/services: cung cấp tình trạng từng thành phần cho OPERATOR.

Hai endpoint /health và /ready chỉ trả thông tin tối thiểu.

Danh sách chi tiết phải kiểm tra quyền và không chứa secret, connection string hoặc stack trace.

Các endpoint này nằm tại gốc Gateway, không bắt buộc có tiền tố /v1.

Danh sách health phải phản ánh Gateway, tám MS nghiệp vụ và hạ tầng PostgreSQL/Redis/RabbitMQ; có Worker riêng thì bổ sung thành phần đó. Phân biệt số MS với số container. Nội dung trạng thái giữ hợp đồng API 07: /health dùng UP; /ready dùng READY/NOT_READY; thành phần dùng UP/DOWN/UNKNOWN và tổng thể dùng UP/DEGRADED. Không thể xác minh quyền OPERATOR thì không trả chi tiết.

## FR28 – Theo dõi kết quả và phục hồi thao tác liên dịch vụ

- FR28.1: Thao tác có nhiều bước phải có định danh và trạng thái bền vững để tra cứu, gửi lại hoặc tiếp tục sau lỗi mà không tạo tác động trùng.
- FR28.2: Hệ thống phân biệt đã hoàn tất, đang xử lý và chưa xác định kết quả; timeout không tự chứng minh thất bại hoặc đã rollback.
- FR28.3: Chỉ trả kết quả cuối thành công khi thỏa hậu điều kiện của nghiệp vụ tương ứng.
- FR28.4: Retry, thao tác bù và giải phóng quyền đối chiếu đúng đối tượng/phiên bản; không tác động lên công việc mới.
- FR28.5: Người dùng chỉ xem tiến trình của mình; vận hành truy cập theo quyền. Đăng ký chưa có token cần bằng chứng truy cập riêng, không chỉ operationId hoặc Idempotency-Key.
- FR28.6: Tiến trình không tự phục hồi được phải được theo dõi, cảnh báo và có quy trình vận hành an toàn; không cưỡng chế kết quả thanh toán/chuyến để che lỗi.

Các yêu cầu trên quy định hành vi cần đạt. HTTP 202, endpoint tra cứu operation, thời hạn lưu giữ và bằng chứng truy cập khi đăng ký là hợp đồng đề xuất cần chốt tại API Document; chưa được coi là endpoint/mã phản hồi đã tồn tại. Trạng thái operation tách khỏi trạng thái Booking, Trip, Payment và Account.
---

# B8. Quy tắc nghiệp vụ và ngoại lệ

## 8.1. Các quy tắc nghiệp vụ

| Mã | Quy tắc |
|---|---|
| BRu01 | Chỉ chọn tài xế có Account ACTIVE, hồ sơ APPROVED, xe hợp lệ đúng loại dịch vụ, trạng thái AVAILABLE, GPS còn mới trong bán kính cấu hình và không bị reservation/Trip khác chiếm Driver hoặc Vehicle |
| BRu02 | Một Driver và một Vehicle chỉ có tối đa một quyền giữ chỗ/phục vụ chuyến đang hoạt động. Một tài xế không có hai Trip hoạt động và không tự chuyển BUSY thành AVAILABLE để nhận thêm chuyến |
| BRu03 | Mỗi Booking có tối đa một lời mời PENDING. Thử lại theo giới hạn tại mục 4.5; dừng khi hết ứng viên, hết số lời mời hoặc hết tổng thời gian |
| BRu04 | Mỗi Booking có tối đa một Trip. Chỉ kích hoạt Trip sau khi lời mời được chấp nhận hợp lệ và giành đủ quyền phân công; dữ liệu chuẩn bị kỹ thuật không được công bố như Trip hoạt động |
| BRu05 | Trip chỉ chuyển theo bảng trạng thái tại mục 8.2; mọi lần chuyển được lưu lịch sử |
| BRu06 | Cước thực tế chỉ được chốt khi Trip COMPLETED và có đủ dữ liệu hợp lệ |
| BRu07 | Không lưu số thẻ đầy đủ, mã bảo mật thẻ hoặc thông tin đăng nhập tài khoản thanh toán của khách |
| BRu08 | Thanh toán điện tử đi qua nhà cung cấp; không xác nhận thành công chỉ dựa vào trang chuyển hướng phía khách |
| BRu09 | Kiểm tra vai trò và quyền trên dữ liệu; biết ID không đồng nghĩa có quyền truy cập |
| BRu10 | Ghi nhật ký thay đổi tài khoản, hồ sơ tài xế, xe, biểu giá, trạng thái chuyến, xử lý sự cố và kết quả thanh toán |
| BRu11 | Đăng ký khách hàng tạo CUSTOMER; đăng ký tài xế là luồng riêng có OTP và tạo DRIVER chờ duyệt. Máy chủ quyết định role/accountStatus; từ chối việc người đăng ký tự gán quyền. Không có đăng ký OPERATOR công khai |
| BRu12 | Email và điện thoại được chuẩn hóa và duy nhất trên toàn bộ Account; đăng nhập dùng emailOrPhone, không có username riêng |
| BRu13 | Chỉ Account ACTIVE được dùng chức năng yêu cầu xác thực. Khóa tài khoản thu hồi mọi phiên; nếu tài xế đang có chuyến, tạo cảnh báo vận hành |
| BRu14 | Người dùng không tự sửa role, accountStatus hoặc ID. Thay đổi email/điện thoại phải xác minh mật khẩu hiện tại và kiểm tra trùng |
| BRu15 | Đăng xuất thu hồi phiên hiện tại; đổi mật khẩu thu hồi mọi phiên. Refresh token được thay thế sau mỗi lần làm mới và token cũ không được sử dụng lại |
| BRu16 | Hủy theo mục 8.3; không tính phí hủy tự động trong MVP |
| BRu17 | Một Trip có tối đa một Fare đã chốt và một Payment thành công; nhiều lần thử phải được ghi nhận riêng |
| BRu18 | Một Trip COMPLETED có tối đa một Rating của đúng khách hàng. Việc đánh giá không phụ thuộc trạng thái thanh toán |
| BRu19 | Vị trí có thời điểm ghi nhận; dữ liệu quá cũ không dùng để ghép mới. Vị trí gửi bù cũ hơn không được ghi đè vị trí mới |
| BRu20 | Account, Driver, Booking, TripRequest, Trip và Payment có các bộ trạng thái riêng; không dùng thay thế cho nhau |
| BRu21 | Cùng một sự kiện không tạo thông báo trùng cho cùng người nhận và cùng kênh; thông báo thất bại không đảo ngược nghiệp vụ đã thành công |
| BRu22 | Customer có tối đa một quyền hoạt động cho tiến trình tạo Booking, Booking đang tìm hoặc Trip chưa đóng. Quyền được chuyển tiếp từ Booking sang Trip, không tạo quyền thứ hai. Payment chưa hoàn tất của chuyến đã đóng không tự chặn chuyến mới |
| BRu23 | OTP phải còn hiệu lực, đúng mục đích và chưa vượt số lần thử. Mã thay thế làm mã cũ mất hiệu lực; quyền xác minh số điện thoại chỉ được tiêu thụ một lần khi tạo hồ sơ |
| BRu24 | Đăng ký Driver hoàn tất khi đủ Account DRIVER, Driver PENDING_APPROVAL/OFFLINE và Application SUBMITTED. Dữ liệu cấp phát tạm thời phải có operation để phục hồi, không dùng như bộ hồ sơ hợp lệ hoặc báo thành công khi chỉ tạo một phần |
| BRu25 | Duyệt/từ chối hồ sơ cập nhật DriverApplication và Driver.approvalStatus nhất quán. Từ chối phải có lý do; duyệt không tự bật AVAILABLE |
| BRu26 | Thông tin phương tiện do tài xế khai báo chưa phải xe được phép hoạt động. Chỉ sau kiểm tra và duyệt mới tạo hoặc liên kết Vehicle/VehicleAssignment hợp lệ |
| BRu27 | Danh sách tài xế gần vị trí chỉ trả ứng viên đủ điều kiện trong bán kính yêu cầu; phân trang không được làm trả tài xế ngoài phạm vi hoặc bỏ qua kiểm tra quyền |
| BRu28 | Customer chỉ xem Booking của mình. Booking và Trip là hai loại lịch sử riêng; yêu cầu không tìm được tài xế vẫn có trong lịch sử Booking |
| BRu29 | Dữ liệu có một dịch vụ sở hữu có thẩm quyền. Transaction chỉ bao phủ dịch vụ đó; tham chiếu liên dịch vụ được kiểm tra qua hợp đồng, không ghi chéo database |
| BRu30 | Accept và hủy Booking được Booking phân xử trên cùng tiến trình; không công bố đồng thời hai kết quả cuối mâu thuẫn |
| BRu31 | Mất phản hồi phải đối soát trước khi bù hoặc phân công lại. Trip đã hoạt động chỉ kết thúc qua quy tắc hủy/đóng hợp lệ, không xóa để giả lập rollback |
| BRu32 | Lệnh giải phóng Customer/Driver/Vehicle phải khớp operation/Trip và phiên bản đang giữ quyền; lệnh cũ không giải phóng quyền mới |
| BRu33 | Chỉ PricingConfig tại Payment là nguồn giá; Booking/Trip giữ snapshot bất biến và Fare lưu phiên bản metrics dùng khi tính |
| BRu34 | Khóa Account/thu hồi Session ngăn các lần cấp quyền mới. Cách xử lý lệnh đã được cấp quyền nhưng chưa hoàn tất ở dịch vụ khác phải có chính sách phân xử và kiểm thử riêng, không suy ra atomic từ sự kiện |

### Quy tắc chọn ứng viên

- Xếp ứng viên hợp lệ theo khoảng cách tăng dần tới điểm đón.
- Khi bằng khoảng cách, dùng driverId làm thứ tự phụ ổn định.
- Không gửi lại cùng một tài xế trong cùng tiến trình điều phối.
- Kiểm tra lại điều kiện khi tài xế nhận; dữ liệu ứng viên ban đầu không đủ để bảo đảm phân công.
- Nếu hai yêu cầu đồng thời tranh chấp cùng tài xế, chỉ một yêu cầu được phân công; yêu cầu còn lại tiếp tục tìm.
- Việc hủy Booking và nhận chuyến đồng thời phải có một kết quả thống nhất, không vừa hủy thành công vừa tạo chuyến hợp lệ.
### Quy tắc danh sách và phân trang

- Danh sách Booking được giới hạn theo Customer đăng nhập trước khi áp dụng lọc và phân trang.
- Danh sách tài xế gần vị trí được lọc theo tọa độ, bán kính và điều kiện nhận chuyến.
- Nearby sắp xếp theo khoảng cách tăng dần, sau đó driverId.
- Booking sắp xếp theo createdAt giảm dần, sau đó bookingId giảm dần.
- Các trang nearby phải gắn với cùng kết quả tìm kiếm hoặc snapshot có thời hạn để hạn chế lặp/bỏ sót do tài xế di chuyển.
- Khi kết quả tìm kiếm hết hạn, yêu cầu thực hiện truy vấn mới.
- limit và cursor không được dùng để vượt quyền xem dữ liệu.
- Chọn ứng viên trong danh sách không thay thế kiểm tra điều kiện tại thời điểm accept.
### Quy tắc loại dịch vụ và biểu giá

Các mã loại dịch vụ trong MVP:

- STANDARD
- PREMIUM
- MOTORBIKE
- VAN

Mỗi phương tiện được gán loại dịch vụ đáp ứng trong phạm vi MVP. Không suy ra loại dịch vụ chỉ từ tên hoặc nhãn xe.

Công thức cước:

`totalAmount = baseFare + distanceKm × pricePerKm + durationMinutes × pricePerMinute`

- Đơn vị tiền tệ: VND.
- Giá và các thành phần cước không âm.
- Làm tròn tổng cuối cùng tới đồng gần nhất; không làm tròn riêng từng thành phần.
- Quãng đường tính theo tuyến thực tế được hệ thống xác nhận, không dùng khoảng cách đường thẳng giữa hai điểm làm cước thực tế.
- Thời gian tính cước từ lúc IN_PROGRESS đến COMPLETED.
- Booking lưu phiên bản biểu giá và các đơn giá áp dụng tại thời điểm tạo.
- Biểu giá mới không làm thay đổi cước của Booking đã tồn tại.
- Mỗi loại dịch vụ chỉ có một phiên bản biểu giá có hiệu lực tại một thời điểm.
- Nếu thiếu dữ liệu tính cước, chưa chốt Fare và chưa thu tiền; tạo yêu cầu kiểm tra cho vận hành.
- Nguồn dữ liệu quãng đường và cách xác nhận phải được cụ thể hóa trong thiết kế trước khi triển khai.

### Quy tắc thanh toán

- CASH: tạo Payment PENDING; chỉ tài xế của chuyến xác nhận đã nhận đủ tiền.
- Thanh toán điện tử: một nhà cung cấp được tích hợp; chỉ hiển thị các phương thức mà nhà cung cấp đó hỗ trợ.
- Kết quả phải được xác minh nguồn gửi, giao dịch, số tiền và đơn vị tiền.
- Thông báo trùng hoặc gửi lại không được ghi nhận thu tiền thêm lần nữa.
- Timeout là kết quả chưa xác định, không tự coi là FAILED.
- Khi kết quả UNKNOWN, phải đối soát trước khi thử lại hoặc chuyển sang tiền mặt.
- Chỉ thử lại khi lần trước đã xác định thất bại.
- Không có hai PaymentAttempt đang xử lý đồng thời cho cùng Payment.
- Payment SUCCESS không bị hạ xuống FAILED bởi một thông báo đến muộn.
- Thông tin thu tiền mặt gồm người xác nhận, thời điểm và số tiền.
- Các trường hợp tranh chấp kết quả được ghi nhận thành sự cố để xử lý, không sửa trực tiếp lịch sử.

## 8.2. Trạng thái chuẩn

### Account

| Trạng thái | Ý nghĩa |
|---|---|
| ACTIVE | Được sử dụng hệ thống theo quyền |
| INACTIVE | Chưa hoạt động hoặc đã ngừng hoạt động |
| SUSPENDED | Bị đình chỉ |

Trạng thái tài khoản không đồng nghĩa trạng thái trực tuyến của tài xế.

Trạng thái cấp phát hồ sơ nội bộ được kiểm tra riêng. Account có thể đã được lưu trong lúc đăng ký chưa hoàn tất, nhưng không được cấp quyền sử dụng như tài khoản đã hoàn tất đăng ký. Không bổ sung enum Account để biểu diễn Saga khi chưa có hợp đồng được duyệt.
### Driver approvalStatus

| Trạng thái | Ý nghĩa |
|---|---|
| PENDING_APPROVAL | Hồ sơ tài xế đang chờ xét duyệt |
| APPROVED | Hồ sơ đã được chấp thuận |
| REJECTED | Hồ sơ bị từ chối, có lý do |

Luồng xét duyệt đăng ký:

- PENDING_APPROVAL → APPROVED.
- PENDING_APPROVAL → REJECTED.

APPROVED chưa đủ để nhận chuyến nếu Account, phương tiện, GPS hoặc trạng thái hoạt động không đáp ứng điều kiện.

Các thao tác thay đổi hồ sơ sau duyệt phải áp dụng quy tắc quản lý Driver tương ứng, có version và audit.

### DriverApplication

| Trạng thái | Ý nghĩa |
|---|---|
| SUBMITTED | Hồ sơ đăng ký đã được gửi |
| APPROVED | Hồ sơ đăng ký được duyệt |
| REJECTED | Hồ sơ đăng ký bị từ chối |

Luồng:

`SUBMITTED → APPROVED | REJECTED`

Bản MVP chỉ xử lý một hồ sơ đăng ký ban đầu cho mỗi Driver. Quy trình nộp lại hoặc quản lý nhiều phiên bản hồ sơ chưa thuộc phạm vi mặc định.

Quyết định xét duyệt phải cập nhật đồng thời hồ sơ đăng ký và trạng thái xét duyệt Driver.

Thông tin xe khai báo trong hồ sơ chưa đồng nghĩa có VehicleAssignment đang hoạt động.
### Driver

| Chuyển trạng thái | Điều kiện |
|---|---|
| OFFLINE → AVAILABLE | Account ACTIVE, hồ sơ/xe hợp lệ và có vị trí mới |
| AVAILABLE → OFFLINE | Tài xế yêu cầu ngoại tuyến hoặc không còn đáp ứng điều kiện |
| AVAILABLE → BUSY | Hệ thống xác nhận phân công thành công |
| BUSY → AVAILABLE | Trip kết thúc và tài xế vẫn đáp ứng điều kiện nhận chuyến |
| BUSY → OFFLINE | Trip kết thúc nhưng tài xế/xe không còn đáp ứng điều kiện |

Nếu tài xế BUSY mất mạng, không tự giải phóng tài xế để nhận chuyến khác. Hệ thống đánh dấu mất kết nối và báo vận hành.

Reservation là trạng thái điều phối nội bộ, không thêm trạng thái Driver công khai. Trong giai đoạn giữ chỗ, dù Driver còn hiển thị AVAILABLE thì cũng không được chọn cho công việc khác. Sau khi Trip đóng, chuyển BUSY về AVAILABLE/OFFLINE khi Driver Service đã xác minh và giải phóng đúng quyền; không yêu cầu các database đổi cùng một thời điểm.

### Booking

| Trạng thái | Ý nghĩa |
|---|---|
| PENDING | Đã tiếp nhận |
| FINDING_DRIVER | Đang tìm tài xế |
| DRIVER_ASSIGNED | Đã phân công và liên kết Trip |
| NO_DRIVER_FOUND | Kết thúc tìm nhưng không phân công được |
| CANCELLED | Hủy trước khi phân công |

Luồng chính:

`PENDING → FINDING_DRIVER → DRIVER_ASSIGNED`

Luồng khác:

- PENDING → CANCELLED.
- FINDING_DRIVER → CANCELLED.
- FINDING_DRIVER → NO_DRIVER_FOUND.

DRIVER_ASSIGNED là kết quả điều phối. Nếu Trip bị hủy sau đó, Booking vẫn giữ kết quả này; trạng thái hủy thuộc Trip.

### TripRequest

`PENDING → ACCEPTED | REJECTED | EXPIRED | CANCELLED`

- EXPIRED: hết hạn phản hồi.
- CANCELLED: Booking đã hủy hoặc lời mời bị hệ thống thu hồi.
- Tài xế không được nhận lại lời mời đã hết hiệu lực.

### Trip

Luồng chính:

`DRIVER_ASSIGNED → ARRIVED_PICKUP → PICKED_UP → IN_PROGRESS → COMPLETED`

- DRIVER_ASSIGNED: có tài xế, đang tiến tới điểm đón.
- ARRIVED_PICKUP: đã đến điểm đón.
- PICKED_UP: đã đón khách.
- IN_PROGRESS: bắt đầu hành trình tính cước.
- COMPLETED: hành trình kết thúc bình thường.
- CANCELLED: bị hủy hợp lệ trước khi đón khách.
- ERROR: hành trình bị gián đoạn và cần xử lý sự cố.

Quy định:

- Chỉ DRIVER_ASSIGNED và ARRIVED_PICKUP được chuyển sang CANCELLED.
- Các trạng thái chưa kết thúc có thể chuyển sang ERROR khi xảy ra sự cố.
- Lưu trạng thái ngay trước ERROR.
- OPERATOR có thể khôi phục về trạng thái trước ERROR sau khi xác minh điều kiện tiếp tục, có lý do và nhật ký.
- Nếu chuyến không thể tiếp tục, ERROR được đóng bằng kết quả xử lý sự cố; không tự đổi thành COMPLETED.
- COMPLETED và CANCELLED không được chuyển trở lại trạng thái đang thực hiện.
- Trip ERROR chưa giải quyết vẫn giữ tài xế BUSY; chỉ giải phóng khi vận hành xác nhận kết thúc hoặc xử lý phù hợp.
- Việc kết thúc Trip và thanh toán là hai quá trình riêng. Trip COMPLETED không đồng nghĩa Payment SUCCESS.

### Payment và PaymentAttempt

| Trạng thái | Ý nghĩa |
|---|---|
| PENDING | Chờ bắt đầu xử lý hoặc chờ xác nhận thu tiền mặt |
| PROCESSING | Đang xử lý thanh toán điện tử |
| SUCCESS | Đã xác nhận thanh toán thành công |
| FAILED | Đã xác định lần xử lý thất bại |
| UNKNOWN | Chưa xác định được kết quả, cần đối soát |

Luồng được phép:

- CASH: PENDING → SUCCESS khi tài xế xác nhận.
- Điện tử: PENDING → PROCESSING → SUCCESS, FAILED hoặc UNKNOWN.
- UNKNOWN → SUCCESS hoặc FAILED sau đối soát.
- Payment FAILED có thể mở lần thử mới; lịch sử PaymentAttempt cũ được giữ nguyên.
- SUCCESS là kết quả cuối cùng trong phạm vi MVP.
### Đối chiếu thuật ngữ với rubric

| Thuật ngữ trong rubric | Thuật ngữ trong CAB |
|---|---|
| Admin | OPERATOR |
| Ride/Trip | Trip |
| Review | Rating |
| Ride CANCELED | Trip CANCELLED |
| Payment COMPLETED | Payment SUCCESS |
| Driver Online | Driver AVAILABLE hoặc BUSY; chỉ AVAILABLE được nhận chuyến mới |
| Driver Offline | Driver OFFLINE |

SRS, API, database và test case dùng thống nhất thuật ngữ CAB.

Tài liệu demo ghi rõ bảng tương ứng. Nếu yêu cầu nghiệm thu bắt buộc tên trạng thái chính xác khác với CAB, phải thống nhất và cập nhật đồng bộ trước khi triển khai.

## 8.3. Hủy và giải phóng tài xế

| Trường hợp | Người được thực hiện | Xử lý |
|---|---|---|
| Booking chưa phân công | Khách sở hữu hoặc OPERATOR | Hủy Booking, thu hồi lời mời và dừng tìm |
| Trip trước PICKED_UP | Khách của chuyến, tài xế được phân công hoặc OPERATOR | Hủy Trip với lý do và thông báo cho bên còn lại |
| Khách không xuất hiện | Tài xế của chuyến | Chỉ chấp nhận lý do NO_SHOW sau thời gian chờ quy định |
| Tài xế/xe gặp sự cố trước đón | Tài xế hoặc OPERATOR | Hủy Trip; đưa tài xế OFFLINE nếu không đủ điều kiện |
| Sau PICKED_UP | Tài xế hoặc OPERATOR báo sự cố | Chuyển xử lý sự cố, không dùng thao tác hủy thông thường |

Khi khách muốn đặt lại sau hủy, tạo Booking mới. MVP không tự thay tài xế trong Trip cũ.

Khi phân công đang chạy, yêu cầu hủy phải được Booking phối hợp với reservation và TripPreparation. Nếu Trip đã hoạt động thì áp dụng quy tắc hủy Trip. Sau khi ghi nhận hủy/đóng, việc giải phóng các quyền có thể cần phục hồi liên dịch vụ; đến khi có xác nhận hợp lệ, tài nguyên vẫn bị chặn nhận công việc mới. Hệ thống phải thể hiện tình trạng chờ phù hợp và theo dõi công việc giải phóng, không tự bỏ khóa vì timeout.

## 8.4. Ngoại lệ bắt buộc

| Ngoại lệ | Hành vi yêu cầu |
|---|---|
| Thiếu dữ liệu hoặc dữ liệu sai | Từ chối, chỉ ra trường lỗi, không tạo kết quả nghiệp vụ hợp lệ từ dữ liệu sai. Dữ liệu cấp phát nội bộ nếu có phải thuộc tiến trình có thể phục hồi/bù, không để thành dữ liệu mồ côi không được quản lý |
| Không có tài xế phù hợp | Kết thúc NO_DRIVER_FOUND và thông báo khách |
| Tài xế từ chối/hết hạn | Thu hồi hiệu lực lời mời cũ và thử ứng viên khác trong giới hạn |
| Nhận chuyến khi lời mời hết hạn hoặc Booking đã hủy | Từ chối; không tạo Trip |
| Mất GPS | Hiển thị thời điểm vị trí gần nhất và trạng thái dữ liệu cũ |
| Hệ thống lỗi sau khi nhận lệnh thành công | Cho phép tra cứu/gửi lại an toàn, không tạo trùng kết quả |
| Thanh toán timeout | Đánh dấu UNKNOWN và đối soát |
| Webhook trùng/sai nguồn/sai số tiền | Không ghi nhận thu tiền trùng hoặc thành công không hợp lệ |
| Gửi thông báo thất bại | Ghi nhận lỗi và thử lại; giữ kết quả nghiệp vụ gốc |
| Account tài xế bị khóa giữa chuyến | Thu hồi quyền, giữ thông tin chuyến và chuyển vận hành xử lý; không tự ghi hoàn thành/hủy |
| OTP sai, hết hạn hoặc vượt số lần thử | Từ chối xác minh; không tạo quyền gửi hồ sơ hợp lệ |
| Yêu cầu gửi OTP quá giới hạn | Trả 429 theo chính sách; không tiếp tục phát mã không giới hạn |
| Verification token đã sử dụng | Không tạo hồ sơ khác; phát lại hợp lệ cùng mã chống lặp trả kết quả đã lưu |
| Hai yêu cầu đăng ký tài xế trùng định danh | Chỉ tạo một bộ Account/Driver/hồ sơ hợp lệ |
| Hai quyết định duyệt hồ sơ đồng thời | Kiểm tra version; không ghi đè quyết định đã được cập nhật |
| RabbitMQ không khả dụng | Giữ sự kiện chưa phát bền vững; phát tiếp khi khôi phục, không mất kết quả nghiệp vụ đã commit |
| Dịch vụ Rating không xác minh được Trip | Không tạo Rating dựa trên dữ liệu client; trả lỗi tạm thời phù hợp |
| Redis phục vụ rate limit không khả dụng | Các endpoint nhạy cảm được quy định trả lỗi tạm thời 503; không âm thầm bỏ giới hạn |
| Token bị sửa chữ ký hoặc payload | Từ chối 401, không cấp quyền từ payload chưa xác minh |
| Đúng danh tính nhưng sai role của chức năng | Từ chối 403, không trả dữ liệu nghiệp vụ |
| Account đã tạo nhưng dịch vụ hồ sơ chưa phản hồi | Giữ tiến trình cấp phát chưa hoàn tất, tra cứu hoặc retry cùng operationId; không cấp quyền đầy đủ hoặc tạo Account khác |
| Giữ chỗ Driver/Vehicle thành công nhưng Trip chưa rõ kết quả | Tra cứu Trip theo assignmentId trước khi giải phóng hoặc thử ứng viên khác |
| Trip kích hoạt nhưng Booking chưa nhận phản hồi | Phục hồi kết quả về phía trước; không tạo Trip thứ hai hoặc trả tài xế về AVAILABLE |
| Lệnh chuẩn bị/kích hoạt đến sau khi đã bù | Kiểm tra generation/trạng thái hủy để từ chối lệnh cũ, không hồi sinh chuyến |
| Trip đã đóng nhưng giải phóng tài nguyên chưa hoàn tất | Giữ công việc giải phóng bền vững, retry có kiểm tra chủ sở hữu và cảnh báo khi quá hạn |
| Một dịch vụ đã commit, lời gọi kế tiếp timeout | Không tự suy luận toàn bộ thất bại; phản hồi theo tình trạng tiến trình và đối soát trước khi bù |
---

# B9. Mô hình dữ liệu nghiệp vụ

Đây là mô hình khái niệm được giữ từ SRS 1.2 và bổ sung quyền sở hữu cho tám MS. Chi tiết bảng, cache và khóa ngoại vật lý nằm trong Micro_Service_Design 1.3. Quan hệ nghiệp vụ giữa hai dịch vụ không phải khóa ngoại hoặc transaction dùng chung database.

## 9.1. Các thực thể

| Thực thể | Thuộc tính chính | Vai trò |
|---|---|---|
| Account | accountId, fullName, email, phone, passwordHash, role, accountStatus, createdAt, updatedAt | Tài khoản và thông tin chung |
| Session | sessionId, accountId, refreshTokenHash, expiresAt, revokedAt | Phiên đăng nhập |
| Customer | customerId, accountId | Định danh nghiệp vụ khách hàng |
| Driver | driverId, accountId, licenseNumber, approvalStatus, driverStatus, activeVehicleId | Hồ sơ và điều kiện hoạt động tài xế |
| Operator | operatorId, accountId | Định danh nhân viên vận hành |
| Vehicle | vehicleId, licensePlate, vehicleType, vehicleStatus, driverId | Phương tiện phục vụ |
| DriverLocation | driverId, latitude, longitude, recordedAt, receivedAt | Vị trí gần nhất và độ mới dữ liệu |
| BookingRequest | bookingId, customerId, pickup, destination, vehicleType, bookingStatus, pricingVersionId, pricingSnapshot, createdAt | Ý định đặt xe |
| DispatchProcess | bookingId, dispatchStatus, attemptCount, startedAt, deadlineAt, configSnapshot | Quá trình tìm tài xế |
| TripRequest | tripRequestId, bookingId, driverId, status, sentAt, expiresAt, respondedAt, reason | Lời mời cho một tài xế |
| Trip | tripId, bookingId, customerId, driverId, vehicleId, tripStatus, startedAt, completedAt, closedAt, closeReason | Chuyến thực tế |
| TripStatusHistory | tripId, previousStatus, newStatus, changedBy, changedAt, reason | Lịch sử chuyển trạng thái |
| PricingConfig | pricingVersionId, vehicleType, baseFare, pricePerKm, pricePerMinute, effectiveFrom, effectiveTo | Phiên bản biểu giá |
| Fare | fareId, tripId, pricingVersionId, distanceKm, durationMinutes, baseAmount, distanceAmount, timeAmount, totalAmount, currency | Cước đã tính của chuyến |
| Payment | paymentId, fareId, customerId, method, paymentStatus, amount, paidAt, confirmedByAccountId | Nghĩa vụ và kết quả thanh toán |
| PaymentAttempt | attemptId, paymentId, idempotencyKey, providerTransactionId, status, createdAt, resolvedAt | Từng lần xử lý thanh toán |
| Rating | ratingId, tripId, customerId, driverId, score, comment, createdAt | Đánh giá sau chuyến |
| Notification | notificationId, eventId, recipientAccountId, eventType, referenceId, deliveryStatus, isRead, createdAt | Thông báo tới tài khoản |
| IncidentRecord | incidentId, tripId, issueType, description, status, reportedBy, handledBy, resolution, createdAt, resolvedAt | Xử lý sự cố |
| AuditLog | auditId, actorId, action, entityType, entityId, changedFields, occurredAt, correlationId | Truy vết thao tác |
| OtpChallenge | challengeId, phoneReference, purpose, codeDigest, expiresAt, failedAttempts, verifiedAt, invalidatedAt | Theo dõi xác minh số điện thoại và giới hạn thử OTP |
| PhoneVerification | verificationId, challengeId, phoneReference, tokenDigest, expiresAt, consumedAt | Quyền gửi hồ sơ sau xác minh, có thời hạn và dùng một lần |
| DriverApplication | applicationId, driverId, submittedVehicleDetails, status, version, submittedAt, reviewedAt, reviewedByAccountId, rejectionReason | Hồ sơ đăng ký và quyết định xét duyệt tài xế |
| VehicleAssignment | assignmentId, driverId, vehicleId, startedAt, endedAt, assignedByAccountId | Phân công xe hiện hành và lịch sử |
| CustomerActivityGuard | customerId, ownerOperationId, bookingId, tripId, version | Quyền hoạt động duy nhất của Customer, do Customer Service quản lý |
| RegistrationOperation | operationId, accountId, loại hồ sơ, trạng thái, kết quả từng bước | Tiến trình cấp phát Account và hồ sơ, do Identity điều phối |
| DriverReservation | reservationId, assignmentId, driverId, vehicleId, bookingId, tripId, generation, state | Giữ/xác nhận quyền phục vụ Driver và Vehicle tại Driver Service |
| AssignmentSaga | assignmentId, bookingId, tripId, trạng thái, version, cancelRequested và kết quả từng bước | Phân xử và phục hồi phân công tại Booking Service |
| TripPreparation | assignmentId, tripId, generation, trạng thái chuẩn bị/kích hoạt/hủy | Ngăn tạo/kích hoạt trùng hoặc hồi sinh bước đã hủy tại Trip |
| TripRoutePoint | sampleId, tripId, driverId, latitude, longitude, recordedAt, receivedAt | Mẫu hành trình đã xác minh, thuộc Trip |
| JourneyMetrics | tripId, metricsVersion, distanceKm, durationMinutes, qualityStatus, calculationMethodVersion, confirmedAt | Kết quả xác nhận dữ liệu tính cước, thuộc Trip |
| ClosureOperation | operationId, tripId, closureVersion, kết quả giải phóng từng quyền | Tiếp tục giải phóng sau khi Trip đóng, thuộc Trip |
| ProviderEvent | provider, providerEventId, attemptId, verifiedResult, processingStatus | Chống xử lý callback trùng và lưu kết quả xác minh tại Payment |
| IdempotencyRecord | danh tính, operation, key, requestDigest, trạng thái, kết quả và thời điểm | Chống lặp tại dịch vụ thực hiện thao tác |
| OutboxEvent / InboxReceipt | eventId, nguồn, phiên bản schema, nội dung tối thiểu/digest và trạng thái xử lý | Bàn giao bền vững, chống trùng và phục hồi sự kiện tại dịch vụ sở hữu |

Quy ước xác nhận thanh toán tiền mặt:

- confirmedByAccountId là accountId của DRIVER được phân công cho Trip và đã xác nhận nhận đủ tiền mặt.
- Không dùng driverId hoặc accountId của OPERATOR thay cho trường này.
- Người xác nhận được xác định từ danh tính đăng nhập đã kiểm tra; client không được tự cung cấp confirmedByAccountId.
- Trường này chỉ có khi đã ghi nhận xác nhận tiền mặt hợp lệ.
- PaymentAttempt tương ứng lưu cùng danh tính người xác nhận để truy vết theo thiết kế và API thanh toán.
- paidAt chỉ có khi Payment SUCCESS.
- Gửi lại yêu cầu xác nhận đã thành công không ghi lại paidAt hoặc tạo thêm lần thanh toán.
  
Các trường mật khẩu/token và dữ liệu thanh toán nhạy cảm không được đưa vào changedFields.
Email, phone và licenseNumber trong bảng là thuộc tính nghiệp vụ ở mức khái niệm, không phải yêu cầu lưu plaintext.

Thiết kế lưu trữ phải mã hóa các dữ liệu này và dùng giá trị tra cứu có khóa riêng khi cần kiểm tra duy nhất. Không lưu thêm cột plaintext để bỏ qua cơ chế bảo vệ.

phoneReference biểu diễn số điện thoại được bảo vệ và định danh tra cứu tương ứng; cấu trúc vật lý nằm trong Micro_Service_Design.

OTP và verification token không lưu dạng rõ.

activeVehicleId của Driver và liên kết Driver trong Vehicle là dữ liệu được suy ra từ VehicleAssignment hiện hành, không phải hai quan hệ cho phép sửa độc lập.
## 9.2. Quan hệ và ràng buộc

- Account có nhiều Session.
- Account liên kết một hồ sơ phù hợp với vai trò trong MVP.
- Customer có nhiều BookingRequest theo thời gian.
- BookingRequest có một DispatchProcess và nhiều TripRequest.
- BookingRequest có tối đa một Trip.
- Driver có nhiều Trip theo lịch sử nhưng tối đa một Trip đang hoạt động.
- Trip có nhiều TripStatusHistory.
- Trip có tối đa một Fare đã chốt.
- Fare có tối đa một Payment.
- Payment có nhiều PaymentAttempt.
- Trip có tối đa một Rating.
- Trip có thể có nhiều IncidentRecord.
- Notification gắn người nhận bằng accountId; customerId/driverId vẫn được giữ cho các liên kết nghiệp vụ.
- OtpChallenge gắn với số điện thoại và mục đích đăng ký.
- PhoneVerification được tạo từ challenge đã xác minh và chỉ được tiêu thụ một lần.
- Driver có một DriverApplication đăng ký ban đầu trong bản MVP.
- Driver và Vehicle có nhiều VehicleAssignment theo lịch sử.
- Mỗi Driver và mỗi Vehicle chỉ có tối đa một VehicleAssignment chưa kết thúc.
- Kết quả xét duyệt hồ sơ có thể phát sinh Notification cho Account DRIVER liên quan.
Quy ước:

- Email và số điện thoại duy nhất trên Account.
- Biển số xe duy nhất sau chuẩn hóa.
- Một xe không đồng thời được gán hoạt động cho nhiều tài xế.
- Không đổi xe đang phục vụ một Trip chưa kết thúc.
- Các tham chiếu giữa dịch vụ không mặc nhiên là khóa ngoại xuyên cơ sở dữ liệu.
- Không xóa dữ liệu đang được lịch sử chuyến/thanh toán tham chiếu để thay cho việc ngừng hoạt động.

---

## 9.3. Quyền sở hữu và tính nhất quán trong tám MS

| Chủ sở hữu | Dữ liệu có thẩm quyền |
|---|---|
| Identity | Account, Operator, Session, OtpChallenge, PhoneVerification, RegistrationOperation |
| Customer | Customer, CustomerActivityGuard |
| Driver | Driver, DriverApplication, Vehicle, VehicleAssignment, DriverLocation, DriverReservation |
| Booking | BookingRequest, DispatchProcess, TripRequest, AssignmentSaga và snapshot giá được chấp nhận |
| Trip | Trip, TripPreparation, TripStatusHistory, IncidentRecord, TripRoutePoint, JourneyMetrics, ClosureOperation |
| Payment | PricingConfig, Fare, Payment, PaymentAttempt, ProviderEvent |
| Rating | Rating |
| Notification | Notification, inbox và công việc công bố thông báo |

Idempotency, audit, outbox/inbox và job được quản lý tại dịch vụ cần sử dụng, không phải database dùng chung. Operator profile nếu còn giữ trong mô hình thuộc Identity, không tạo MS thứ chín.

- Giao tiếp nội bộ qua hợp đồng có xác thực; không đọc/ghi database dịch vụ khác.
- Snapshot giá, xe và danh tính lịch sử giữ nguyên theo quy tắc đã chốt; projection có nguồn và version, không trở thành bản gốc có thể sửa độc lập.
- Dữ liệu đăng ký chưa hoàn tất và TripPreparation có trạng thái kỹ thuật, không được trình bày như đăng ký hoặc chuyến đã thành công.
- CustomerActivityGuard chuyển quyền từ Booking sang Trip, không tạo quyền thứ hai; chỉ giải phóng khi còn khớp chủ sở hữu.
- DriverReservation bảo vệ cả Driver và Vehicle. Quyền đã gắn Trip hoạt động không tự mất chỉ vì TTL hoặc Worker dừng.
- Sự kiện lặp/sai thứ tự không làm giảm version, ghi đè kết quả cuối hoặc tác động lên công việc mới.

---

# B10. Yêu cầu phi chức năng

Các mục tiêu định lượng dưới đây là đề xuất cho môi trường nghiệm thu MVP. Khi kiểm thử phải ghi rõ cấu hình máy, dữ liệu, tải và phiên bản ứng dụng.

| Mã | Yêu cầu | Cách kiểm chứng |
|---|---|---|
| NFR01 | Với 50 người dùng đồng thời, dữ liệu 10.000 chuyến, bài thử 10 phút: mục tiêu 95% yêu cầu hồ sơ, tạo Booking, cập nhật/xem trạng thái phản hồi trong 1 giây; tỷ lệ lỗi ngoài dự kiến dưới 1%. Đo từ Gateway, bao gồm các hop nội bộ. Thời gian chờ tài xế/provider đo riêng. Nếu có phản hồi đang xử lý, phải báo riêng độ trễ xác nhận cuối, không tính phản hồi 202 nhanh là nghiệp vụ đã hoàn tất | Kiểm thử tải và báo cáo riêng độ trễ API, thời gian hoàn tất operation, phân vị và tỷ lệ lỗi |
| NFR02 | Tám MS Identity, Customer, Driver, Booking, Trip, Payment, Rating và Notification có tiến trình, quyền sở hữu dữ liệu và khả năng build/triển khai riêng khi giữ tương thích hợp đồng. Dispatch thuộc Booking; hành trình thuộc Trip và vị trí mới nhất thuộc Driver. Khi tranh chấp không tạo hai Trip cho một Booking hoặc hai quyền phục vụ hoạt động cho cùng Driver/Vehicle | Rà soát tám ranh giới, quyền database, triển khai riêng và kiểm thử tranh chấp |
| NFR03 | Sau restart không mất kết quả đã xác nhận; retry không tạo Booking, hồ sơ, Trip, Rating, thông báo hoặc thanh toán trùng. Saga lưu bước đã hoàn tất; mất phản hồi được tra cứu trước khi bù. Lỗi thông báo không đảo ngược nghiệp vụ. Lệnh cũ không giải phóng tài nguyên hoặc hồi sinh tiến trình đã hủy | Ngắt sau từng commit/RPC, phát lặp và sai thứ tự, restart Worker, đối chiếu các bất biến |
| NFR04 | Chức năng được bảo vệ kiểm tra chữ ký JWT, issuer, audience, thời hạn, Account, Session, role và quyền trên dữ liệu. Token bị sửa hoặc không hợp lệ trả 401; token hợp lệ nhưng sai role của chức năng trả 403. Phiên đã thu hồi không tiếp tục truy cập được | Kiểm thử JWT tampering, truy cập trái phép, token hết hạn và thu hồi |
| NFR05 | Mật khẩu lưu dạng băm chuyên dụng; email, phone và giấy phép được mã hóa khi lưu, khóa tách khỏi database và Git. Có quản lý phiên bản/luân chuyển khóa. Không ghi mật khẩu, OTP, token hoặc dữ liệu nhạy cảm không cần thiết vào log. Dữ liệu cá nhân/vị trí chỉ hiển thị đúng quyền. Kết nối ngoài máy phát triển dùng HTTPS | Đọc trực tiếp database, kiểm tra quyền giải mã, rà soát log/secret và kiểm thử xoay khóa |
| NFR06 | Truy vết từ Account/Booking tới Trip, Fare, Payment, Incident bằng ID, operationId/correlationId. Mỗi dịch vụ ghi audit của thay đổi do mình thực hiện; không phụ thuộc Analytics để giữ audit gốc. Theo dõi backlog, tiến trình chờ/bù và giải phóng quá hạn mà không lộ secret | Kiểm tra trace/audit của luồng qua nhiều MS và công việc phục hồi |
| NFR07 | Gateway cung cấp /health, /ready và /health/services; phản ánh trạng thái thực của dịch vụ và phụ thuộc. Readiness chưa đạt trả 503. Danh sách chi tiết chỉ dành cho OPERATOR. Theo dõi được Worker, backlog, độ trễ, Booking đang chờ và Payment UNKNOWN | Thử dừng dịch vụ/phụ thuộc, kiểm tra HTTP status, nội dung phản hồi và khả năng khôi phục |
| NFR08 | Nhà cung cấp thanh toán, bản đồ và thông báo được tách qua hợp đồng tích hợp; thay nhà cung cấp không đổi quy tắc nghiệp vụ cốt lõi | Rà soát thiết kế và kiểm thử với bộ giả lập hợp đồng |
| NFR09 | Khi kết nối bình thường, 95% cập nhật trạng thái/vị trí đã được máy chủ nhận xuất hiện cho người theo dõi trong 3 giây; vị trí quá ngưỡng được đánh dấu cũ | Đo timestamp và mô phỏng mất mạng |
| NFR10 | Có sao lưu/khôi phục dữ liệu bền vững; môi trường thử nghiệm sao lưu mỗi ngày và có ít nhất một lần phục hồi kiểm chứng. Phạm vi gồm dữ liệu tám MS, bằng chứng chống trùng, tiến trình/job và kế hoạch khôi phục khóa. Sau restore kiểm tra liên kết và đối soát trạng thái liên dịch vụ; không suy ra nhất quán chỉ từ số hàng khôi phục | Restore có kiểm soát, đối chiếu dữ liệu liên dịch vụ và tiếp tục job; không thu tiền lần nữa |
| NFR11 | Mọi HTTP request từ client và callback bên ngoài đi qua Gateway. Các dịch vụ nghiệp vụ không công bố cổng trong cấu hình chạy bài mặc định. Route nội bộ không mở cho client. Gateway không thay thế phân quyền tại dịch vụ đích | Gọi qua Gateway, kiểm tra cấu hình cổng và thử truy cập backend trực tiếp |
| NFR12 | Gateway và các MS dùng gRPC nội bộ có xác thực, scope, deadline và mapping lỗi; RabbitMQ truyền sự kiện từ dịch vụ sở hữu nghiệp vụ. Outbox/inbox bền vững, retry có backoff theo loại việc, chống trùng và xử lý lỗi quá ngưỡng. Chỉ retry RPC ghi khi có chống lặp; không buộc mọi luồng dùng event bất đồng bộ | Theo dõi một RPC gRPC thật và một sự kiện qua broker; kiểm thử timeout, caller sai, giao lặp/sai thứ tự và phục hồi |
| NFR13 | Compose baseline có Gateway, tám MS, PostgreSQL, Redis và RabbitMQ, tương ứng 12 container nếu mỗi thành phần một container; Worker tách riêng làm tăng container nhưng không tăng số MS nghiệp vụ. Có cấu hình/migration/seed và healthcheck riêng, kết nối phục hồi khi phụ thuộc restart; chỉ Gateway công bố cổng ứng dụng | Liệt kê thành phần và quyền database, khởi chạy/restart phụ thuộc theo hướng dẫn; migration/seed là tác vụ một lần |
| NFR14 | Source có thư mục riêng cho Gateway và tám MS; contracts dùng chung không chứa ORM/repository để truy cập chéo database. Repository có .gitignore, .dockerignore, .env.example; không commit hoặc đóng gói secret vào image | Rà soát cấu trúc source, import giữa dịch vụ, file tracked, image và lịch sử Git khi nghi lộ secret |
| NFR15 | Input người dùng không được ghép trực tiếp vào SQL; truy vấn tham số hóa và các thành phần động có danh sách cho phép. Payload SQL injection không vượt xác thực, không đọc trái phép và không làm lộ lỗi database | Gửi payload injection qua API và kiểm tra phản hồi cùng truy vấn liên quan |
| NFR16 | Nội dung người dùng được xử lý như văn bản trong MVP. Khi hiển thị phải encode đúng ngữ cảnh, không thực thi script. Phản hồi JSON và giao diện phải được kiểm tra phù hợp | Gửi payload XSS qua API, kiểm tra response và nơi hiển thị trên trình duyệt |
| NFR17 | Gateway áp dụng rate limit theo IP/tài khoản/chức năng; vượt ngưỡng trả 429 và Retry-After. Có kiểm thử tải theo kịch bản hơn 1.000 request/giây của rubric, ghi rõ môi trường, thời gian, số 429, lỗi ngoài dự kiến và khả năng phục hồi | Chạy công cụ kiểm thử tải trong môi trường kiểm soát; lưu báo cáo thay vì suy đoán từ cấu hình |
| NFR18 | Tiến trình liên dịch vụ có trạng thái bền vững, chủ sở hữu, ID/phiên bản và phục hồi có điều kiện. Chỉ người có quyền xem/tiếp tục; operationId không tự là quyền truy cập. Thời hạn lưu, ngân sách chờ và quy trình can thiệp được đặc tả trước triển khai | Kiểm thử FR28/UC22/AC21; gọi sai người, restart, timeout và lệnh quá hạn hoặc đến muộn |

Không cam kết tỷ lệ uptime vận hành thực tế chỉ dựa trên bài thử ngắn của MVP.

---

# B11. Sơ đồ Use Case

Sơ đồ dưới đây biểu diễn tác nhân và các nhóm Use Case. Chi tiết tiền điều kiện, luồng và ngoại lệ nằm ở B12.

```mermaid
flowchart LR
    C["Khách hàng"]
    D["Tài xế"]
    G["Người đăng ký tài xế"]
    O["Nhân viên vận hành"]
    P["Nhà cung cấp thanh toán"]
    M["Nhà cung cấp bản đồ"]
    S["Nhà cung cấp OTP/SMS"]

    subgraph CAB["CAB System"]
        A(["UC01: Tài khoản và phiên"])
        B(["UC02: Đặt xe"])
        X(["UC03: Điều phối"])
        T(["UC04: Theo dõi chuyến"])
        R(["UC05: Nhận hoặc từ chối"])
        E(["UC06: Thực hiện chuyến"])
        PAY(["UC07: Tính cước và thanh toán"])
        RATE(["UC08: Đánh giá"])
        OPS(["UC09: Vận hành và sự cố"])
        FLEET(["UC10: Xét duyệt tài xế và quản lý xe"])
        GPS(["UC11: Trực tuyến và GPS"])
        CANCEL(["UC12: Hủy"])
        HIST(["UC13: Lịch sử chuyến"])
        PRICE(["UC14: Biểu giá và cước dự kiến"])
        N(["UC15: Thông báo"])
        REPORT(["UC16: Báo cáo - ngoài MVP"])
        REG(["UC17: Đăng ký tài xế qua OTP"])
        NEAR(["UC18: Tài xế gần vị trí"])
        BOOKHIST(["UC19: Danh sách Booking"])
        PROFILE(["UC20: Hồ sơ theo mã"])
        HEALTH(["UC21: Sức khỏe hệ thống"])
        PROGRESS(["UC22: Theo dõi tiến trình liên dịch vụ"])
    end

    C --- A
    C --- B
    C --- T
    C --- PAY
    C --- RATE
    C --- CANCEL
    C --- HIST
    C --- N
    C --- PRICE
    C --- NEAR
    C --- BOOKHIST
    C --- PROFILE

    D --- A
    D --- X
    D --- R
    D --- E
    D --- PAY
    D --- GPS
    D --- CANCEL
    D --- HIST
    D --- N
    D --- PROFILE
    D --- REG

    G --- REG
    S --- REG

    O --- A
    O --- T
    O --- OPS
    O --- FLEET
    O --- CANCEL
    O --- PRICE
    O --- REPORT
    O --- NEAR
    O --- PROFILE
    O --- HEALTH
    C --- PROGRESS
    D --- PROGRESS
    G --- PROGRESS
    O --- PROGRESS

    P --- PAY
    M --- PRICE
    M --- T

    B -. "khởi tạo điều phối" .-> X
    REG -. "hồ sơ chờ xét duyệt" .-> FLEET
    FLEET -. "kết quả xét duyệt" .-> N
```
# B12. Đặc tả Use Case

Tiền điều kiện chung đối với chức năng được bảo vệ: Account ACTIVE, phiên hợp lệ và có quyền thực hiện. Ngoại lệ chung: dữ liệu không hợp lệ, hết quyền hoặc tài nguyên không tồn tại phải được xử lý rõ ràng, không tạo kết quả thành công giả.

## UC01 – Tài khoản và phiên đăng nhập

| Use Case con | Tác nhân | Luồng chính và hậu điều kiện | Ngoại lệ |
|---|---|---|---|
| UC01.1 Đăng ký khách hàng | Khách chưa có tài khoản | Nhập thông tin → kiểm tra → Identity ghi tiến trình → Customer tạo hồ sơ → xác nhận đủ liên kết → hoàn tất đăng ký → yêu cầu đăng nhập | Trùng định danh, thiếu dữ liệu, tự gán quyền; mất phản hồi thì theo dõi/retry cùng tiến trình, không báo thành công một phần |
| UC01.2 Đăng nhập | Ba vai trò | Nhập emailOrPhone và mật khẩu → xác thực → kiểm tra ACTIVE và cấp phát hồ sơ đã hoàn tất → tạo Session → trả thông tin tài khoản/quyền | Sai thông tin, tài khoản không hoạt động hoặc cấp phát chưa xong; không tiết lộ tài khoản tồn tại khi thông tin xác thực sai |
| UC01.3 Xem/cập nhật hồ sơ | Ba vai trò | Xem hồ sơ mình → sửa trường cho phép → kiểm tra → lưu → trả dữ liệu mới | Sửa role/status/ID, trùng liên hệ, thiếu xác minh mật khẩu khi đổi email/điện thoại |
| UC01.4 Đổi mật khẩu | Ba vai trò | Xác minh mật khẩu hiện tại → kiểm tra mật khẩu mới → lưu bản băm → thu hồi mọi phiên → đăng nhập lại | Sai mật khẩu hiện tại hoặc dữ liệu mới không hợp lệ |
| UC01.5 Làm mới phiên | Ba vai trò | Kiểm tra refresh token, Session và Account → thay refresh token → cấp access token mới | Hết hạn, đã thu hồi, token đã được thay thế |
| UC01.6 Đăng xuất | Ba vai trò | Thu hồi phiên hiện tại → kết thúc quyền truy cập của phiên | Gửi lại thao tác không làm ảnh hưởng các phiên khác |

## UC02 – Đặt xe

- Tác nhân: CUSTOMER.
- Tiền điều kiện: không có Booking/Trip khác đang hoạt động; loại dịch vụ có biểu giá hiệu lực.
- Luồng: nhập điểm đón/đến và loại dịch vụ → kiểm tra → ghi tiến trình → Customer giữ quyền hoạt động → lấy snapshot giá từ Payment → Booking lưu yêu cầu và công việc điều phối → chuyển FINDING_DRIVER → khởi tạo UC03.
- Ngoại lệ: dữ liệu sai, ngoài vùng được hỗ trợ, dịch vụ chưa cấu hình, đã có yêu cầu hoạt động hoặc gửi trùng.
- Hậu điều kiện cuối: có một Booking hợp lệ hoặc yêu cầu bị từ chối với lý do rõ ràng. Nếu chưa xác định kết quả do gián đoạn, phản ánh tiến trình theo UC22; không giả thành thất bại hoặc tạo Booking thứ hai.

## UC03 – Tìm và phân công tài xế

- Kích hoạt: Booking chuyển FINDING_DRIVER.
- Tác nhân tham gia: tài xế phản hồi qua UC05.
- Luồng: chọn ứng viên theo BRu01 → gửi một TripRequest → chờ phản hồi → Booking điều phối giữ quyền và chuẩn bị/kích hoạt Trip theo UC05 → ghi kết quả phân công → thông báo.
- Ngoại lệ: từ chối, hết hạn, mất điều kiện, tranh chấp, Booking bị hủy.
- Hậu điều kiện: DRIVER_ASSIGNED, NO_DRIVER_FOUND hoặc CANCELLED; không còn lời mời PENDING khi quá trình đã kết thúc.

## UC04 – Theo dõi chuyến

- Tác nhân: khách của chuyến và OPERATOR.
- Tiền điều kiện: có quyền xem Trip.
- Luồng: chọn chuyến → xem trạng thái, tài xế, xe, vị trí, thời điểm vị trí và ETA → nhận cập nhật.
- Ngoại lệ: mất GPS hoặc dịch vụ ETA không khả dụng; hiển thị dữ liệu cuối kèm cảnh báo độ mới.
- Hậu điều kiện: người xem biết trạng thái gần nhất và mức cập nhật của dữ liệu.

## UC05 – Nhận hoặc từ chối lời mời

- Tác nhân: tài xế được chỉ định.
- Tiền điều kiện: TripRequest PENDING, còn hạn; Booking đang tìm và tài xế còn đủ điều kiện.
- Luồng nhận: xem lời mời → chấp nhận → Booking phân xử quyền xử lý → Driver giữ Driver/Vehicle → Trip chuẩn bị chuyến → gắn quyền Customer/Driver/Vehicle với tripId → kích hoạt Trip → ghi kết quả phân công và thông báo.
- Luồng từ chối: nhập lý do nếu có → REJECTED → điều phối tiếp tục.
- Ngoại lệ: phản hồi muộn, đã xử lý, sai tài xế, Booking đã hủy, tài xế vừa nhận chuyến khác.
- Hậu điều kiện: kết quả lời mời được ghi nhận một lần.

- Chỉ xác nhận nhận thành công khi đủ hậu điều kiện phân công; khi mất phản hồi tra cứu cùng assignmentId trước khi bù. Trip đã hoạt động không bị xóa bù. Yêu cầu hủy đến trong lúc phân công được Booking ghi nhận và xử lý theo trạng thái thật.
- Ngoại lệ bổ sung: reservation tranh chấp, Trip đã kích hoạt nhưng phản hồi mất, lệnh cũ đến sau khi bù; theo dõi/khôi phục qua UC22.

## UC06 – Thực hiện chuyến

- Tác nhân: tài xế được phân công.
- Tiền điều kiện: Trip chưa kết thúc.
- Luồng: xác nhận đến đón → đón khách → bắt đầu hành trình → hoàn thành.
- Hệ thống kiểm tra từng chuyển trạng thái, ghi lịch sử và thông báo.
- Ngoại lệ: bỏ bước, cập nhật chuyến khác, lặp thao tác hoặc sự cố.
- Hậu điều kiện: Trip có trạng thái hợp lệ; COMPLETED tạo công việc xác nhận JourneyMetrics và giải phóng tài nguyên đúng quyền. Chỉ khi metrics CONFIRMED mới cho Payment phát hành Fare. Giải phóng liên dịch vụ có thể chờ retry, không làm Trip đã đóng quay lại hoạt động.

## UC07 – Tính cước và thanh toán

- Tác nhân: khách của chuyến, tài xế của chuyến và nhà cung cấp thanh toán.
- Tiền điều kiện: Trip COMPLETED và có dữ liệu tính cước hợp lệ.
- Luồng: tính Fare → hiển thị thành phần giá → khách chọn phương thức.
- Tiền mặt: Payment PENDING → tài xế xác nhận đã nhận đủ tiền → SUCCESS.
- Điện tử: tạo PaymentAttempt → gửi nhà cung cấp → xác minh kết quả → cập nhật Payment.
- Ngoại lệ: dữ liệu cước thiếu, thanh toán thất bại, timeout, callback trùng hoặc không hợp lệ.
- Hậu điều kiện: lưu kết quả đã xác định; nếu chưa rõ thì giữ UNKNOWN để đối soát, không tự đánh dấu thành công.

## UC08 – Đánh giá tài xế

- Tác nhân: khách của chuyến.
- Tiền điều kiện: Trip COMPLETED và chưa có đánh giá.
- Luồng: nhập điểm nguyên 1–5 và nhận xét tùy chọn → kiểm tra chủ chuyến, trạng thái và đánh giá đã tồn tại → lưu Rating cùng kết quả chống lặp.
- Ngoại lệ: sai chủ chuyến, điểm không hợp lệ, chuyến chưa hoàn thành hoặc đánh giá trùng.
- Hậu điều kiện: một Rating gắn đúng Trip, Customer và Driver.
- Không yêu cầu Payment phải SUCCESS.

- Rating xác minh Account/Session với Identity và ngữ cảnh chuyến với Trip; không còn phụ thuộc lời gọi đến CAB Core. Không xác minh được thì không lưu đánh giá từ dữ liệu client tự khai báo.

## UC09 – Quản lý vận hành và sự cố

- Tác nhân: OPERATOR.
- Luồng: xem dữ liệu → chọn đối tượng → thực hiện thao tác được phép → ghi lý do khi cần → lưu nhật ký.
- Với sự cố: tạo IncidentRecord → xác minh → thực hiện hành động hợp lệ → ghi kết quả → đóng hoặc tiếp tục theo dõi.
- Ngoại lệ: không đủ quyền, dữ liệu đã thay đổi hoặc trạng thái không cho phép.
- Hậu điều kiện: thay đổi truy vết được; không ép trạng thái thanh toán thành công hoặc chuyến hoàn thành để bỏ qua sự cố.

## UC10 – Xét duyệt hồ sơ tài xế và quản lý xe

- Tác nhân: OPERATOR.
- Tiền điều kiện: Account ACTIVE, phiên hợp lệ và có quyền vận hành.
- Luồng xét duyệt:
  1. Xem danh sách hồ sơ theo trạng thái.
  2. Mở chi tiết hồ sơ tài xế và thông tin xe khai báo.
  3. Kiểm tra điều kiện, giấy phép, biển số và ràng buộc phân công.
  4. Chọn duyệt hoặc từ chối; từ chối phải nhập lý do.
  5. Kiểm tra version của hồ sơ.
  6. Cập nhật hồ sơ và Driver.approvalStatus nhất quán.
  7. Khi duyệt, tạo hoặc liên kết Vehicle/VehicleAssignment hợp lệ.
  8. Ghi người thực hiện, thời điểm, audit và sự kiện thông báo.
- Luồng quản lý xe: OPERATOR tạo hoặc cập nhật phương tiện và phân công xe theo quyền, tuân thủ các ràng buộc về tính duy nhất, trạng thái xe và chuyến đang hoạt động. UC10 không tạo trực tiếp Account DRIVER; tài khoản tài xế được tạo qua luồng đăng ký tại UC17.
- Ngoại lệ: hồ sơ đã xử lý, version cũ, trùng giấy phép/biển số, xe đang gán cho tài xế khác hoặc đang có chuyến.
- Hậu điều kiện:
  - Quyết định được lưu nhất quán.
  - Tài xế nhận được kết quả qua thông báo trong ứng dụng.
  - Driver giữ OFFLINE sau khi duyệt.
  - Gửi lại quyết định đã thành công không tạo xe hoặc phân công trùng.

## UC11 – Trực tuyến và cập nhật vị trí

- Tác nhân: DRIVER.
- Luồng: yêu cầu trực tuyến → kiểm tra điều kiện và vị trí → AVAILABLE → gửi vị trí định kỳ.
- Ngoại lệ: GPS cũ, tọa độ sai, mất mạng, hồ sơ/xe không hợp lệ.
- Hậu điều kiện: hệ thống có trạng thái hoạt động và vị trí với thời điểm rõ ràng.
- BUSY không được tự giải phóng bằng thao tác ngoại tuyến.

## UC12 – Hủy yêu cầu hoặc chuyến

- Tác nhân: khách sở hữu, tài xế được phân công hoặc OPERATOR.
- Luồng: chọn hủy → nhập lý do → kiểm tra quyền/trạng thái → kết thúc Booking hoặc Trip → thu hồi lời mời → cập nhật tài xế → thông báo.
- Ngoại lệ: đã đón khách, hết quyền, chưa đủ thời gian NO_SHOW hoặc trạng thái đã thay đổi.
- Hậu điều kiện cuối: đối tượng hủy đúng phạm vi, không còn offer hợp lệ và quyền Customer/Driver/Vehicle được giải phóng đúng đối tượng. Quyết định hủy và tiến trình giải phóng phải truy vết được; gián đoạn được retry/cảnh báo, không giả định cập nhật nguyên tử giữa các dịch vụ.

## UC13 – Lịch sử chuyến

- Tác nhân: CUSTOMER hoặc DRIVER.
- Luồng: chọn khoảng thời gian/trạng thái → xem danh sách phân trang → xem chi tiết chuyến và thanh toán.
- Ngoại lệ: yêu cầu xem chuyến của người khác.
- Hậu điều kiện: chỉ trả về dữ liệu thuộc phạm vi được phép.

## UC14 – Biểu giá và cước dự kiến

- OPERATOR: nhập phiên bản biểu giá → kiểm tra đơn giá/thời gian hiệu lực → lưu.
- CUSTOMER, khi có chức năng ước tính: tìm/chọn địa chỉ → xác định tuyến → xem quãng đường, thời gian và cước dự kiến.
- Ngoại lệ: chồng lấn biểu giá, đơn giá âm, bản đồ không khả dụng.
- Hậu điều kiện: biểu giá mới chỉ ảnh hưởng Booking mới; cước dự kiến được ghi rõ là ước tính.

## UC15 – Thông báo

- Tác nhân nhận: CUSTOMER, DRIVER.
- Kích hoạt: sự kiện nghiệp vụ.
- Luồng: xác định người nhận → chống trùng → tạo thông báo → gửi → người nhận xem/đánh dấu đã đọc.
- Ngoại lệ: mất kết nối hoặc gửi thất bại; lưu trạng thái để gửi lại.
- Hậu điều kiện: không tạo bản ghi trùng, không đảo ngược nghiệp vụ đã hoàn tất.

## UC16 – Báo cáo cơ bản

**Ngoài MVP, giữ để truy vết.** Chỉ thực hiện khi phạm vi mở rộng đã được duyệt; dữ liệu tổng hợp đi qua hợp đồng/projection có nguồn và độ mới, không JOIN trực tiếp database của các MS.

- Tác nhân: OPERATOR.
- Luồng: chọn thời gian → tổng hợp → hiển thị số chuyến và số tiền đã thu.
- Quy ước: số tiền đã thu tính theo Payment SUCCESS và paidAt; số chuyến tính theo thời điểm tạo Trip.
- Tỷ lệ hủy = số Trip CANCELLED / tổng Trip được tạo trong khoảng đã chọn.
- Booking không tìm được tài xế được báo riêng, không tính thành Trip bị hủy.
- Nếu mẫu số bằng 0, hiển thị “Không có dữ liệu”, không gây lỗi hoặc tạo tỷ lệ giả.
- Hậu điều kiện: chỉ tiêu có định nghĩa, thời gian và dữ liệu đối chiếu được.
## UC17 – Đăng ký tài xế qua OTP

- Tác nhân: người đăng ký tài xế, nhà cung cấp OTP/SMS; tài xế đăng nhập để xem hồ sơ đã gửi.
- Tiền điều kiện gửi hồ sơ: số điện thoại đã xác minh, verification token còn hiệu lực và đúng mục đích.
- Luồng:
  1. Nhập số điện thoại.
  2. Yêu cầu OTP.
  3. Hệ thống kiểm tra giới hạn và gửi mã.
  4. Người đăng ký nhập mã.
  5. Hệ thống xác minh và cấp verification token ngắn hạn.
  6. Nhập thông tin cá nhân, email, mật khẩu, giấy phép và phương tiện.
  7. Gửi hồ sơ cùng mã chống lặp.
  8. Identity kiểm tra định danh, tiêu thụ token và lưu tiến trình; Driver tạo Driver/DriverApplication idempotently; Identity xác nhận đủ liên kết để hoàn tất.
  9. Khi đăng ký đã hoàn tất, tài xế đăng nhập xem hồ sơ và chờ xét duyệt. Nếu cấp phát chưa hoàn tất thì theo dõi/tiếp tục tiến trình theo UC22.
- Ngoại lệ: OTP sai/hết hạn, vượt giới hạn, token đã dùng, dữ liệu trùng, dữ liệu không hợp lệ hoặc provider không khả dụng.
- Hậu điều kiện: Account DRIVER ACTIVE, Driver PENDING_APPROVAL/OFFLINE và DriverApplication SUBMITTED; chưa được nhận chuyến.

## UC18 – Tra cứu tài xế gần vị trí

- Tác nhân: CUSTOMER hoặc OPERATOR.
- Tiền điều kiện: tài khoản/phiên hợp lệ và tọa độ hợp lệ.
- Luồng: nhập tọa độ, bán kính và giới hạn → lọc ứng viên đủ điều kiện → sắp xếp khoảng cách → xem các trang kết quả.
- Ngoại lệ: tọa độ sai, giới hạn không hợp lệ, cursor hết hạn hoặc không có ứng viên.
- Hậu điều kiện: chỉ trả dữ liệu tối thiểu của tài xế đủ điều kiện trong phạm vi; không tạo Booking hoặc giữ chỗ Driver.
- Kịch bản chấm dùng bán kính 1 km.

## UC19 – Danh sách Booking

- Tác nhân: CUSTOMER.
- Tiền điều kiện: tài khoản và phiên hợp lệ.
- Luồng: chọn trạng thái nếu cần → yêu cầu danh sách → hệ thống giới hạn theo Customer đăng nhập → phân trang → xem chi tiết Booking thuộc quyền.
- Ngoại lệ: cursor không hợp lệ hoặc yêu cầu xem dữ liệu của khách khác.
- Hậu điều kiện: thấy cả Booking đã có Trip và Booking không tìm được tài xế; không lộ dữ liệu Customer khác.

## UC20 – Tra cứu hồ sơ theo mã

- Tác nhân: CUSTOMER, DRIVER hoặc OPERATOR.
- Tiền điều kiện: có quyền đối với loại hồ sơ và đối tượng được yêu cầu.
- Luồng: gửi customerId hoặc driverId → kiểm tra danh tính/role/quan hệ → trả các trường được phép.
- Ngoại lệ: token không hợp lệ, sai role, không có quyền trên đối tượng hoặc ID không tồn tại.
- Hậu điều kiện: không thể đọc hồ sơ người khác chỉ bằng thay ID; thông tin tài xế công khai không chứa giấy phép hoặc dữ liệu liên hệ nhạy cảm.

## UC21 – Kiểm tra sức khỏe hệ thống

- Tác nhân: OPERATOR đối với danh sách chi tiết; hệ thống giám sát đối với kiểm tra tối thiểu.
- Luồng: gọi endpoint qua Gateway → kiểm tra thành phần trong thời gian giới hạn → trả trạng thái và thời điểm kiểm tra.
- Ngoại lệ: một dịch vụ hoặc phụ thuộc không phản hồi, Worker không tiến triển hoặc chưa kết nối dữ liệu.
- Hậu điều kiện: phản hồi thể hiện tình trạng thực; readiness không đạt trả 503; thông tin chi tiết được bảo vệ và không lộ secret.
---

## UC22 – Theo dõi và phục hồi tiến trình liên dịch vụ

- Tác nhân: người khởi tạo có quyền, OPERATOR được phép và Worker của dịch vụ sở hữu tiến trình.
- Tiền điều kiện: có operation được lưu; caller chứng minh quyền xem hoặc tiếp tục. Người đăng ký chưa có Session phải dùng bằng chứng truy cập được đặc tả riêng.
- Luồng: gửi/tra cứu lại thao tác → đối chiếu danh tính, key và nội dung → đọc bước đã commit → tiếp tục hoặc trả trạng thái hiện tại → xác nhận kết quả cuối khi đủ điều kiện.
- Worker: phát hiện công việc đến hạn → giành quyền xử lý theo version → tra cứu trạng thái chưa rõ → retry/bù có điều kiện → lưu kết quả và audit.
- Ngoại lệ: key trùng khác nội dung; caller khác; dependency không phản hồi; lệnh cũ; kết quả mâu thuẫn cần vận hành.
- Hậu điều kiện: không tạo tác động trùng, không lộ tiến trình của người khác, không trả thành công giả hoặc làm mất dữ liệu đã commit.
- API 202/operation URL và chính sách hết hạn là hợp đồng cần chốt, không được coi là đã có chỉ từ Use Case này.

---

# B13. Tiêu chí chấp nhận

## AC01 – Tài khoản và phiên

- Đăng ký hợp lệ tạo Account CUSTOMER và Customer; dữ liệu trùng bị từ chối.
- Cả ba vai trò dùng emailOrPhone; không yêu cầu username riêng.
- Không tự gán được role/accountStatus.
- Account INACTIVE/SUSPENDED không đăng nhập hoặc làm mới phiên được.
- Hồ sơ chỉ cho sửa trường được phép.
- Đăng xuất làm phiên hiện tại mất quyền; các phiên khác không bị thu hồi nhầm.
- Đổi mật khẩu thành công thu hồi mọi phiên.
- Refresh token cũ không dùng lại được sau khi đã thay thế.
- Phản hồi và log không chứa mật khẩu hoặc token bí mật ngoài dữ liệu cấp phiên cần thiết cho người đăng nhập.

- Dừng dịch vụ Customer sau khi Identity lưu tiến trình: không báo đăng ký hoàn tất hoặc cấp phiên sử dụng đầy đủ; khi khôi phục chỉ tạo một Account/Customer liên kết.
- Retry sau mất phản hồi tìm lại cùng kết quả/operation, không tạo hồ sơ khác.

## AC02 – Đặt xe

- Dữ liệu hợp lệ tạo một Booking và chuyển sang tìm tài xế.
- Từ chối thiếu điểm đón/đến, tọa độ sai hoặc dịch vụ không hỗ trợ.
- Không tạo yêu cầu mới khi khách đã có yêu cầu/chuyến hoạt động.
- Gửi lại cùng mã chống lặp và cùng nội dung trả cùng kết quả, không tạo thêm Booking.
- Cùng mã chống lặp nhưng khác nội dung bị từ chối.
- Booking giữ đúng phiên bản biểu giá tại thời điểm tạo.

- Hai key khác nhau của cùng Customer vẫn chỉ giữ được một ActivityGuard.
- Mất phản hồi sau commit Booking không giải phóng guard một cách mù quáng; tiến trình được tra cứu/khôi phục.

## AC03 – Điều phối

- Tài xế sai loại xe, không đủ điều kiện, OFFLINE/BUSY hoặc GPS cũ bị loại.
- Chọn ứng viên theo quy tắc khoảng cách và thứ tự phụ.
- Mỗi Booking chỉ có một lời mời PENDING.
- Hết hạn hoặc từ chối thì thử ứng viên khác trong giới hạn.
- Phản hồi sau hết hạn/hủy bị từ chối.
- Hai phản hồi đồng thời không tạo hai Trip cho một Booking.
- Một tài xế không được nhận hai Trip đang hoạt động.
- Khi kết thúc tìm thất bại, Booking NO_DRIVER_FOUND và không còn lời mời hợp lệ.

- Hai Booking tranh chấp cùng Driver/Vehicle chỉ có một reservation được xác nhận.
- Trip chuẩn bị chưa được hiển thị như chuyến hoạt động.
- Trip đã kích hoạt nhưng mất phản hồi: retry trả đúng Trip, không tạo mới hoặc trả Driver về AVAILABLE.
- Hủy phần chuẩn bị rồi nhận lệnh kích hoạt trễ: từ chối lệnh cũ.
- Mất phản hồi không tự kết luận tài xế từ chối hoặc chuyển sang ứng viên khác trước khi đối soát.

## AC04 – Theo dõi

- Khách của chuyến và OPERATOR xem được dữ liệu được phép.
- Người không liên quan không xem được vị trí chuyến.
- Dữ liệu gồm trạng thái, thông tin xe/tài xế, vị trí và thời điểm ghi nhận.
- GPS quá ngưỡng được đánh dấu cũ.
- Không có ETA thì thể hiện chưa xác định, không báo ETA bằng 0.
- Cập nhật đáp ứng mục tiêu NFR09 trong môi trường nghiệm thu.

- Mẫu GPS từ Driver sang Trip được chống trùng và kiểm tra đúng chuyến/thời gian; mẫu chuyến cũ không cập nhật chuyến mới.
- Trip đã đóng không trả vị trí live của tài xế đang thực hiện chuyến khác.

## AC05 – Thực hiện chuyến

- Chỉ tài xế được phân công thực hiện cập nhật thông thường.
- Bỏ qua trạng thái bắt buộc bị từ chối.
- Mỗi thay đổi có lịch sử và người thực hiện.
- Gửi lại cùng thao tác đã thành công không tạo lịch sử hoặc sự kiện lặp.
- COMPLETED có thời điểm kết thúc và kích hoạt xác nhận JourneyMetrics; chỉ metrics CONFIRMED mới cho phép phát hành Fare.
- Trip kết thúc không quay lại hoạt động.
- ERROR không tự bị xem là chuyến hoàn thành.

- Giải phóng sau đóng Trip được lưu bền vững và tiếp tục sau restart; lệnh giải phóng trễ không ảnh hưởng Trip mới.
- Tài nguyên chưa xác nhận giải phóng không được nhận công việc mới để che tình trạng phụ thuộc đang lỗi.

## AC06 – Tính cước và thanh toán

- Cước sử dụng đúng phiên bản biểu giá, quãng đường và thời gian đã xác nhận.
- Thay đổi biểu giá mới không làm đổi cước của Booking cũ.
- Chọn CASH chưa làm Payment thành công.
- Chỉ tài xế của chuyến được xác nhận thu tiền mặt.
- Kết quả điện tử sai nguồn, sai số tiền hoặc sai giao dịch không được chấp nhận.
- Callback lặp không làm tăng số tiền đã thu.
- Timeout tạo UNKNOWN; không mở lần thu mới khi chưa đối soát.
- Payment SUCCESS không bị hạ trạng thái bởi callback đến muộn.
- Khách không tạo thanh toán cho chuyến của người khác.
- Có bằng chứng luồng thanh toán online qua sandbox của nhà cung cấp, từ tạo yêu cầu đến callback/webhook đã xác minh.
- Callback/webhook đi qua Gateway.
- Gửi lại request với cùng Idempotency-Key và nội dung trả HTTP status/body đã lưu; không tạo PaymentAttempt hoặc lần thu tiền mới.
- Cùng Idempotency-Key nhưng nội dung khác bị từ chối.
- Một request dùng key mới vẫn phải tuân thủ ràng buộc không thu trùng và không mở lần thử khi kết quả trước còn UNKNOWN.
- Sau thanh toán, Trip vẫn COMPLETED và Payment liên kết là SUCCESS.

- Payment xác minh quyền và dữ liệu có thẩm quyền từ Identity/Trip qua hợp đồng, không đọc chéo database.
- Fare giữ snapshot giá và metricsVersion đã dùng; sự kiện metrics lặp không tạo Fare/Payment thứ hai.
- Phản hồi tiến trình đang chạy không được tính là kết quả thanh toán cuối cùng; replay không mở Attempt mới.
## AC07 – Đánh giá

- Chỉ khách của Trip COMPLETED được đánh giá.
- Điểm là số nguyên từ 1 đến 5.
- Nhận xét là tùy chọn.
- Mỗi chuyến chỉ có một đánh giá.
- Gửi lại cùng mã chống lặp và nội dung trả kết quả đã lưu, không tạo Rating thứ hai.
- Điểm đánh giá trung bình chưa phải điều kiện nghiệm thu bắt buộc; nếu bổ sung phải có yêu cầu và kiểm thử riêng.
- Trip COMPLETED nhưng Payment chưa SUCCESS vẫn được đánh giá.

## AC08 – Vận hành và sự cố

- OPERATOR xem được dữ liệu trong phạm vi vận hành.
- Mọi thay đổi quan trọng có nhật ký.
- IncidentRecord có trạng thái, người xử lý và kết quả.
- Khóa tài khoản đang có phiên làm phiên mất quyền.
- Khóa tài khoản tài xế đang có chuyến tạo cảnh báo, không tự làm mất lịch sử chuyến.
- Không sửa giao dịch thành công hoặc nhật ký bằng thao tác quản trị thông thường.

## AC09 – Tài xế và phương tiện

- Có Account DRIVER chưa đủ để nhận chuyến nếu hồ sơ/xe chưa hợp lệ.
- Không gán hoạt động cùng một xe cho hai tài xế.
- Không đổi xe giữa một Trip đang hoạt động.
- Chỉ tài xế đủ điều kiện và có vị trí mới được AVAILABLE.
- Tài xế BUSY không tự chuyển AVAILABLE.
- Vị trí gửi bù cũ không ghi đè vị trí mới.

## AC10 – Hủy

- Hủy Booking đang tìm làm dừng điều phối và thu hồi lời mời.
- Trip chỉ hủy thông thường trước PICKED_UP.
- NO_SHOW chỉ được dùng sau thời gian chờ quy định.
- Không vừa hủy Booking thành công vừa tạo Trip hợp lệ do tranh chấp.
- Tài xế được giải phóng hoặc đưa OFFLINE đúng điều kiện.
- Mọi hủy có lý do và người thực hiện.

- Accept/hủy cùng lúc có một quyết định điều phối; lỗi giữa các MS không tạo hai kết quả cuối mâu thuẫn.
- Hủy đã ghi nhận nhưng giải phóng chưa xong phải có công việc phục hồi và cảnh báo; không giải phóng Driver khi chưa xác minh Trip có đang hoạt động.

## AC11 – Lịch sử

- Khách/tài xế chỉ thấy chuyến thuộc phạm vi mình.
- Danh sách phân trang và lọc được.
- Chi tiết phân biệt trạng thái Trip với trạng thái Payment.
- Không mất lịch sử khi tài khoản, xe hoặc tài xế ngừng hoạt động.

## AC12 – Biểu giá

- Không chấp nhận đơn giá âm hoặc khoảng hiệu lực chồng lấn của cùng loại dịch vụ.
- Phiên bản mới áp dụng đúng thời điểm.
- Booking giữ đơn giá đã áp dụng.
- Cước dự kiến, nếu có, được phân biệt rõ với cước thực tế.

## AC13 – Thông báo

- Có thông báo cho các sự kiện: tiếp nhận Booking, lời mời tài xế, phân công, không tìm được xe, đến đón, hủy, hoàn thành và kết quả thanh toán.
- Người dùng chỉ đọc/đánh dấu thông báo của mình.
- Sự kiện lặp không tạo thông báo trùng.
- Lỗi gửi được ghi nhận để thử lại.
- Lỗi thông báo không làm Booking, Trip hoặc Payment thành công bị đảo ngược.
- Có thông báo duyệt hoặc từ chối hồ sơ tài xế, gắn đúng DriverApplication và người nhận.
- Message xét duyệt được giao lại không tạo thông báo thứ hai cho cùng sự kiện/người nhận/kênh.
- Notification Service lỗi không làm mất hoặc đảo ngược quyết định xét duyệt đã lưu.
## AC14 – Báo cáo

**Ngoài MVP; các tiêu chí dưới đây chỉ áp dụng khi chức năng báo cáo được duyệt triển khai.** Không coi chưa chạy AC14 là lỗi thiếu chức năng bắt buộc của baseline tám MS.

- Số tiền đã thu chỉ gồm Payment SUCCESS theo paidAt.
- Không tính Payment FAILED/UNKNOWN vào số tiền đã thu.
- Số chuyến hoàn thành/hủy khớp dữ liệu Trip trong phạm vi thời gian.
- Booking NO_DRIVER_FOUND được báo riêng.
- Báo cáo thể hiện thời gian, múi giờ và cách tính.
- Khoảng không có dữ liệu không gây chia cho 0 hoặc hiển thị tỷ lệ sai.
## AC15 – Đăng ký và xét duyệt tài xế

- OTP chỉ xác minh thành công khi đúng mã, đúng purpose, còn hạn và chưa vượt số lần thử.
- Gửi lại OTP tuân thủ giới hạn; mã cũ mất hiệu lực khi được thay thế.
- Không trả OTP trong API công khai hoặc ghi OTP vào log.
- Verification token dùng một lần, gắn với số điện thoại đã xác minh.
- Đăng ký hợp lệ tạo Account DRIVER, Driver PENDING_APPROVAL/OFFLINE và DriverApplication SUBMITTED nhất quán.
- Trùng email, phone hoặc giấy phép không tạo bộ đăng ký hoàn tất thứ hai. Bản ghi cấp phát tạm thời nếu có phải có tiến trình bù/thu hồi hoặc phục hồi; không đăng nhập như hồ sơ hợp lệ khi chưa hoàn tất.
- Phát lại yêu cầu đăng ký hợp lệ không tạo tài khoản hoặc hồ sơ thứ hai.
- Tài xế chờ duyệt đăng nhập và xem hồ sơ mình được, nhưng không bật AVAILABLE hoặc nhận chuyến.
- OPERATOR xem được danh sách và chi tiết hồ sơ.
- Duyệt/từ chối kiểm tra version; từ chối bắt buộc có lý do.
- Duyệt cập nhật hồ sơ, Driver và phân công xe hợp lệ nhất quán.
- Không duyệt bằng cách chiếm xe của tài xế khác hoặc xe đang phục vụ chuyến.
- Driver giữ OFFLINE sau duyệt.
- Tài xế nhận được kết quả xét duyệt.

- Dừng Identity/Driver giữa các bước đăng ký rồi khôi phục không tạo Account, hồ sơ hoặc tiêu thụ verification token lần hai.
- Duyệt hồ sơ, tạo/liên kết xe, VehicleAssignment và outbox vẫn có thể commit nguyên tử trong Driver Service; không tách nhỏ transaction này sang MS khác.

## AC16 – Tra cứu tài xế trong khu vực

- Có ít nhất năm Driver với trạng thái/điều kiện khác nhau trong dữ liệu kiểm thử.
- Có ít nhất hai Driver đủ điều kiện trong 1 km để kiểm tra phân trang.
- Truy vấn 1 km không trả Driver ngoài phạm vi.
- Driver OFFLINE/BUSY, chưa duyệt, Account không ACTIVE, xe không hợp lệ hoặc GPS cũ bị loại.
- Sắp xếp đúng khoảng cách và driverId.
- limit và cursor hoạt động đúng; các trang cùng kết quả tìm kiếm không lặp/bỏ sót do thay đổi vị trí.
- Cursor hết hạn được xử lý rõ ràng.
- Không lộ email, phone, giấy phép hoặc tọa độ chính xác trong kết quả công khai.
- Tra cứu không làm Driver BUSY hoặc tạo quyền giữ chỗ.

## AC17 – Danh sách Booking

- Có ít nhất năm Booking của Customer được dùng để kiểm tra.
- Danh sách có giới hạn, phân trang và lọc trạng thái.
- Có Booking NO_DRIVER_FOUND để chứng minh lịch sử Booking không phụ thuộc việc có Trip.
- Customer không đọc được Booking của người khác bằng thay tham số hoặc cursor.
- Thứ tự kết quả ổn định theo createdAt và bookingId.
- Trang cuối không tạo nextCursor giả.

## AC18 – Tra cứu hồ sơ theo mã

- Token hợp lệ và đúng quyền xem được Customer/Driver theo mã.
- CUSTOMER xem Customer của mình; DRIVER xem Driver của mình.
- OPERATOR truy cập theo quyền vận hành.
- CUSTOMER chỉ xem thông tin tài xế tối thiểu khi có quan hệ chuyến phù hợp.
- Sai role của chức năng trả 403.
- Không có quyền trên đối tượng bị từ chối theo quy ước API, không lộ dữ liệu cá nhân.
- Không trả passwordHash, token, OTP hoặc khóa trong hồ sơ.

## AC19 – Kiến trúc, triển khai và sức khỏe hệ thống

- Giải thích được cấu trúc source và trách nhiệm từng dịch vụ/module.
- Client sử dụng Gateway; cấu hình chạy bài không công bố cổng HTTP của backend.
- Route nội bộ không gọi được từ client qua Gateway.
- Có bằng chứng gRPC nội bộ và RabbitMQ truyền dữ liệu giữa các dịch vụ theo hợp đồng; không lấy việc gọi hàm trong cùng tiến trình làm bằng chứng IPC giữa hai MS.
- Message lặp không làm lặp tác động nghiệp vụ.
- Broker ngừng hoạt động không làm mất sự kiện đã ghi bền vững; khôi phục thì xử lý tiếp.
- Docker Compose khởi chạy được các thành phần theo hướng dẫn.
- Liệt kê được container và healthcheck tương ứng.
- /health, /ready và /health/services trả đúng trạng thái khi hệ thống bình thường và khi ngắt phụ thuộc.
- Chi tiết health chỉ dành cho OPERATOR; không lộ secret.
- Repository và image không chứa secret được commit/đóng gói ngoài ý muốn.

- Giải thích đúng tám MS nghiệp vụ; Gateway và hạ tầng không tính vào số này.
- Runtime role của mỗi MS bị từ chối đọc/ghi database MS khác.
- Danh sách health không còn chỉ có CAB Core; có đủ tám MS, Gateway và phụ thuộc theo cấu hình.
- Nếu thiếu hợp đồng gRPC hoặc schema producer mới thì chưa đánh dấu IPC tương ứng đã hoàn tất.

## AC20 – Bảo mật và chống lạm dụng

- Đọc database không thấy password plaintext.
- Email, phone và giấy phép được mã hóa; không có bản plaintext phụ để bỏ qua bảo vệ.
- Khóa nằm ngoài database chứa ciphertext và ngoài Git; có kiểm chứng đọc dữ liệu khi xoay khóa.
- Payload SQL injection không đăng nhập được hoặc làm lộ dữ liệu/lỗi database.
- Payload XSS không thực thi tại nơi hiển thị.
- JWT bị sửa sub/role hoặc chữ ký bị từ chối 401.
- Customer gọi chức năng riêng của Driver bằng token hợp lệ bị từ chối 403.
- Vượt rate limit nhận 429 và Retry-After.
- Có báo cáo kiểm thử tải theo kịch bản rubric, ghi rõ môi trường và kết quả; không chỉ đưa ảnh cấu hình rate limit.
- Replay thanh toán đáp ứng AC06, không phát sinh thu tiền trùng.
---

## AC21 – Tiến trình liên dịch vụ

- Chỉ công bố kết quả cuối thành công khi đủ hậu điều kiện của nghiệp vụ; timeout không được giả thành rollback toàn bộ.
- Restart tại từng bước không làm mất quyết định đã commit; retry không tạo hồ sơ, Booking, Trip hoặc thanh toán trùng.
- Operation, reservation và lệnh giải phóng gắn đúng ID/phiên bản; lệnh cũ không tác động công việc mới.
- Chỉ người có quyền xem kết quả/tiến trình; biết operationId hoặc Idempotency-Key không đủ để đọc dữ liệu của người khác.
- Đăng ký chưa có user token có bằng chứng tra cứu được đặc tả và kiểm thử riêng.
- Có kiểm thử mất phản hồi sau kích hoạt Trip và sau provider đã xử lý; không giải phóng/thu tiền lần nữa khi kết quả chưa rõ.
- Có quan sát tiến trình chờ, bù và cần vận hành; khi hết ngân sách retry không tự giả thành thành công.
- Kịch bản 202/operation endpoint chỉ được nghiệm thu sau khi hợp đồng API tương ứng đã được duyệt và triển khai.

---

# B14. Ma trận truy xuất yêu cầu

| RQM | BG | BR | BP | FR | UC | AC | Ưu tiên |
|---|---|---|---|---|---|---|---|
| RQM01 | BG08 | BR08 | BP07 | FR01 | UC01.1–UC01.6 | AC01 | Must Have |
| RQM02 | BG01 | BR01 | BP01 | FR02, FR03 | UC02 | AC02 | Must Have |
| RQM03 | BG02 | BR02 | BP02 | FR04, FR05, FR06, FR07 | UC03, UC05 | AC03 | Must Have |
| RQM04 | BG03 | BR03 | BP03, BP08 | FR09, FR18 | UC04, UC11 | AC04, AC09 | Must Have |
| RQM05 | BG04 | BR04 | BP03 | FR08 | UC06 | AC05 | Must Have |
| RQM06 | BG05 | BR05 | BP04 | FR10, FR11, FR12 | UC07 | AC06 | Must Have |
| RQM07 | BG09 | BR07 | BP06 | FR16 | UC08 | AC07 | Must Have |
| RQM08 | BG07, BG08 | BR06 | BP05 | FR14, FR15 | UC09 | AC08 | Must Have |
| RQM09 | BG02, BG07 | BR09 | BP08 | FR17, FR18 | UC10, UC11 | AC09, AC15 | Must Have |
| RQM10 | BG04 | BR04 | BP09 | FR19 | UC12 | AC10 | Must Have |
| RQM11 | BG01, BG04 | BR04 | BP12 | FR20 | UC13 | AC11 | Must Have |
| RQM12 | BG05, BG07 | BR11 | BP11 | FR21.1 | UC14 | AC12 | Must Have |
| RQM13 | BG01, BG05 | BR01, BR11 | BP01 | FR21.2 | UC14 | AC12 | Should Have |
| RQM14 | BG06 | BR10 | BP10 | FR13 | UC15 | AC13 | Must Have |
| RQM15 | BG07 | BR06 | BP13 | FR22 | UC16 | AC14 | Ngoài MVP, giữ để truy vết |
| RQM16 | BG07, BG08 | BR08, BR09 | BP14 | FR23 | UC17 | AC15 | Must Have |
| RQM17 | BG01, BG02 | BR01, BR02 | BP15 | FR24 | UC18 | AC16 | Must Have |
| RQM18 | BG01 | BR01 | BP12 | FR25 | UC19 | AC17 | Must Have |
| RQM19 | BG07, BG08 | BR06, BR08, BR09 | BP12 | FR26 | UC20 | AC18 | Must Have |
| RQM20 | BG07 | BR06 | BP05 | FR27 | UC21 | AC19 | Must Have |
| RQM21 | BG01, BG02, BG04, BG05, BG08 | BR01, BR02, BR04, BR05, BR08, BR09 | BP16 | FR28; áp dụng cho các FR liên dịch vụ | UC22 | AC21 | Must Have; hợp đồng chi tiết cần chốt trước triển khai |

Các NFR áp dụng xuyên suốt các dòng liên quan. Khi lập test case phải ghi rõ FR/AC hoặc NFR được kiểm chứng.
### Truy xuất các yêu cầu kỹ thuật và bảo mật

| Nhóm yêu cầu | NFR | Tiêu chí chấp nhận |
|---|---|---|
| Ranh giới dịch vụ và xử lý đồng thời | NFR02, NFR03, NFR18 | AC02, AC03, AC19, AC21 |
| Gateway, IPC và triển khai | NFR11, NFR12, NFR13, NFR14 | AC19 |
| Health và quan sát hệ thống | NFR06, NFR07 | AC19 |
| Xác thực, phân quyền và bảo vệ dữ liệu | NFR04, NFR05 | AC01, AC18, AC20 |
| SQL injection và XSS | NFR15, NFR16 | AC20 |
| Rate limit và tải vượt giới hạn | NFR17 | AC20 |
| Replay và kết quả thanh toán | NFR03, NFR04 | AC06, AC20 |
| Tiến trình liên dịch vụ và quyền tra cứu | NFR03, NFR04, NFR06, NFR18 | AC01, AC03, AC10, AC15, AC21 |

### Đối chiếu rubric chấm project

| Tiêu chí rubric | Nội dung | Yêu cầu liên quan |
|---|---|---|
| 1 | Tổ chức source code | NFR14, AC19 |
| 2 | .gitignore và .env | NFR05, NFR14, AC19 |
| 3 | Nhiệm vụ Gateway | NFR11, AC19 |
| 4 | IPC giữa các dịch vụ | NFR02, NFR12, AC19 |
| 5 | Compose và danh sách container | NFR13, AC19 |
| 6 | Health, ready và danh sách service | FR27, UC21, NFR07, AC19 |
| 7 | Kafka/RabbitMQ | NFR12, AC19; CAB chọn RabbitMQ |
| 8 | Request bên ngoài qua Gateway | NFR11, AC19 |
| 9 | Đăng ký khách hàng | FR01.1, UC01.1, AC01 |
| 10 | Đăng nhập và cấp token | FR01.2, UC01.2, AC01 |
| 11 | Tra cứu Customer theo mã | FR26, UC20, AC18 |
| 12 | Tra cứu Driver theo mã | FR26, UC20, AC18 |
| 13 | Tài xế trong 1 km, limit và paging | FR24, UC18, AC16 |
| 14 | Danh sách Booking của Customer | FR25, UC19, AC17 |
| 15 | Đặt xe và phát offer | FR02–FR07, FR28, UC02–UC03, UC22, AC02–AC03, AC21 |
| 16 | Tài xế nhận chuyến | FR05, FR28, UC05, UC22, AC03, AC21 |
| 17 | Trạng thái và vị trí chuyến | FR08, FR09, FR18, UC04, UC06, UC11, AC04–AC05 |
| 18 | Hủy chuyến có lý do và thông báo | FR19, FR28, UC12, UC22, AC10, AC13, AC21 |
| 19 | Thanh toán online và callback | FR11–FR12, UC07, AC06 |
| 20 | Đánh giá chuyến đi | FR16, UC08, AC07 |
| 21 | Tài xế đăng ký qua OTP | FR23, FR28, UC17, UC22, AC15, AC21 |
| 22 | Duyệt/từ chối hồ sơ | FR17, FR13, UC10, UC15, AC15, AC13 |
| 23 | Bật/tắt nhận chuyến | FR18, UC11, AC09 |
| 24 | Bảo vệ dữ liệu lưu trữ và quản lý khóa | NFR05, AC20 |
| 25 | SQL injection | NFR15, AC20 |
| 26 | XSS | NFR16, AC20 |
| 27 | JWT tampering | NFR04, AC20 |
| 28 | Truy cập API sai quyền | FR01.7, NFR04, AC20 |
| 29 | Rate limit | NFR17, AC20 |
| 30 | Replay/idempotency thanh toán | FR12, FR28, NFR03, NFR18, AC06, AC20, AC21 |

Bảng này xác định phạm vi cần kiểm chứng, không phải bảng điểm hoặc kết quả đã đạt.

Mỗi tiêu chí khi nghiệm thu phải có dữ liệu kiểm thử, thao tác, kết quả thực tế và bằng chứng phù hợp.

### Trạng thái bộ kiểm thử liên kết

Thông tin dưới đây là mốc của CAB_Test_Cases_ver_1.xlsx theo baseline 1.2, được giữ để truy vết; chưa phải xác nhận workbook đã chuyển đổi sang tám MS. Mốc cũ gồm:

- 16 sheet.
- 398 ca kiểm thử.
- 394 ca đang áp dụng.
- 4 ca được giữ để truy vết và đánh dấu OUT_OF_SCOPE hoặc SUPERSEDED.
- 11 ca NEEDS_DECISION trong các ca đang áp dụng.
- Sheet Rubric Mapping đối chiếu đủ 30 tiêu chí chấm project.

Tại mốc baseline 1.2 được ghi trong SRS cũ, toàn bộ ca có Execution Status=NOT_RUN. Lần sửa SRS này không chạy kiểm thử hoặc xác minh trạng thái thực thi hiện tại; giữ kết quả kiểm thử riêng và không tự chuyển ca sang PASS.

Các ca NEEDS_DECISION gồm:

- TC-PAYMENT-004, TC-PAYMENT-007, TC-PAYMENT-008, TC-PAYMENT-015, TC-PAYMENT-017, TC-PAYMENT-024, TC-PAYMENT-025, TC-PAYMENT-026 và TC-PAYMENT-037: cần nhà cung cấp thanh toán và hợp đồng tích hợp cụ thể.
- TC-DREG-030: cần lựa chọn nhà cung cấp/kênh OTP và môi trường thử nghiệm.
- TC-SEC-018: cần kiểm chứng chống thu tiền trùng xuyên suốt hệ thống CAB và nhà cung cấp thanh toán.

Expected Result và Required Evidence mô tả kết quả mong đợi và minh chứng cần thu thập, không phải kết quả đã đạt.

Sau khi hoàn tất quyết định thiết kế, cập nhật dữ liệu kiểm thử và chuyển Design Status sang DEFINED khi đủ đặc tả. Execution Status vẫn giữ NOT_RUN cho đến khi thực sự chạy.

Việc có ca kiểm thử liên kết không tự chứng minh tiêu chí rubric đã đạt. Kết luận nghiệm thu phải dựa trên kết quả thực tế và bằng chứng.

Danh sách NEEDS_DECISION trong workbook không thay thế danh sách quyết định thiết kế còn mở. Phương pháp xác nhận JourneyMetrics vẫn cần được đặc tả và bổ sung kiểm thử thuật toán trước khi triển khai tính cước.

Khi chuyển workbook sang tám MS:

- Giữ ID các ca còn đúng; chỉ chỉnh Preconditions, bước, endpoint/caller, Expected Result và Required Evidence bị ảnh hưởng.
- Không đổi số hoặc xóa ca hàng loạt. Ca thay thế/ngừng áp dụng được đánh dấu và liên kết lý do.
- Các ca báo cáo liên quan FR22/UC16/AC14 được rà soát để đánh dấu ngoài MVP; không tự giả định danh sách bốn ca cũ đã bao gồm thay đổi này.
- Bổ sung ca cấp phát hồ sơ gián đoạn, reservation tranh chấp, accept/cancel, Trip kích hoạt mất phản hồi, lệnh trễ sau bù, giải phóng cũ và quyền operation.
- Sửa minh chứng HTTP nội bộ/CAB Core sang gRPC và các dịch vụ sở hữu mới; kiểm tra nhiều producer, schema event, quyền database và health.
- Chỉ tính lại tổng ca đang áp dụng, NEEDS_DECISION và số sheet sau khi sửa và kiểm tra workbook thực tế; không tự đặt tổng mới trong SRS.

## Điều kiện hoàn tất bản thiết kế

Bản thiết kế được coi là hoàn tất khi đáp ứng các điều kiện sau:

- Các thông số đề xuất tại mục 4.5 và B10 đã được duyệt và có cách kiểm chứng.
- Không còn hai bộ trạng thái khác nhau cho cùng một đối tượng.
- Mỗi chức năng đang áp dụng có FR, Use Case và tiêu chí chấp nhận tương ứng.
- Mã BR trong ma trận truy xuất khớp phần định nghĩa B5.
- Yêu cầu đã ngừng áp dụng được đánh dấu rõ để truy vết; không được triển khai như yêu cầu còn hiệu lực.
- SRS, API Document, Micro_Service_Design và test case sử dụng thống nhất phạm vi, thuật ngữ và quy tắc nghiệp vụ.
- Các hạng mục ngoài MVP không được đưa vào triển khai như yêu cầu mặc định.
- Đánh giá chuyến thuộc phạm vi Must Have của bản nộp.
- Luồng OTP, đăng ký, xét duyệt và thông báo tài xế được mô tả nhất quán.
- Không còn chức năng OPERATOR tạo trực tiếp tài khoản tài xế trong phạm vi hiện tại.
- Việc xét duyệt chỉ thực hiện qua nghiệp vụ review; không có đường cập nhật approvalStatus để bỏ qua kiểm tra hồ sơ.
- Chức năng tra cứu tài xế trong 1 km được phân biệt với bán kính điều phối Booking.
- Danh sách Booking được phân biệt với lịch sử Trip.
- Gateway, giao tiếp giữa dịch vụ, RabbitMQ, Docker Compose và healthcheck có yêu cầu cùng tiêu chí kiểm chứng.
- Thuật ngữ thanh toán và chuyến đi được phân biệt: Payment SUCCESS không đồng nghĩa Trip vừa hoàn thành, và Trip COMPLETED không chứng minh đã thanh toán.
- Có ánh xạ đủ 30 tiêu chí rubric sang yêu cầu và minh chứng cần chuẩn bị.
- Nhà cung cấp OTP, thanh toán sandbox và hợp đồng tích hợp được chốt trước khi triển khai các phần phụ thuộc.
- Phương pháp xác nhận quãng đường, chất lượng dữ liệu GPS và xử lý JourneyMetrics cần rà soát được chốt trước khi triển khai tính cước.
- Các chính sách vận hành còn mở được cụ thể hóa trong Micro_Service_Design trước khi triển khai phần liên quan.

- Tám MS và chủ sở hữu dữ liệu trong B4.6/B9.3 thống nhất với Micro_Service_Design 1.3; không còn cam kết transaction xuyên database.
- Hợp đồng gRPC, xác thực dịch vụ, mapping lỗi và schema event nhiều producer được đặc tả.
- Tiến trình đăng ký, phân công, hủy/đóng và giải phóng có trạng thái, điểm quyết định, điều kiện bù và kiểm thử gián đoạn.
- Hợp đồng khi operation chưa hoàn tất, gồm đề xuất 202 và quyền tra cứu trước đăng nhập, được duyệt đồng bộ trước triển khai.
- Chính sách Account lock cạnh tranh với lệnh đang chạy được chốt; không tự coi sự kiện thu hồi là cập nhật nguyên tử toàn hệ thống.
- FR22/UC16/AC14/RQM15 được đánh dấu ngoài MVP, nhưng audit và giám sát kỹ thuật vẫn được nghiệm thu.
- Giữ nguyên mã và yêu cầu còn phù hợp; mọi thay đổi ý nghĩa hợp đồng phải có truy vết và test tương ứng.
- Kết quả kiểm thử được ghi nhận riêng; không suy ra từ việc đã viết tài liệu hoặc đã commit.

### Các quyết định còn mở

| Hạng mục | Nội dung cần hoàn tất | Phần phụ thuộc |
|---|---|---|
| OTP | Nhà cung cấp/kênh gửi, môi trường thử nghiệm, hợp đồng gửi, timeout, retry và giới hạn | Xác minh số điện thoại khi đăng ký tài xế |
| Thanh toán sandbox | Nhà cung cấp, phương thức hỗ trợ, tạo/tra cứu giao dịch, xác minh webhook, acknowledgement, idempotency và đối soát | Thanh toán online và chống thu tiền trùng |
| JourneyMetrics | Phương pháp xác nhận quãng đường, tiêu chí chất lượng GPS, xử lý mất mẫu/sự cố và quy trình rà soát | Phát hành Fare và tạo Payment |
| Vận hành | Hoàn thiện chính sách retry/backoff, lưu dữ liệu và bằng chứng chống trùng, xoay khóa, sao lưu và phục hồi | Công việc nền, bảo mật và khả năng phục hồi |
| Hợp đồng gRPC và xác thực nội bộ | .proto, caller/scope, user context, deadline và mapping lỗi; xác minh Account/Session | Gateway và tám MS |
| Saga và reservation | Trạng thái, điểm quyết định, generation, tra cứu kết quả chưa rõ, ma trận bù và can thiệp vận hành | Đăng ký, Booking, accept/cancel, đóng Trip |
| Operation công khai | Ngân sách chờ, đề xuất 202, schema kết quả/URL tra cứu, quyền trước/sau đăng nhập và thời hạn bằng chứng | FR28, UC22, AC21 và API bị ảnh hưởng |
| Thu hồi quyền khi có lệnh đang chạy | Điểm cấp quyền, xử lý lệnh in-flight và kiểm thử cạnh tranh với khóa Account | Identity, Driver, Booking, Trip và Payment |
| Sự kiện nhiều producer | Schema/version, allowlist nguồn theo eventType, quyền broker và loại bỏ phụ thuộc source=CAB_CORE | Outbox/inbox, Notification và API 06 |
| Đồng bộ tài liệu và demo | Ma trận UC/test sau tách MS, số thành phần health, phạm vi báo cáo và giao diện kiểm chứng XSS | API 01–08, workbook và kịch bản chấm |

Chi tiết các quyết định này được quản lý tại mục 15 của Micro_Service_Design phiên bản 1.3. Khi có quyết định được duyệt, phải cập nhật các tài liệu và test case bị ảnh hưởng.

Các ca NEEDS_DECISION chỉ được chuyển sang DEFINED khi đã đủ đặc tả; không chuyển sang PASS chỉ vì quyết định đã được chốt.

Hoàn tất đồng bộ tài liệu chưa đồng nghĩa đã hoàn tất mọi quyết định thiết kế. Hoàn tất thiết kế cũng không đồng nghĩa hệ thống đã được triển khai hoặc đạt các tiêu chí nghiệm thu.
