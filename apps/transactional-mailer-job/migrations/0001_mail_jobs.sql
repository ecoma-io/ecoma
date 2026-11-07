-- 0001_mail_jobs.sql — schema `mail_jobs`: trạng thái thực thi job trong D1 `mail-job`.
--
-- Nguồn: docs/applications/transactional-mailer-job/01-architecture.md §7, §9.2.1, §9.2.2, §9.5;
--        docs/applications/transactional-mailer-job/02-requirements.md FR-006/FR-007.
--
-- Invariant chỉ được encode bằng constraint khi biểu diễn đúng trong D1 và không chặn transition
-- hợp lệ; điều kiện claim/fencing giữ ở consumer dưới dạng conditional UPDATE như tài liệu.
-- Schema không có cột nào cho raw payload, recipient, nội dung render hay credential/secret.
-- `last_error`/`last_error_class` chỉ được ghi error class/code đã sanitize — KHÔNG lưu nguyên văn
-- raw error body của provider (§13); schema không bound được nội dung, đó là trách nhiệm của writer.
--
-- Mọi constraint đều được đặt tên theo convention của repo (`CONSTRAINT <table>_<rule>_check`).
-- Trên SQLite/D1, constraint có tên làm thông báo lỗi trả về chính tên đó
-- (`CHECK constraint failed: mail_jobs_status_check`) thay vì nguyên biểu thức, nên đọc được ngay
-- khi debug và migration sau tham chiếu được mà không phải rebuild bảng.

CREATE TABLE mail_jobs (
  delivery_id TEXT NOT NULL,
  message_id TEXT,                          -- NULL khi tra message không có envelope (trường hợp 404)
  dispatch_generation INTEGER NOT NULL,
  execution_generation INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'processing',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,                          -- error class/code đã sanitize; KHÔNG lưu raw error body (§13)
  last_error_class TEXT,                    -- TEXT: docs chưa chốt bộ giá trị đóng; xem ghi chú PR
  provider_message_id TEXT,
  outcome_report_state TEXT NOT NULL DEFAULT 'none',
  report_lease_owner TEXT,
  report_lease_expires_at INTEGER,
  report_attempts INTEGER NOT NULL DEFAULT 0,
  blocked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  -- `NOT NULL` ở cột là bắt buộc: trên rowid table, `PRIMARY KEY` không kèm `NOT NULL` vẫn cho NULL
  CONSTRAINT mail_jobs_pkey PRIMARY KEY (delivery_id),

  -- Enum đóng cho status (§7)
  CONSTRAINT mail_jobs_status_check CHECK (status IN ('processing', 'sent', 'failed', 'blocked')),

  -- Enum đóng cho outcome_report_state (§7)
  CONSTRAINT mail_jobs_outcome_report_state_check CHECK (
    outcome_report_state IN ('none', 'pending', 'reported', 'superseded', 'orphaned')
  ),

  -- Counter: dispatch_generation bắt đầu từ 1; các counter còn lại không âm
  CONSTRAINT mail_jobs_dispatch_generation_check CHECK (dispatch_generation >= 1),
  CONSTRAINT mail_jobs_execution_generation_check CHECK (execution_generation >= 0),
  CONSTRAINT mail_jobs_attempts_check CHECK (attempts >= 0),
  CONSTRAINT mail_jobs_report_attempts_check CHECK (report_attempts >= 0),

  -- Tính nhất quán cặp lease: cùng null hoặc cùng có
  CONSTRAINT mail_jobs_lease_pair_check CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT mail_jobs_report_lease_pair_check CHECK (
    (report_lease_owner IS NULL) = (report_lease_expires_at IS NULL)
  ),

  -- blocked_at nhất quán: blocked ⇔ blocked_at NOT NULL
  CONSTRAINT mail_jobs_blocked_at_parity_check CHECK ((status = 'blocked') = (blocked_at IS NOT NULL)),

  -- Report state ↔ status: outcome_report_state = 'none' ⇔ status = 'processing'
  CONSTRAINT mail_jobs_report_state_parity_check CHECK (
    (outcome_report_state = 'none') = (status = 'processing')
  ),

  -- Không cho delivery_id rỗng (chống bug ghi key rỗng im lặng)
  CONSTRAINT mail_jobs_delivery_id_non_empty_check CHECK (delivery_id <> '')
);

-- Index cho hai đường truy vấn canonical của §7
-- Sweep report: quét các report pending, sắp xếp theo tuổi bản ghi
CREATE INDEX mail_jobs_report_sweep_idx
  ON mail_jobs (outcome_report_state, updated_at);

-- Tìm job theo status + lease hết hạn để thu hồi lease
CREATE INDEX mail_jobs_status_lease_idx
  ON mail_jobs (status, lease_expires_at);
