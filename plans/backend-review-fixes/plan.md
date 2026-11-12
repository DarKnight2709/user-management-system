# Kế hoạch sửa lỗi và thiếu sót sau khi soát toàn bộ backend

Ngày soát: 2026-11-12. Đây là kế hoạch; chưa có thay đổi code nào được thực hiện.

**Phạm vi:** toàn bộ `src/`, `prisma/`, `test/`, `Dockerfile`, `docker-compose*.yml`,
`.github/workflows/`, AGENTS.md, README.md và các file follow-up ở thư mục gốc.

**Ngoài phạm vi** (đang làm riêng):

- Logging và audit → `plans/audit-logging-hardening/plan.md`.
- Tối ưu truy vấn (index, offset/count, phân trang, truy vấn phân quyền).
- Scale ngang (throttler dùng Redis, nhiều instance, tách worker).

Quy tắc áp dụng cho mọi giai đoạn (theo AGENTS.md):

- Mỗi giai đoạn là một PR riêng, commit theo Conventional Commits.
- Cập nhật AGENTS.md và README.md trong cùng thay đổi.
- Ba lớp test khi áp dụng được: unit, database integration (schema tạm,
  `RUN_DATABASE_TESTS=true`), e2e. Nói rõ lớp nào không áp dụng.
- Không chạy seed, cleanup hay migration trên database ứng dụng khi chưa được
  yêu cầu rõ; review SQL migration trước khi áp dụng.

---

## 1. Tóm tắt phát hiện

Mức độ: **Cao** = lỗi bảo mật/đúng đắn hoặc rủi ro mất dữ liệu; **Trung bình** =
thiếu sót cần sửa trước production; **Thấp** = dọn dẹp, tài liệu.

