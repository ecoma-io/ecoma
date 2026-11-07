import type { MailTemplateRecord } from './records';

/**
 * Repository đọc `mail_templates`.
 *
 * Không có write port: CRUD template (Admin API) chưa được chốt
 * (`01-architecture.md` §4.1/§10), và service hôm nay chạy với template seed. C1 dựng bảng làm
 * target của read/seed; thêm đường ghi là việc của PR khi quyết định CRUD được chốt.
 */
export interface MailTemplateRepository {
  /**
   * Tra template theo id — neo cho `mail_messages.template_id` (FK `RESTRICT`).
   *
   * Trả `null` khi không có; không lọc `disabled` ở đây vì caller có thể cần đọc cả version
   * đã tắt (replay phải trả nguyên bản template version đã chọn lúc tạo).
   */
  findById(id: string): Promise<MailTemplateRecord | null>;

  /**
   * Mọi ứng viên `status = 'active'` cho đúng `(name, locale)` — điều kiện chọn duy nhất mà
   * `01-architecture.md` §4.1 chốt.
   *
   * ⚠️ Trả về **mảng**, không phải một record: tài liệu chỉ nói "chọn khi `status = active`"
   * và **không** chốt cách chọn khi có nhiều hơn một version active cùng `(name, locale)`
   * (`01-architecture.md` §10 để open CRUD). Chốt một thứ tự thắng ở đây (vd `ORDER BY
   * version DESC LIMIT 1`) sẽ lặng lẽ biến một quyết định chưa chốt thành implementation.
   * Việc chọn một version là implementation gate của template selection ở PR render (C3).
   *
   * Thứ tự `version` tăng dần chỉ để đọc được và ổn định trong test — **không** phải quy tắc
   * chọn.
   */
  findActiveByNameAndLocale(name: string, locale: string): Promise<readonly MailTemplateRecord[]>;
}
