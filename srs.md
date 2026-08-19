B1: xác định ngữ cảnh nghiệp vụ & vấn đề nghiệp vụ.
  1. Vấn đề nghiệp vụ
  Công ty ABC đang gặp khó khăn trong vận hành dịch vụ đặt xe do việc phân công tài xế còn thủ công, khách hàng khó theo dõi chuyến đi, thông tin thanh toán chưa được quản lý tập trung và hệ thống hiện tại khó mở rộng.
  
  Các vấn đề chính:
  - Phân công tài xế thủ công → khó đáp ứng nhanh khi số lượng yêu cầu tăng.
  - Khó theo dõi chuyến đi → khách hàng không nắm rõ trạng thái chuyến và thời gian tài xế đến.
  - Thanh toán chưa tập trung → khó quản lý thông tin và giao dịch.
  - Khó mở rộng hệ thống → khó phục vụ số lượng lớn khách hàng, tài xế và phát triển thêm tính năng.
    
    2. Ngữ cảnh nghiệp vụ
  CAB System là nền tảng đặt xe trực tuyến hỗ trợ toàn bộ quy trình từ khi khách hàng tạo yêu cầu đặt xe, tìm và phân công tài xế, thực hiện chuyến, tính cước, thanh toán, thông báo đến đánh giá sau chuyến; đồng thời hỗ trợ nhân viên vận hành quản lý hoạt động của hệ thống. Customer-Requirement.docxDOCX
  
  Các bên chính
  - Khách hàng: tạo yêu cầu, theo dõi và sử dụng chuyến xe.
  - Tài xế: nhận và thực hiện chuyến.
  - Nhân viên vận hành: quản lý và giám sát hoạt động.
  - Ban lãnh đạo: theo dõi hiệu quả và định hướng hệ thống.
  - Nhà cung cấp thanh toán: hỗ trợ thanh toán điện tử bên ngoài.
  Quy trình nghiệp vụ cốt lõi của MVP
  Đặt xe → Tìm tài xế → Phân công → Thực hiện chuyến → Hoàn thành → Tính cước → Thanh toán → Đánh giá
B2: lập bảng gồm stackholeder & vai trò. vẽ matrix stackholeder

  | Stakeholder | Vai trò |
|---|---|
| Khách hàng | Sử dụng hệ thống để đăng ký/đăng nhập, nhập điểm đón – điểm đến, chọn loại xe, gửi yêu cầu đặt xe, theo dõi chuyến, xem lịch sử, thanh toán và đánh giá tài xế. |
| Tài xế | Nhận và thực hiện chuyến xe; cập nhật hồ sơ, phương tiện, trạng thái hoạt động và trạng thái chuyến; cung cấp thông tin vị trí để hệ thống tìm tài xế phù hợp. |
| Nhân viên vận hành | Quản lý khách hàng, tài xế, phương tiện và chuyến đi; theo dõi chuyến đang diễn ra, kiểm tra trạng thái tài xế, hỗ trợ xử lý sự cố và tra cứu lịch sử giao dịch. |
| Ban lãnh đạo | Định hướng và đưa ra yêu cầu đối với hệ thống; quan tâm đến khả năng mở rộng, hiệu quả hoạt động và các báo cáo về số chuyến, doanh thu, tỷ lệ hoàn thành, tỷ lệ hủy và hiệu quả tài xế. |
| Nhà cung cấp dịch vụ thanh toán | Cung cấp dịch vụ thanh toán điện tử bên ngoài để CAB tích hợp và xử lý giao dịch mà không lưu trực tiếp thông tin thanh toán nhạy cảm. |
  
                    matrix stackholeder
                MỨC ĐỘ ẢNH HƯỞNG LÊN HỆ THỐNG
                         ↑
                         │
       RẤT CAO          │       ● BAN LÃNH ĐẠO
                         │
                         │
       CAO              │       ● NHÂN VIÊN VẬN HÀNH
                         │       ● KHÁCH HÀNG
                         │
       TRUNG BÌNH       │       ● TÀI XẾ
                         │
       THẤP             │       ● NHÀ CUNG CẤP THANH TOÁN
                         │
                         └──────────────────────────────→
B3: xác định các Business Goal
  BG01 – Số hóa đặt xe
  → Khách hàng có thể tự đặt xe.
  BG02 – Tự động tìm & phân công tài xế
  → Giảm việc phân công thủ công.
  BG03 – Theo dõi chuyến xe
  → Khách hàng và vận hành biết chuyến đang ở trạng thái nào.
  BG04 – Quản lý thực hiện chuyến
  → Tài xế cập nhật quá trình chuyến.
  BG05 – Tính cước & thanh toán
  → Hoàn tất nghiệp vụ giao dịch.
  BG06 – Thông báo các sự kiện quan trọng
  → Đảm bảo khách hàng/tài xế nhận được thông tin cần thiết.
  BG07 – Quản lý vận hành
  → Nhân viên có thể giám sát và xử lý các hoạt động chính.
  BG08 – Bảo mật & kiểm soát truy cập
  → Bảo vệ dữ liệu và thao tác quản trị.
