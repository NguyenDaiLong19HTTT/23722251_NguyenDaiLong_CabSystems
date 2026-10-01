# RPC giữa dịch vụ

## Quy tắc chung

Protobuf là nguồn chuẩn field/type; tài liệu này là ràng buộc semantic bắt buộc. Proto3 không có required: server phải từ chối field bắt buộc rỗng, enum UNSPECIFIED/không biết, version/generation=0, timestamp không hợp lệ. ID dài 1–128, chuỗi phải có ký tự không trắng. `Command.command_id` UUID; `operation_id` ID ổn định của Saga/registration/closure. Mỗi bước và ý định khác nhau có command_id riêng; retry cùng bước giữ nguyên ID và payload. Field optional vắng khác với chuỗi rỗng. Không nhận principal/account role do client tự khai làm bằng chứng quyền.

`Decimal.value`: regex `^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$`, tối đa 24 ký tự, tính bằng decimal, không float; tiền tệ chỉ VND. Chỉ ROUND_HALF_UP một lần khi phát hành Fare nguyên VND. Point: latitude [-90,90], longitude [-180,180], hữu hạn. PricingSnapshot bất biến với đúng vehicleType, version và thời điểm Booking chấp nhận; không có giá áp dụng thì FAILED_PRECONDITION/PRICING_UNAVAILABLE, không dùng zero.

`EntityId.id` của Get*Provision là registration operationId; của GetBookingGuardDecision là bookingId. Read trả NOT_FOUND nếu chưa có; không suy ra thao tác trước chưa chạy chỉ từ timeout. Các response state phải xác định, timestamp/version bắt buộc nếu đã tạo. RPC successful return nghĩa local commit bền vững, không có transaction xuyên DB.

Deadline và allowlist chính xác nằm ở `rpc-policy.json`. Read 1s; mutation 2s; FindDispatchCandidates 1.5s; ActivateTrip 4s để đủ các xác minh. Deadline con=min(budget còn lại trừ 100ms, policy method); không còn budget thì dừng gọi. Unary max receive/send 1MiB, candidates limit 1–100, excluded IDs tối đa 100, radius 1–5000m. Read retry tối đa 2 lần trong deadline với jitter 50–150ms chỉ UNAVAILABLE. Không retry mù mutation: khi DEADLINE_EXCEEDED/UNAVAILABLE/CANCELLED coi outcome chưa biết; query trạng thái theo ID rồi replay cùng command. Deadline hủy không tự rollback commit.

Idempotency key local `(authenticated caller, full RPC method, command_id)`, fingerprint toàn bộ canonical request và operation_id. Same ID khác payload: ALREADY_EXISTS/IDEMPOTENCY_CONFLICT. Khi cùng operation/aggregate với command mới vẫn phải unique business key. Cùng command trả kết quả lịch sử sau xác thực; response có thể cũ nên query để lấy hiện tại. Không lưu raw token hoặc PII rõ trong fingerprint; dùng HMAC cho payload nhạy cảm. Persist receipt cùng transaction nghiệp vụ.

## Identity và đăng ký

VerifyUserIdentity và VerifyRatingUserIdentity kiểm tra token chữ ký, issuer/audience/expiry, Session chưa revoked/hết hạn, Account ACTIVE và provisioning hoàn tất. allowed_roles phải là tập con policy use case bên gọi; empty bị từ chối. Rating wrapper tương đương verify chung nhưng chỉ rating-service được gọi. Trả profileId đã xác nhận theo role; OPERATOR không cần Customer/Driver ID. Không có profile đã xác nhận thì UNAVAILABLE/PROFILE_NOT_READY. Không gọi GetAccountContact để thay thế xác thực.

VerifyAccountEligibility: chỉ kiểm tra Account ACTIVE, role và provisioning của **công việc đã được cấp quyền bền vững**; không xác nhận Session và không được dùng cho request người dùng. Booking/Driver dùng để recheck trước chọn/reserve; Account bị khóa làm fail precondition và đi bù trước activation. Phục hồi/release/ghi nhận thanh toán cho công việc cũ vẫn phải chạy dù Account bị khóa.

