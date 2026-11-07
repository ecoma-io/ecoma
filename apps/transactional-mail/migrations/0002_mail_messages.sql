-- 0002_mail_messages.sql — bảng `mail_messages`: lá thư đã render trong D1 `mail`.
--
-- Nguồn: docs/applications/transactional-mail/01-architecture.md §4.2, §6.2, §6.2.2;
--        docs/applications/transactional-mail/02-requirements.md FR-002, FR-007, NFR-001.
--
-- ⚠️ Bảng này KHÔNG có cột nào lưu raw `variables` (FR-007, invariant 17): worker render một
-- lần tại request time, persist template version đã chọn + nội dung đã render. `variables`
-- chỉ tồn tại trong bộ nhớ request. `request_fingerprint` là biểu diễn duy nhất được persist
-- của idempotency replay — HMAC-SHA-256 có khoá, không phải hash trần, không chứa raw
-- `variables` hay nội dung render.
--
-- ⚠️ Hai lớp state KHÔNG được ghi đè lên nhau (§6.2.1). Bảng này là lớp delivery outcome
-- (`accepted/queued/sent/failed/blocked`); lớp publish state nằm ở `mail_outbox` (0003).
-- Publisher KHÔNG BAO GIỜ ghi `sent`/`failed`/`blocked` và không ghi `queued` đè trạng thái
-- terminal; outcome callback KHÔNG BAO GIỜ lùi trạng thái. Mọi UPDATE đều conditional —
-- guard nằm trong `WHERE`, không có read-then-write không guard (invariant bất biến §8).
--
-- `terminal_at` là mốc thời gian FR-007 cần để retention query hoạt động: content
-- (recipient + subject_rendered + body_rendered) được giữ sau khi message đạt trạng thái
-- terminal. Cột này do repository ghi cùng lúc với transition sang `sent`/`failed`.
--
-- Mọi constraint đều đặt tên theo convention `CONSTRAINT <table>_<rule>_check`.