| ID | Mức độ | Khu vực | Vấn đề | Bằng chứng |
| --- | --- | --- | --- | --- |
| R01 | Cao | Auth | Lộ email tồn tại qua thời gian phản hồi login: email không tồn tại trả về ngay, email đúng phải chạy bcrypt | `src/modules/auth/auth.service.ts:22-25` |
| R02 | Cao | Auth | Login cấp phiên mới sau khi mật khẩu vừa đổi: mật khẩu được so ngoài transaction, transaction login chỉ kiểm tra `deletedAt` (BACKEND_AUDIT F02 vẫn mở) | `auth.service.ts:22-35`, `services/auth-session.service.ts:29-41` |
| R03 | Cao | Auth | Body login không qua validation: `LocalStrategy` đọc `req.body` trước pipe nên `LoginDto` không bao giờ chạy; email không phải chuỗi gây `TypeError` → 500 (F01 vẫn mở) | `auth.controller.ts:36-46`, `users.service.ts` `findOneByEmail` gọi `email.trim()` |
| R04 | Cao | CI | E2E của auth, users, audit không chạy trong CI vì thiếu `RUN_AUTH_E2E_TESTS`, `RUN_USERS_E2E_TESTS`, `RUN_AUDIT_E2E_TESTS` | `.github/workflows/deploy.yml` (khối `env` của job `ci`) |
| R05 | Cao | Deploy | Redis production không có mật khẩu, không bật AOF, không đặt `maxmemory` dù container giới hạn 128M; job BullMQ có thể mất khi restart hoặc container bị OOM-kill. Compose local thì có `appendonly yes` và `noeviction` | `docker-compose.prod.yml` (service `redis`) so với `docker-compose.yml` |
| R06 | Cao | Deploy | Grafana production hard-code `admin`/`admin`, vi phạm quy tắc không hard-code credentials | `docker-compose.prod.yml` (service `grafana`) |
| R07 | Cao | Deploy | Ứng dụng dùng chính root credentials của MinIO (`S3_ACCESS_KEY` = `MINIO_ROOT_USER`), nên ai chiếm được app có toàn quyền trên object storage | `docker-compose.prod.yml` (`minio`, `backend`) |
| R08 | Cao | Deploy | Image chỉ có tag `latest` nên không rollback được; migration chạy trên production mà không backup trước; Trivy đặt `exit-code: '0'` nên không bao giờ chặn build | `deploy.yml` (`build-and-push-backend`, `deploy-to-vps`, `trivy-fs-scan`) |
| R09 | Trung bình | Validation | Tên, username, email không giới hạn độ dài; tên toàn khoảng trắng hợp lệ; ngày sinh tương lai hợp lệ; username không có pattern (F04 vẫn mở) | `src/modules/auth/dto/auth.dto.ts`, `src/modules/users/dto/user.dto.ts` |
| R10 | Trung bình | Validation | Mật khẩu toàn khoảng trắng được chấp nhận ở đăng ký và đổi mật khẩu, trong khi seed admin thì chặn (F03 vẫn mở) | `auth.dto.ts` `RegisterDto.password`, `change-password.dto.ts` |
| R11 | Trung bình | Tài khoản | Đổi email qua `PUT /users` không cần mật khẩu hiện tại, không xác minh email mới, không thu hồi phiên; email lại dùng để đăng nhập và để khớp lời mời tổ chức | `users.controller.ts` `update`, `users.service.ts` `update` |
| R12 | Trung bình | Tài khoản | Chưa có xác minh email khi đăng ký và chưa có quên mật khẩu, nên có thể đăng ký trước email của người khác | `AUTH_FOLLOW_UP.md` mục "Features not yet implemented" |
| R13 | Trung bình | Lỗi HTTP | Hết số lần retry serializable (P2034 hoặc 40001/40P01) rơi vào nhánh mặc định và trả 500 thay vì 503/409 có `Retry-After` | `src/common/filters/prisma-exception.filter.ts` (nhánh `default`), `prisma.service.ts` `serializableTransaction` |
| R14 | Trung bình | Dữ liệu | Không có job dọn refresh token đã hết hạn hoặc bị thu hồi (F13 vẫn mở) | Không có `refreshToken.deleteMany` nào trong `src/` |
| R15 | Trung bình | Dữ liệu | Email/username của tài khoản đã xoá mềm vẫn bị giữ unique vĩnh viễn; chưa có chính sách khôi phục hay tái sử dụng | `prisma/schema.prisma` `User.email @unique` |
| R16 | Trung bình | Môi trường | Phiên bản PostgreSQL lệch nhau: local 17, CI và production 15 | `docker-compose.yml`, `docker-compose.prod.yml`, `deploy.yml`, `k6.yml` |
| R17 | Trung bình | Deploy | `backend` chỉ chờ `postgres`/`redis` ở trạng thái `service_started`, không có healthcheck | `docker-compose.prod.yml` |
| R18 | Thấp | Lỗi HTTP | Lỗi trùng unique trả tên cột (`Unique constraint failed on: email`) | `prisma-exception.filter.ts` nhánh `P2002` |
| R19 | Thấp | Dọn dẹp | `ServeStaticModule` phục vụ thư mục `uploads` không còn tồn tại (avatar đã chuyển sang S3); route tĩnh này cũng không đi qua guard | `src/app.module.ts:42-45` |
| R20 | Thấp | Vòng đời | Pool `pg` tạo bên ngoài có thể không được đóng khi shutdown, vì `onModuleDestroy` chỉ gọi `$disconnect()` (F18, cần xác minh) | `src/core/database/prisma.service.ts` |
| R21 | Thấp | Tài liệu | AGENTS.md lệch với code: seed admin thật cấp thêm `ORGANIZATION read/update`; module `organizations/admin` không được mô tả; sơ đồ layout chỉ liệt kê auth và users | `prisma/seeds/admin.seed.ts:58-65`, `src/modules/organizations/admin/` |
| R22 | Thấp | Tài liệu | `RBAC_FOLLOW_UP.md`, `AUTH_FOLLOW_UP.md`, `BACKEND_AUDIT.md` đã cũ: nhiều mục "resume here" đã làm xong, vài phát hiện đã sửa (F06 adapter-pg đã nằm trong `dependencies`, F16 đã có `helmet`) | các file ở thư mục gốc |

