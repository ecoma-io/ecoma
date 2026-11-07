-- 0009_mail_templates_seed.sql — seed catalog template cho `transactional-mail`.
--
-- Nguồn: issue #132; docs/applications/transactional-mail/02-requirements.md FR-003;
--        docs/applications/transactional-mail/01-architecture.md §4.1 (service chạy với template seed).
--
-- ⚠️ Seed tối thiểu cho đường Account → Mail: template logic `account.login-otp`
-- (apps/account/server/lib/mail.ts, `OTP_LOGIN_TEMPLATE`), locale `en` (sender mặc định
-- `locale: 'en'`), biến `code` là mã OTP 8 chữ số (`variables: { code }`).
--
-- ⚠️ `variables_schema_json` theo đúng subset FR-003: `schema_version` + `variables{name,
-- type, required, nullable?, max_length?, format?}`. `code` là chuỗi 8 ký tự, khai
-- `max_length: 8`. Subject/body chỉ dùng placeholder `{{ code }}` đã khai báo trong schema.
--
-- Idempotent: `INSERT … ON CONFLICT (id) DO NOTHING` — apply lại là no-op, đúng quy ước
-- migration forward-only. Thay đổi schema = tạo version mới, không UPDATE tại chỗ.

INSERT INTO mail_templates (id, name, locale, version, subject_template, body_template, variables_schema_json, status, created_at, updated_at)
VALUES (
  'tpl-account-login-otp-en',
  'account.login-otp',
  'en',
  1,
  'Your login code {{ code }}',
  '<p>Your login code is {{ code }}</p>',
  '{"schema_version":1,"variables":{"code":{"type":"string","required":true,"max_length":8}}}',
  'active',
  CAST(unixepoch('subsec') * 1000 AS INTEGER),
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
)
ON CONFLICT (id) DO NOTHING;