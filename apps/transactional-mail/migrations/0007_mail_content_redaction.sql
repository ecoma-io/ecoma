-- 0007_mail_content_redaction.sql — cho phép redact content đã quá hạn retention.
--
-- Nguồn: docs/applications/transactional-mail/02-requirements.md FR-007 ("Message terminal quá
--        hạn retention → content bị xoá/redact, metadata còn"); §5.3 của
--        docs/applications/transactional-mail/03-operations.md (chu kỳ retention).
--
-- ⚠️ VÌ SAO FILE NÀY TỒN TẠI — và vì sao nó là một rebuild bảng.
--
-- FR-007 yêu cầu redact `recipient` + `subject_rendered` + `body_rendered` sau một thời
-- hạn, nhưng schema ở `0002_mail_messages.sql` đặt:
--
--     CONSTRAINT mail_messages_recipient_non_empty_check CHECK (recipient <> '')
--
-- Ràng buộc đó **đúng** khi được viết (chống bug ghi recipient rỗng lúc tạo message), và
-- nó cũng chặn đúng thứ FR-007 đòi: `UPDATE … SET recipient = ''` ném
-- `CHECK constraint failed: mail_messages_recipient_non_empty_check`, tức redact **không
-- bao giờ** chạy được. Đã đo trên D1 thật (wrangler local + `getPlatformProxy`) — không phải
-- suy đoán từ đọc DDL.
--
-- SQLite không sửa được CHECK của một bảng đã có, nên lựa chọn duy nhất là **rebuild**:
-- tạo bảng mới không có CHECK đó, chép dữ liệu sang, đổi tên. Đây là đường expand →
-- compatible rollout → contract của chính migration này: không cột nào bị đổi tên, không
-- row nào bị mất, không query nào của code phải sửa.
--
-- ⚠️ BA ĐIỀU KIỆN MÀ REBUILD NÀY PHẢI GIỮ, và mỗi cái đều đã được đo trên D1 thật
-- (`wrangler d1 execute --local`, tức đúng workerd/SQLite của Cloudflare chứ không phải
-- `better-sqlite3`):
--
-- 1. **FK `mail_outbox.delivery_id → mail_messages.delivery_id` (RESTRICT) chặn
--    `DROP TABLE mail_messages`.** Đã thử trực tiếp: `DROP TABLE mail_messages` khi còn
--    outbox row trỏ tới → `FOREIGN KEY constraint failed`. Đây không phải hạn chế của
--    `0002`/`0003` mà là đặc tính của SQLite: `DROP TABLE` là một `DELETE` toàn bảng, nên
--    RESTRICT vi phạm ở chính statement đó.
--
-- 2. **Không có `PRAGMA` nào dập được (1).** Đo từng cái trên D1 thật:
--    - `PRAGMA foreign_keys = off` → **không có tác dụng**: đọc lại trong cùng batch vẫn ra
--      `foreign_keys = 1`. D1 bật FK theo connection và không cho tắt giữa chừng.
--    - `PRAGMA defer_foreign_keys = on` → có hiệu lực (đọc lại ra `1`) nhưng **không đủ**:
--      chỉ hoãn kiểm FK *tới cuối transaction*, mà `DROP TABLE` vẫn là thao tác ngay trong
--      transaction đó nên vẫn ném lỗi. Đo cả hai bảng: drop con rồi drop cha vẫn **fail**.
--    - `BEGIN`/`COMMIT` trong file migration → workerd **từ chối** ("please use the
--      state.storage.transaction()…"). Đây là ranh giới của D1: migration file không tự
--      mở transaction được.
--    Lối thoát duy nhất còn lại là `DEFERRABLE INITIALLY DEFERRED` trên chính FK (đo thì
--    chạy được) — nhưng **cố ý không dùng**: nó đổi vĩnh viễn ngữ nghĩa FK cho mọi write
--    sau này, tức đánh đổi tính đúng-đắn lâu dài của bảng cho một nhu cầu một lần. Thay vào
--    đó migration này dùng (3).
--
-- 3. **Copy vào bảng tạm KHÔNG có FK.** Toàn bộ mẹo nằm ở chỗ bảng tạm không **tham chiếu**
--    gì: nếu bảng tạm của `mail_outbox` mang FK trỏ tới `mail_messages` (kể cả trỏ tới bảng
--    *mới*) thì chính nó chặn `DROP TABLE mail_messages` — đã đo và đây chính là lỗi ở bản
--    đầu tiên của file này. Bảng tạm khai **không có** mệnh đề `FOREIGN KEY`, chỉ khai cột.
--    FK được tạo lại **sau** khi `mail_messages` đã là bảng mới, ở statement `CREATE TABLE`
--    cuối cùng. Đo lại: copy → drop con → drop cha → rename → tạo lại bảng con có FK: pass.
--
-- ⚠️ `PRAGMA defer_foreign_keys = on` vẫn được giữ ở đầu file dù theo (2) nó không cứu
-- được gì: nó là đệm an toàn cho trường hợp `CREATE TABLE mail_outbox (… FOREIGN KEY …)`
-- tức thời chạy trước khi rename (không xảy ra với thứ tự dưới đây) và là tài liệu ý định rằng
-- migration này cố ý xử lý FK theo kiểu hoãn. Nó vô hại: mọi constraint trong file này đều
-- hợp lệ ở thời điểm commit, nên commit vẫn kiểm và vẫn fail nếu có sai sót.
--
-- ⚠️ Index phải được tạo lại. `DROP TABLE` mang theo index của bảng đó, và tên index là
-- không gian theo schema — `CREATE INDEX mail_outbox_status_available_idx` lần hai sẽ ném
-- `index … already exists` (đã đo). Danh sách index ở đây phải khớp **đúng** với năm index
-- `0002`/`0003` tạo, kể cả tên và thứ tự cột.
--
-- ⚠️ Cột `subject_rendered`/`body_rendered` không có CHECK tương tự, nên chúng đã redact
-- được ngay từ `0002`; chỉ `recipient` là cột duy nhất cần thay đổi.
--
-- ⚠️ CHECK `recipient` được **siết lại**, KHÔNG bị bỏ. Bản `0002` là:
--
--     CONSTRAINT mail_messages_recipient_non_empty_check CHECK (recipient <> '')
--
-- và bản ở đây là:
--
--     CONSTRAINT mail_messages_recipient_non_empty_check CHECK (
--       recipient <> '' OR status IN ('sent', 'failed')
--     )
--
-- Vì sao không bỏ hẳn (lựa chọn đã cân nhắc và loại): một CHECK `recipient <> ''` mà không có
-- điều kiện nào khác là câu trả lời sai cho câu hỏi "recipient rỗng có phải lỗi không?" — sau
-- FR-007 nó **không còn là lỗi ở mọi trạng thái**. Nhưng vẫn là lỗi ở trạng thái non-terminal:
-- một message `accepted`/`queued` còn phải gửi lại được mà mất recipient thì lỗi đó chỉ lộ ra
-- ở tận Queue, và im lặng cho tới lúc đó. CHECK siết giữ đúng bảo vệ đó: rỗng thì chỉ chấp
-- nhận khi row đã terminal (`sent`/`failed`) — tức đúng trường hợp duy nhất FR-007 cho phép
-- xoá.
--
-- Vì sao đây là lựa chọn **đúng** chứ không phải nới lỏng: vế phải của OR là một tập trạng
-- thái hữu hạn mà schema đã định nghĩa (`mail_messages_status_check`), nên CHECK không mở
-- thêm một lối lách nào ngoài ý muốn — row muốn rỗng đều phải là row đã terminal. Và việc
-- `redactContent` guard `status IN ('sent','failed') AND terminal_at < ?` trong **cùng một
-- statement** nghĩa là chính câu lệnh đó, chứ không phải một caller khác, là thứ quyết định
-- khi nào `recipient` trở thành rỗng.
--
-- ⚠️ Giữ **nguyên tên** constraint cũng là một yêu cầu của chính repo: `mail-d1.spec.ts`
-- kiểm danh sách tên CHECK của từng bảng và kiểm **tổng số** `CHECK (` trong DDL bằng `toBe`.
-- Đặt lại tên hoặc bỏ constraint sẽ làm hai khẳng định đó đỏ mà không đổi hành vi nào.

PRAGMA defer_foreign_keys = on;

-- Bước 1 — bảng tạm cho hai bảng, **không khai constraint nào** (xem điều kiện (3)).
-- Tên `_migration_0007_` để không bao giờ trùng với tên bảng thật.
CREATE TABLE migration_0007_outbox_stage (
  id TEXT,
  delivery_id TEXT,
  dispatch_generation INTEGER,
  status TEXT,
  publish_attempts INTEGER,
  available_at INTEGER,
  claimed_at INTEGER,
  claimed_by TEXT,
  published_at INTEGER,
  last_error TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE migration_0007_messages_stage (
  id TEXT,
  app TEXT,
  principal_id TEXT,
  template_id TEXT,
  template_name TEXT,
  template_version INTEGER,
  locale TEXT,
  recipient TEXT,
  subject_rendered TEXT,
  body_rendered TEXT,
  status TEXT,
  delivery_id TEXT,
  dispatch_generation INTEGER,
  recovery_cycle_count INTEGER,
  idempotency_key TEXT,
  request_fingerprint TEXT,
  correlation_id TEXT,
  failure_reason TEXT,
  terminal_at INTEGER,
  created_at INTEGER,
  updated_at INTEGER
);

-- Copy trước, drop sau: mọi row của cả hai bảng được giữ nguyên mọi cột. `SELECT *` ở đây an
-- toàn vì hai bảng tạm khai **đúng thứ tự cột** của bảng gốc — thứ tự cột là hợp đồng của
-- `INSERT … SELECT`, không phải thứ suy ra được từ tên cột.
INSERT INTO migration_0007_outbox_stage SELECT * FROM mail_outbox;
INSERT INTO migration_0007_messages_stage SELECT * FROM mail_messages;

-- Bước 2 — drop con trước, cha sau. Tới đây không còn FK nào trỏ tới `mail_messages`, nên
-- `DROP TABLE mail_messages` hợp lệ (điều kiện (1)+(3)).
DROP TABLE mail_outbox;
DROP TABLE mail_messages;

-- Bước 3 — dựng lại bảng cha. Giữ **mọi** constraint của `0002_mail_messages.sql` trừ
-- **đúng một**: `mail_messages_recipient_non_empty_check`. Xem giải thích ở đầu file về
-- vì sao không thay thế bằng một CHECK khác.
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

  CONSTRAINT mail_messages_pkey PRIMARY KEY (id),
  CONSTRAINT mail_messages_principal_idempotency_key_unique UNIQUE (principal_id, idempotency_key),
  CONSTRAINT mail_messages_delivery_id_unique UNIQUE (delivery_id),
  CONSTRAINT mail_messages_template_id_fkey FOREIGN KEY (template_id)
    REFERENCES mail_templates (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT mail_messages_status_check CHECK (
    status IN ('accepted', 'queued', 'sent', 'failed', 'blocked')
  ),
  CONSTRAINT mail_messages_dispatch_generation_check CHECK (dispatch_generation >= 1),
  CONSTRAINT mail_messages_recovery_cycle_count_check CHECK (recovery_cycle_count >= 0),
  CONSTRAINT mail_messages_template_version_check CHECK (template_version >= 1),
  CONSTRAINT mail_messages_terminal_at_parity_check CHECK (
    (status IN ('sent', 'failed')) = (terminal_at IS NOT NULL)
  ),
  CONSTRAINT mail_messages_request_fingerprint_format_check CHECK (
    request_fingerprint GLOB 'p[0-9]*.k[0-9]*:*'
    AND length(request_fingerprint) >= 20
  ),
  CONSTRAINT mail_messages_failure_reason_class_check CHECK (
    failure_reason IS NULL
    OR failure_reason IN ('retryable', 'permanent', 'credential', 'contract', 'internal-auth')
  ),
  CONSTRAINT mail_messages_id_non_empty_check CHECK (id <> ''),
  CONSTRAINT mail_messages_delivery_id_non_empty_check CHECK (delivery_id <> ''),
  CONSTRAINT mail_messages_app_non_empty_check CHECK (app <> ''),
  CONSTRAINT mail_messages_principal_id_non_empty_check CHECK (principal_id <> ''),
  CONSTRAINT mail_messages_template_id_non_empty_check CHECK (template_id <> ''),
  CONSTRAINT mail_messages_template_name_non_empty_check CHECK (template_name <> ''),
  CONSTRAINT mail_messages_locale_non_empty_check CHECK (locale <> ''),

  -- FR-007: `recipient` rỗng **chỉ** hợp lệ khi row đã terminal — xem giải thích đầy đủ ở
  -- khối ghi chú ngay trên `PRAGMA defer_foreign_keys`. Tên constraint giữ nguyên để các
  -- khẳng định về danh sách tên CHECK trong `mail-d1.spec.ts` không cần đổi.
  CONSTRAINT mail_messages_recipient_non_empty_check CHECK (
    recipient <> '' OR status IN ('sent', 'failed')
  ),

  -- FR-002: key bắt buộc, ≤ 128 ký tự.
  CONSTRAINT mail_messages_idempotency_key_format_check CHECK (
    idempotency_key <> '' AND length(idempotency_key) <= 128
  )
);

-- Bước 4 — bảng con, khai lại FK **giờ đã trỏ tới bảng cha mới**. Constraint giữ nguyên từng
-- cái từ `0003_mail_outbox.sql`: không cái nào bị bỏ, đổi tên hay nới lỏng.
CREATE TABLE mail_outbox (
  id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  dispatch_generation INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  publish_attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  claimed_at INTEGER,
  claimed_by TEXT,
  published_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  CONSTRAINT mail_outbox_pkey PRIMARY KEY (id),
  CONSTRAINT mail_outbox_delivery_id_unique UNIQUE (delivery_id),
  CONSTRAINT mail_outbox_delivery_id_fkey FOREIGN KEY (delivery_id)
    REFERENCES mail_messages (delivery_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT mail_outbox_status_check CHECK (
    status IN ('pending', 'publishing', 'published', 'failed')
  ),
  CONSTRAINT mail_outbox_dispatch_generation_check CHECK (dispatch_generation >= 1),
  CONSTRAINT mail_outbox_publish_attempts_check CHECK (publish_attempts >= 0),
  CONSTRAINT mail_outbox_available_at_check CHECK (available_at > 0),
  CONSTRAINT mail_outbox_lease_pair_check CHECK ((claimed_at IS NULL) = (claimed_by IS NULL)),
  CONSTRAINT mail_outbox_id_non_empty_check CHECK (id <> ''),
  CONSTRAINT mail_outbox_delivery_id_non_empty_check CHECK (delivery_id <> ''),
  CONSTRAINT mail_outbox_last_error_format_check CHECK (
    last_error IS NULL OR length(last_error) > 0
  )
);

-- Bước 5 — chép ngược dữ liệu từ bảng tạm. `INSERT … SELECT` với danh sách cột tường minh:
-- sau rebuild, thứ tự cột là do **file này** quyết định, nên không còn là hợp đồng với một
-- migration khác nữa — nêu tên cột làm cho việc lệch thứ tự thành lỗi ngay thay vì lỗi âm
-- thầm.
INSERT INTO mail_messages (
  id, app, principal_id, template_id, template_name, template_version, locale,
  recipient, subject_rendered, body_rendered, status, delivery_id, dispatch_generation,
  recovery_cycle_count, idempotency_key, request_fingerprint, correlation_id, failure_reason,
  terminal_at, created_at, updated_at
)
SELECT
  id, app, principal_id, template_id, template_name, template_version, locale,
  recipient, subject_rendered, body_rendered, status, delivery_id, dispatch_generation,
  recovery_cycle_count, idempotency_key, request_fingerprint, correlation_id, failure_reason,
  terminal_at, created_at, updated_at
FROM migration_0007_messages_stage;

INSERT INTO mail_outbox (
  id, delivery_id, dispatch_generation, status, publish_attempts, available_at,
  claimed_at, claimed_by, published_at, last_error, created_at, updated_at
)
SELECT
  id, delivery_id, dispatch_generation, status, publish_attempts, available_at,
  claimed_at, claimed_by, published_at, last_error, created_at, updated_at
FROM migration_0007_outbox_stage;

-- Bảng tạm hết nhiệm việc. D1 không có `DROP TABLE IF EXISTS` trong ngữ cảnh này nên câu lệnh
-- thẳng là đủ — nếu file chạy lại thì migration ledger đã chặn từ trước.
DROP TABLE migration_0007_outbox_stage;
DROP TABLE migration_0007_messages_stage;

-- Năm index của `0002`/`0003`, giữ nguyên tên và thứ tự cột. Index đã bị `DROP TABLE` mang
-- đi nên phải khai lại tường minh — xem ghi chú index ở đầu file.
CREATE INDEX mail_messages_status_updated_idx ON mail_messages (status, updated_at);
CREATE INDEX mail_messages_status_terminal_idx ON mail_messages (status, terminal_at);
CREATE INDEX mail_outbox_status_available_idx ON mail_outbox (status, available_at);
CREATE INDEX mail_outbox_status_claimed_idx ON mail_outbox (status, claimed_at);
CREATE INDEX mail_outbox_status_updated_idx ON mail_outbox (status, updated_at);