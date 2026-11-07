/**
 * Unit test tầng unit cho các resolver riêng lẻ của `config-load.ts`.
 *
 * ⚠️ **Vì sao file này tồn tại bên cạnh `config.spec.ts` của app.** `config.spec.ts` (app)
 * kiểm `resolvePushNotificationConfig` **tổng thể** qua env thật — fail closed của sáu SLA,
 * coherence của FR-008. Nhưng các resolver riêng lẻ có hợp đồng mà đường tổng thể không chạm
 * tới: giá trị default của mười tham số kỹ thuật, keyring CSV parse, và đặc biệt
 * `maxIdempotencyKeyLength` là **hằng hợp đồng** không ghi đè được qua env. Test ở đây kiểm
 * từng resolver trực tiếp, không cần dựng một env hoàn chỉnh cho mỗi case.
 *
 * ⚠️ **Thông điệp lỗi không chứa giá trị** được kiểm lại ở cấp resolver: một giá trị test
 * độc đáo đưa vào env, nếu `PushConfigError` nối giá trị vào message thì test đỏ.
 */

import { describe, expect, it } from 'vitest';

import {
  CONFIG_VARIABLE,
  PushConfigError,
  assertConfigCoherence,
  resolveCredentialKeyring,
  resolveEngineering,
  resolveRuntimeMetadata,
  resolveSla,
} from './config-load';
import { readHostAllowlist, readRequiredMilliseconds } from './config-port';
import { DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST } from './records';

