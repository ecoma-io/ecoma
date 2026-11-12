/**
 * Unit test của aggregation readiness — port của 5 test Rust
 * `src/readiness.rs` (`#[cfg(test)] mod tests`): aggregation `is_ready`,
 * thứ tự `failures` và nhãn tiếng Anh, cộng phần mapping lỗi→trạng thái của
 * probe (deadline/overload/error) với `withClient` bị mock — đường mạng thật
 * (probe qua workerd + PostgreSQL) thuộc suite integration.
 */
import { type Mock, describe, expect, it, vi } from 'vitest';

import { BINDING_GATEWAY, BINDING_MARKETPLACE, BINDING_TENANT, type LlmApiEnv } from './env';
import {
  createBindingLimiters,
  OperationDeadlineError,
  QueueCapacityExceededError,
  withClient,
} from './connections';
import {
  BINDING_STATUS_LABELS,
  failures,
  isReady,
  probeReadiness,
  READINESS_DEADLINE_MS,
  type BindingStatus,
  type ReadinessReport,
} from './readiness';

function report(
  gateway: BindingStatus,
  tenant: BindingStatus,
  marketplace: BindingStatus,
): ReadinessReport {
  return { gateway, tenant, marketplace };
}

describe('readiness report', () => {
  it('is ready only when all three bindings are ready', () => {
    expect(isReady(report('ready', 'ready', 'ready'))).toBe(true);
  });

  it('any non-ready binding fails the whole report', () => {
    expect(isReady(report('ready', 'timeout', 'ready'))).toBe(false);
  });

  it('timed out binding is reported with its name in declaration order', () => {
    const failed = failures(report('ready', 'missing', 'timeout'));
    expect(failed).toHaveLength(2);
    expect(failed[0]).toEqual([BINDING_TENANT, 'missing']);
    expect(failed[1]).toEqual([BINDING_MARKETPLACE, 'timeout']);
  });

  it('ready report has no failures', () => {
    expect(failures(report('ready', 'ready', 'ready'))).toHaveLength(0);
  });
});

describe('binding status labels', () => {
  it('are English runtime words', () => {
    expect(BINDING_STATUS_LABELS.ready).toBe('ready');
    expect(BINDING_STATUS_LABELS.unavailable).toBe('unavailable');
    expect(BINDING_STATUS_LABELS.missing).toBe('missing');
    expect(BINDING_STATUS_LABELS.timeout).toBe('timeout');
  });

  it('keep the gateway binding name wired to wrangler.jsonc', () => {
    // Tên binding khớp chính xác `wrangler.jsonc` — đổi một phía là phải đổi
    // cả hai phía cùng lúc (hợp đồng đóng băng của Issue #22).
    expect(BINDING_GATEWAY).toBe('DB_LLM_GATEWAY');
    expect(BINDING_TENANT).toBe('DB_LLM_TENANT');
    expect(BINDING_MARKETPLACE).toBe('DB_LLM_MARKETPLACE');
  });
});

/**
 * Mapping lỗi probe → trạng thái readiness. `withClient` bị mock — limiter
 * giữ bản thật (probe gọi qua nó nhưng mock không dùng limiter).
 */
vi.mock('./connections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./connections')>();
  return {
    ...actual,
    withClient: vi.fn<(...args: Parameters<typeof withClient>) => Promise<unknown>>(),
  };
});
const withClientMock = withClient as unknown as Mock;

function hyperdriveEnv(): LlmApiEnv {
  return {
    DB_LLM_GATEWAY: { connectionString: 'postgresql://gateway.invalid/db-llm-gateway' },
    DB_LLM_TENANT: { connectionString: 'postgresql://tenant.invalid/db-llm-tenant' },
    DB_LLM_MARKETPLACE: { connectionString: 'postgresql://marketplace.invalid/db-llm-marketplace' },
  };
}

describe('probe error mapping', () => {
  it('maps an operation deadline to the timeout status and keeps other bindings ready', async () => {
    // Probe gateway gọi đầu (thứ tự BINDING_NAMES) — deadline hết ở gateway;
    // hai binding còn lại khỏe. Chỉ gateway timeout, không lan (fail-closed
    // per-binding, đúng semantics Rust).
    withClientMock
      .mockRejectedValueOnce(new OperationDeadlineError())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const outcome = await probeReadiness(hyperdriveEnv(), createBindingLimiters());
    expect(outcome.gateway).toBe('timeout');
    expect(outcome.tenant).toBe('ready');
    expect(outcome.marketplace).toBe('ready');
    expect(isReady(outcome)).toBe(false);
    // Deadline operation được truyền xuống withClient cho từng probe.
    for (const invocation of withClientMock.mock.calls) {
      expect(invocation[2]?.deadlineMs).toBe(READINESS_DEADLINE_MS);
    }
  });

  it('maps admission overload to unavailable, not to timeout', async () => {
    // Queue admission đầy là `unavailable` — khác `timeout` của deadline;
    // hai nhãn khác nhau của hợp đồng readiness (review P2 của PR #152).
    withClientMock
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new QueueCapacityExceededError())
      .mockResolvedValueOnce({ rows: [] });
    const outcome = await probeReadiness(hyperdriveEnv(), createBindingLimiters());
    expect(outcome.gateway).toBe('ready');
    expect(outcome.tenant).toBe('unavailable');
    expect(outcome.marketplace).toBe('ready');
  });

  it('maps any other probe failure to unavailable', async () => {
    withClientMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('connection refused'));
    const outcome = await probeReadiness(hyperdriveEnv(), createBindingLimiters());
    expect(outcome.marketplace).toBe('unavailable');
    expect(isReady(outcome)).toBe(false);
  });

  it('reports a binding missing from env without probing it', async () => {
    withClientMock.mockClear();
    withClientMock.mockResolvedValue({ rows: [] });
    const env = hyperdriveEnv();
    const outcome = await probeReadiness(
      { DB_LLM_GATEWAY: env.DB_LLM_GATEWAY },
      createBindingLimiters(),
    );
    expect(outcome.gateway).toBe('ready');
    expect(outcome.tenant).toBe('missing');
    expect(outcome.marketplace).toBe('missing');
    // Chỉ binding có mặt trong env được probe.
    expect(withClientMock).toHaveBeenCalledTimes(1);
  });
});
