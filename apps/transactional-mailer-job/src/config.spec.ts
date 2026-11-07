import { describe, expect, it } from 'vitest';

import {
  CLOUDFLARE_SENDER_ADDRESS,
  loadMailerJobConfig,
  MailerJobConfigError,
  SEND_EMAIL_BINDING_NAME,
} from './config';

/**
 * Env tối thiểu hợp lệ cho loader — từng test override đúng biến cần kiểm.
 * Provider `fake` để không cần credential endpoint/token/from.
 */
function baseEnv(): Record<string, string> {
  return {
    MAIL_PROVIDER_KIND: 'fake',
    MAIL_PROVIDER_TIMEOUT_MS: '10000',
    MAIL_JOB_MAX_EXECUTION_ATTEMPTS: '4',
    MAIL_JOB_EXECUTION_LEASE_MS: '30000',
    MAIL_JOB_REPORT_LEASE_MS: '10000',
    MAIL_JOB_MAX_REPORT_ATTEMPTS: '5',
    MAIL_JOB_SWEEP_BATCH_LIMIT: '20',
    MAIL_JOB_PROVIDER_CALL_SAFE_WINDOW_MS: '86400000',
    MAIL_QUARANTINE_HMAC_KEY: 'a'.repeat(64),
  };
}

describe('execution lease vs provider timeout cross-check', () => {
  it('accepts an execution lease exactly one ms above the provider timeout', () => {
    // Biên `>` là giá trị nhỏ nhất vẫn hợp lệ — loader chặn ở `<=`, một đảo dấu hay
    // hạ bất đẳng thức xuống `<` sẽ làm test này đỏ.
    const config = loadMailerJobConfig({
      ...baseEnv(),
      MAIL_PROVIDER_TIMEOUT_MS: '10000',
      MAIL_JOB_EXECUTION_LEASE_MS: '10001',
    });
    expect(config.executionLeaseMs).toBe(10_001);
  });

  it('rejects an execution lease equal to the provider timeout', () => {
    // Ghim bất đẳng thức gia hạn §9.2.1 ở loader: `mail-provider-port` dựng deadline của
    // một request provider bằng `min(now + providerTimeoutMs, lease_expires_at)` (protected
    // overlap giữa các generation). Lease == trần chờ sập deadline về lease expiry — không
    // còn chỗ cho một lời gọi trọn vẹn: mọi request bị cắt ngắn ở lease expiry, theo
    // contract adapter (`deadlineMs <= now`) trả `rejected`/`retryable` ⇒ RETRY, chưa bao
    // giờ tới làn ambiguity. Chặn ở boot, message chỉ nêu tên env var.
    expect(() =>
      loadMailerJobConfig({
        ...baseEnv(),
        MAIL_PROVIDER_TIMEOUT_MS: '10000',
        MAIL_JOB_EXECUTION_LEASE_MS: '10000',
      }),
    ).toThrow(MailerJobConfigError);
  });

  it('rejects an execution lease smaller than the provider timeout', () => {
    // Cùng bất đẳng thức gia hạn §9.2.1 — lease nhỏ hơn trần chờ thì mọi request provider
    // bị cắt với `rejected`/`retryable` ⇒ RETRY; cấu hình vô nghĩa phải chết ở boot.
    expect(() =>
      loadMailerJobConfig({
        ...baseEnv(),
        MAIL_PROVIDER_TIMEOUT_MS: '30000',
        MAIL_JOB_EXECUTION_LEASE_MS: '10000',
      }),
    ).toThrow(MailerJobConfigError);
  });
});

describe('cloudflare provider branch', () => {
  /** Binding `send_email` hình dạng thật ở runtime Workers — chỉ cần `.send` là function. */
  const fakeBinding: Record<string, unknown> = {
    send: () => Promise.resolve({ messageId: 'cf-msg-1' }),
  };

  function cloudflareEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...baseEnv(),
      MAIL_PROVIDER_KIND: 'cloudflare',
      MAIL_CF_SENDER: CLOUDFLARE_SENDER_ADDRESS,
      [SEND_EMAIL_BINDING_NAME]: fakeBinding,
      ...overrides,
    };
  }

  it('loads a cloudflare provider with the pinned sender and the timeout', () => {
    const config = loadMailerJobConfig(cloudflareEnv());

    expect(config.provider).toEqual({
      kind: 'cloudflare',
      cloudflare: { sender: CLOUDFLARE_SENDER_ADDRESS, timeoutMs: 10_000 },
    });
  });

  it('rejects a sender that differs from the pinned address', () => {
    // Hai lớp chặn (config + `allowed_sender_addresses` của binding wrangler) phải nói
    // cùng một sự thật — loader là nơi phát hiện lệch sớm nhất, ở boot chứ không phải
    // ở lần gửi đầu tiên.
    expect(() => loadMailerJobConfig(cloudflareEnv({ MAIL_CF_SENDER: 'me@ecoma.io' }))).toThrow(
      MailerJobConfigError,
    );
  });

  it('fails closed when the send_email binding is absent or lacks send()', () => {
    // KHÔNG fallback sang Resend: binding thiếu là cấu hình sai, tự chuyển kênh gửi là
    // đường gửi mail qua kênh không ai review.
    expect(() =>
      loadMailerJobConfig(cloudflareEnv({ [SEND_EMAIL_BINDING_NAME]: undefined })),
    ).toThrow(MailerJobConfigError);
    expect(() =>
      loadMailerJobConfig(cloudflareEnv({ [SEND_EMAIL_BINDING_NAME]: { send: 'nope' } })),
    ).toThrow(MailerJobConfigError);
    expect(() => loadMailerJobConfig(cloudflareEnv({ [SEND_EMAIL_BINDING_NAME]: {} }))).toThrow(
      MailerJobConfigError,
    );
  });

  it('rejects Resend credentials present next to the cloudflare provider', () => {
    // Credential production đứng cạnh provider không dùng nó là dấu hiệu môi trường nhầm
    // lẫn (cùng quy tắc leak với nhánh fake) — chết ở boot, thông báo chỉ nêu tên biến.
    expect(() =>
      loadMailerJobConfig(cloudflareEnv({ MAIL_PROVIDER_ENDPOINT: 'https://api.resend.com' })),
    ).toThrow(MailerJobConfigError);
    expect(() =>
      loadMailerJobConfig(cloudflareEnv({ MAIL_PROVIDER_TOKEN: 're_secret_x' })),
    ).toThrow(MailerJobConfigError);
  });

  it('rejects an unknown provider kind instead of defaulting', () => {
    // Fail-closed, không default ngầm (§3): thiếu hoặc sai kind là lỗi khởi động.
    expect(() => loadMailerJobConfig({ ...baseEnv(), MAIL_PROVIDER_KIND: undefined })).toThrow(
      MailerJobConfigError,
    );
    expect(() => loadMailerJobConfig({ ...baseEnv(), MAIL_PROVIDER_KIND: 'mailgun' })).toThrow(
      MailerJobConfigError,
    );
  });

  it('accepts the resend branch unchanged beside the cloudflare branch', () => {
    // Adapter Resend giữ nguyên vai trò phụ — kind=resend vẫn là đường hợp lệ, thêm
    // cloudflare không được phá nhánh cũ.
    const config = loadMailerJobConfig({
      ...baseEnv(),
      MAIL_PROVIDER_KIND: 'resend',
      MAIL_PROVIDER_ENDPOINT: 'https://api.resend.example',
      MAIL_PROVIDER_TOKEN: 're_token',
      MAIL_PROVIDER_FROM: 'no-reply@ecoma.io',
    });

    expect(config.provider.kind).toBe('resend');
  });
});