GetAccountContact: CUSTOMER/DRIVER chỉ OWN_PROFILE của mình; OPERATOR được OPERATIONS_PROFILE; ACTIVE_TRIP_CONTACT chỉ trip-service, user phải là bên tham gia Trip chưa đóng. Identity gọi Trip.GetActiveTripContactContext để kiểm tra quan hệ, Trip xác minh user bằng VerifyUserIdentity (không gọi lại GetAccountContact). Trip recheck trạng thái/version ngay trước khi trả public response, loại bỏ phone khi đóng. Customer/Driver profile lookup lấy Account ID từ mapping local, không tin client chọn ID. OWN/OPERATIONS trả field theo OpenAPI; ACTIVE_TRIP_CONTACT chỉ full_name/phone, không email. Không cache PII xuyên request.

Identity sinh account/profile/application/operation ID trước gọi Provision*. Customer ghi profile; Driver ghi Driver OFFLINE/PENDING_APPROVAL + Application SUBMITTED + outbox trong cùng transaction, chưa tạo Vehicle chính thức. ProposedVehicle chỉ plate_number/vehicle_type theo API07; license/plate chuẩn hóa như OpenAPI. Unique account_id, operation_id, profile_id và license digest. Provision retry không tạo lại application/event. GetProvision trả trạng thái operation không có PII.

CancelProvision chỉ Identity coordinator sau quyết định bù bền vững, không được xóa profile đã được hoàn tất hoặc đã có hoạt động. Identity phải CAS trạng thái registration sang COMPENSATING trước gọi cancel và từ thời điểm này tuyệt đối không finalize/provision lại; bên nhận ghi tombstone ngay cả khi chưa từng nhận Provision. Provision trễ gặp tombstone phải bị từ chối. Không xóa tombstone. Account/registration chỉ FAILED khi bù xác nhận hoàn tất; provisioning chưa chắc chắn vẫn PROCESSING. JWT đăng nhập chỉ cấp sau khi Identity ghi SUCCEEDED. OTP, password và recovery token ở Identity, không gửi sang profile MS.

## Guard, reservation và phân công

AcquireGuard do Booking gọi sau khi ghi CreateBookingOperation + authorization receipt. Customer unique một guard chưa RELEASED/customer; trả guard_id/generation do Customer cấp tăng đơn điệu, không từ caller. Acquire giữ theo bookingId ngay cả khi Booking đang tạo; GetBookingGuardDecision phải tra được cả create operation. AcquireGuard kiểm tra Booking decision KEEP_BOOKING_GUARD và tombstone local trước commit. Duplicate cùng operation trả cùng guard. Conflict ACTIVE_CUSTOMER_ACTIVITY.

Booking CAS cùng điểm quyết định accept/cancel/reject/expire và chốt assignmentId/tripId. GetAssignmentDecision trả snapshot đầy đủ, freeze pickup/destination/pricing/parties/guard; IDs trùng giữa snapshot và trường trực tiếp phải giống nhau. `claimed_at < min(offer_expires_at, dispatch_deadline_at)`; bằng deadline là quá hạn. Recovery của claim hợp lệ không bị biến thành EXPIRED chỉ vì hiện tại đã qua deadline.

ReserveDriver xác minh GetAssignmentDecision: đúng IDs, state CLAIMED/PREPARING; recheck Account eligibility, APPROVED/AVAILABLE, Vehicle ACTIVE/đúng loại, GPS <=30s và expected versions. Driver giữ Driver+Vehicle nguyên tử; unique một HELD/BOUND trên từng Driver và Vehicle. Trả generation từ DB. Candidate không phải reservation; sort distance rồi driverId; không bao giờ bảo đảm còn rảnh lúc accept. reserve retry sau đã BOUND trả reservation hiện có, không reserve lại.

