-- Durable replay protection for internal HMAC envelopes.
CREATE TABLE IF NOT EXISTS staff_access.internal_nonces (
  nonce text PRIMARY KEY,
  expires_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS internal_nonces_expires_at_idx
  ON staff_access.internal_nonces (expires_at);

GRANT SELECT, INSERT, DELETE ON staff_access.internal_nonces TO ecoma_staff_access_runtime;