**Chuyển sang plan logging** (không xử lý ở đây): schema `authorization.denied`
chỉ chấp nhận `USER:read`, `USER:delete`, `ORGANIZATION:delete`, nên các lần bị
từ chối ở `ORGANIZATION:read/update` (admin organizations) và `AUDIT_LOG:read`
bị loại khỏi security log (`authorization-denied-event.schema.ts:8-12`).

---

## 2. Kế hoạch theo giai đoạn

Thứ tự đề xuất: 1 → 2 → 3 → 4 → 5, sau đó 6 và 7 (cần quyết định trước),
giai đoạn 8 làm kèm mỗi PR và chốt lại ở cuối.

### Giai đoạn 1. CI và độ phủ test (R04, R08 phần Trivy, R16)

- **Vấn đề:** ba bộ e2e không chạy trong CI; Trivy không bao giờ chặn build;
  test chạy trên PostgreSQL khác phiên bản với local.
- **Giải pháp:**
  - Thêm `RUN_AUTH_E2E_TESTS`, `RUN_USERS_E2E_TESTS`, `RUN_AUDIT_E2E_TESTS` vào
    job `ci`.
  - Thêm test kiểm tra mọi cờ `RUN_*_E2E_TESTS` dùng trong `test/` đều có trong
    workflow, để lần sau không bị sót.
  - Đổi Trivy sang `exit-code: '1'` cho `HIGH,CRITICAL`, kèm `.trivyignore`
    có lý do cho từng ngoại lệ.
  - Thống nhất một phiên bản PostgreSQL cho local, CI, k6 và production.
- **Xác nhận:**
  - CI chạy và báo số test của ba bộ e2e (không còn bị skip).
  - Một lỗ hổng HIGH giả lập làm CI fail.
- **Cần quyết định:** chọn PostgreSQL 15 hay 17. Nâng production lên 17 cần
  `pg_dump`/`pg_upgrade` và có backup.

### Giai đoạn 2. Sửa luồng đăng nhập (R01, R02, R03)

- **Vấn đề:** lộ email qua thời gian phản hồi, có thể cấp phiên sau khi đổi mật
  khẩu, body login không được validate.
- **Giải pháp:**
  - R03: validate body bằng `LoginDto` trước khi strategy chạy (một guard hoặc
    validate tường minh trong `LocalStrategy` bằng `class-validator`), trả 422
    giống các route khác. Giới hạn độ dài email và mật khẩu đầu vào.
  - R01: khi không tìm thấy email vẫn chạy `bcrypt.compare` với một hash giả
    tạo sẵn lúc khởi động, để hai nhánh tốn thời gian tương đương.
  - R02: trong transaction login, đọc lại `hashedPassword` và chỉ cấp refresh
    token nếu nó vẫn bằng hash đã dùng để xác thực; nếu khác thì 401.
- **Xác nhận:**
  - Unit: email không phải chuỗi → 422, không còn 500; nhánh email không tồn
    tại có gọi `compare`.
  - Database integration: giả lập đổi mật khẩu xen giữa xác thực và tạo phiên,
    login phải bị từ chối và không có refresh token mới.
  - E2E (`RUN_AUTH_E2E_TESTS=true`): body sai kiểu trả 422.
  - Đo thủ công chênh lệch thời gian phản hồi giữa email tồn tại và không tồn
    tại (chỉ để tham khảo, không đưa vào CI).

### Giai đoạn 3. Validation dữ liệu tài khoản (R09, R10)

- **Vấn đề:** dữ liệu hồ sơ không giới hạn và cho phép giá trị vô nghĩa; mật
  khẩu toàn khoảng trắng.
- **Giải pháp:**
  - Gom quy tắc vào một chỗ dùng chung cho `RegisterDto`, `CreateUserDto`,
    `UpdateUserDto`:
    - Tên: trim, 1–100 ký tự, không toàn khoảng trắng.
    - Username: pattern rõ ràng (ví dụ `^[a-z0-9_.]{3,32}$`).
    - Email: tối đa 254 ký tự.
    - Ngày sinh: không ở tương lai, không quá 150 năm trước.
  - Mật khẩu: yêu cầu ít nhất một ký tự không phải khoảng trắng, giống seed
    admin; áp dụng cho cả `RegisterDto` và `ChangePasswordDto`.
  - Tuỳ chọn: thêm `CHECK` ở database cho độ dài, sau khi kiểm tra dữ liệu cũ.
