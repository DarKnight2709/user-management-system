# Hạ tầng, CI/CD và triển khai

Tài liệu này mô tả project chạy ở đâu, code đi từ `git push` đến VPS như thế nào, và cách vận hành.
Nó được viết dựa trên các file trong repo tại thời điểm 2026-11-12 (sau loạt sửa từ giai đoạn 1 đến 5b
của `plans/backend-review-fixes/plan.md`). Những gì **không nằm trong repo** và tôi không thể xác nhận
được ghi rõ ở mục 11.

Mọi lệnh ở mục 9 chưa được chạy thử trên VPS thật; hãy kiểm tra trước khi dùng khi có sự cố.

## 1. Bức tranh tổng thể

```text
Developer ── push / pull request ──▶ GitHub
                                      │
                          GitHub Actions (.github/workflows/)
                          ├─ deploy.yml  : kiểm tra → build image → deploy
                          ├─ k6.yml      : thử tải (hằng tuần / thủ công)
                          └─ dast-zap.yml: quét bảo mật động (hằng tuần / thủ công)
                                      │ (chỉ khi push vào main)
                       build ──▶ GHCR: ums-backend:latest và :<commit sha>
                                      │
                       scp + ssh ──▶ VPS, thư mục ~/app
                                      │   bash scripts/deploy.sh <commit sha>
                                      ▼
        Docker Compose (docker-compose.prod.yml), mạng nội bộ "ums-net"
        ┌─────────┬───────┬────────────────┬─────────┬───────┬───────┬─────────┐
        │postgres │ redis │ minio+minio-init│ backend │ loki  │ alloy │ grafana │
        └─────────┴───────┴────────────────┴─────────┴───────┴───────┴─────────┘
```

Ba môi trường:

| Môi trường | Cấu hình | Dùng để |
| :--- | :--- | :--- |
| Local | `docker-compose.yml` + `.env` | Phát triển (`NODE_ENV=development`, có Swagger) |
| CI | `.github/workflows/*.yml` | Kiểm tra tự động trên database và Redis dùng một lần |
| Production | `docker-compose.prod.yml` + `scripts/deploy.sh` | Chạy thật trên một VPS |

Không có môi trường staging.

## 2. Pipeline CI/CD (`.github/workflows/deploy.yml`)

Chạy khi mở/cập nhật pull request vào `main` và khi push vào `main`.

```text
ci ─────────────┐
secret-scan ────┤
trivy-fs-scan ──┼─▶ build-and-push-backend ─▶ deploy-to-vps     (hai job sau chỉ chạy khi push vào main)
semgrep ────────┘
```

| Job | Làm gì | Chặn merge/deploy khi lỗi? |
| :--- | :--- | :--- |
| `ci` | Postgres 15 + Redis 7 dùng một lần; `npm ci`, `prisma generate`, lint, build, unit test, integration test (`RUN_DATABASE_TESTS=true`), **áp migration**, rồi e2e (mọi cờ `RUN_*_E2E_TESTS` đều bật) | Có |
| `secret-scan` | Gitleaks quét toàn bộ lịch sử git | Có |
| `trivy-fs-scan` | Quét thư viện và cấu hình, mức HIGH/CRITICAL, `exit-code: 1` | Có (đây là cổng đã chặn một lần vì 4 lỗ hổng DoS) |
| `semgrep` | SAST với bộ luật `p/typescript` | Có |
| `build-and-push-backend` | Build image để quét, Trivy image scan, rồi push `latest` và `<sha>` lên GHCR | Quét image **không** chặn (`exit-code: 0`) |
| `deploy-to-vps` | Tạo `.env` từ secret, copy file lên VPS, chạy `scripts/deploy.sh` | — |

Điểm cần nhớ:
- Test e2e chỉ chạy khi có migration trước, vì một số request (ví dụ login) chạm bảng `users` kể cả khi bị từ chối. Test tự kiểm tra (`test/ci-e2e-flags.spec.ts`) cho đảm bảo mọi cờ e2e mới đều được bật trong workflow này.
- Test integration dùng schema tạm riêng, còn e2e dùng database `ums_test` của job.
- Pull request chỉ chạy kiểm tra, **không** build image hay deploy.

