# Prisma/PostgreSQL — thử nghiệm persistence riêng

Ngày 2026-10-02, nhánh `feat/customer-foundation`, HEAD `c5314ece78506047c85e9aeb4e836d2dc9453f84`.
Kết luận: **Prisma phù hợp có điều kiện cho các primitive persistence đã thử của CAB**.
14/14 kiểm thử trên PostgreSQL thật đạt, gồm cả hai database và cạnh tranh transaction.
Đây là bằng chứng kỹ thuật để đề xuất adapter, chưa phải quyết định dùng ORM cho mọi service,
schema đăng ký/login hay nghiệm thu persistence production.

## Phiên bản và cách chạy

- Giữ Node 24.19.0, npm 11.17.0, TypeScript 6.0.3 và ESM/NodeNext của scaffold.
- Pin Prisma CLI, `@prisma/client`, `@prisma/adapter-pg` cùng **7.10.0**;
  `pg` và `@types/pg` **8.23.1**; manifests và lockfile khớp pin trực tiếp.
  Registry có bản 8 prerelease; chọn 7 stable và API/tài liệu v7, không cài tag `latest`.
- PostgreSQL **17.11-bookworm**, pin digest
  `sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652`.
  `SHOW server_version` thực tế: `17.11 (Debian 17.11-1.pgdg12+2)`.