- **Xác nhận:**
  - Unit cho từng quy tắc, cả giá trị biên.
  - E2E: đăng ký với dữ liệu sai trả 422.
  - Nếu thêm `CHECK`: database integration chạy migration trên schema tạm có
    dữ liệu mẫu hợp lệ và không hợp lệ.
- **Cần quyết định:** pattern username và giới hạn độ dài cụ thể; dữ liệu hiện
  có vi phạm quy tắc mới thì xử lý thế nào.

### Giai đoạn 4. Ánh xạ lỗi HTTP (R13, R18)

- **Vấn đề:** xung đột transaction sau khi hết retry trả 500; lỗi unique lộ tên
  cột.
- **Giải pháp:**
  - Khi `serializableTransaction` hết lượt retry, ném lỗi riêng; filter ánh xạ
    sang 503 kèm `Retry-After`.
  - Thông báo P2002 dùng câu chung (ví dụ "Resource already exists"); service
    nào cần thông báo cụ thể (slug, email) thì tự ném `ConflictException`.
- **Xác nhận:**
  - Unit cho filter và cho helper retry (P2034 và DriverAdapterError 40001).
  - Database integration: ép xung đột liên tục, phản hồi là 503 chứ không phải
    500.
- **Lưu ý:** kiểm tra lại test hiện có đang mong đợi đúng thông báo P2002 cũ.

### Giai đoạn 5. Cứng hoá triển khai production (R05, R06, R07, R08, R17, R19)

- **Vấn đề:** Redis không bền và không có mật khẩu; Grafana mật khẩu mặc định;
  app dùng root MinIO; không rollback và không backup trước migration; route
  tĩnh thừa.
- **Giải pháp:**
  - Redis: `requirepass` lấy từ env, `appendonly yes`,
    `maxmemory-policy noeviction`, `maxmemory` nhỏ hơn giới hạn container.
  - Grafana: lấy `GF_SECURITY_ADMIN_USER/PASSWORD` từ `.env`, có kiểm tra bắt
    buộc như các biến khác.
  - MinIO: `minio-init` tạo user riêng cho app với policy chỉ đọc/ghi/xoá trên
    bucket `avatars`; app dùng user đó thay cho root.
  - Image: gắn thêm tag theo commit SHA; compose production dùng tag cố định;
    ghi lại cách rollback về tag trước.
  - Trước `prisma migrate deploy`: chạy `pg_dump` ra file có ngày giờ và chỉ
    tiếp tục khi dump thành công.
  - Healthcheck cho `postgres` (`pg_isready`) và `redis` (`redis-cli ping`);
    `backend` chờ `service_healthy`.
  - Xoá `ServeStaticModule` và dependency `@nestjs/serve-static` nếu không còn
    chỗ nào dùng.
- **Xác nhận:**
  - Chạy compose production trên máy local hoặc VM thử: restart Redis giữa lúc
    có job thì job không mất; Redis từ chối kết nối không có mật khẩu.
  - App upload/xoá avatar được bằng user mới; user đó không tạo/xoá được bucket.
  - Thử rollback sang tag SHA trước đó.
  - `GET /static/...` trả 404 sau khi xoá module.
  - Unit/database/e2e: không áp dụng cho phần hạ tầng; vẫn chạy toàn bộ test
    hiện có sau khi xoá `ServeStaticModule`.
- **Cần quyết định:** nơi lưu file backup và thời hạn giữ; có cần reverse proxy
  và TLS trong repo hay để ngoài.

### Giai đoạn 6. Vòng đời dữ liệu (R14, R15, R20)

- **Vấn đề:** refresh token tích luỹ mãi; email/username của tài khoản đã xoá
  bị khoá vĩnh viễn; pool có thể không được đóng.
