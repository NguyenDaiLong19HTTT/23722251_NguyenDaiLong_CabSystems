# Persistence Identity/Customer — quyết định có điều kiện

Cập nhật 2026-10-02. Chọn Prisma **7.10.0** có điều kiện cho Identity và Customer,
dựa trên probe PostgreSQL 17.11 tại repo này. Review source của người review chưa chạy lại
vì ZIP thiếu cấu hình/cấu trúc repo; không ghi thành PASS độc lập. Không áp ORM mặc định cho service khác.
Node 24.19.0, TypeScript 6.0.3, ESM và các dependency hiện có giữ nguyên; không cài mới.
Phần probe bên dưới là bằng chứng lịch sử. Phần production V1 được cập nhật ở cuối tài liệu;
không coi generate/build là PostgreSQL integration PASS.

## Lifecycle và ranh giới hiện tại

`IdentityPersistence` và `CustomerPersistence` ở infrastructure, mỗi lớp là Nest provider singleton
trong module sở hữu nó. Nhận **chỉ** URL có username `identity_runtime`/`customer_runtime` và
database `cab_identity`/`cab_customer`; URL migration/admin không được đưa vào ứng dụng.
Không tạo client theo request. Mỗi provider dùng một `PrismaPg` nhận PoolConfig, `max=4`,
connect timeout 3 giây, idle timeout 1 giây, statement timeout 8 giây, lock timeout 5 giây.
`onModuleInit` gọi `$connect()` và query `SELECT 1` vì `$connect()` đơn lẻ đã được quan sát
trả success khi port DB không kết nối. Failure được trả lỗi chung không kèm URL/password.
`onModuleDestroy` gọi `$disconnect()` một lần. Adapter 7.10.0 tạo/sở hữu pool khi nhận config
và `dispose()` gọi `pool.end()`; **không** truyền pool bên ngoài rồi đóng thêm lần nữa.

Provider nay nằm **đúng một lần trong production AppModule** với factory generated client production
riêng service. `IdentityCoreModule`/`CustomerCoreModule` chỉ phục vụ smoke và network harness không DB;
entry point production luôn dùng AppModule và đòi runtime URL/DB. Không copy client probe sang production
hoặc expose model probe qua application/domain. Không chạy migration khi boot.

Harness `experiments/prisma-postgres/lifecycle.spec.ts` dùng Nest container thật với factory
client probe riêng cho từng service. Wrapper chỉ đếm method trên **client thật**: mỗi context
factory/connect/disconnect đúng 1/1/1; URL migration bị chặn với factory count 0.
Hai lần boot/close/service giữ đồng thời ba transaction trên ba connection bằng barrier có hạn.
`application_name` UUID riêng cho context cho phép quan sát **toàn bộ** connection tương ứng
trong `pg_stat_activity`, rồi xác nhận count 0 sau `app.close()`; không suy từ một PID duy nhất.
Port lỗi trả error sạch trong hạn và client thất bại được disconnect một lần. Harness không được
đưa vào AppModule production.

## Workflow migration được chọn cho hai service

- Mỗi service sở hữu schema Prisma, generated client và lịch sử migration riêng. Probe ở
  `src/infrastructure/prisma-probe`; V1 production ở `src/infrastructure/prisma`, không trộn V1/V2 probe.
- Development: sửa schema trong service sở hữu trên database dev **của service**, dùng
  `prisma migrate dev --config <service-config>` để tạo SQL, review SQL và sửa migration **chưa áp dụng**
  khi cần CHECK/partial unique/FK/grant. Migration role hiện NOCREATEDB, vì vậy dev operator cần
  tạo **shadow DB dev riêng cho từng service** và cấu hình `datasource.shadowDatabaseUrl` trong
  Prisma config dev (khác URL database chính); role phải có quyền trên shadow DB đó. Prisma có thể
  reset shadow DB trong `migrate dev`, nên không trỏ vào DB người dùng/production.
  Đây là workflow đã chọn, **chưa dựng/chạy migrate dev production schema** trong nhiệm vụ này.
  Không chạy lệnh này trên database deployment.
- Deployment: migration role riêng chạy migration SQL **đã review** bằng
  `prisma migrate deploy --config <service-config>` trong bước deploy tách application boot.
  Runtime role chỉ có CONNECT/USAGE/DML cần thiết, không DDL, không đọc migration ledger;
  không giao migration/admin credential cho runtime.