describe('resolveSla — the six SLA parameters have no default', () => {
  const COMPLETE = {
    IDEMPOTENCY_RETENTION_MS: '7000007',
    CALLER_RETRY_WINDOW_MS: '3000003',
    MAX_NOTIFICATION_TTL_MS: '5000005',
    PAYLOAD_DIGEST_ALGORITHM: 'none',
    OUTBOX_RECOVERY_SLA_MS: '1111111',
    DELIVERY_RECONCILIATION_AGE_MS: '2222222',
  };

  it('returns each SLA value verbatim when all six are present', () => {
    const sla = resolveSla(COMPLETE);

    expect(sla.idempotencyRetentionMs).toBe(7_000_007);
    expect(sla.callerRetryWindowMs).toBe(3_000_003);
    expect(sla.maxNotificationTtlMs).toBe(5_000_005);
    expect(sla.payloadDigestAlgorithm).toBe('none');
    expect(sla.outboxRecoverySlaMs).toBe(1_111_111);
    expect(sla.deliveryReconciliationAgeMs).toBe(2_222_222);
  });

  it('names the digest variable when the value is missing even though every number is set', () => {
    // `PAYLOAD_DIGEST_ALGORITHM` là TÊN thuật toán, không phải số — "thiếu" và "sai" cùng
    // nghĩa là "chưa có một quyết định đã chốt", cùng rơi vào PushConfigError.
    let thrown: unknown;
    try {
      resolveSla({ ...COMPLETE, PAYLOAD_DIGEST_ALGORITHM: undefined });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PushConfigError);
    expect((thrown as PushConfigError).problems).toEqual([CONFIG_VARIABLE.PayloadDigestAlgorithm]);
  });

  it('never puts a configured SLA value into the error message', () => {
    // Mỗi giá trị ở đây vừa **sai hình dạng** (đưa tên biến vào lỗi) vừa là một chuỗi độc
    // nhất; nếu thông điệp nối giá trị thô thì assert này đỏ.
    let thrown: unknown;
    try {
      resolveSla({
        IDEMPOTENCY_RETENTION_MS: '1111111x',
        CALLER_RETRY_WINDOW_MS: '2222222x',
        MAX_NOTIFICATION_TTL_MS: '3333333x',
        OUTBOX_RECOVERY_SLA_MS: '4444444x',
        DELIVERY_RECONCILIATION_AGE_MS: '5555555x',
        PAYLOAD_DIGEST_ALGORITHM: 'sha256',
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PushConfigError);
    const message = (thrown as PushConfigError).message;
    for (const value of ['1111111x', '2222222x', '3333333x', '4444444x', '5555555x']) {
      expect(message).not.toContain(value);
    }
    // `sha256` là một thuật toán hợp lệ về mặt chữ — nó không được lọt vào message như một
    // giá trị được chấp nhận ngầm.
    expect(message).not.toContain('sha256');
  });
});

describe('resolveEngineering — ten tunable parameters with defaults, one contract constant', () => {
  it('applies the documented default for every parameter when env is empty', () => {
    const engineering = resolveEngineering({});

    expect(engineering).toEqual({
      deliveryLeaseDurationMs: 60_000,
      notificationRateLimit: 600,
      notificationRateLimitWindowMs: 60_000,
      outboxBatchSize: 50,
      outboxLeaseDurationMs: 30_000,
      outboxMaxPublishAttempts: 5,
      outboxPublishBackoffMs: 5_000,
      reconciliationBatchSize: 100,
      outboxReconciliationBatchSize: 100,
      defaultMaxDeliveriesPerNotification: 100,
      maxIdempotencyKeyLength: 128,
      providerTestTimeoutMs: 5_000,
    });
  });

  it('lets env override the tunable parameters', () => {
    const engineering = resolveEngineering({
      DELIVERY_LEASE_DURATION_MS: '45000',
      OUTBOX_BATCH_SIZE: '10',
    });

    expect(engineering.deliveryLeaseDurationMs).toBe(45_000);
    expect(engineering.outboxBatchSize).toBe(10);
  });

  it('rejects a malformed override and falls back to the default', () => {
    // "Có thiết lập nhưng sai hình dạng" = chưa cấu hình đúng — dùng default, không ném:
    // engineering là lựa chọn kỹ thuật, không phải cam kết correctness.
    const engineering = resolveEngineering({
      DELIVERY_LEASE_DURATION_MS: 'not-a-number',
      OUTBOX_BATCH_SIZE: '-5',
    });

    expect(engineering.deliveryLeaseDurationMs).toBe(60_000);
    expect(engineering.outboxBatchSize).toBe(50);
  });

  it('keeps maxIdempotencyKeyLength at the contract constant regardless of env', () => {
    // FR-008 nói `Idempotency-Key` ≤ 128 và CHECK của schema cũng chặn 128. Cho nó ghi đè
    // được là mở đường chấp nhận key dài hơn hợp đồng đã công bố cho caller.
    const engineering = resolveEngineering({ IDEMPOTENCY_KEY_MAX_LENGTH: '4096' });

    expect(engineering.maxIdempotencyKeyLength).toBe(128);
  });
});

describe('resolveCredentialKeyring — serving versions must contain the current version', () => {
  it('parses a CSV list, trimming entries', () => {
    const keyring = resolveCredentialKeyring({
      CREDENTIAL_KEY_VERSION: 'K2',
      CREDENTIAL_SERVING_VERSIONS: ' K1 , K2 ,',
    });

    expect(keyring).toEqual({ currentVersion: 'K2', servingVersions: ['K1', 'K2'] });
  });

  it('fails when the current version is absent from the serving list', () => {
    // Ghi bằng K2 trong khi K2 không được phục vụ = mọi credential mới không đọc được, và
    // lỗi chỉ lộ ra ở claim — lúc đã gửi notification thật (§7.3).
    let thrown: unknown;
    try {
      resolveCredentialKeyring({ CREDENTIAL_KEY_VERSION: 'K2', CREDENTIAL_SERVING_VERSIONS: 'K1' });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PushConfigError);
    expect((thrown as PushConfigError).problems).toEqual(['CREDENTIAL_SERVING_VERSIONS']);
  });

  it('names both variables when both are missing', () => {
    let thrown: unknown;
    try {
      resolveCredentialKeyring({});
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PushConfigError);
    expect((thrown as PushConfigError).problems).toEqual([
      'CREDENTIAL_KEY_VERSION',
      'CREDENTIAL_SERVING_VERSIONS',
    ]);
  });
});

describe('resolveRuntimeMetadata — service metadata with sane defaults', () => {
  it('defaults environment to local and log level to info', () => {
    const runtime = resolveRuntimeMetadata({});

    expect(runtime).toEqual({
      service: 'push-notification',
      environment: 'local',
      logLevel: 'info',
    });
  });

  it('keeps an unknown log level at info instead of throwing', () => {
    // LOG_LEVEL sai không được làm deploy fail: observability không phải đường serving.
    const runtime = resolveRuntimeMetadata({ ENVIRONMENT: 'production', LOG_LEVEL: 'verbose' });

    expect(runtime.environment).toBe('production');
    expect(runtime.logLevel).toBe('info');
  });
});

/** Cấu hình SLA tự nhất quán — mỗi constraint test override đúng một biến. */
function coherentSla(
  overrides: Partial<Parameters<typeof resolveSla>[0]> = {},
): ReturnType<typeof resolveSla> {
  return resolveSla({
    IDEMPOTENCY_RETENTION_MS: '7000007',
    CALLER_RETRY_WINDOW_MS: '3000003',
    MAX_NOTIFICATION_TTL_MS: '5000005',
    PAYLOAD_DIGEST_ALGORITHM: 'none',
    OUTBOX_RECOVERY_SLA_MS: '1111111',
    DELIVERY_RECONCILIATION_AGE_MS: '2222222',
    ...overrides,
  });
}

describe('assertConfigCoherence — the two documented constraints of FR-008', () => {
  it('accepts a coherent configuration', () => {
    const config = {
      sla: coherentSla(),
      engineering: resolveEngineering({}),
    } as unknown as Parameters<typeof assertConfigCoherence>[0];

    expect(() => assertConfigCoherence(config)).not.toThrow();
  });

  it('throws naming both variables when retention is shorter than the retry window', () => {
    const config = {
      sla: coherentSla({ IDEMPOTENCY_RETENTION_MS: '1000001', CALLER_RETRY_WINDOW_MS: '3000003' }),
    } as unknown as Parameters<typeof assertConfigCoherence>[0];

    let thrown: unknown;
    try {
      assertConfigCoherence(config);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PushConfigError);
    const message = (thrown as PushConfigError).message;
    expect(message).toContain('IDEMPOTENCY_RETENTION_MS');
    expect(message).toContain('CALLER_RETRY_WINDOW_MS');
  });

  it('throws naming both variables when the retry window exceeds the notification TTL', () => {
    const config = {
      sla: coherentSla({ CALLER_RETRY_WINDOW_MS: '9999999' }),
    } as unknown as Parameters<typeof assertConfigCoherence>[0];

    let thrown: unknown;
    try {
      assertConfigCoherence(config);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PushConfigError);
    expect((thrown as PushConfigError).message).toContain('MAX_NOTIFICATION_TTL_MS');
  });
});

describe('env reader helpers at the config boundary', () => {
  it('readRequiredMilliseconds rejects non-integers that would fail open as NaN', () => {
    // NaN lọt xuống `expires_at` làm cổng `expires_at <= now` luôn false — đúng fail-open
    // mà FR-015 cấm. Biên cấu hình là chỗ rẻ nhất để bắt.
    expect(readRequiredMilliseconds({ X: '7000007' }, 'X')).toBe(7_000_007);
    expect(readRequiredMilliseconds({ X: '12.5' }, 'X')).toBeNull();
    expect(readRequiredMilliseconds({ X: 'abc' }, 'X')).toBeNull();
    expect(readRequiredMilliseconds({ X: '' }, 'X')).toBeNull();
    expect(readRequiredMilliseconds({ X: 123 }, 'X')).toBeNull();
  });

  it('readHostAllowlist falls back to the documented default on any malformed input', () => {
    expect(
      readHostAllowlist({}, 'PUSH_ENDPOINT_HOST_ALLOWLIST', DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST),
    ).toEqual(DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST);
    expect(
      readHostAllowlist(
        { PUSH_ENDPOINT_HOST_ALLOWLIST: 'not-json' },
        'PUSH_ENDPOINT_HOST_ALLOWLIST',
        DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
      ),
    ).toEqual(DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST);
    expect(
      readHostAllowlist(
        { PUSH_ENDPOINT_HOST_ALLOWLIST: '{"a":1}' },
        'PUSH_ENDPOINT_HOST_ALLOWLIST',
        DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
      ),
    ).toEqual(DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST);
    // Mảng rỗng = "chưa cấu hình", không phải "cho phép tất cả" — fallback về default.
    expect(
      readHostAllowlist(
        { PUSH_ENDPOINT_HOST_ALLOWLIST: '[]' },
        'PUSH_ENDPOINT_HOST_ALLOWLIST',
        DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
      ),
    ).toEqual(DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST);
    expect(
      readHostAllowlist(
        { PUSH_ENDPOINT_HOST_ALLOWLIST: '["push.example.com"]' },
        'PUSH_ENDPOINT_HOST_ALLOWLIST',
        DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
      ),
    ).toEqual(['push.example.com']);
  });
});