- Theo [Prisma v7 requirements](https://www.prisma.io/docs/orm/v7/reference/system-requirements),
  Node 24/TypeScript hiện có đáp ứng yêu cầu; driver adapter PostgreSQL và ESM được dùng theo v7.
  Tham khảo [PostgreSQL connector](https://www.prisma.io/docs/orm/v7/overview/databases/postgresql),
  [transactions/OCC](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions),
  [PostgreSQL versioning](https://www.postgresql.org/support/versioning/).

Từ Git root, sau khi cài dependencies local theo lockfile:

```powershell
# Chỉ cần biến này nếu docker.exe chưa nằm trong PATH; dùng đường dẫn cài đặt của máy.
$env:CAB_PROBE_DOCKER = '<existing-docker-executable>'
npm.cmd run probe:postgres
npm.cmd run typecheck:probe
npm.cmd run build
npm.cmd run typecheck
npm.cmd test -- --reporter=verbose
npm.cmd run test:built
```

Không chạy dòng placeholder nếu Docker đã có trong PATH. Runner tạo credentials ngẫu nhiên,
generate từng client, `prisma migrate deploy` từng database, typecheck probe và chạy Vitest thật,
rồi cleanup tài nguyên của chính lần chạy trong `finally`. Không cần cung cấp URL/password thật.
`npm.cmd run probe:generate` đã kiểm chứng exit 0, generate hai client không cần mở DB/cung cấp URL.
Client generated được ignore và phải có trước build trên checkout mới: sau cài dependency, chạy
`probe:generate` rồi build/typecheck nếu chỉ kiểm tra scaffold. `probe:postgres` cũng tự generate;
không cần dựng cả hệ thống.
`npm.cmd test` mặc định không tự khởi động PostgreSQL; suite probe là opt-in riêng.

## Database-per-Service và phạm vi tài nguyên

`experiments/prisma-postgres/compose.yaml` chỉ có một PostgreSQL trong profile `test`.
Project tên `cab-prisma-probe-<UUID>` mới mỗi lần, host port động chỉ bind `127.0.0.1`,
data nằm trên tmpfs, không tạo volume bền vững. Runner kiểm tra project/container ownership
trước khi chọn target và cleanup; không chọn container/database có sẵn.

| Database | Migration role | Runtime role | Quyền runtime |
|---|---|---|---|
| cab_identity | identity_migration | identity_runtime | CONNECT đúng DB, USAGE schema, SELECT/INSERT/UPDATE/DELETE đúng ba bảng probe |
| cab_customer | customer_migration | customer_runtime | CONNECT đúng DB, USAGE schema, SELECT/INSERT/UPDATE/DELETE đúng ba bảng probe |

Cả bốn role đều NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOINHERIT. Migration role là owner DB;
bootstrap admin chỉ của instance thử nghiệm tạo DB/role. Thu hồi PUBLIC trên hai DB, schema public
và các DB mặc định dùng được; runtime không có CREATE/TEMP, không đọc migration ledger.
Không foreign key, transaction, JOIN hoặc ORM model chung xuyên service.

Password chỉ được sinh cho lần chạy này: admin password file trong `.secrets/<project>` ignored,
role password/URL trong bộ nhớ và môi trường tiến trình con. Runner che password trước in stdout/stderr,
không dump environment/connection string; `.env.example` chỉ chứa placeholder.
Cleanup dùng `compose down --timeout 5` đúng project mới, **không `down -v`**, không trust-store/global install.
Inventory trước/sau xác nhận các container người dùng giữ trạng thái và volume giữ nguyên;
không còn container probe hoặc thư mục credential của lần chạy cuối.
Đây là môi trường dev/test SCRAM trên loopback, **chưa kiểm chứng TLS PostgreSQL production**.

## Adapter/schema/migration

Mỗi service có `src/infrastructure/prisma-probe/` riêng: schema, config ESM, factory client,
generated client riêng và SQL migration `202610020001_probe`. Domain/application không import Prisma.
Factory chưa gắn vào Nest provider/bootstrap; ứng dụng không tự kết nối DB probe.

Ba bảng `probe_business`, `probe_outbox`, `probe_active_right` chỉ là fixture kỹ thuật,
không phải Account/Customer/Session và không được đưa vào domain. SQL được review, gồm FK local,
CHECK version, NUMERIC(30,12), partial unique index `WHERE active = TRUE` và grant DML rõ từng bảng.
Apply bằng `migrate deploy`, không `db push`, `migrate reset`, sync schema hoặc sửa contract.
Partial index dùng SQL, không bật Prisma Preview để thay SQL review.

## Expected / actual trên PostgreSQL thật

Mỗi hàng chạy độc lập cho Identity và Customer: 7 ca/service, **14/14 PASS**.

| Ca | Expected | Actual | Kết quả |
|---|---|---|---|
| a. Migration | Apply DB rỗng; deploy lại giữ dữ liệu và ledger | Runner xác nhận 0 bảng trước apply; deploy lại không thêm migration; tên/checksum ledger giữ nguyên và probe seed còn nguyên | PASS ×2 |
| b. Transaction + outbox | Cả hai commit hoặc cả hai rollback | Commit có 1 business + 1 outbox; lỗi duplicate PK thật giữa transaction trả P2002, cả hai bảng không còn row của transaction lỗi | PASS ×2 |
| c. CAS concurrent | Hai UPDATE cùng expectedVersion chỉ một thắng | Barrier cho hai transaction; updateMany theo id/version, kết quả đúng một won/một conflict, version cuối 1 | PASS ×2 |
| d. FOR UPDATE | Cùng connection trong transaction; transaction thứ hai thực sự bị khóa | Tagged `$queryRaw` tham số UUID; PID giữ nguyên trong mỗi transaction, hai PID khác nhau; `pg_blocking_pids` xác nhận blocker trước release, sau release transaction thứ hai hoàn tất | PASS ×2 |
| e. Partial unique | Hai active cho một resource bị chặn kể cả cạnh tranh | Catalog xác nhận predicate/index; hai transaction đồng thời: một insert thắng, một P2002, count active=1; deactivate rồi insert mới thành công | PASS ×2 |
| f. Decimal | Roundtrip và arithmetic không mất chữ số | `123456789012345678.123456789012` giữ nguyên qua Prisma và SQL amount::text; cộng `0.000000000001` bằng Decimal precision 40 ra đúng đuôi .013 | PASS ×2 |
| g. Runtime isolation | DML đúng DB được phép; DDL và DB khác bị deny | Các ca trước dùng runtime thật; CREATE/ALTER/đọc ledger và kết nối DB kia bị SQLSTATE 42501; catalog xác nhận role flags và CONNECT/CREATE/TEMP đúng | PASS ×2 |

Đồng bộ bằng barrier/latch và quan sát lock catalog, không suy concurrency từ sleep.
Timeout hữu hạn: latch 5 giây, quan sát blocker 3 giây, statement 8 giây, lock 5 giây,
interactive transaction 10 giây, Vitest case 15 giây; migration subprocess cũng có timeout.
Observer dùng bootstrap admin chỉ để đọc bằng chứng của hai DB thử nghiệm; thao tác kiểm chứng adapter dùng runtime role.

**Phát hiện cần giữ khi dùng tiếp:** Prisma.Decimal mặc định precision 20 giữ roundtrip nhưng phép cộng
giá trị NUMERIC(30,12) lớn đã làm mất chữ số trong lần chạy đầu. Adapter probe dùng Decimal.clone
precision 40/ROUND_HALF_UP riêng, không sửa precision global và không chuyển tiền sang Number.
Scale/range/rounding của value object nghiệp vụ vẫn phải được thiết kế riêng; probe không tự chốt chính sách tiền.

Các lần đầu thất bại do env Compose chưa truyền vào inspect, overload transaction union ở typecheck,
observer URL chọn nhầm database và precision Decimal. Đã sửa nguyên nhân, giữ assertion và rerun toàn probe;
cleanup vẫn chạy cho từng attempt. Không reset DB hay hạ assertion để đạt.

## Lệnh đã chạy và ranh giới bằng chứng

| Lệnh | Actual cuối |
|---|---|
| `npm.cmd install --cache .cache/npm --no-audit --no-fund` | Cài local và cập nhật lockfile; không cài global/đổi ExecutionPolicy |
| `npm.cmd run probe:postgres` | Exit 0; PG 17.11 thật; migrate cả hai DB; 14/14 PASS; cleanup project/secret PASS |
| `npm.cmd run typecheck:probe` | Exit 0 |
| `npm.cmd run probe:generate` | Exit 0; hai client 7.10.0 generate không kết nối DB |
| `npm.cmd run build` | Exit 0 cho mọi workspace |
| `npm.cmd run typecheck` | Exit 0 cho workspace và test scaffold |
| `npm.cmd test -- --reporter=verbose` | Exit 0; 35/35 test, 6 file; giữ mTLS/policy, payload 1 MiB và smoke DI |
| `npm.cmd run test:built` | Exit 0; ba built application context/metadata/DI/close PASS |
| Pin/ignore/whitespace và Docker inventory | Pin trực tiếp khớp lock; generated/secret ignored; diff sạch; tài nguyên có sẵn giữ nguyên |

Docker/npm/Vitest dùng quyền chạy cần thiết ngoài sandbox theo giới hạn môi trường đã xác định;
không đổi ACL máy, ExecutionPolicy hoặc version để vượt lỗi. Npm báo lifecycle scripts chưa approved;
không mở quyền scripts toàn bộ, generate/migrate/test thực tế vẫn chạy được.
Không chạy lại contract validator vì task này không sửa input/validator contract;
static PASS lịch sử không được nhận là kết quả mới hoặc integration PASS.

Giữ được pattern infrastructure per-service, SQL review, conditional UPDATE/CAS, transaction client,
parameterized lock, Decimal precision và phân quyền DB. **File probe, bảng probe, Compose tmpfs, runner,
observer admin và harness là thử nghiệm**, không tự chuyển thành nền tảng production hoặc auto-migration lúc boot.

Chưa kiểm chứng upgrade schema nghiệp vụ có dữ liệu, migration drift với custom SQL/future schema diff,
forward fix/restore, backup, pool tải thật, reconnect/failover, deadlock retry, PG TLS/rotation hay ORM major 8.
Chưa tạo đăng ký/login/schema nghiệp vụ, broker hoặc ORM model dùng chung.
Metadata tổng 8 KiB chưa enforce/test; JWT/Session/object authorization, HTTP mapping,
issuer rotation/revocation và deployment transport tiếp tục ở backlog.
Payload 1 MiB và mTLS/policy PASS không đồng nghĩa bảo vệ đầy đủ transport.

Bước nhỏ tiếp theo: review và chốt có dùng Prisma 7 cùng workflow SQL migration cho Identity/Customer;
sau đó giao adapter lifecycle/config production và kiểm tra migration upgrade riêng, chưa mở rộng mọi service.
Hardening metadata 8 KiB là nhiệm vụ transport riêng trước handler nghiệp vụ.
