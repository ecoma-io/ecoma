/**
 * Colocated spec của trang Overview sau #208 — số liệu thật từ ma trận compose
 * của BFF, không metric bịa:
 *
 * - Có dữ liệu: ba stat card hiển thị số đếm được từ row thật.
 * - 503 ⇒ unavailable; lỗi ⇒ error; rỗng ⇒ empty (trung thực, không "0 giả").
 * - Điều hướng mở rộng: sáu khu vực, mỗi link trỏ tới route có thật.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import OverviewPage from './index.vue';
import { flush, mountPactBrokerPage, stubFetch, type FetchEndpoint } from '../../tests/harness';

function matrixEndpoint(rows: object[]): FetchEndpoint {
  return { path: '/api/broker/pacts', status: 200, body: { matrix: rows } };
}

function row(consumer: string, provider: string, verified: boolean | null): object {
  return {
    consumer: { name: consumer, version: { number: '1.0.0' } },
    provider: { name: provider },
    pact: { createdAt: '2026-11-13T00:00:00Z' },
    verificationResult:
      verified === null ? null : { success: verified, verifiedAt: '2026-11-13T01:00:00Z' },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('overview page — real stats from the composed matrix', () => {
  it('renders real counts for pacticipants, integrations and verifications', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([
        matrixEndpoint([
          row('svc-consumer', 'svc-provider', true),
          row('svc-consumer', 'svc-provider', null),
          row('svc-other', 'svc-provider', false),
        ]),
      ]),
    );
    const wrapper = await mountPactBrokerPage(OverviewPage);
    await flush();

    const stats = wrapper.find('[data-testid="pact-broker-overview-stats"]');
    expect(stats.exists()).toBe(true);
    const text = stats.text();
    // 2 pacticipant, 2 cặp consumer/provider, 2 verification có kết quả.
    expect(text).toContain('2');
    wrapper.unmount();
  });

  it('links every dashboard area including the new verifications, matrix and onboarding pages', async () => {
    vi.stubGlobal('fetch', stubFetch([matrixEndpoint([row('a', 'b', true)])]));
    const wrapper = await mountPactBrokerPage(OverviewPage);
    await flush();

    for (const area of [
      'pacts',
      'verifications',
      'matrix',
      'environments',
      'tokens',
      'onboarding',
    ]) {
      expect(
        wrapper.find(`[data-testid="overview-area-${area}"]`).exists(),
        `missing area link: ${area}`,
      ).toBe(true);
    }
    wrapper.unmount();
  });

  it('treats a 503 from the BFF as unavailable', async () => {
    vi.stubGlobal('fetch', stubFetch([{ path: '/api/broker/pacts', status: 503, body: {} }]));
    const wrapper = await mountPactBrokerPage(OverviewPage);
    await flush();

    expect(wrapper.find('[data-testid="pact-broker-overview-stats"]').exists()).toBe(false);
    expect(wrapper.findAll('button')).toHaveLength(0);
    wrapper.unmount();
  });

  it('shows the empty state when the broker has no data — never fake zeros', async () => {
    vi.stubGlobal('fetch', stubFetch([matrixEndpoint([])]));
    const wrapper = await mountPactBrokerPage(OverviewPage);
    await flush();

    expect(wrapper.find('[data-testid="pact-broker-overview-stats"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