B4: xác định scope
  Xây dựng nền tảng đặt xe hỗ trợ quy trình cốt lõi từ đặt xe → tìm và phân công tài xế → thực hiện chuyến → theo dõi → tính cước → thanh toán → thông báo → đánh giá, đồng thời cung cấp chức năng quản trị cơ bản cho nhân viên vận hành, bảo mật và phân quyền người dùng.
B5: xác định BR
  ### BR01 – Hỗ trợ khách hàng đặt xe trực tuyến
  
  Hệ thống cần xác định **điểm đón và điểm đến** của khách hàng để tạo yêu cầu đặt xe. Khách hàng cần đăng nhập tài khoản, lựa chọn loại xe/dịch vụ và gửi yêu cầu đặt xe đến hệ thống.
  
  ### BR02 – Tự động tìm và phân công tài xế
  
  Hệ thống cần dựa trên **vị trí của khách hàng, vị trí tài xế, trạng thái sẵn sàng và loại xe/dịch vụ được yêu cầu** để tìm tài xế phù hợp. Hệ thống cũng cần xử lý trường hợp tài xế chấp nhận, từ chối hoặc không phản hồi yêu cầu bằng cách tiếp tục tìm tài xế khác khi cần thiết.
  
  ### BR03 – Theo dõi trạng thái chuyến xe
  
  Hệ thống cần cung cấp thông tin về **trạng thái hiện tại của chuyến, tài xế đã nhận chuyến, vị trí tài xế và thời gian dự kiến tài xế đến** để khách hàng và nhân viên vận hành có thể theo dõi quá trình thực hiện chuyến xe.
  
  ### BR04 – Quản lý và thực hiện chuyến xe
  
  Hệ thống cần quản lý quá trình thực hiện chuyến từ khi tài xế nhận chuyến đến khi hoàn thành. Tài xế cần cập nhật các trạng thái **đã đến điểm đón, đã đón khách, đang di chuyển và hoàn thành chuyến**. Thông tin chuyến đi cần được lưu lại để phục vụ quản lý và tra cứu.
  
  ### BR05 – Tính cước và thanh toán
  
  Hệ thống cần xác định **số tiền khách hàng phải trả dựa trên loại dịch vụ và thông tin chuyến đi**. Hệ thống cần hỗ trợ thanh toán bằng tiền mặt hoặc thanh toán điện tử thông qua nhà cung cấp bên ngoài, đồng thời ghi nhận kết quả giao dịch thành công hoặc thất bại mà không lưu trực tiếp thông tin thanh toán nhạy cảm.
  
  ### BR06 – Quản lý và giám sát vận hành
  
  Hệ thống cần cung cấp cho nhân viên vận hành khả năng quản lý **khách hàng, tài xế, phương tiện và chuyến đi**, đồng thời theo dõi trạng thái tài xế, các chuyến đang diễn ra và hỗ trợ xử lý các trường hợp chuyến bị lỗi. Quyền truy cập của nhân viên cần được kiểm soát phù hợp với vai trò.
B6:xác định BP
  ### BP01 – Đặt xe
  
  Khách hàng đăng nhập, nhập **điểm đón và điểm đến**, lựa chọn loại xe/dịch vụ và gửi yêu cầu đặt xe. Hệ thống tiếp nhận và ghi nhận yêu cầu đặt xe.
  
  ### BP02 – Tìm và phân công tài xế
  
  Sau khi nhận yêu cầu, hệ thống xác định các tài xế phù hợp dựa trên **vị trí, trạng thái sẵn sàng và loại xe/dịch vụ**. Hệ thống gửi yêu cầu đến tài xế. Nếu tài xế từ chối hoặc không phản hồi, hệ thống tiếp tục tìm tài xế khác. Nếu không tìm được tài xế, hệ thống thông báo cho khách hàng.
  
  ### BP03 – Thực hiện chuyến xe
  
  Sau khi tài xế nhận chuyến, tài xế thực hiện chuyến và cập nhật trạng thái theo quá trình **đã đến điểm đón → đã đón khách → đang di chuyển → hoàn thành chuyến**. Hệ thống cập nhật trạng thái để khách hàng và nhân viên vận hành theo dõi.
  
  ### BP04 – Tính cước và thanh toán
  
  Sau khi chuyến hoàn thành, hệ thống xác định **số tiền khách hàng phải trả** dựa trên loại dịch vụ và thông tin chuyến đi. Khách hàng thanh toán bằng tiền mặt hoặc thanh toán điện tử thông qua nhà cung cấp bên ngoài. Hệ thống ghi nhận kết quả thanh toán.
  
  ### BP05 – Quản lý và giám sát chuyến xe
  
  Nhân viên vận hành theo dõi các chuyến đang diễn ra, trạng thái tài xế, thông tin khách hàng, phương tiện và hỗ trợ xử lý các trường hợp chuyến bị lỗi.
  
  ### BP06 – Đánh giá sau chuyến
  
  Sau khi chuyến hoàn thành, khách hàng có thể xem thông tin chuyến và thực hiện đánh giá tài xế.
  
B7: xác định FR
## Functional Requirements (FR)

### FR01 – Quản lý tài khoản khách hàng

