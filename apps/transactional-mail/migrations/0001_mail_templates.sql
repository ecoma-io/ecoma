-- 0001_mail_templates.sql — bảng `mail_templates`: bản khai báo template trong D1 `mail`.
--
-- Nguồn: docs/applications/transactional-mail/01-architecture.md §4.1;
--        docs/applications/transactional-mail/02-requirements.md FR-003.
--
-- ⚠️ `variables_schema_json` là **metadata** khai báo tên/kiểu/giới hạn của biến theo TỪNG
-- template version (subset JSON có version: `schema_version` + `variables{name,type,required,
-- nullable?,max_length?,format?}` — FR-003), KHÔNG phải bản sao giá trị biến. Lệnh cấm
-- "không persist raw `variables`" (FR-007) áp cho `mail_messages`, không áp cho cột này:
-- hai thứ khác nhau và không được so khớp tên theo substring.
--
-- Schema là một phần của version: đổi schema = tạo version mới, nên `variables_schema_json`
-- không có `DEFAULT` và không được UPDATE tại chỗ.
--
-- CRUD template (Admin API) chưa chốt (`01-architecture.md` §10); service hôm nay chạy với
-- template seed. Vì vậy bảng này dựng làm target của read/seed, không phải làm target của
-- delete: `mail_messages.template_id` trỏ về đây bằng `ON DELETE RESTRICT` (0002).
--
-- Mọi constraint đều đặt tên theo convention `CONSTRAINT <table>_<rule>_check`: trên
-- SQLite/D1 constraint có tên trả về chính tên đó trong thông báo lỗi
-- (`CHECK constraint failed: mail_templates_status_check`), nên đọc được ngay khi debug và
-- migration sau tham chiếu được mà không phải rebuild bảng.

CREATE TABLE mail_templates (
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  version INTEGER NOT NULL,
  subject_template TEXT NOT NULL,
  body_template TEXT NOT NULL,
  variables_schema_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  -- `NOT NULL` ở cột là bắt buộc: trên rowid table, `PRIMARY KEY` không kèm `NOT NULL` vẫn cho NULL.
  CONSTRAINT mail_templates_pkey PRIMARY KEY (id),

  -- §4.1: một template version là duy nhất theo (name, locale, version).
  -- `locale` đã là một thành phần của khoá, nên bảng này tự phân biệt `en`/`vi` — không có
  -- unique index nào được ghép thêm `status`, nếu không hai version khác nhau cùng `active`
  -- cho một locale sẽ bị loại oan.
  CONSTRAINT mail_templates_version_key_unique UNIQUE (name, locale, version),

  -- §4.1: template chỉ được chọn khi `status = 'active'`.
  CONSTRAINT mail_templates_status_check CHECK (status IN ('active', 'disabled')),

  -- Version bắt đầu từ 1 và chỉ tăng.
  CONSTRAINT mail_templates_version_check CHECK (version >= 1),

  -- Không cho định danh rỗng (chống bug ghi key rỗng im lặng).
  CONSTRAINT mail_templates_id_non_empty_check CHECK (id <> ''),
  CONSTRAINT mail_templates_name_non_empty_check CHECK (name <> ''),
  CONSTRAINT mail_templates_locale_non_empty_check CHECK (locale <> ''),

  -- Template rỗng không render được gì; `variables_schema_json` rỗng không phải schema hợp lệ
  -- (FR-003: `variables` thiếu schema → reject ở tầng service).
  CONSTRAINT mail_templates_subject_template_non_empty_check CHECK (subject_template <> ''),
  CONSTRAINT mail_templates_body_template_non_empty_check CHECK (body_template <> ''),
  CONSTRAINT mail_templates_variables_schema_json_non_empty_check CHECK (variables_schema_json <> '')
);

-- Không có unique index `(name, locale) WHERE status = 'active'`: `01-architecture.md` §4.1
-- chỉ chốt `UNIQUE (name, locale, version)` và điều kiện chọn template là `status = active`.
-- "Mỗi (name, locale) chỉ đúng một version active" là một ràng buộc mạnh hơn và chưa được
-- tài liệu chốt; C1 cố ý không tự chốt. Việc chọn version active khi có nhiều hơn một
-- candidate là implementation gate của template selection ở PR render (C3).
