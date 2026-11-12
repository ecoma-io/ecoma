/**
 * Unit test của aggregation readiness — port của 5 test Rust
 * `src/readiness.rs` (`#[cfg(test)] mod tests`): aggregation `is_ready`,
 * thứ tự `failures` và nhãn tiếng Anh. Đường mạng (probe thật qua pool) không
 * thuộc unit layer — nó được đo ở suite integration.
 */
import { describe, expect, it } from 'vitest';

import { BINDING_GATEWAY, BINDING_MARKETPLACE, BINDING_TENANT } from './env';
import {
  BINDING_STATUS_LABELS,
  failures,
  isReady,
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
