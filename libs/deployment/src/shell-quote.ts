/**
 * Hai hàm escaping cho `provisionScript` của các deploy unit (hiện dùng ở
 * `deploys/backoffice-deploy/index.ts`) — mỗi hàm giải một bài toán KHÁC, đặt
 * đúng biên của nó:
 *
 * - {@link shellQuote}: bảo vệ MỘT argument POSIX shell. Nó là lớp DUY NHẤT
 *   đứng giữa giá trị và trình thông dịch shell — giá trị đi qua đây phải bất
 *   biến với `$`, backtick, `"`, `\`... vì single quote tắt mọi mở rộng.
 * - {@link sqlQuote}: bảo vệ MỘT string literal SQL. Nó KHÔNG bảo vệ shell —
 *   caller phải tự đặt output của nó vào ngữ cảnh shell an toàn.
 *
 * Tách hai hàm thành module riêng để spec test được bằng POSIX shell thật
 * (`shell-quote.spec.ts`) mà không phải khởi động Pulumi: deploy unit chạy thẳng
 * `index.ts` qua runtime Pulumi, không có test harness nào ở `deploys/*`.
 */

/**
 * Quote một giá trị thành đúng MỘT argument của POSIX shell.
 *
 * Bọc trong single quote (tắt mọi mở rộng: `$`, backtick, `"`, `\`, glob...);
 * nháy đơn nhúng được thay bằng chuỗi đóng-escape-mở `'\''` — chuẩn POSIX
 * (POSIX.1-2017 §2.2.2: không có cơ chế escape nào BÊN TRONG single quote,
 * cách duy nhất là kết thúc literal, escape một nháy đơn, mở lại literal).
 *
 * `worktreeRoot` đến từ `--config namespace:worktreeRoot=` do người dùng gõ,
 * không phải giá trị kiểm soát — một path chứa `$`, backtick hay nháy đơn
 * phải là path thật, không phải mã shell được chạy.
 *
 * Dùng `replace` với regex global chứ không phải `replaceAll`: tsconfig của
 * deploy unit đặt `target: es2020`, thiếu `String.prototype.replaceAll`
 * (ES2021) — typecheck fail-loud đã bắt đúng điều đó.
 *
 * NUL byte là giới hạn của chính biên argv POSIX (mọi scheme quoting đều
 * không mang được NUL qua argument) — không phải hàm này cố xử lý; giá trị
 * chứa NUL không thể đến từ Pulumi config hợp lệ hay path của kernel.
 */
export const shellQuote = (value: string): string => `'${value.replace(/'/gu, `'\\''`)}'`;

/**
 * Escape một giá trị để đặt an toàn bên trong SQL literal nháy đơn.
 *
 * Trong chuỗi SQL, một dấu nháy đơn được escape thành hai dấu nháy đơn (chuẩn
 * SQL, đúng hành vi với `standard_conforming_strings = on` mặc định của
 * PostgreSQL — giả định này được giữ; không cấu hình nào trong repo tắt nó).
 * Mọi giá trị đi vào `ALTER ROLE ... PASSWORD '<giá trị>'` đều
 * phải qua hàm này: password do orchestration sinh (`base64url`, không chứa
 * nháy đơn) vẫn an toàn như cũ, nhưng đoạn nối chuỗi được miễn nhiễm với giá
 * trị tương lai thay đổi bảng chữ cái — một password chứa `'` ngày nào đó
 * không còn phá SQL literal nữa.
 *
 * ⚠️ Output của hàm này chỉ an toàn trong NGỮ CẢNH SQL. Nhúng nó vào script
 * shell thì phải nằm trong single quote của shell (hoặc qua
 * {@link shellQuote} cho argument của shell) — trong double quotes của shell,
 * `$` và backtick trong giá trị vẫn được shell biến đổi trước khi psql thấy
 * SQL.
 */
export const sqlQuote = (value: string): string => `'${value.replace(/'/gu, "''")}'`;