Hệ thống phải cho phép khách hàng đăng ký tài khoản, đăng nhập và cập nhật thông tin cá nhân.

### FR02 – Tạo yêu cầu đặt xe

Hệ thống phải cho phép khách hàng nhập điểm đón, điểm đến, lựa chọn loại xe/dịch vụ và gửi yêu cầu đặt xe.

### FR03 – Tiếp nhận yêu cầu đặt xe

Hệ thống phải tiếp nhận và ghi nhận yêu cầu đặt xe của khách hàng, đồng thời cập nhật trạng thái yêu cầu để khách hàng có thể theo dõi.

### FR04 – Tìm tài xế phù hợp

Hệ thống phải xác định các tài xế phù hợp dựa trên vị trí, trạng thái sẵn sàng và loại xe/dịch vụ mà khách hàng yêu cầu.

### FR05 – Gửi yêu cầu chuyến đến tài xế

Hệ thống phải gửi thông tin yêu cầu chuyến đến tài xế phù hợp và cho phép tài xế chấp nhận hoặc từ chối chuyến.

### FR06 – Tìm tài xế thay thế

Khi tài xế được đề xuất từ chối hoặc không phản hồi, hệ thống phải tiếp tục tìm tài xế phù hợp khác mà không yêu cầu khách hàng tạo lại yêu cầu.

### FR07 – Thông báo kết quả tìm tài xế

Hệ thống phải thông báo cho khách hàng khi tài xế nhận chuyến hoặc khi hệ thống không tìm được tài xế phù hợp.

### FR08 – Cập nhật trạng thái chuyến

Hệ thống phải cho phép tài xế cập nhật trạng thái chuyến theo các trạng thái: đã đến điểm đón, đã đón khách, đang di chuyển và hoàn thành chuyến.

### FR09 – Theo dõi chuyến xe

Hệ thống phải cho phép khách hàng và nhân viên vận hành theo dõi trạng thái hiện tại của chuyến xe, thông tin tài xế và thời gian dự kiến tài xế đến.

### FR10 – Tính cước chuyến xe

Hệ thống phải xác định số tiền khách hàng phải trả dựa trên loại dịch vụ và thông tin chuyến đi sau khi chuyến hoàn thành.

### FR11 – Thanh toán chuyến xe

Hệ thống phải hỗ trợ khách hàng thanh toán bằng tiền mặt hoặc phương thức thanh toán điện tử thông qua nhà cung cấp thanh toán bên ngoài.

### FR12 – Xử lý kết quả thanh toán

Hệ thống phải ghi nhận kết quả thanh toán. Khi thanh toán điện tử thất bại, hệ thống phải thông báo cho khách hàng và cho phép xử lý lại theo chính sách của doanh nghiệp.

### FR13 – Gửi thông báo

Hệ thống phải gửi thông báo cho khách hàng và tài xế khi xảy ra các sự kiện quan trọng như tiếp nhận yêu cầu, tài xế nhận chuyến, tài xế đến điểm đón, chuyến hoàn thành và thanh toán có kết quả.

### FR14 – Quản lý dữ liệu vận hành

Hệ thống phải cho phép nhân viên vận hành quản lý thông tin khách hàng, tài xế, phương tiện và chuyến đi.

### FR15 – Giám sát và xử lý chuyến

Hệ thống phải cho phép nhân viên vận hành xem các chuyến đang diễn ra, kiểm tra trạng thái tài xế và hỗ trợ xử lý các trường hợp chuyến bị lỗi.

### FR16 – Đánh giá tài xế

Hệ thống phải cho phép khách hàng đánh giá tài xế sau khi chuyến xe hoàn thành.

B8: XÁC ĐỊNH NGUYÊN TẮC & NGOẠI LỆ 
  ## Business Rules

### BRu01 – Chỉ tài xế phù hợp mới được đề xuất chuyến

Hệ thống chỉ đề xuất chuyến cho tài xế đáp ứng các tiêu chí phù hợp do doanh nghiệp xác định, bao gồm vị trí, trạng thái sẵn sàng và các tiêu chí vận hành khác.

### BRu02 – Tài xế phải ở trạng thái sẵn sàng để nhận chuyến

Tài xế chỉ được xem xét phân công khi đang ở trạng thái sẵn sàng nhận chuyến.

### BRu03 – Hệ thống phải tiếp tục tìm tài xế khi tài xế từ chối hoặc không phản hồi

Nếu tài xế được đề xuất không nhận chuyến hoặc không phản hồi trong thời gian quy định, hệ thống phải tiếp tục tìm tài xế phù hợp khác mà không yêu cầu khách hàng tạo lại yêu cầu.

### BRu04 – Chuyến xe phải có tài xế được phân công trước khi thực hiện

Chuyến xe chỉ được chuyển sang quá trình thực hiện sau khi có tài xế chấp nhận chuyến.

### BRu05 – Trạng thái chuyến phải được cập nhật theo quá trình thực hiện

Tài xế phải cập nhật trạng thái chuyến theo trình tự nghiệp vụ gồm: đã đến điểm đón, đã đón khách, đang di chuyển và hoàn thành chuyến.

### BRu06 – Cước được xác định sau khi chuyến hoàn thành

