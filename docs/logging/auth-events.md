# Authentication event catalog

## Quy tắc chung

- Category: security.
- Schema version: 1.
- Event ID và request ID do server tạo/kiểm soát.
- Thời gian dùng UTC.
- Không lưu password, password hash, token, OTP,
  Authorization, Cookie, Set-Cookie hoặc raw request/response body.
- IP chỉ lấy từ kết nối hoặc proxy đã được tin cậy.
- Dữ liệu phải được chuẩn hóa, lọc secrets và giới hạn kích thước.
- Các request bị rate limiter chặn thuộc event auth.login.throttled.
- Lỗi hạ tầng thuộc application log hoặc auth.login.error,
  không ghi thành lỗi credential.
- Loki retention dự kiến: 7 ngày cho giai đoạn đầu.
  Đây là cấu hình triển khai, cần kiểm chứng việc xóa thực tế.

## auth.login.succeeded

### Ý nghĩa

Server đã hoàn tất xác thực và commit phiên đăng nhập.

Không khẳng định client đã nhận response.

### Trigger

- Credential hợp lệ.
- Tài khoản được phép đăng nhập.
- Phiên đăng nhập đã được lưu thành công.

### Dữ liệu

- actor: USER, ID lấy từ kết quả xác thực đáng tin cậy.
- outcome: SUCCESS.
- authMethod: PASSWORD.
- sessionRef: familyId của refresh token, dùng để liên kết các sự kiện trong cùng một phiên đăng nhập; giữ nguyên qua các lần rotation và không dùng để xác thực.
- requestContext: requestId; IP/User-Agent nếu policy cho phép.

### Chính sách

- Đích: Winston Console -> Docker -> Alloy -> Loki.
- Không lưu event riêng vào PostgreSQL.
- Xuất event sau khi transaction tạo phiên commit.
- Lỗi logging không hủy phiên đã commit.
- Producer: AuthService tại bước hoàn tất login.

## auth.login.failed

### Ý nghĩa

Một lần xác thực được xử lý và bị từ chối.

### Trigger

- Credential không hợp lệ; hoặc
- Tài khoản không được phép đăng nhập theo policy.

### Dữ liệu

- actor: ANONYMOUS, không gán userId chưa được xác thực.
- outcome: FAILURE.
- reasonCode: INVALID_CREDENTIALS hoặc ACCOUNT_UNAVAILABLE.
- loginIdentifierRef: HMAC có version của email đã chuẩn hóa,
  nếu cần liên kết các lần thử; không ghi email thô.
- requestContext: requestId; IP/User-Agent nếu policy cho phép.

### Chính sách

- Đích: Winston Console -> Docker -> Alloy -> Loki.
- Không lưu event riêng vào PostgreSQL.
- Lỗi logging không thay đổi kết quả từ chối đăng nhập.
- Không trả reason nội bộ hoặc tình trạng tồn tại tài khoản cho client.
- Producer: Một vị trí duy nhất sở hữu quyết định từ chối.
  Không ghi lặp tại strategy, guard và exception filter.

## auth.password.changed

### Ý nghĩa

Server đã commit việc đổi mật khẩu và thu hồi các refresh session hiện có.

Không khẳng định client đã nhận response.

### Trigger

- Mật khẩu hiện tại hợp lệ.
- Mật khẩu mới khác mật khẩu hiện tại.
- Transaction cập nhật mật khẩu và thu hồi refresh session đã commit.

### Dữ liệu

- actor: USER thực hiện đổi mật khẩu.
- outcome: SUCCESS.
- requestContext: requestId.
- Không ghi mật khẩu, password hash hoặc refresh token.

### Chính sách

- Đích: Winston Console -> Docker -> Alloy -> Loki.
- Không lưu event riêng vào PostgreSQL.
- Chỉ phát event sau khi transaction commit.
- Lỗi logging không đảo ngược việc đổi mật khẩu đã commit.
- Producer: AuthService sau transaction đổi mật khẩu.

## auth.refresh_token.reuse_detected

### Ý nghĩa

Một refresh token đã bị thu hồi được sử dụng lại; hệ thống đã thu hồi các token còn lại trong cùng family.

### Dữ liệu

- actor: ANONYMOUS, vì người gửi token đã bị từ chối xác thực.
- target: USER gắn với bản ghi refresh token đã xác minh.
- sessionRef: familyId, chỉ dùng liên kết log và không dùng để xác thực.
- requestContext: requestId; IP/User-Agent nếu policy cho phép.
- Không ghi raw refresh token.

### Chính sách

- Đích: Winston Console -> Docker -> Alloy -> Loki.
- Không lưu event riêng vào PostgreSQL.
- Ghi event sau khi transaction thu hồi token family đã commit.
- Logging failure không khôi phục token đã thu hồi hoặc thay đổi kết quả từ chối.
- Producer: AuthService sau transaction refresh-token reuse detection.

## auth.logout.completed

### Ý nghĩa

Server đã hoàn tất yêu cầu thu hồi refresh session.

### Dữ liệu

- actor: USER đã xác thực.
- scope: `SESSION_FAMILY` khi đăng xuất một phiên; `ALL_SESSIONS` khi đăng xuất mọi phiên.
- sessionRef: familyId nếu bản ghi phiên được tìm thấy; không dùng để xác thực.
- requestContext: requestId; IP/User-Agent nếu policy cho phép.
- Không ghi refresh token.

### Chính sách

- Đích: Winston Console -> Docker -> Alloy -> Loki.
- Không lưu event riêng vào PostgreSQL.
- Chỉ phát event sau khi transaction thu hồi token commit.
- Với logout một phiên không còn bản ghi, thao tác vẫn hoàn tất idempotently; sessionRef được bỏ qua.
- Logging failure không thay đổi kết quả logout.
- Producer: AuthService sau transaction logout/logout-all.

## auth.login.throttled

### Ý nghĩa

Login request bị chặn bởi rate limiter trước khi chạy xác thực bằng mật khẩu.

### Dữ liệu

- actor: ANONYMOUS.
- limitPolicy: `IP` hoặc `ACCOUNT`, chỉ cho biết counter policy nào đạt giới hạn.
- requestContext: requestId; IP/User-Agent nếu policy cho phép.
- Không ghi email, password hoặc tracker key.

### Chính sách

- Đích: Winston Console -> Docker -> Alloy -> Loki.
- Chỉ phát cho route login khi limiter từ chối request.
- Không lưu event riêng vào PostgreSQL.
- Producer: CustomThrottlerGuard trước khi trả HTTP 429.
