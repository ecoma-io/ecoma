-- 0002_rejected_command_quarantine.sql — bản ghi quarantine đã sanitize cho command bị reject.
--
-- Nguồn: docs/applications/transactional-mailer-job/03-operations.md §3.1.
--
-- Bảng chỉ lưu bản ghi đã sanitize: `quarantine_id` (HMAC của raw body, khoá Worker Secret),
-- `queue_message_id`, `reason`, **tên** key vi phạm (không phải value), `attempts`, timestamps.
-- Không có cột nào cho raw payload, recipient, subject/body, field value hay credential/secret.
--
-- Khoá chính tổ hợp (quarantine_id, queue_message_id): hai Queue message khác nhau có cùng raw
-- body cho cùng digest vẫn là hai bản ghi riêng, không ghi đè hay mất bản ghi; ghi lặp cùng một
-- (quarantine_id, queue_message_id) là idempotent ở phía worker (ON CONFLICT DO UPDATE).
-- Retention/cleanup cố ý KHÔNG định nghĩa ở đây — đó là platform operations gate.
--
-- Lưu ý: encoding của digest (hex/base64) không bị schema ràng buộc; worker quyết định encoding.
--
-- Mọi constraint đều được đặt tên theo convention của repo (`CONSTRAINT <table>_<rule>_check`).

CREATE TABLE quarantine (
  quarantine_id TEXT NOT NULL,           -- HMAC của raw body (Worker Secret)
  queue_message_id TEXT NOT NULL,        -- Cloudflare Queues message.id
  reason TEXT NOT NULL,
  field_name TEXT,                       -- tên key vi phạm khi reason = 'forbidden-field'; NULL nếu không áp dụng
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  -- Khoá chính tổ hợp: không ghi đè bản ghi của message khác dù trùng digest body
  CONSTRAINT quarantine_pkey PRIMARY KEY (quarantine_id, queue_message_id),

  -- Reason chỉ thuộc tập canonical
  CONSTRAINT quarantine_reason_check CHECK (
    reason IN ('missing-delivery-id', 'unparseable-body', 'unsupported-version', 'forbidden-field')
  ),

  -- Chặn key rỗng (phòng vệ)
  CONSTRAINT quarantine_quarantine_id_non_empty_check CHECK (quarantine_id <> ''),
  CONSTRAINT quarantine_queue_message_id_non_empty_check CHECK (queue_message_id <> ''),

  -- §3.1 hàng 5: record của 'forbidden-field' chỉ ghi TÊN key vi phạm, nên bắt buộc có field_name
  CONSTRAINT quarantine_forbidden_field_name_check CHECK (
    reason <> 'forbidden-field' OR field_name IS NOT NULL
  ),

  -- Attempts phải >= 1
  CONSTRAINT quarantine_attempts_check CHECK (attempts >= 1)
);

-- Không thêm index riêng: prefix của composite PK (quarantine_id, ...) đã phục vụ tra cứu theo digest;
-- §3.1 không định nghĩa truy vấn operator canonical nào theo queue_message_id hay cho retention scan.
