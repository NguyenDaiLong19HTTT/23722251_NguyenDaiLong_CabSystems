# Kết quả kiểm tra hợp đồng

Ngày: 2026-10-01. Baseline repository: `1938d4f41e75f99552ae2a0f38578a16563989ed`.

- PASS: protoc biên dịch 7 file, 34 RPC; không lỗi import/type/field number.
- PASS: 34/34 method khớp chính xác rpc-policy.json, không method thiếu allowlist.
- PASS: 2 JSON Schema hợp lệ Draft 2020-12.
- PASS: 23 fixture (19 Notification v2, 4 domain v1), mỗi event type có fixture/routing.
- PASS: 21 negative checks, gồm source/routing giả, thiếu dữ liệu, version sai, người nhận trùng, GPS tương lai, payload không được phép.
- PASS: schema Notification trùng định nghĩa API06 sau chuyển $ref/format int64.
- PASS: cả 8 YAML OpenAPI parse thành công (không thay thế OpenAPI semantic validator).
- PASS: Python validator compile; git diff whitespace check với CRLF baseline được giữ nguyên.

Chạy lại: `python contracts/tools/validate.py` sau cài requirements.txt. Phiên bản thư viện đã pin. Không cần network lúc chạy validator.

Chưa thực hiện: backend runtime, generated language client/server integration, certificate/ACL deployment, concurrent accept/cancel, compensation crash matrix, broker failover/replay, thực nghiệm provider hoặc thuật toán metrics. Không dùng các kết quả static trên để đánh dấu test tích hợp PASS.