Hai workflow phụ (không chạm môi trường thật, đều dựng image trong runner với database dùng một lần):
- `k6.yml`: thử tải bằng k6 (script trong `performance/`), 03:00 UTC thứ Hai hằng tuần hoặc chạy tay (chọn smoke/load/stress/login/writes). Số liệu chỉ so sánh được giữa các lần chạy workflow này, không phản ánh năng lực của VPS.
- `dast-zap.yml`: quét bị động bằng OWASP ZAP, 02:00 UTC thứ Hai hoặc chạy tay. `fail_action: false`, tức là chỉ báo cáo.

### GitHub secrets đang được dùng

| Secret | Dùng ở | Ý nghĩa |
| :--- | :--- | :--- |
| `ENV_PRODUCTION` | `deploy-to-vps` | Toàn bộ nội dung file `.env` của production (xem mục 7) |
| `EC2_HOST`, `EC2_USERNAME`, `EC2_SSH_KEY` | scp và ssh | Địa chỉ, tài khoản và khoá SSH của VPS |
| `GH_PAT` | đăng nhập GHCR | Token để push image (CI) và pull image (VPS) |
| `GITHUB_TOKEN` | Gitleaks | Do GitHub cấp tự động |

## 3. Điều gì xảy ra khi merge vào `main`

1. Các job kiểm tra chạy; nếu xanh thì `build-and-push-backend` build image từ `Dockerfile` và push hai tag (`latest` và `<commit sha>`).
2. `deploy-to-vps` ghi secret `ENV_PRODUCTION` thành `.env` trên runner rồi **copy lên VPS** vào `~/app`: `docker-compose.prod.yml`, `.env`, `scripts/deploy.sh`, hai file policy MinIO, cấu hình Alloy, Loki và Grafana.
3. Nó SSH vào VPS, đăng nhập GHCR rồi chạy `bash scripts/deploy.sh <sha>`. Script làm theo thứ tự:

| Bước | Hàm trong `deploy.sh` | Nếu lỗi thì |
| :--- | :--- | :--- |
| Pull image `backend loki alloy grafana` theo tag | `compose pull` | Dừng, chưa đổi gì |
| Dựng Postgres, `pg_dump` ra `~/backups/ums-<giờ UTC>-before-<tag>.dump`, kiểm tra đọc lại được bằng `pg_restore --list`, giữ 7 bản mới nhất | `backup_database`, `prune_old_backups` | Dừng, chưa đổi gì |
| `prisma migrate deploy` rồi seed danh mục quyền tổ chức, trong container tạm của image mới | `compose run --rm backend ...` | Dừng; bản đang chạy giữ nguyên (mỗi migration chạy trong một transaction của Postgres) |
| `up -d --remove-orphans` | `compose up` | — |
| Chờ healthcheck của `ums-backend` (tối đa 30 lần, mỗi lần 5 giây) | `wait_for_backend` | Chạy lại image trước (xem dưới), job vẫn báo **fail** |
| Ghi tag vào `~/app/.deployed-tag`, đặt lại mật khẩu Grafana, dọn image backend cũ (giữ bản hiện tại, bản trước và `latest`) | `sync_grafana_admin_password`, `prune_old_backend_images` | Chỉ cảnh báo |

**Rollback tự động chỉ đổi image, không hoàn tác migration.** Vì vậy mọi migration phải tương thích với bản trước (thêm cột/bảng trước, xoá sau). Lần deploy đầu tiên sau khi có script không có bản trước để quay lại, vì `.deployed-tag` chưa tồn tại. Khôi phục database từ backup luôn là quyết định thủ công.

Nhiều lần deploy chồng nhau không được bảo vệ: workflow không có `concurrency`, nên hai lần push sát nhau có thể chạy hai script cùng lúc trên VPS.

## 4. Image backend (`Dockerfile`)