- **Giải pháp:**
  - Job định kỳ xoá refresh token đã hết hạn hoặc đã thu hồi quá N ngày, xoá
    theo lô nhỏ. Lưu ý phát hiện tái sử dụng token cần giữ token đã thu hồi
    đến hết hạn của cả họ token.
  - Chọn một chính sách cho tài khoản đã xoá: giữ nguyên (ghi rõ trong README),
    hoặc giải phóng email/username sau một thời gian bằng cách thay giá trị.
  - Xác minh `$disconnect()` có đóng pool ngoài không; nếu không, gọi
    `pool.end()` sau `$disconnect()`.
- **Xác nhận:**
  - Database integration: job chỉ xoá đúng dòng hết hạn hoặc thu hồi quá hạn;
    token còn hiệu lực và logic phát hiện tái sử dụng vẫn đúng.
  - Unit cho `onModuleDestroy` kiểm tra pool được đóng.
- **Cần quyết định:** thời hạn giữ refresh token; chính sách tái sử dụng email.

### Giai đoạn 7. Tính năng tài khoản còn thiếu (R11, R12)

- **Vấn đề:** đổi email không cần xác thực lại; chưa có xác minh email và quên
  mật khẩu.
- **Giải pháp** (dùng lại hàng đợi email và SMTP của invitation):
  - Đổi email: yêu cầu mật khẩu hiện tại, gửi xác nhận tới email mới, chỉ đổi
    sau khi xác nhận; thông báo tới email cũ; thu hồi các phiên khác.
  - Xác minh email khi đăng ký: thêm `emailVerifiedAt`; quyết định tính năng
    nào bị chặn khi chưa xác minh (ví dụ chấp nhận lời mời).
  - Quên mật khẩu: token một lần, hết hạn ngắn, chỉ lưu hash; phản hồi giống
    nhau dù email có tồn tại hay không; thu hồi mọi phiên sau khi đặt lại.
  - Mỗi luồng có audit event riêng (phối hợp với plan logging).
- **Xác nhận:** đủ ba lớp test cho từng luồng; e2e chỉ dùng request không tạo
  dữ liệu ứng dụng thật, theo quy ước hiện có.
- **Cần quyết định:** sản phẩm có cần các luồng này không, làm theo thứ tự nào.

### Giai đoạn 8. Đồng bộ tài liệu (R21, R22)

- **Vấn đề:** AGENTS.md và các file follow-up không còn khớp với code.
- **Giải pháp:**
  - AGENTS.md: sửa danh sách quyền của seed admin; thêm mô tả module
    `organizations/admin` (routes, quyền, audit `organization.status.changed`);
    cập nhật sơ đồ layout cho đủ các module.
  - Cập nhật hoặc lưu trữ `RBAC_FOLLOW_UP.md`, `AUTH_FOLLOW_UP.md`,
    `BACKEND_AUDIT.md`: đánh dấu mục đã xong, chuyển mục còn mở về plan này.
- **Xác nhận:** mọi đường dẫn file được nhắc trong AGENTS.md và README.md đều
  tồn tại; không còn mục "resume here" đã hoàn thành.

---

## 3. Quyết định cần bạn chốt trước khi code

1. Giai đoạn 1: phiên bản PostgreSQL chung (15 hay 17).
2. Giai đoạn 3: pattern username, giới hạn độ dài, cách xử lý dữ liệu cũ vi
   phạm.
3. Giai đoạn 5: nơi lưu backup trước migration; reverse proxy và TLS nằm trong
   repo hay ngoài.
4. Giai đoạn 6: thời hạn giữ refresh token; chính sách email của tài khoản đã
   xoá.
5. Giai đoạn 7: có làm xác minh email, quên mật khẩu, đổi email an toàn không.

## 4. Chưa kiểm chứng

- Kết luận dựa trên đọc code và cấu hình; chưa chạy test, chưa gửi request thử.
- R03 (email không phải chuỗi → 500) và R20 (pool không đóng) dựa trên đọc
  code và BACKEND_AUDIT.md; cần tái lập lại trước khi sửa.
- R01 là phân tích luồng code; chưa đo thời gian phản hồi thực tế.
- Chưa kiểm tra cấu hình trên VPS (firewall, reverse proxy, TLS, backup ngoài
  repo).