Hệ thống xác định số tiền khách hàng phải trả dựa trên loại dịch vụ và thông tin chuyến đi sau khi chuyến hoàn thành.

### BRu07 – Hệ thống không lưu trực tiếp thông tin thanh toán nhạy cảm

Thông tin nhạy cảm của thẻ hoặc tài khoản thanh toán không được lưu trực tiếp trong hệ thống CAB khi thực hiện thanh toán điện tử.

### BRu08 – Thanh toán điện tử phải thông qua nhà cung cấp bên ngoài

Các giao dịch thanh toán điện tử phải được xử lý thông qua nhà cung cấp dịch vụ thanh toán bên ngoài.

### BRu09 – Chức năng quản trị phải được kiểm soát quyền truy cập

Các thao tác quản trị phải được phân quyền để nhân viên không có quyền không thể thực hiện các thao tác nhạy cảm.

### BRu10 – Các thao tác quan trọng phải được lưu vết

Hệ thống phải lưu lại các thao tác quan trọng để phục vụ kiểm tra và xử lý khi có sự cố.
B9: XÁC ĐỊNH MÔ HÌNH THỰC THỂ
  ## Mô hình hóa dữ liệu – Xác định Entity
  
  ### 1. Customer – Khách hàng
  
  Đại diện cho người sử dụng dịch vụ đặt xe của hệ thống CAB.
  
  **Thuộc tính chính:**
  - CustomerID – Mã khách hàng
  - FullName – Họ và tên
  - Phone – Số điện thoại
  - Email – Email
  - AccountStatus – Trạng thái tài khoản
  
  **Nghiệp vụ liên quan:**
  Khách hàng đăng ký/đăng nhập, tạo yêu cầu đặt xe, theo dõi chuyến, thanh toán và đánh giá tài xế.
  
  ---
  
  ### 2. Driver – Tài xế
  
  Đại diện cho tài xế tham gia cung cấp dịch vụ vận chuyển trên hệ thống.
  
  **Thuộc tính chính:**
  - DriverID – Mã tài xế
  - FullName – Họ và tên
  - Phone – Số điện thoại
  - Status – Trạng thái hoạt động
  - CurrentLocation – Vị trí hiện tại
  
  **Nghiệp vụ liên quan:**
  Tài xế nhận/từ chối chuyến, cập nhật trạng thái chuyến và cung cấp vị trí để hệ thống tìm tài xế phù hợp.
  
  ---
  
  ### 3. Vehicle – Phương tiện
  
  Đại diện cho phương tiện được tài xế sử dụng để thực hiện chuyến xe.
  
  **Thuộc tính chính:**
  - VehicleID – Mã phương tiện
  - LicensePlate – Biển số xe
  - VehicleType – Loại xe
  - Status – Trạng thái phương tiện
  - DriverID – Tài xế sử dụng phương tiện
  
  **Nghiệp vụ liên quan:**
  Phương tiện được sử dụng để đáp ứng loại xe/dịch vụ mà khách hàng yêu cầu.
  
  ---
  
  ### 4. Booking Request – Yêu cầu đặt xe
  
  Đại diện cho yêu cầu đặt xe được khách hàng tạo trên hệ thống trước khi chuyến xe được thực hiện.
  
  **Thuộc tính chính:**
  - BookingRequestID – Mã yêu cầu
  - CustomerID – Mã khách hàng
  - PickupLocation – Điểm đón
  - Destination – Điểm đến
  - VehicleType – Loại xe/dịch vụ
  - CreatedAt – Thời gian tạo yêu cầu
  - Status – Trạng thái yêu cầu
  
  **Nghiệp vụ liên quan:**
  Khách hàng tạo yêu cầu đặt xe. Hệ thống sử dụng thông tin yêu cầu để tìm và phân công tài xế phù hợp.
  
  ---
  
  ### 5. Trip – Chuyến xe
  
  Đại diện cho chuyến xe thực tế được thực hiện sau khi yêu cầu đặt xe được tài xế chấp nhận.
  
  **Thuộc tính chính:**
  - TripID – Mã chuyến
  - BookingRequestID – Mã yêu cầu đặt xe
  - CustomerID – Mã khách hàng
  - DriverID – Mã tài xế
  - PickupLocation – Điểm đón
  - Destination – Điểm đến
  - StartTime – Thời gian bắt đầu
  - EndTime – Thời gian kết thúc
  - Status – Trạng thái chuyến
  - Fare – Cước chuyến
  
  **Nghiệp vụ liên quan:**
  Quản lý toàn bộ quá trình từ khi tài xế nhận chuyến, đến điểm đón, đón khách, di chuyển và hoàn thành chuyến.
  
  ---
  
  ### 6. Payment – Thanh toán
  
  Đại diện cho giao dịch thanh toán của một chuyến xe.
  
  **Thuộc tính chính:**
  - PaymentID – Mã thanh toán
  - TripID – Mã chuyến
  - Amount – Số tiền thanh toán
  - PaymentMethod – Phương thức thanh toán
  - PaymentStatus – Trạng thái thanh toán
  - TransactionID – Mã giao dịch của nhà cung cấp thanh toán
  
  **Nghiệp vụ liên quan:**
  Ghi nhận và quản lý kết quả thanh toán bằng tiền mặt hoặc thanh toán điện tử thông qua nhà cung cấp bên ngoài.
  
  **Lưu ý:**
  Hệ thống CAB **không lưu trực tiếp thông tin nhạy cảm của thẻ hoặc tài khoản thanh toán**.
  
  ---
  
  ### 7. Rating – Đánh giá
  
  Đại diện cho đánh giá của khách hàng đối với tài xế sau khi chuyến xe hoàn thành.

