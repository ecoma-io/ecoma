-- 0005_quarantine_lifecycle_reason.sql — mở rộng `quarantine.reason` cho lifecycle ingest.
--
-- Nguồn: docs/applications/transactional-mailer-job/01-architecture.md §11.3; cùng quy tắc
-- sanitize với 0002: bảng chỉ lưu reason (enum đóng), KHÔNG lưu payload/raw body.
--
-- Ingest lifecycle event reject payload hỏng (`quarantined` path) theo đúng mô hình
-- "không bao giờ retry payload hỏng" của Mail Command — payload không hợp lệ thì retry
-- bao nhiêu lần cũng không hợp lệ hơn, nên nó đi vào bảng `quarantine` thay vì quay vòng
-- Queue retry. CHECK của 0002 liệt kê cứng bốn giá trị của Mail Command path, nên giá trị
-- mới phải được thêm bằng rebuild constraint (SQLite không sửa CHECK tại chỗ).
--
-- Expand-compatible: tạo bảng mới với CHECK mở rộng, copy row, drop bảng cũ, rename —
-- toàn bộ trong một transaction ngầm của migration runner (một file migration chạy
-- nguyên vẹn hay không chạy gì cả).

CREATE TABLE quarantine_new (
  quarantine_id TEXT NOT NULL,           -- HMAC của raw body (Worker Secret)
  queue_message_id TEXT NOT NULL,        -- Cloudflare Queues message.id
  reason TEXT NOT NULL,
  field_name TEXT,                       -- tên key vi phạm khi reason = 'forbidden-field'; NULL nếu không áp dụng
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  CONSTRAINT quarantine_pkey PRIMARY KEY (quarantine_id, queue_message_id),

  -- Reason chỉ thuộc tập canonical — mở rộng so với 0002 thêm `lifecycle-event-invalid`
  -- (ingest lifecycle event reject payload sai shape; §11.3).
  CONSTRAINT quarantine_reason_check CHECK (
    reason IN (
      'missing-delivery-id',
      'unparseable-body',
      'unsupported-version',
      'forbidden-field',
      'lifecycle-event-invalid'
    )
  ),

  CONSTRAINT quarantine_quarantine_id_non_empty_check CHECK (quarantine_id <> ''),
  CONSTRAINT quarantine_queue_message_id_non_empty_check CHECK (queue_message_id <> ''),

  CONSTRAINT quarantine_forbidden_field_name_check CHECK (
    reason <> 'forbidden-field' OR field_name IS NOT NULL
  ),

  CONSTRAINT quarantine_attempts_check CHECK (attempts >= 1)
);

INSERT INTO quarantine_new
  (quarantine_id, queue_message_id, reason, field_name, attempts, created_at, updated_at)
SELECT
  quarantine_id, queue_message_id, reason, field_name, attempts, created_at, updated_at
FROM quarantine;

DROP TABLE quarantine;
ALTER TABLE quarantine_new RENAME TO quarantine;