PrepareTrip kiểm tra snapshot Booking và Driver reservation đúng assignment/parties; unique bookingId/assignmentId/tripId. PREPARED không hiển thị như Trip hoạt động. Booking BindGuard và BindReservation cùng tripId, đúng generation, chỉ khi Trip PREPARED; quyền BOUND không hết TTL. Booking chuyển ACTIVATING trước ActivateTrip. Trip truy vấn Customer.GetGuard/Driver.GetReservation và Booking.GetAssignmentDecision: cùng trip, đủ BOUND, ACTIVATING, rồi CAS PREPARED→ACTIVE trong local transaction, tạo status DRIVER_ASSIGNED. Không tin một boolean `confirmed` caller gửi. Customer/Driver không được tự release BOUND khi activation đang xác minh.

CancelTripPreparation là CAS PREPARED→PREPARATION_CANCELLED; khi chưa tồn tại tạo tombstone chứa cả assignment/booking/trip ID để chặn Prepare trễ. Nếu ACTIVE, FAILED_PRECONDITION/TRIP_ALREADY_ACTIVE; coordinator chuyển forward recovery, không rollback. Activate và Cancel serialize trên cùng row/tombstone; mọi Prepare trễ phải kiểm tra tombstone. Booking finalizes ASSIGNED/outbox sau xác nhận ACTIVE. Worker lease chỉ điều phối tiến độ, không cấp quyền mới hoặc xóa tombstone.

RestoreBookingGuard: Booking muốn tiếp tục tìm Driver sau một assignment thất bại. Customer kiểm tra Trip tombstone PREPARATION_CANCELLED cùng assignment/trip, CAS đúng guard+generation+bound trip về BOOKING_HELD, xóa binding cũ; không giải phóng quyền Customer để Booking khác chen vào. Lệnh bind cũ phải tra tombstone nên không phục hồi assignment chết.

ReleaseReservation bởi Booking: Trip phải PREPARATION_CANCELLED; ngay cả reserve chưa được nhận lúc bù cũng phải tra/query trạng thái đến kết quả rõ ràng. Booking không được release quyền khi Trip ACTIVE. ReleaseGuard bởi Booking: không có active Trip và GetBookingGuardDecision=RELEASE_BOOKING_GUARD; nếu đã từng bind phải có tombstone tương ứng. Generation và IDs không khớp trả FAILED_PRECONDITION/STALE_FENCE; tuyệt đối không chạm quyền mới. Bản ghi RELEASED giữ lại để replay.

| Điểm hỏng | Hành động coordinator |
|---|---|
| Chưa reserve, chưa prepare | Query reservation/preparation; khi chắc chưa active thì tạo tombstone trước bù |
| Reserve/prepare/bind đã commit | CancelTripPreparation trước; release đúng reservation; restore guard nếu tìm tiếp hoặc release guard khi Booking terminal |
| Activate timeout | GetTripPreparation; ACTIVE thì finalize phía trước; PREPARED có thể retry activate hoặc cancel bằng CAS |
| ACTIVE, Booking chưa finalize | Hoàn tất Booking/offer/outbox, không tạo Trip thứ hai |
| Cancel race accept | Booking giữ cancelRequested; nếu ACTIVE chuyển use case cancel Trip theo luật public, không báo Booking CANCELLED sớm |

## Đóng chuyến

Trip transaction ghi closedAt/status/history/ClosureOperation/outbox trước trả public 200. ReleaseReservation/ReleaseGuard bởi trip-service bắt buộc trip_id + closure_operation_id. Bên nhận tự GetClosureContext, kiểm tra exact guard/reservation/generation; local release commit rồi trả receipt state RELEASED. GetClosureContext chỉ trả chuyến đã đóng với đúng closure operation, ERROR chưa closedAt không đủ. `block_vehicle=true` khi đóng bởi VEHICLE_ISSUE: Driver vô hiệu hóa/block Vehicle và release trong **cùng transaction**, không chờ event; Driver AVAILABLE chỉ nếu vẫn đủ điều kiện, khác thì OFFLINE.