**Thuộc tính chính:**
- RatingID – Mã đánh giá
- TripID – Mã chuyến
- CustomerID – Mã khách hàng
- DriverID – Mã tài xế
- RatingScore – Điểm đánh giá
- Comment – Nội dung đánh giá
- CreatedAt – Thời gian đánh giá

B10: XÁC ĐINH YÊU CẦU PHI CHỨC NĂNG
# Yêu cầu phi chức năng (Non-Functional Requirements)

## NFR01 – Hiệu năng

Hệ thống phải đáp ứng thời gian phản hồi phù hợp đối với các thao tác chính như đăng nhập, tạo yêu cầu đặt xe, tìm tài xế, cập nhật trạng thái chuyến và truy vấn thông tin chuyến.

Hệ thống phải đảm bảo hoạt động ổn định khi số lượng yêu cầu đặt xe tăng cao.

## NFR02 – Khả năng mở rộng

Hệ thống phải có khả năng mở rộng khi số lượng khách hàng, tài xế và yêu cầu đặt xe tăng lên.

Các thành phần của hệ thống cần có khả năng mở rộng độc lập khi tải tăng, hạn chế việc phải thay đổi toàn bộ hệ thống.

## NFR03 – Tính sẵn sàng và ổn định

Hệ thống phải hoạt động ổn định trong thời gian cung cấp dịch vụ và hạn chế ảnh hưởng của lỗi tại một thành phần đến toàn bộ hệ thống.

Hệ thống phải có cơ chế xử lý và ghi nhận lỗi để nhân viên vận hành có thể phát hiện và hỗ trợ xử lý sự cố.

## NFR04 – Bảo mật

Hệ thống phải xác thực người dùng và kiểm soát quyền truy cập dựa trên vai trò.

Các thao tác quản trị và thao tác nhạy cảm phải được kiểm soát để ngăn chặn truy cập trái phép.

## NFR05 – Bảo vệ dữ liệu

Hệ thống phải bảo vệ dữ liệu cá nhân, dữ liệu vị trí và dữ liệu giao dịch của người dùng.

Thông tin nhạy cảm liên quan đến thẻ hoặc tài khoản thanh toán không được lưu trực tiếp trong hệ thống CAB khi sử dụng dịch vụ thanh toán bên ngoài.

## NFR06 – Ghi log và truy vết

Hệ thống phải ghi nhận các thao tác quan trọng và các lỗi xảy ra trong quá trình vận hành để phục vụ việc kiểm tra, giám sát và xử lý sự cố.

## NFR07 – Khả năng quan sát hệ thống

Hệ thống phải cung cấp khả năng theo dõi các chỉ số và trạng thái hoạt động quan trọng, bao gồm tình trạng dịch vụ, lỗi và các vấn đề ảnh hưởng đến quá trình vận hành.

## NFR08 – Khả năng bảo trì và mở rộng

Hệ thống phải được thiết kế theo hướng cho phép bổ sung dịch vụ, phương thức thanh toán hoặc nhà cung cấp thông báo trong tương lai mà không phải xây dựng lại toàn bộ hệ thống.
B11: VẼ UC
## Use Case Diagram – CAB System MVP

B12: VIẾT ĐẶC TẢ UC
# Đặc tả Use Case – CAB System MVP

## UC01 – Đăng ký / Đăng nhập

**Actor:** Khách hàng

**Mục tiêu:**  
Cho phép khách hàng tạo tài khoản và đăng nhập để sử dụng các chức năng của hệ thống.

**Tiền điều kiện:**
- Khách hàng chưa đăng nhập đối với chức năng đăng ký.
- Khách hàng đã có tài khoản đối với chức năng đăng nhập.

**Luồng chính:**
1. Khách hàng chọn đăng ký hoặc đăng nhập.
2. Khách hàng cung cấp thông tin cần thiết.
3. Hệ thống kiểm tra thông tin.
4. Nếu thông tin hợp lệ, hệ thống tạo tài khoản hoặc xác thực tài khoản.
5. Hệ thống cho phép khách hàng truy cập các chức năng phù hợp.

**Ngoại lệ:**
- Thông tin đăng ký không hợp lệ → Hệ thống thông báo lỗi.
- Thông tin đăng nhập không chính xác → Hệ thống từ chối đăng nhập và thông báo cho khách hàng.

**Hậu điều kiện:**
- Tài khoản được tạo thành công hoặc khách hàng đăng nhập thành công.


## UC02 – Đặt xe

**Actor:** Khách hàng

**Mục tiêu:**  
Cho phép khách hàng tạo yêu cầu đặt xe.

