-- 0004_mail_lifecycle_events.sql — lớp quan sát lifecycle event của provider (D1 `mail-job`).
--
-- Nguồn: docs/applications/transactional-mailer-job/01-architecture.md §11.3.
--
-- Bảng này là **lớp quan sát riêng**, không tham gia state machine: mọi transition của
-- `mail_jobs` (§9.2.2) không đọc bảng này, và event KHÔNG đè `status`/`last_error` hay
-- outcome báo control plane. `deferred` không sinh đường gửi lại — provider tự retry
-- delivery của nó; worker không phát sinh thư mới từ event nào trong bảng này.
--
-- Dedupe: `event_id` là PRIMARY KEY — cùng event giao lại (Queue redelivery, replay)
-- ghi đúng một row; ingest trả `duplicate` và vẫn ack. Định danh không có CHECK tiền tố:
-- giá trị do provider sinh, schema không ràng buộc hình dạng nó (khác `mail_jobs` nơi
-- worker kiểm soát giá trị).
--
-- Correlation: `message_id` là `provider_message_id` mà adapter trả lúc `send()` được
-- chấp nhận. Event chưa tra được delivery (`delivery_id` NULL) VẪN được persist — dữ
-- liệu thật đã tới; correlation bù sau là việc của truy vấn, không phải điều kiện ghi.
--
-- KHÔNG có raw payload: mọi field của provider ngoài bộ chuẩn hoá (smtpResponse, reason
-- free-form, subject...) bị normalizer bỏ trước khi tới đây — cùng nguyên tắc "chỉ lưu
-- token đã sanitize" với `last_error` (0001).
--
-- Mọi constraint đều đặt tên theo convention `CONSTRAINT <table>_<rule>_check`.

CREATE TABLE mail_lifecycle_events (
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message_id TEXT NOT NULL,
  delivery_id TEXT,
  occurred_at INTEGER NOT NULL,
  terminal INTEGER NOT NULL,
  reason_token TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  -- Dedupe key: cùng event hai lần là một row (`01-architecture.md` §11.3).
  CONSTRAINT mail_lifecycle_events_pkey PRIMARY KEY (event_id),

  -- Enum đóng của model trung tính — không tên field/giá trị vendor nào ở đây.
  CONSTRAINT mail_lifecycle_events_event_type_check CHECK (
    event_type IN ('delivered', 'deferred', 'bounced', 'failed', 'rejected', 'complained')
  ),

  -- boolean lưu 0/1 (SQLite không có kiểu boolean riêng).
  CONSTRAINT mail_lifecycle_events_terminal_check CHECK (terminal IN (0, 1)),

  -- Token lý do đóng — cùng tập với `MAIL_LIFECYCLE_REASON_TOKEN_VALUES`.
  CONSTRAINT mail_lifecycle_events_reason_token_check CHECK (
    reason_token IS NULL
    OR reason_token IN (
      'bounce-soft',
      'bounce-hard',
      'delivery-failed',
      'policy-rejected',
      'spam-complaint'
    )
  ),

  -- Không cho định danh rỗng (chống bug ghi key rỗng im lặng).
  CONSTRAINT mail_lifecycle_events_event_id_non_empty_check CHECK (event_id <> ''),
  CONSTRAINT mail_lifecycle_events_message_id_non_empty_check CHECK (message_id <> ''),

  -- occurred_at là epoch ms: sane window của normalizer (sau 2020) đã lọc phía application;
  -- schema chỉ chặn giá trị phi thực tuyệt đối (âm).
  CONSTRAINT mail_lifecycle_events_occurred_at_check CHECK (occurred_at >= 0)
);

-- Correlation path: tra event theo delivery đã khớp (delivery_id tra được từ
-- provider_message_id lúc ingest); NULL cho event chưa khớp.
CREATE INDEX mail_lifecycle_events_delivery_idx ON mail_lifecycle_events (delivery_id, occurred_at);

-- Truy vấn vận hành theo loại event và tuổi (alert bảng bounced/complaint tăng bất thường).
CREATE INDEX mail_lifecycle_events_type_idx ON mail_lifecycle_events (event_type, occurred_at);

-- Index cho correlation: subquery correlate tra `mail_jobs.provider_message_id` theo
-- từng event ingest — không index thì mỗi event quét toàn bảng `mail_jobs`.
CREATE INDEX mail_jobs_provider_message_id_idx ON mail_jobs (provider_message_id);
