/**
 * Chế độ màu của shell. Ba giá trị chuẩn của mọi giao diện web: hai chế độ tường
 * minh và `system` đi theo `prefers-color-scheme` của hệ điều hành.
 *
 * Đây là cấu hình shell **duy nhất** còn lại sau khi bảng chọn 9 màu chủ đạo và
 * setting LTR/RTL bị gỡ (issue #213): màu accent là thương hiệu của sản phẩm nên
 * không phải lựa chọn, còn chiều văn bản là thuộc tính của ngôn ngữ nội dung và
 * suy ra từ locale của app — cả hai đều không phải thứ người dùng được "chọn".
 */
export type AppShellColorMode = 'light' | 'dark' | 'system';
