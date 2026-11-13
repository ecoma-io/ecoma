/**
 * Flag chống stringification của Output PHẢI được set TRƯỚC khi
 * `@pulumi/pulumi` được import (`utils.js` đọc biến này đúng MỘT lần lúc
 * module load). Module side-effect này phải là **import đầu tiên** của spec
 * dùng nó: thứ tự evaluate của ES module bảo đảm body của module này chạy
 * xong trước khi body của `@pulumi/pulumi` được nạp.
 *
 * Với flag ON, `Output.toString()` NÉM thay vì lặng lẽ trả placeholder:
 * chương trình ĐÃ SỬA (trigger dựng qua `pulumi.interpolate`) phải construct
 * sạch — chứng minh không còn chỗ nào stringifies một Output; còn pattern CŨ
 * (`${k}=${v}` template literal thường) phải ném `OutputToStringError` thay
 * vì sản sinh chuỗi hằng trơ (issue #154).
 */
process.env.PULUMI_ERROR_OUTPUT_STRING = 'true';