- Hai giai đoạn trên `node:24-bookworm-slim`: giai đoạn build chạy `npm ci`, `prisma generate`, `npm run build`; giai đoạn chạy cài dependency production (`npm ci --omit=dev`), chạy bằng user `node` (không phải root) với `NODE_ENV=production`.
- Image còn chứa `prisma/`, `prisma7.config.ts`, client Prisma đã sinh và `src/common` (các seed dùng chung). Đó là lý do `docker compose run backend npx prisma migrate deploy` chạy được bên trong image.
- `HEALTHCHECK` gọi `/health/ready` (kiểm tra PostgreSQL) mỗi 30 giây, sau 40 giây khởi động. Script deploy dựa vào trạng thái này.
- Prisma 7 tự nhận `prisma7.config.ts` (đã kiểm chứng cục bộ), nên không cần cờ `--config` ở máy chủ.

## 5. Các service trên VPS (`docker-compose.prod.yml`)

Mọi cổng đều chỉ bind `127.0.0.1`: không service nào tự mở ra Internet. Cách người dùng truy cập từ ngoài được nói ở mục 11.

| Service | Image | Cổng (localhost) | Dữ liệu | Giới hạn | Ghi chú |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `postgres` | `postgres:15-alpine` | 5432 | volume `pgdata` | 1 CPU, 512M | Healthcheck `pg_isready` |
| `redis` | `redis:7-alpine` | 6379 | volume `redisdata` | 0.5 CPU, 128M | AOF bật, `maxmemory 96mb`, `noeviction`, có mật khẩu, healthcheck |
| `minio` | `ghcr.io/darknight2709/ums-minio:RELEASE.2025-04-22...` | 9000, 9001 (console) | volume `miniodata` | 0.5 CPU, 1G | Tài khoản root chỉ để quản trị |
| `minio-init` | cùng image | — | — | — | Chạy một lần rồi thoát (xem dưới) |
| `backend` | `ghcr.io/darknight2709/ums-backend:${BACKEND_IMAGE_TAG:-latest}` | 3000 | — | 1 CPU, 512M | Chờ postgres và redis healthy, minio-init hoàn tất |
| `loki` | `grafana/loki:3.4.2` | — | volume `loki_data` | — | Lưu log, giữ 7 ngày |
| `alloy` | `grafana/alloy:v1.7.1` | — | volume `alloy_data` | — | Thu log từ Docker (mount `docker.sock`) |
| `grafana` | `grafana/grafana:11.5.2` | 3001 | volume `grafana_data` | — | Giao diện xem log |

Mọi service dùng log driver `local` (tối đa 20 MB × 5 file mỗi container) và `restart: always`.

**`minio-init`** làm bốn việc mỗi lần chạy: từ chối nếu `S3_ACCESS_KEY` trùng `MINIO_ROOT_USER`; tạo bucket `avatars`; áp bucket policy công khai đọc (`docker/minio/avatars-policy.json`); tạo user ứng dụng với policy `avatars-app` chỉ cho `PutObject` và `DeleteObject` trên `avatars/*` (`docker/minio/avatars-app-policy.json`). Image `ums-minio` dùng `pull_policy: never`, tức phải có sẵn trên VPS; nó không được build trong repo này.

## 6. Dữ liệu và việc lưu trữ

| Dữ liệu | Nằm ở | Bền vững thế nào |
| :--- | :--- | :--- |
| Dữ liệu nghiệp vụ, bảng audit (`audit_events`) | Postgres, volume `pgdata` | Backup `pg_dump` trước mỗi lần deploy, 7 bản gần nhất trong `~/backups` (cùng ổ đĩa với database) |
| Hàng đợi job (email mời) | Redis, volume `redisdata` | AOF; đầy bộ nhớ thì từ chối ghi chứ không bị kill |
| Ảnh đại diện | MinIO, volume `miniodata` | Không có backup. Đọc công khai, ghi qua tài khoản app |
| Log ứng dụng | Loki, volume `loki_data` | Cấu hình giữ 7 ngày; việc xoá thật sự chưa được quan sát (`docs/logging/logging-rollout.md`) |
| Cấu hình Grafana | volume `grafana_data` | Datasource Loki được nạp từ `grafana/provisioning/` |

Bản ghi audit gốc luôn nằm trong Postgres; bản sao đi qua log chỉ là phụ.

## 7. Cấu hình và secret production

`.env` trên VPS được **tạo lại từ secret `ENV_PRODUCTION` mỗi lần deploy**. Sửa tay file trên VPS sẽ bị ghi đè; muốn đổi giá trị phải sửa secret rồi deploy lại.

