-- 0008_data_domain_v1.sql — ba bảng data domain v1: hồ sơ và preference.
--
-- Phạm vi: `user_profiles`, `user_preferences`, `notification_preferences` —
-- ba bảng mà `01-architecture.md` §3.2–3.4 mô tả nhưng schema chưa có. PR này
-- **chỉ** tạo bảng: chưa có đường đọc/ghi nào (BFF route là việc của PR2/PR4
-- trong sequence của Issue #274), nên mọi truy vấn dưới đây là hợp đồng hình
-- dạng cho các PR kế tiếp, không phải mã chết của một tính năng đã có.
--
-- ⚠️ Forward-only: KHÔNG sửa file migration cũ. File này là expand — thêm bảng
--    mới, không đổi bảng nào.
--
-- ⚠️ IDEMPOTENT BẮT BUỘC (README "Advisory lock và idempotent"): runner không có
--    bảng ledger — nó chạy lại MỌI file mỗi lần apply. `CREATE TABLE IF NOT
--    EXISTS` và `GRANT` (bản chất lặp được) đều là no-op khi schema đã ở trạng
--    thái đích. Test `migrations.spec.ts` áp mọi file hai lần.
--
-- ## Quyết định v1 mà docs chưa chốt (reviewer có quyền veto)
--
-- Docs chốt mục đích từng bảng nhưng không chốt hình dạng cột. Các lựa chọn
-- dưới đây là của v1, nêu ra đây để mỗi ý đều bị nhìn thấy khi review:
--
--   * `user_profiles` chỉ có `display_name` + `avatar_url`, đúng hai thứ §3.2
--     nêu tên. "Thông tin hồ sơ do user chủ động nhập" khác chưa thành cột —
--     thêm cột nào phải biện minh được riêng.
--   * `user_profiles.display_name` NULL = "chưa nhập"; rỗng là dạng sai. Avatar
--     chỉ nhận scheme https (app validate phần còn lại).
--   * `user_preferences.locale` NOT NULL **không** DB default: default theo
--     Accept-Language là quyết định lúc tạo account (FR-008c, app-side). Một DB
--     default sẽ nuốt im lặng đường ghi thiếu locale — trái hướng "reject, không
--     fallback" của FR-008a. Allowlist `en` | `vi` đúng §3.3; `zh-CN` mà
--     `locale-registry.ts` phía UI khai là mục tiêu UI tương lai, thêm vào DB là
--     forward-fix sau khi contract server chốt.
--   * `notification_preferences`: taxonomy kênh **không** được docs chốt. v1
--     chọn `email` | `push` — đúng hai cơ chế delivery tồn tại hôm nay
--     (transactional-mail, web-push-notification-job). Kiểu
--     `NotificationPreferences` phía UI (serviceEmail/productUpdates/marketing)
--     là phân loại nội dung, sẽ cần align ở PR4.
--   * `enabled boolean` là nội dung tối thiểu của intent: một row phải nói được
--     ý định là gì; "row tồn tại = được gửi" là chính sách opt-in — thứ thuộc về
--     PR2/PR4, không phải schema. Bảng giữ trung tính với cả opt-in lẫn opt-out,
--     và KHÔNG ghi delivery state / device list / subscription (§3.4 — thứ đó
--     thuộc `push` và `web-push-notification-job`).
--   * "Tần suất mong muốn" (§3.4 nêu tên) chưa thành cột: chưa có yêu cầu v1 nào
--     dùng nó; thêm sau là expand thuần tuý.

BEGIN;

-- ---------------------------------------------------------------------------
-- user_profiles — hồ sơ do user chủ động nhập
-- ---------------------------------------------------------------------------
--
-- PRIMARY KEY trên `user_sub` **là chính** ràng buộc 1:1 với `users` (§3.2):
-- một sub tối đa một hồ sơ. Không surrogate id — `email_addresses` cần id vì
-- quan hệ 1:N, còn bảng này không; thêm id là thêm một index không trả lời cho
-- truy vấn nào (`01-architecture.md` §3: không index "cho chắc").
CREATE TABLE IF NOT EXISTS account.user_profiles (
  user_sub text PRIMARY KEY REFERENCES account.users (sub) ON DELETE RESTRICT,
  -- Tên hiển thị do user nhập. NULL = chưa nhập lần nào; chuỗi rỗng là dạng sai
  -- (app normalize/trim trước khi ghi — database không tự normalize, cùng luật
  -- với `email_addresses.address_normalized`; CHECK đây là lớp hai chặn giá trị
  -- hình thức sai).
  display_name text,
  -- URL avatar. App validate đầy đủ (host allowlist, kích thước...); DB chỉ giữ
  -- hình dạng scheme: avatar render được trong browser phải qua https.
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_profiles_display_name_shape_check CHECK (
    display_name IS NULL OR length(display_name) > 0
  ),
  CONSTRAINT user_profiles_avatar_url_scheme_check CHECK (
    avatar_url IS NULL OR avatar_url ~ '^https://'
  )
);

COMMENT ON TABLE account.user_profiles IS
  'Self-entered profile of a user: display name and avatar URL. 1:1 with users; NULL means not entered yet.';
COMMENT ON COLUMN account.user_profiles.display_name IS
  'Display name entered by the user. NULL = never entered; an empty string is invalid by shape check.';
COMMENT ON COLUMN account.user_profiles.avatar_url IS
  'HTTPS avatar URL. Full validation is app-layer; the DB only pins the https scheme.';

-- ---------------------------------------------------------------------------
-- user_preferences — contract ổn định đọc bởi nhiều service
-- ---------------------------------------------------------------------------
--
-- Ba trường này là **contract ổn định** đọc bởi frontend khác, `llm-*`,
-- `backoffice` (§3.3), nên typed column chứ không JSONB: validate ở tầng ghi,
-- sai một key phải là lỗi thấy được chứ không phải typo im lặng phía consumer.
CREATE TABLE IF NOT EXISTS account.user_preferences (
  user_sub text PRIMARY KEY REFERENCES account.users (sub) ON DELETE RESTRICT,
  -- Allowlist đóng (FR-008a): giá trị lạ bị REJECT, không fallback im lặng.
  -- Không DB default — xem phần "Quyết định v1" ở đầu file.
  locale text NOT NULL,
  -- IANA TZ name, lưu dạng text. DB chỉ giữ hình dạng "không rỗng": validation
  -- theo tz database là của tầng app (§3.3) — SQL không kiểm được tên IANA mà
  -- không cài bảng timezone, và một CHECK cứng danh sách sẽ mục ruỗng khi
  -- tzdata cập nhật. Default là giá trị docs chốt (§3.3).
  timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  color_mode text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_preferences_locale_check CHECK (locale IN ('en', 'vi')),
  CONSTRAINT user_preferences_timezone_shape_check CHECK (length(timezone) > 0),
  CONSTRAINT user_preferences_color_mode_check CHECK (color_mode IN ('system', 'light', 'dark'))
);

COMMENT ON TABLE account.user_preferences IS
  'Identity-owned display preferences: locale, timezone, color_mode. Typed columns, not JSONB - a stable contract read by several services.';
COMMENT ON COLUMN account.user_preferences.locale IS
  'Closed allowlist en | vi. Unknown values are rejected, never silently fallen back (FR-008a). No DB default: the Accept-Language-derived default is applied once at account creation (FR-008c, app-side).';
COMMENT ON COLUMN account.user_preferences.timezone IS
  'IANA TZ name stored as text. IANA validation is app-layer; the DB only enforces non-empty. Default Asia/Ho_Chi_Minh per 01-architecture.md 3.3.';
COMMENT ON COLUMN account.user_preferences.color_mode IS
  'Theme preference. Default system per 01-architecture.md 3.3.';

-- ---------------------------------------------------------------------------
-- notification_preferences — ý định của user, không phải delivery state
-- ---------------------------------------------------------------------------
--
-- PRIMARY KEY (user_sub, channel) vừa là ràng buộc "một intent cho mỗi cặp"
-- vừa là index tra cứu "mọi kênh của một sub" (prefix `user_sub`) — không cần
-- index nào khác, và không surrogate id cho cùng lý do với `user_profiles`.
CREATE TABLE IF NOT EXISTS account.notification_preferences (
  user_sub text NOT NULL REFERENCES account.users (sub) ON DELETE RESTRICT,
  -- Taxonomy kênh là quyết định v1 (docs chưa chốt): hai cơ chế delivery tồn
  -- tại hôm nay. Thêm kênh (vd. sms) là forward-fix kèm quyết định contract.
  channel text NOT NULL,
  -- Ý định của user cho kênh này. Bảng TRUNG TÍNH với chính sách ghi: opt-in
  -- hay opt-out, row tạo lúc nào — đó là quyết định của PR2/PR4, không mã hoá
  -- ở đây. KHÔNG cột device/subscription/delivery state (§3.4): thứ đó thuộc
  -- `push` và `web-push-notification-job`.
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_preferences_channel_check CHECK (channel IN ('email', 'push')),
  -- Ràng buộc + index tra cứu được tuyên bố ở phần nhận xét bảng phía trên:
  -- "một intent cho mỗi cặp" và tra cứu prefix `user_sub` không cần index nào
  -- khác. (Bổ sung sau OCR review — DDL ban đầu thiếu PK dù comment đã nêu.)
  PRIMARY KEY (user_sub, channel)
);

COMMENT ON TABLE account.notification_preferences IS
  'User intent per notification channel. Never a device list, subscription or delivery state - those belong to the push services (01-architecture.md 3.4).';
COMMENT ON COLUMN account.notification_preferences.channel IS
  'Delivery channel. v1 taxonomy: email | push, the only two delivery mechanisms on the platform today.';
COMMENT ON COLUMN account.notification_preferences.enabled IS
  'Whether the user allows this channel. The table is neutral on opt-in vs opt-out write semantics; that is a product decision, not a schema one.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--
-- Grant nằm ở file tạo bảng — cùng luật với `0005`/`0006` (`0002` không có
-- default privilege cho bảng mới). Cả ba bảng thuộc nhóm (2) của §7.1 — bị xoá
-- hoặc anonymize khi account bị xoá — nên DELETE là thao tác hợp lệ của luồng
-- xoá account; không bảng nào trong ba là append-only hay tombstone.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE account.user_profiles TO ecoma_account_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE account.user_preferences TO ecoma_account_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE account.notification_preferences TO ecoma_account_runtime;

COMMIT;