- Migration đã áp dụng là bất biến. Thay đổi tiếp theo thêm migration mới, không sửa/checksum lại V1.
  CHECK/partial unique index viết tay phải được kiểm tra trên DB nâng cấp **và** fresh install,
  kể cả quyền GRANT cho đối tượng mới. Schema/client/migration phải khớp trước rollout.
- Không dùng `db push`, `migrate reset`, xóa DB/volume để vượt lỗi. Khi deploy lỗi, dừng rollout;
  xem `_prisma_migrations` và trạng thái DB thực tế, xác định DDL nào đã commit. Chọn forward fix
  hoặc phục hồi có review/backup, rồi dùng `migrate resolve` **chỉ sau khi** DB thực khớp trạng thái
  ghi vào ledger. Không giả định Prisma rollback dữ liệu tự động.

Lệnh v7 và xử lý failure theo [Prisma CLI migrate v7](https://www.prisma.io/docs/cli/v7/migrate),
[shadow database v7](https://www.prisma.io/docs/orm/v7/prisma-migrate/understanding-prisma-migrate/shadow-database)
và [Prisma v7 patching/failed migration](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/patching-and-hotfixing).

## Bằng chứng thử nghiệm và cách chạy

Từ Git root, cần Node/npm đã pin, dependency theo lockfile và Docker Engine có sẵn.
Nếu Docker CLI không ở PATH, đặt `CAB_PROBE_DOCKER` tới executable của máy trong session shell;
không ghi đường dẫn máy hoặc password vào config Git.

```powershell
npm.cmd run probe:generate
npm.cmd run probe:postgres
npm.cmd run typecheck:probe
npm.cmd run build
npm.cmd run typecheck
npm.cmd test -- --reporter=verbose
npm.cmd run test:built
```

`probe:postgres` là kiểm thử opt-in, tạo project Compose UUID/port loopback, tmpfs, database và
credentials chỉ của lần chạy, rồi cleanup đúng project. Không truy cập container/volume/DB sẵn có.
Nó tạm dựng **V1 thật** từ file SQL gốc trên DB rỗng, ghi sentinel bằng runtime role,
deploy **V2 SQL mới** gồm cột `probe_note` và bảng `probe_upgrade_audit`, rồi kiểm tra dữ liệu,
partial unique V1, grant runtime V2, ledger replay. DB fresh của từng service apply V1+V2
và so cột, kiểu NUMERIC precision/scale, CHECK/FK, index và ma trận GRANT runtime từ catalog;
thao tác runtime thật xác nhận FK/CHECK và quyền DML trên cả hai đường.
DB failure dùng một migration cố ý lỗi **có BEGIN/COMMIT tường minh** trong thư mục tạm: CLI trả nonzero,
ledger ghi failed, DDL trong transaction này không để lại marker và replay tiếp bị chặn;
không gọi reset/resolve để làm test xanh. Prisma CLI ở phiên bản này trả PostgreSQL transaction error
cho lần lỗi đầu, không nhất thiết mã P3018; bài test dựa vào exit, ledger và trạng thái DB.
Kết quả rollback này chỉ áp dụng cho SQL thử nghiệm có transaction tường minh;
không chứng minh mọi migration tự rollback hoặc khôi phục dữ liệu tự động.

Kết quả cuối: V1→V2/replay/fresh/failure PASS cho cả Identity và Customer;
20/20 Vitest PostgreSQL thật (14 probe cũ + 6 lifecycle) PASS, runner exit 0/cleanup PASS.
Build/typecheck/typecheck probe, 35/35 full suite và ba built context PASS.
Một lần full suite trong sandbox bị `ERR_SWC_NATIVE_CACHE` do ACL đã biết;
cùng lệnh ngoài sandbox PASS, không đổi version/ACL toàn máy.
V1 không sửa; contracts/OpenAPI/protobuf/policy không đổi nên không chạy lại validator hợp đồng.

Probe chưa chứng minh nâng cấp schema nghiệp vụ có tải, DB backup/restore, migration rollback dữ liệu,
pool tải thật, TLS DB/rotation, hay production wiring. Metadata gRPC tổng 8 KiB, JWT/Session,
object authorization, HTTP mapping và transport deployment vẫn ở backlog.

Production V1 đã chạy `db:verify` trên project riêng, gồm role/constraint/ledger và lifecycle.
Tiếp theo review SQL/rollout, rồi giao crypto, coordinator và handler. Postman register/login
chưa hoạt động.

## Production V1: schema, role, boot và cách kiểm chứng

- Identity: [schema Prisma](../../services/identity-service/src/infrastructure/prisma/schema.prisma),
  [SQL V1](../../services/identity-service/src/infrastructure/prisma/migrations/202610020003_identity_foundation/migration.sql).
  Customer: [schema Prisma](../../services/customer-service/src/infrastructure/prisma/schema.prisma),
  [SQL V1](../../services/customer-service/src/infrastructure/prisma/migrations/202610020003_customer_foundation/migration.sql).
  `prisma.config.ts` và generated client tách theo service; generated output được ignore. V1 viết SQL
  có transaction tường minh, không sửa probe migration. Prisma model không biểu diễn partial unique,
  CHECK và trigger; SQL là nguồn cho các ràng buộc đó và phải review cùng schema.
- Identity có `contact_claim` với partial UNIQUE `(kind,lookup_hmac) WHERE released_at IS NULL`.
  Account cũ giữ digest/contact mã hóa nhưng không còn giữ quyền sau FAILED. Helper persistence
  `persistConfirmedCompensation` đối chiếu response Cancel đã xác minh với ba ID, ghi step Cancel
  CONFIRMED, CAS operation COMPENSATING, revoke Session, khóa Account FAILED và release cả hai claim
  **cùng transaction**. Caller phải xác minh nguồn mTLS/policy của response trước khi gọi; helper
  không làm RPC. Login lookup đầu tiên chỉ qua claim chưa release; eligibility JOIN operation SUCCEEDED +
  Account READY/ACTIVE chỉ dùng sau xác minh password. Không tìm Account lịch sử theo digest.
  Session absolute expiry SQL là 168 giờ.
- Customer `customer_provision` giữ tombstone và UNIQUE vô điều kiện operation/account/profile;
  receipt lưu response lịch sử bốn field. Composite FK local bảo vệ binding Customer/receipt.
  Audit không FK để không phụ thuộc vòng đời/tombstone; không có FK xuyên database.
- App dùng `CAB_IDENTITY_RUNTIME_URL` / `CAB_CUSTOMER_RUNTIME_URL`, kiểm username và database,
  tạo một PrismaPg/client cho mỗi Nest context, connect + query khi boot, disconnect khi shutdown.
  CLI migration chỉ dùng `CAB_IDENTITY_MIGRATION_URL` / `CAB_CUSTOMER_MIGRATION_URL` trong deploy job;
  application không đọc URL đó. Config mẫu ở `.env.example`, chỉ placeholder. Không boot DB ở import.
- Runtime role chỉ CONNECT/USAGE + DML theo ma trận V2 ở cuối tài liệu, không CREATE/DDL, không đọc
  `_prisma_migrations`, không CONNECT DB kia. Với bảng mới, mỗi migration phải thêm GRANT đúng role.

Từ Git root, khi Docker Engine/CLI có sẵn:

```powershell
npm.cmd run db:generate
npm.cmd run build
npm.cmd run typecheck
npm.cmd run typecheck:db
npm.cmd run db:verify
npm.cmd test -- --reporter=verbose
npm.cmd run test:built
```

`db:verify` dùng Compose PostgreSQL 17.11 pin từ probe nhưng project UUID mới, cổng loopback,
tmpfs và secret test được xóa chỉ sau kiểm tra ownership; không chạm DB/container/volume sẵn có.
Runner tạo hai DB rỗng, role migration/runtime riêng, migrate deploy V1+V2, chạy test cạnh tranh/contact,
receipt/tombstone, CAS, Session, role và production Nest boot/query/close; deploy lại so ledger/data.
Không chạy V2 nghiệp vụ giả. Upgrade từ schema nghiệp vụ trước V1 chưa tồn tại/chưa kiểm chứng.
Test trực tiếp SQL/adapter chỉ chứng minh persistence, không chứng minh HTTP/gRPC coordinator/JWT.
Docker CLI chỉ có ngoài sandbox tại máy này; đặt `CAB_PROBE_DOCKER` tới executable của máy trong
session shell, không ghi đường dẫn cá nhân vào repo. Lần đầu khi CLI chưa có trong PATH,
`db:verify` dừng `spawnSync docker ENOENT`; sau đó chạy ngoài sandbox với CLI sẵn có:
PostgreSQL 17.11 **PASS 10/10** ca production, V1 apply trên DB rỗng của hai service,
deploy lại không có pending migration và ledger/data giữ nguyên. Project UUID/tmpfs đã cleanup.
`test:built` và unit smoke chỉ boot CoreModule không DB; hai production AppModule boot/query/close
và quan sát connection biến mất đã được kiểm tra riêng bằng DB thật trong `db:verify`.

Race giữa phase-check và RPC đã gửi vẫn còn: CAS Identity cùng Customer transaction/tombstone là
fence cuối cùng; cần test network/restart trong nhiệm vụ coordinator. Chưa có crypto/key rotation,
JWT/Session flow, publisher, REST register/login hay handler tra cứu. Metadata gRPC 8 KiB và
HTTP/errorCode operationId sai validation còn ở backlog. MVP local không tự purge PII/evidence;
D08 production chưa chốt.

## Forward V2 evidence guard và quyền runtime (2026-10-02)

V1 đã áp dụng được giữ nguyên. [Identity V2](../../services/identity-service/src/infrastructure/prisma/migrations/202610020004_identity_evidence_guard/migration.sql) kiểm tra trước dữ liệu V1 mâu thuẫn, rồi thay CHECK snapshot/terminal để `NULL` không lọt qua PostgreSQL CHECK. [Customer V2](../../services/customer-service/src/infrastructure/prisma/migrations/202610020004_customer_evidence_guard/migration.sql) chặn thay binding, xóa tombstone và đảo trạng thái `PROVISION_CANCELLED`. Cả hai V2 giữ transaction tường minh cho phần DDL; deploy lỗi giữ dữ liệu V1 và failed ledger để người vận hành điều tra/resolve, không tự reset hoặc sửa evidence.

| Runtime role | SELECT/INSERT | UPDATE được phép | DELETE |
|---|---|---|---|
| Identity `account` | Có | Contact/password/status/access/version/profile tiến độ; không đổi ID, created_at | Không |
| Identity `registration_operation` | Có | Phase/status, Customer state, snapshot/terminal, thời điểm tiến độ, version; không đổi binding/key/fingerprint | Không |
| Identity `contact_claim` | Có | Chỉ `released_at`; trigger đòi FAILED đã xác nhận, cấm chèn claim đã release và sửa binding | Không |
| Identity `session` | Có | Digest/key version/rotated/revoked/version; ID, Account, created/expires bất biến | Không |
| Identity `registration_step`, `identity_outbox` | Có | Chỉ trạng thái/thử lại/xuất bản; command và payload bất biến | Không |
| Identity `identity_audit` | Có | Không; append-only | Không |
| Customer `customer_provision` | Có | State, updated/cancelled/version; binding bất biến và CANCELLED không đảo | Không |
| Customer `customer` | Có | updated/version | Có, chỉ profile chưa hoàn tất theo protocol; FK/trigger bảo vệ trường hợp khác |
| Customer `customer_rpc_receipt`, `customer_audit` | Có | Không; append-only | Không |

`db:verify` [runner](../../experiments/production-postgres/run.mjs) áp V1+V2 fresh; [upgrade harness](../../experiments/production-postgres/upgrade.mjs) áp V1 nguyên bản, ghi sentinel bằng runtime role rồi nâng lên V2, so catalog constraint/trigger/grant và ledger/data với fresh, deploy lại, và chứng minh V2 từ chối dữ liệu V1 vi phạm. [Integration spec](../../experiments/production-postgres/production.spec.ts) dùng PostgreSQL thật để thử quyền runtime, CHECK `NULL`, Session expiry/binding, contact claim, tombstone, receipt/audit; ca rollback gọi chính `persistConfirmedCompensation`, không chỉ một transaction SQL do test tự viết. `db:verify` gần nhất: 14/14 integration PASS trên project Docker riêng, fresh/upgrade/replay/invalid-data PASS; project đã cleanup. Review ngoài mới đọc source, chưa tự chạy lại.

Login sau này phải dùng `findCurrentClaimOwnerByContact` chỉ trên claim chưa release để tìm Account trước khi xác minh password; không lộ trạng thái ra HTTP trước xác minh. `findReadyAccountByContactAfterAuthentication` chỉ là eligibility lookup sau xác minh và kiểm tra Account/Session đầy đủ. Customer vẫn chưa có business adapter Provision/Cancel/receipt; test Customer dùng Prisma/SQL trực tiếp. Helper compensation nhận evidence do caller đã xác thực từ Customer, không tự chứng minh nguồn; gọi lại sau commit có thể conflict, caller phải query durable outcome thay vì retry mù. HTTP/gRPC coordinator, JWT/Session flow và metadata tổng 8 KiB còn chưa kiểm chứng.