Closure worker retry tới khi cả hai confirmed, alert khi kéo dài; public ClosureOperation PROCESSING/SUCCEEDED không bị map sang FAILED vì hết số retry vận chuyển. Không tạo Fare cho CANCELLED hoặc ERROR closed. Lệnh đóng/release không phụ thuộc user token còn sống.

## Pricing, Fare, Rating và liên hệ

GetPricingSnapshot do Booking gọi sau tạo operation, capture giá hiệu lực tại booking_accepted_at server. Unique operation_id, replay trả snapshot đầu tiên kể cả giá hiện hành đã đổi; vehicleType/timestamp đổi là conflict. Snapshot copy vào Booking/Trip không trở thành chỉnh sửa giá ở các MS khác.

GetFareContext chỉ Payment worker; trip COMPLETED và metrics CONFIRMED, metrics_version chính xác, trả dữ liệu lịch sử bất biến. Version không khớp → FAILED_PRECONDITION/METRICS_VERSION_MISMATCH, chưa confirmed → METRICS_NOT_CONFIRMED. Payment unique Fare/trip, cố định metricsVersion/pricingVersion. Event metrics chỉ là tín hiệu; không dùng body event/client làm số tiền. Thuật toán metrics chưa chốt ở D03, không được tự xác nhận dữ liệu thiếu.

GetTripPaymentContext yêu cầu user token; Trip kiểm tra user Customer chủ chuyến/Driver lịch sử/OPERATOR theo use case. Payment tiếp tục enforce quyền endpoint riêng: chỉ Driver lịch sử confirm CASH, không cho OPERATOR xác nhận thay. GetTripRatingContext tương tự trả snapshot local kể cả Trip chưa COMPLETED; Rating mới quyết định TRIP_NOT_COMPLETED. Trip missing/outside scope cùng NOT_FOUND/TRIP_NOT_FOUND. Không gọi Payment để cho phép Rating. Các context không có token hoặc giấy phép/phone.

## Lưu giữ và tiến hóa

Baseline nội bộ: receipt mutation, saga, generation, tombstone, pricing capture, event inbox dedupe giữ hết vòng đời dự án MVP, không tự TTL/delete. Payload GPS mã hóa, chỉ Trip consumer được đọc; retention dữ liệu GPS/PII riêng cần chính sách D08 trước production. Outbox payload đã ACK có thể archive nhưng không xóa khóa dedupe trước thời hạn replay. D02/provider retention chưa chốt nên không purge payment evidence. Thay retention phải có migration và chặn replay cũ an toàn.


### Fencing cả lệnh chưa đến

Compensation **luôn gọi Driver.CancelReservation sau Trip tombstone**, kể cả GetReservation=NOT_FOUND. Driver kiểm tra Trip PREPARATION_CANCELLED rồi ghi tombstone theo assignmentId trong transaction serialize với ReserveDriver; nếu HELD/BOUND cùng assignment thì release ở đó. Reserve tới muộn không được tạo giữ quyền sau tombstone. Cancel không tác động reservation của assignment khác. Response Cancellation được dùng khi chưa từng có reservation, không giả generation=0 là quyền hợp lệ.

Khi Booking/CreateBookingOperation terminal, **luôn gọi Customer.CancelBookingGuard**; Customer xác minh GetBookingGuardDecision=RELEASE_BOOKING_GUARD đúng customer/booking rồi ghi tombstone theo bookingId, serialize với AcquireGuard. Nếu đã bind, phải kiểm tra tombstone Trip; nếu Trip ACTIVE không được cancel guard. Nếu chưa acquire thì vẫn tạo tombstone để chặn Acquire tới muộn. Lệnh release cụ thể theo guardId/generation còn dùng cho Trip closure; không thay bằng cancel rộng. Không kết thúc compensation dựa duy nhất trên một lần query NOT_FOUND.