Compose từ chối khởi động nếu thiếu các biến bắt buộc dưới đây (`:?` trong file compose):

| Biến | Dùng bởi | Ghi chú |
| :--- | :--- | :--- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | postgres | Chỉ có tác dụng ở lần khởi tạo database đầu tiên |
| `DATABASE_URL` | backend | Trỏ tới service `postgres` |
| `REDIS_PASSWORD` | redis, backend | Mật khẩu Redis |
| `GRAFANA_ADMIN_PASSWORD` | grafana, `deploy.sh` | User luôn là `admin`; mật khẩu được đặt lại mỗi lần deploy vì Grafana chỉ đọc biến này khi tạo database lần đầu |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | minio, minio-init | Tài khoản quản trị MinIO |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | minio-init, backend | Tài khoản riêng của ứng dụng; phải khác `MINIO_ROOT_USER` |

Các biến còn lại do ứng dụng bắt buộc khi khởi động (`src/core/config/env.validation.ts`): hai JWT secret (khác nhau, tối thiểu 64 ký tự), `INVITATION_TOKEN_SECRET`, `ACCOUNT_TOKEN_SECRET` (signs password reset links), `FRONTEND_URL`, `REDIS_HOST`, `SMTP_HOST`, `SMTP_FROM`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_PUBLIC_URL`. `NODE_ENV=production` phải được đặt rõ ràng, vì mặc định là development.

Khi tạo giá trị mới, dùng chuỗi hex hoặc chữ-số, tránh `$`, `#`, dấu nháy và khoảng trắng vì compose nội suy `.env`.

## 8. Quan sát (log)

```text
backend ──JSON ra stdout──▶ Docker (log driver local) ──▶ Alloy ──▶ Loki ──▶ Grafana
```

- Alloy chỉ thu container có nhãn `com.ums.logs=true` (hiện là `backend`), làm mới danh sách mỗi 10 giây.
- Truy cập Grafana và console MinIO qua đường hầm SSH (mục 9), không có đường công khai.
- Lỗi của chính pipeline log và việc giám sát/cảnh báo nằm ngoài tài liệu này; xem `plans/audit-logging-hardening/plan.md`.

## 9. Việc vận hành thường gặp

Chạy trong `~/app` trên VPS. Viết tắt `dc` = `docker compose -f docker-compose.prod.yml`.

| Việc | Cách làm |
| :--- | :--- |
| Xem trạng thái | `dc ps` |
| Xem log backend | `dc logs --tail 100 backend` |
| Biết VPS đang chạy commit nào | `cat .deployed-tag` |
| Deploy lại không đổi code | GitHub → Actions → chạy lại workflow trên commit mới nhất |
| Thêm hoặc đổi biến môi trường | Sửa secret `ENV_PRODUCTION`, rồi deploy lại |
| Mở Grafana hoặc MinIO console | `ssh -L 3001:127.0.0.1:3001 -L 9001:127.0.0.1:9001 <user>@<vps>` rồi vào `http://localhost:3001` / `:9001` |
| Quay lại một bản cũ bằng tay | `BACKEND_IMAGE_TAG=<sha> dc up -d backend`, sau đó `echo <sha> > .deployed-tag` |
| Xem các bản backup | `ls -lt ~/backups` |
| Khôi phục database (**chưa thử**) | `dc stop backend`, rồi `dc exec -T postgres sh -c 'pg_restore --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < ~/backups/<file>.dump`, rồi `dc start backend` |

Quy tắc khi viết migration mới: phải chạy được với **cả bản hiện tại lẫn bản trước** của ứng dụng (thêm trước, bỏ sau), vì rollback không hoàn tác migration.

## 10. Lịch sử thay đổi liên quan (loạt rà soát tháng 11/2026)