**Tiền điều kiện:**
- Khách hàng đã đăng nhập.

**Luồng chính:**
1. Khách hàng chọn chức năng đặt xe.
2. Khách hàng nhập điểm đón.
3. Khách hàng nhập điểm đến.
4. Khách hàng chọn loại xe/dịch vụ.
5. Khách hàng gửi yêu cầu đặt xe.
6. Hệ thống kiểm tra thông tin yêu cầu.
7. Hệ thống ghi nhận yêu cầu đặt xe.
8. Hệ thống chuyển yêu cầu sang quá trình tìm và phân công tài xế.

**Ngoại lệ:**
- Thiếu hoặc không hợp lệ thông tin điểm đón/điểm đến → Hệ thống yêu cầu khách hàng bổ sung hoặc chỉnh sửa.
- Không tìm được tài xế → Hệ thống thông báo cho khách hàng.

**Hậu điều kiện:**
- Yêu cầu đặt xe được ghi nhận và chuyển sang quá trình tìm tài xế.


## UC03 – Tìm và phân công tài xế

**Actor:** Hệ thống / Tài xế

**Mục tiêu:**  
Tìm và phân công tài xế phù hợp cho yêu cầu đặt xe.

**Tiền điều kiện:**
- Có yêu cầu đặt xe hợp lệ.

**Luồng chính:**
1. Hệ thống tiếp nhận yêu cầu đặt xe.
2. Hệ thống xác định các tài xế phù hợp.
3. Hệ thống gửi yêu cầu chuyến đến tài xế phù hợp.
4. Tài xế xem thông tin chuyến.
5. Tài xế chấp nhận chuyến.
6. Hệ thống ghi nhận tài xế được phân công.
7. Hệ thống thông báo cho khách hàng về tài xế đã nhận chuyến.

**Ngoại lệ:**
- Tài xế từ chối → Hệ thống tiếp tục tìm tài xế khác.
- Tài xế không phản hồi → Hệ thống tiếp tục tìm tài xế khác.
- Không còn tài xế phù hợp → Hệ thống thông báo cho khách hàng.

**Hậu điều kiện:**
- Một tài xế được phân công cho chuyến hoặc yêu cầu được thông báo không thể đáp ứng.


## UC04 – Theo dõi chuyến xe

**Actor:** Khách hàng / Nhân viên vận hành

**Mục tiêu:**  
Cho phép theo dõi trạng thái và thông tin của chuyến xe.

**Tiền điều kiện:**
- Yêu cầu đặt xe đã được ghi nhận.
- Đối với chuyến đang thực hiện, tài xế đã được phân công.

**Luồng chính:**
1. Actor chọn chuyến cần theo dõi.
2. Hệ thống hiển thị trạng thái hiện tại của chuyến.
3. Hệ thống hiển thị thông tin tài xế.
4. Hệ thống cập nhật trạng thái chuyến khi tài xế thay đổi trạng thái.
5. Actor theo dõi thông tin chuyến.

**Ngoại lệ:**
- Không thể cập nhật thông tin chuyến → Hệ thống ghi nhận lỗi và thông báo trạng thái hiện tại nếu có.

**Hậu điều kiện:**
- Actor nhận được thông tin trạng thái mới nhất mà hệ thống có.


## UC05 – Nhận / Từ chối chuyến

**Actor:** Tài xế

**Mục tiêu:**  
Cho phép tài xế phản hồi yêu cầu chuyến được hệ thống gửi đến.

**Tiền điều kiện:**
- Tài xế đang ở trạng thái sẵn sàng.
- Hệ thống đã gửi yêu cầu chuyến đến tài xế.

**Luồng chính:**
1. Tài xế nhận thông báo yêu cầu chuyến.
2. Tài xế xem thông tin chuyến.
3. Tài xế chọn nhận chuyến.
4. Hệ thống ghi nhận tài xế nhận chuyến.
5. Hệ thống cập nhật trạng thái chuyến.
6. Hệ thống thông báo cho khách hàng.

**Ngoại lệ:**
- Tài xế từ chối → Hệ thống ghi nhận việc từ chối và tiếp tục tìm tài xế khác.
- Tài xế không phản hồi → Hệ thống tiếp tục tìm tài xế khác theo quy định.

**Hậu điều kiện:**
- Chuyến được tài xế nhận hoặc được chuyển sang quá trình tìm tài xế khác.


## UC06 – Cập nhật trạng thái chuyến

**Actor:** Tài xế

**Mục tiêu:**  
Cho phép tài xế cập nhật quá trình thực hiện chuyến.

**Tiền điều kiện:**
- Tài xế đã nhận chuyến.

**Luồng chính:**
1. Tài xế bắt đầu thực hiện chuyến.
2. Tài xế cập nhật trạng thái đã đến điểm đón.
3. Tài xế cập nhật trạng thái đã đón khách.
4. Tài xế cập nhật trạng thái đang di chuyển.
5. Tài xế cập nhật trạng thái hoàn thành chuyến.
6. Hệ thống lưu trạng thái mới.
7. Hệ thống cập nhật thông tin cho các bên liên quan.

