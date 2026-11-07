/**
 * Public surface của persistence layer D1 cho `transactional-mail` (C1).
 *
 * Chỉ ba thứ走出 cửa ngoài: kiểu bề mặt D1 tối giản, factory lắp ráp và kiểu
 * kết quả của factory. Cụm `D1*Repository`/`D1*Store` và mọi kiểu row giữ
 * nội bộ — composition root (C2) không thao tác row thô, nó chỉ giữ một
 * `D1MailPersistence` và gọi các port.
 *
 * Port (`MailMessageRepository`, `MailOutboxRepository`, …) KHÔNG được re-export
 * ở đây: chúng thuộc `@ecoma-io/transactional-mail-application`, nơi application
 * định nghĩa chúng. Re-export sẽ tạo đường dẫn thứ hai tới cùng một type và làm
 * mờ ranh giới `type:application` / `type:infrastructure`.
 */

export { createD1MailPersistence, type D1MailPersistence } from './create-d1-mail-persistence';
export type { D1SubsetDatabase, D1SubsetPreparedStatement, D1SubsetResult } from './d1-surface';