| PR / giai đoạn | Thay đổi về CI/CD hoặc hạ tầng |
| :--- | :--- |
| Giai đoạn 1 (`chore/ci-e2e-flags`, #57) | Bật e2e auth, users, audit trong CI; thêm bước áp migration trước e2e (nếu không, login trả 500 vì thiếu bảng); Trivy fs chặn ở HIGH/CRITICAL; test kiểm tra cờ e2e; nâng body-parser, joi, multer, source-map-js để qua cổng Trivy |
| Giai đoạn 2–4 (#58, #59, #60) | Sửa code ứng dụng (login, validation, lỗi HTTP), không đổi hạ tầng; riêng giai đoạn 4 thêm 503 + `Retry-After` khi xung đột transaction |
| Giai đoạn 5a (`chore/deploy-hardening`, #61) | `scripts/deploy.sh` (backup, tag theo SHA, rollback image), Redis AOF + giới hạn bộ nhớ, healthcheck postgres/redis, gỡ `ServeStaticModule` |
| Giai đoạn 5b (`chore/prod-credentials-hardening`) | Mật khẩu Redis, mật khẩu Grafana từ biến môi trường, tài khoản MinIO riêng cho ứng dụng |
| Giai đoạn 6 (`fix/data-lifecycle-cleanup`) | Job dọn refresh token hết hạn, đóng pool database khi shutdown |
| Giai đoạn 7a (`feat/password-forget`) | Quên và đặt lại mật khẩu: bảng `user_security_tokens`, queue BullMQ thứ hai `account-email`, biến môi trường mới `ACCOUNT_TOKEN_SECRET` (bắt buộc, thêm vào `ENV_PRODUCTION` trước khi merge) |

## 11. Điều tôi không biết hoặc chưa kiểm chứng

**Không nằm trong repo, không thể xác nhận:**
- **Reverse proxy:** không service nào mở cổng ra ngoài, nhưng `S3_PUBLIC_URL` và `FRONTEND_URL` trỏ tới `http://<ip-vps>` (cổng 80, đường `/storage`). Nghĩa là có một thứ khác trên VPS (Nginx hoặc tương tự) đang chuyển tiếp. Cấu hình của nó chưa nằm trong repo.
- **TLS:** các URL trên là `http`, chưa có HTTPS.
- Hệ điều hành và nhà cung cấp VPS (tên secret `EC2_*` gợi ý AWS nhưng tôi không biết chắc), firewall/security group, phiên bản Docker và Compose (script cần Compose v2.1.1+ vì dùng `up --wait`).
- Cách build và vị trí của image `ums-minio`, quy tắc bảo vệ nhánh `main` trên GitHub, việc có giám sát/cảnh báo nào bên ngoài hay không.

**Đã viết nhưng chưa chạy thật:** toàn bộ `scripts/deploy.sh`, rollback, backup/restore, `minio-init` (các lệnh `mc admin` phụ thuộc phiên bản `mc` trong image), việc đặt lại mật khẩu Grafana, Redis với AOF/mật khẩu.

## 12. Các điểm yếu còn mở

| Vấn đề | Chi tiết |
| :--- | :--- |
| **Backend nhận toàn bộ `.env`** | `backend` dùng `env_file: .env`, nên container ứng dụng có cả `MINIO_ROOT_PASSWORD`, `GRAFANA_ADMIN_PASSWORD`, `SEED_ADMIN_PASSWORD`... trong biến môi trường. Điều này làm giảm lợi ích của việc tách tài khoản MinIO. Hướng sửa: liệt kê biến cần thiết trong `environment:` hoặc tách file env |
| Backup cùng ổ đĩa | `~/backups` nằm cùng VPS với database; mất ổ là mất cả hai. Chưa có bản sao ra ngoài |
| Một instance, chưa scale ngang | Throttler lưu trong RAM, worker BullMQ chạy chung process với API |
| Không có staging | Mọi thay đổi vào `main` đi thẳng production |
| Phiên bản Postgres lệch | Local dùng 17, CI và production dùng 15; đổi production cần dump/restore sang volume mới |
| Quét image không chặn | Trivy image scan có `exit-code: 0` |
| `docker.sock` cho Alloy | Mount chỉ đọc vẫn gọi được toàn bộ Docker API, tương đương quyền root trên host |
| Không có `concurrency` trong workflow | Hai lần deploy chồng nhau có thể chạy song song |
| Mật khẩu Postgres yếu | `POSTGRES_PASSWORD` hiện rất yếu; đổi biến không đổi mật khẩu của database đã tồn tại, cần `ALTER USER` và cập nhật `DATABASE_URL` |
| Rollback không hoàn tác cấu hình | Rollback chỉ đổi image backend; compose luôn là bản mới nhất |
