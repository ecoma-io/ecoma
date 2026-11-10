-- 0004_api_key_trusted_ci.sql — trusted_ci flag on api_keys (P4.4, issue #462).
--
-- Them cot `trusted_ci` vao bang `remote_cache.api_keys` de phan biet
-- credential CI (tu fork/PR — khong duoc phep ghi) va credential thuong
-- (duoc phep ghi neu co scope `write`).
--
-- `trusted_ci = true`: key duoc cap cho CI co tin cahy (push vao nhanh chinh,
-- pipeline duoc duy tri boi don vi) — duoc phep ghi neu co scope `write`.
-- `trusted_ci = false`: key tu CI khong tin cahy (fork PR, PR tu ngoai) — chi
-- duoc doc, khong bao giờ duoc phep ghi (P4.4 fork/PR write protection).
--
-- Cot mac dinh la `false` (fail-closed): moi key moi tao la khong tin cahy cho
-- den khi duoc cap nhat rang buoc o control plane.

BEGIN;

ALTER TABLE remote_cache.api_keys
  ADD COLUMN IF NOT EXISTS trusted_ci boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN remote_cache.api_keys.trusted_ci IS
  'A boolean flag marking the key as a trusted CI credential (true) or not (false).
   Untrusted keys are read-only, never writable (P4.4 fork/PR write protection).
   Defaults to false for fail-closed security.';

COMMIT;
