# CAB — Hợp đồng giao tiếp nội bộ 1.3

Baseline tài liệu: commit `1938d4f41e75f99552ae2a0f38578a16563989ed`. Bổ sung ngày 2026-10-01.

Đây là hợp đồng thiết kế có protobuf biên dịch được và JSON Schema kiểm tra được; **chưa phải triển khai backend hoặc bằng chứng chạy tích hợp**.

- [RPC và invariant](RPC.md): request/response trong `proto/cab/internal/v1/*.proto`, caller, deadline, retry, Saga.
- [Xác thực và lỗi](SECURITY.md): mTLS, user context, quyền từng phương thức, mã lỗi.
- [RabbitMQ](EVENTS.md): schema, routing, nguồn/người nhận, outbox/inbox và DLQ.
- `rpc-policy.json`: allowlist từng RPC dùng làm đầu vào interceptor, deny mặc định.
- `events/topology.json`: hợp đồng broker, producer/consumer; không phải file import RabbitMQ definitions.
- `tools/validate.py`: compile tất cả protobuf thành descriptor; kiểm tra allowlist, schema, fixture và negative cases.

Phạm vi: lời gọi **giữa tám dịch vụ nghiệp vụ**. Rating chỉ gọi Identity/Trip; Notification nhận RabbitMQ và xử lý inbox cục bộ, nên không tạo service RPC rỗng cho hai dịch vụ này. Không mở REST `/internal/*`. Gateway → dịch vụ cho 74 operation REST MVP là facade riêng, vẫn theo OpenAPI; bộ này **không tuyên bố đã định nghĩa protobuf cho toàn bộ facade Gateway**, webhook provider hay health. OTP/payment provider và thuật toán JourneyMetrics vẫn là D01–D03 chưa chốt.

Protobuf package `cab.internal.v1` là version giao thức, độc lập version tài liệu 1.3. ID là opaque nonempty string, không ép UUID cho dữ liệu API hiện tại; command/event ID mới dùng UUID. Không tái sử dụng field number; khi bỏ field phải `reserved` tên và số. Đổi nghĩa hoặc kiểu không tương thích dùng package mới. Không dùng `Struct`, JSON blob hoặc `Any` để né đặc tả DTO.

Kiểm tra từ root repository:

```sh
python -m pip install -r contracts/tools/requirements.txt
python contracts/tools/validate.py
```

Descriptor và kết quả kiểm tra nằm trong thư mục tạm, không thêm generated stub vào source. Sinh stub bằng plugin ngôn ngữ của backend sau khi chọn stack. `VALIDATION.md` ghi kết quả lần kiểm tra hiện tại. Test runtime về transaction, mTLS, broker ACL, chaos và concurrency vẫn phải chạy khi có implementation.