**Ngoại lệ:**
- Có lỗi trong quá trình thực hiện → Hệ thống ghi nhận trạng thái/lỗi để nhân viên vận hành xử lý.

**Hậu điều kiện:**
- Trạng thái chuyến được cập nhật.


## UC07 – Tính cước và thanh toán

**Actor:** Khách hàng / Nhà cung cấp dịch vụ thanh toán

**Mục tiêu:**  
Cho phép xác định số tiền khách hàng phải trả và thực hiện thanh toán.

**Tiền điều kiện:**
- Chuyến xe đã hoàn thành.
- Hệ thống có thông tin cần thiết để xác định cước.

**Luồng chính:**
1. Hệ thống xác định số tiền khách hàng phải trả.
2. Khách hàng chọn phương thức thanh toán.
3. Nếu chọn tiền mặt, hệ thống ghi nhận thanh toán tiền mặt.
4. Nếu chọn thanh toán điện tử, hệ thống chuyển yêu cầu đến nhà cung cấp thanh toán bên ngoài.
5. Nhà cung cấp xử lý giao dịch.
6. Nhà cung cấp trả kết quả giao dịch.
7. Hệ thống ghi nhận trạng thái thanh toán.
8. Hệ thống thông báo kết quả cho khách hàng.

**Ngoại lệ:**
- Thanh toán điện tử thất bại → Hệ thống thông báo cho khách hàng và xử lý lại theo chính sách của doanh nghiệp.
- Nhà cung cấp thanh toán không phản hồi → Hệ thống ghi nhận trạng thái giao dịch phù hợp và không tự xác nhận thanh toán thành công.

**Hậu điều kiện:**
- Thanh toán được ghi nhận thành công hoặc thất bại.

**Quy tắc nghiệp vụ:**
- CAB không lưu trực tiếp thông tin nhạy cảm của thẻ hoặc tài khoản thanh toán.


## UC08 – Đánh giá tài xế

**Actor:** Khách hàng

**Mục tiêu:**  
Cho phép khách hàng đánh giá tài xế sau khi chuyến hoàn thành.

**Tiền điều kiện:**
- Chuyến xe đã hoàn thành.
- Khách hàng là người sử dụng chuyến.

**Luồng chính:**
1. Khách hàng chọn chuyến đã hoàn thành.
2. Khách hàng chọn chức năng đánh giá.
3. Khách hàng nhập điểm đánh giá và/hoặc nhận xét.
4. Khách hàng gửi đánh giá.
5. Hệ thống kiểm tra và lưu đánh giá.

**Ngoại lệ:**
- Thông tin đánh giá không hợp lệ → Hệ thống yêu cầu khách hàng chỉnh sửa.

**Hậu điều kiện:**
- Đánh giá được lưu vào hệ thống.


## UC09 – Quản lý và giám sát vận hành

**Actor:** Nhân viên vận hành

**Mục tiêu:**  
Cho phép nhân viên vận hành quản lý các đối tượng và giám sát hoạt động đặt xe.

**Tiền điều kiện:**
- Nhân viên vận hành đã đăng nhập.
- Nhân viên có quyền truy cập chức năng.

**Luồng chính:**
1. Nhân viên truy cập hệ thống quản trị.
2. Nhân viên xem thông tin khách hàng, tài xế, phương tiện và chuyến đi.
3. Nhân viên theo dõi các chuyến đang diễn ra.
4. Nhân viên kiểm tra trạng thái tài xế.
5. Khi phát sinh vấn đề, nhân viên kiểm tra thông tin liên quan.
6. Nhân viên thực hiện xử lý theo nghiệp vụ được cho phép.
7. Hệ thống lưu vết thao tác quan trọng.

**Ngoại lệ:**
- Nhân viên không có quyền → Hệ thống từ chối thao tác.
- Chuyến xảy ra lỗi → Nhân viên kiểm tra và hỗ trợ xử lý.

**Hậu điều kiện:**
- Thông tin vận hành được cập nhật hoặc vấn đề được ghi nhận/xử lý.
B13 XÁC ĐỊNH AC
# Acceptance Criteria (AC)

## AC01 – Đăng ký / Đăng nhập

- Khách hàng có thể đăng ký tài khoản khi cung cấp đầy đủ thông tin hợp lệ.
- Hệ thống không cho phép đăng ký khi thông tin bắt buộc không hợp lệ.
- Khách hàng có thể đăng nhập bằng thông tin tài khoản hợp lệ.
- Hệ thống từ chối đăng nhập khi thông tin xác thực không chính xác.
- Sau khi đăng nhập thành công, khách hàng được phép sử dụng các chức năng dành cho khách hàng.

---

## AC02 – Đặt xe

- Khách hàng đã đăng nhập có thể nhập điểm đón và điểm đến.
- Khách hàng có thể lựa chọn loại xe/dịch vụ.
- Hệ thống không cho phép gửi yêu cầu khi thiếu thông tin bắt buộc.
- Khi thông tin hợp lệ, hệ thống ghi nhận yêu cầu đặt xe.
- Yêu cầu đặt xe được chuyển sang quá trình tìm và phân công tài xế.
- Khách hàng nhận được thông tin về trạng thái của yêu cầu đặt xe.