CREATE TABLE mail_messages (
  id TEXT NOT NULL,
  app TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_name TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  locale TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject_rendered TEXT NOT NULL,
  body_rendered TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted',
  delivery_id TEXT NOT NULL,
  dispatch_generation INTEGER NOT NULL DEFAULT 1,
  recovery_cycle_count INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  correlation_id TEXT,
  failure_reason TEXT,
  terminal_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  -- `NOT NULL` ở cột là bắt buộc: trên rowid table, `PRIMARY KEY` không kèm `NOT NULL` vẫn cho NULL.
  --
  -- Không có CHECK nào ép tiền tố `msg_` (§4.2 nêu `id` (`msg_`), `delivery_id` (`dlv_`)) vì
  -- "ID strategy — mặc định UUIDv7, có đổi sang compact ID không" vẫn là quyết định mở ở
  -- `docs/architecture/01-architecture.md` §10, trước khi có schema production. Ép tiền tố lúc này
  -- sẽ bắt một quyết định chưa chốt thành constraint, mà SQLite không sửa được CHECK tại chỗ:
  -- đổi sang UUIDv7 sẽ phải rebuild bảng. Tiền tố sinh do generator của application layer
  -- (contract với wire), không phải việc của storage.
  CONSTRAINT mail_messages_pkey PRIMARY KEY (id),

  -- §4.2 / invariant 3: replay trả message cũ, không tạo outbox mới. Scope là authenticated
  -- principal + key — KHÔNG dùng caller-supplied `app`, vì chưa có bất biến one-to-one giữa
  -- principal và `app` (FR-002).
  CONSTRAINT mail_messages_principal_idempotency_key_unique UNIQUE (principal_id, idempotency_key),

  -- `delivery_id` là idempotency key cấp logical delivery phía consumer (§4.2): Queue envelope
  -- chỉ mang `{ version, delivery_id }`, và `mail_outbox` tham chiếu đúng cột này.
  CONSTRAINT mail_messages_delivery_id_unique UNIQUE (delivery_id),

  -- Template được tham chiếu bằng id; RESTRICT vì `01-architecture.md` §4.1 chưa chốt CRUD
  -- template và không có documented delete operation. Template chỉ được "tắt" bằng
  -- `status = 'disabled'`, không xoá row.
  CONSTRAINT mail_messages_template_id_fkey FOREIGN KEY (template_id)
    REFERENCES mail_templates (id) ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- §4.2: trạng thái delivery — mỗi giá trị một nghĩa duy nhất.
  CONSTRAINT mail_messages_status_check CHECK (
    status IN ('accepted', 'queued', 'sent', 'failed', 'blocked')
  ),

  -- Fencing: generation khởi tạo là 1 (§6.2.2), chỉ redrive có authorize tăng nó.
  CONSTRAINT mail_messages_dispatch_generation_check CHECK (dispatch_generation >= 1),

  -- Ngân sách A (§6.5): chỉ tăng, không reset.
  CONSTRAINT mail_messages_recovery_cycle_count_check CHECK (recovery_cycle_count >= 0),

  -- Server chọn template version tại thời điểm tạo; replay phải trả nguyên bản version đó
  -- (FR-002), nên cột là snapshot chứ không phải join runtime.
  CONSTRAINT mail_messages_template_version_check CHECK (template_version >= 1),

  -- `terminal_at` = mốc FR-007 cho retention query; parity với trạng thái terminal để không
  -- tồn tại row terminal thiếu mốc (content bị giữ vô thời hạn) hay row non-terminal có mốc
  -- (prune xoá sớm). Repository ghi cả hai trong cùng conditional UPDATE.
  CONSTRAINT mail_messages_terminal_at_parity_check CHECK (
    (status IN ('sent', 'failed')) = (terminal_at IS NOT NULL)
  ),

  -- `request_fingerprint` là HMAC có khoá dạng `p1.k1:<64 hex>` (FR-002): profile tag `p1`,
  -- key version `k1`, rồi digest. Ràng buộc này chặn hash trần (`SHA-256(canonical)` không
  -- tiền tố khoá) lọt vào cột — FR-007 AC yêu cầu storage schema assert đúng điều đó.
  -- GLOB `p[0-9]*.k[0-9]*:` cho phép profile/key version tăng số (`p2`, `k2`) mà không cần
  -- rebuild bảng.
  CONSTRAINT mail_messages_request_fingerprint_format_check CHECK (
    request_fingerprint GLOB 'p[0-9]*.k[0-9]*:*'
    AND length(request_fingerprint) >= 20
  ),

  -- `failure_reason` chỉ nhận `error_class` đã validate theo **đúng năm giá trị canonical**
  -- (`01-architecture.md` §7.2, `02-requirements.md` FR-002), hoặc `NULL` (outcome `sent`, hoặc
  -- `blocked`-do-ngân-sách). FR-002 ghi rõ đây là "ánh xạ duy nhất" vào cột này, nên CHECK
  -- đóng là cách durable hoá mệnh lệnh "không bao giờ ghi nguyên văn giá trị nhận được": HTTP
  -- layer reject chuỗi ngoài bộ bằng `400`, và kể cả một caller lọt xuống đây thì constraint
  -- chặn thay vì chỉ có "không được chuỗi rỗng".
  --
  -- Hai giá trị nội bộ của worker/control-plane bị loại cùng cách: `execution-budget-exhausted`
  -- không phải `error_class` (worker báo bằng `outcome = blocked` không kèm class) và
  -- `delivery-not-found` là kết quả lookup `404`, không phải outcome (FR-002).
  --
  -- Không chứa recipient, nội dung render hay nguyên văn error body (NFR-001): bộ giá trị
  -- trên là enum nên bản thân giá trị đã không chứa được dữ liệu tự do.
  CONSTRAINT mail_messages_failure_reason_class_check CHECK (
    failure_reason IS NULL
    OR failure_reason IN ('retryable', 'permanent', 'credential', 'contract', 'internal-auth')
  ),

  -- Không cho định danh rỗng (chống bug ghi key rỗng im lặng).
  CONSTRAINT mail_messages_id_non_empty_check CHECK (id <> ''),
  CONSTRAINT mail_messages_delivery_id_non_empty_check CHECK (delivery_id <> ''),
  CONSTRAINT mail_messages_app_non_empty_check CHECK (app <> ''),
  CONSTRAINT mail_messages_principal_id_non_empty_check CHECK (principal_id <> ''),
  CONSTRAINT mail_messages_template_id_non_empty_check CHECK (template_id <> ''),
  CONSTRAINT mail_messages_template_name_non_empty_check CHECK (template_name <> ''),
  CONSTRAINT mail_messages_locale_non_empty_check CHECK (locale <> ''),
  CONSTRAINT mail_messages_recipient_non_empty_check CHECK (recipient <> ''),

  -- FR-002: key bắt buộc, ≤ 128 ký tự.
  CONSTRAINT mail_messages_idempotency_key_format_check CHECK (
    idempotency_key <> '' AND length(idempotency_key) <= 128
  )
);

-- Index cho đường claim/quét đã document:
-- - Reconciler/repair quét message theo trạng thái và tuổi (§6.2.2, hàng 5/8).
-- - Retention quét content đã terminal quá hạn (FR-007).
CREATE INDEX mail_messages_status_updated_idx ON mail_messages (status, updated_at);
CREATE INDEX mail_messages_status_terminal_idx ON mail_messages (status, terminal_at);