---

## AC03 – Tìm và phân công tài xế

- Hệ thống chỉ xem xét các tài xế phù hợp với yêu cầu đặt xe.
- Tài xế đang ở trạng thái sẵn sàng mới được xem xét phân công.
- Khi tài xế chấp nhận, hệ thống ghi nhận tài xế được phân công cho chuyến.
- Khi tài xế từ chối, hệ thống tiếp tục tìm tài xế khác.
- Khi tài xế không phản hồi theo thời gian quy định, hệ thống tiếp tục tìm tài xế khác.
- Khi không còn tài xế phù hợp, hệ thống thông báo cho khách hàng.

---

## AC04 – Theo dõi chuyến xe

- Khách hàng có thể xem trạng thái hiện tại của chuyến.
- Khách hàng có thể xem thông tin tài xế đã nhận chuyến.
- Hệ thống cập nhật trạng thái khi tài xế thay đổi trạng thái chuyến.
- Nhân viên vận hành có thể xem các chuyến đang diễn ra.
- Nhân viên vận hành có thể kiểm tra trạng thái của tài xế và chuyến xe.

---

## AC05 – Thực hiện chuyến xe

- Tài xế chỉ có thể thực hiện chuyến sau khi đã nhận chuyến.
- Tài xế có thể cập nhật trạng thái "Đã đến điểm đón".
- Tài xế có thể cập nhật trạng thái "Đã đón khách".
- Tài xế có thể cập nhật trạng thái "Đang di chuyển".
- Tài xế có thể cập nhật trạng thái "Hoàn thành".
- Hệ thống lưu lại trạng thái mới của chuyến.
- Khách hàng có thể nhìn thấy trạng thái chuyến sau khi được cập nhật.

---

## AC06 – Tính cước và thanh toán

- Khi chuyến hoàn thành, hệ thống xác định số tiền khách hàng phải trả.
- Khách hàng có thể lựa chọn phương thức thanh toán được hệ thống hỗ trợ.
- Thanh toán tiền mặt được ghi nhận vào hệ thống.
- Thanh toán điện tử được chuyển đến nhà cung cấp thanh toán bên ngoài.
- Hệ thống ghi nhận kết quả giao dịch từ nhà cung cấp thanh toán.
- Khi thanh toán thất bại, hệ thống thông báo kết quả cho khách hàng.
- Hệ thống không lưu trực tiếp thông tin nhạy cảm của thẻ hoặc tài khoản thanh toán.

---

## AC07 – Đánh giá tài xế

- Chỉ khách hàng đã sử dụng chuyến mới có thể đánh giá tài xế của chuyến đó.
- Khách hàng có thể nhập điểm đánh giá.
- Khách hàng có thể nhập nhận xét nếu chức năng được hỗ trợ.
- Hệ thống lưu đánh giá gắn với đúng chuyến và tài xế.
- Khách hàng không thể đánh giá một chuyến chưa hoàn thành.

---

## AC08 – Quản lý và giám sát vận hành

- Nhân viên vận hành có thể xem thông tin khách hàng.
- Nhân viên vận hành có thể xem thông tin tài xế.
- Nhân viên vận hành có thể xem thông tin phương tiện.
- Nhân viên vận hành có thể xem thông tin chuyến xe.
- Nhân viên vận hành có thể theo dõi các chuyến đang diễn ra.
- Nhân viên vận hành có thể kiểm tra trạng thái tài xế.
- Nhân viên vận hành có thể hỗ trợ xử lý các trường hợp chuyến bị lỗi.
- Hệ thống từ chối các thao tác mà nhân viên không có quyền thực hiện.

B14: XÁC ĐỊNH RQM
# Requirement Matrix (RQM)

| RQM ID | Business Requirement | Business Process | Functional Requirement | Use Case | Acceptance Criteria | Priority |
|---|---|---|---|---|---|---|
| RQM01 | BR01 – Hỗ trợ khách hàng đặt xe | BP01 – Đặt xe | FR01, FR02, FR03 | UC01, UC02 | AC01, AC02 | Must Have |
| RQM02 | BR02 – Tự động tìm và phân công tài xế | BP02 – Tìm và phân công tài xế | FR04, FR05, FR06, FR07 | UC03, UC05 | AC03 | Must Have |
| RQM03 | BR03 – Theo dõi trạng thái chuyến xe | BP03 – Thực hiện chuyến | FR08, FR09 | UC04, UC06 | AC04, AC05 | Must Have |
| RQM04 | BR04 – Quản lý và thực hiện chuyến xe | BP03 – Thực hiện chuyến | FR08, FR09 | UC06 | AC05 | Must Have |
| RQM05 | BR05 – Tính cước và thanh toán | BP04 – Tính cước và thanh toán | FR10, FR11, FR12 | UC07 | AC06 | Must Have |
| RQM06 | BR06 – Đánh giá tài xế | BP06 – Đánh giá sau chuyến | FR16 | UC08 | AC07 | Should Have |
| RQM07 | BR07 – Quản lý và giám sát vận hành | BP05 – Quản lý và giám sát | FR14, FR15 | UC09 | AC08 | Must Have |


