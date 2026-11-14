/**
 * Colocated spec của trang Verifications (issue #208) — hợp đồng render trên
 * catalog thật và BFF stub thật:
 *
 * - Trang đọc cùng ma trận HAL của `/api/broker/pacts` (BFF compose), nhóm
 *   theo provider cho consumer đang chọn và hiện verification **mới nhất**
 *   theo `verifiedAt` khi một provider có nhiều row.
 * - 503 ⇒ unavailable; lỗi khác ⇒ error; rỗng ⇒ empty.
 * - Shape lạ không làm trang vỡ.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pactBrokerMessages } from '../i18n/catalogs';
import VerificationsPage from './verifications.vue';
import { flush, mountPactBrokerPage, stubFetch, type FetchEndpoint } from '../../tests/harness';

const verificationTexts = {
  success: pactBrokerMessages.en.pacts.verificationSuccess,
  failed: pactBrokerMessages.en.pacts.verificationFailed,
  none: pactBrokerMessages.en.pacts.verificationNone,
} as const;

function matrixEndpoint(rows: object[]): FetchEndpoint {
  return { path: '/api/broker/pacts', status: 200, body: { matrix: rows } };
}

function row(overrides: {
  consumerName: string;
  version: string;
  providerName: string;
  success?: boolean;
  verifiedAt?: string;
}): object {
  return {
    consumer: { name: overrides.consumerName, version: { number: overrides.version } },
    provider: { name: overrides.providerName },
    pact: { createdAt: '2026-11-13T00:00:00Z' },
    verificationResult:
      overrides.success === undefined
        ? null
        : {
            success: overrides.success,
            verifiedAt: overrides.verifiedAt ?? '2026-11-13T01:00:00Z',
          },
  };
}

async function mountWith(endpoints: FetchEndpoint[]) {
  vi.stubGlobal('fetch', stubFetch(endpoints));
  const wrapper = await mountPactBrokerPage(VerificationsPage);
  await flush();
  return wrapper;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('verifications page — latest result per provider', () => {
  it('renders one row per provider with the verification outcome and timestamp', async () => {
    const wrapper = await mountWith([
      matrixEndpoint([
        row({ consumerName: 'svc-a', version: '1.0.0', providerName: 'svc-b', success: true }),
        row({ consumerName: 'svc-a', version: '1.0.0', providerName: 'svc-c', success: false }),
        row({ consumerName: 'svc-a', version: '1.0.0', providerName: 'svc-d' }),
      ]),
    ]);

    expect(wrapper.find('[data-testid="pact-broker-verifications-table"]').exists()).toBe(true);
    expect(wrapper.findAll('tbody tr')).toHaveLength(3);
    const text = wrapper.text();
    expect(text).toContain(verificationTexts.success);
    expect(text).toContain(verificationTexts.failed);
    expect(text).toContain(verificationTexts.none);
    expect(text).toContain('2026-11-13T01:00:00Z');
    wrapper.unmount();
  });

  it('picks the latest verifiedAt row when a provider has several consumer versions', async () => {
    const wrapper = await mountWith([
      matrixEndpoint([
        row({
          consumerName: 'svc-a',
          version: '1.0.0',
          providerName: 'svc-b',
          success: true,
          verifiedAt: '2026-11-12T00:00:00Z',
        }),
        row({
          consumerName: 'svc-a',
          version: '2.0.0',
          providerName: 'svc-b',
          success: false,
          verifiedAt: '2026-11-13T00:00:00Z',
        }),
      ]),
    ]);

    // Verification mới nhất (13/11, failed) thắng — không phải row cũ (passed).
    // Assert trong tbody: header "Verified at" chứa chuỗi "Verified" nên
    // not-toContain trên toàn trang luôn sai.
    const outcomeText = wrapper.find('tbody').text();
    expect(outcomeText).toContain(verificationTexts.failed);
    expect(outcomeText).not.toContain(verificationTexts.success);
    wrapper.unmount();
  });

  it('treats a 503 from the BFF as unavailable instead of an error with retry', async () => {
    const wrapper = await mountWith([{ path: '/api/broker/pacts', status: 503, body: {} }]);

    expect(wrapper.find('[data-testid="pact-broker-verifications-table"]').exists()).toBe(false);
    expect(wrapper.findAll('button')).toHaveLength(0);
    wrapper.unmount();
  });

  it('renders an error with a retry control for a non-503 API failure', async () => {
    const wrapper = await mountWith([{ path: '/api/broker/pacts', status: 500, body: null }]);

    expect(wrapper.find('[data-testid="pact-broker-verifications-table"]').exists()).toBe(false);
    expect(wrapper.findAll('button').length).toBeGreaterThanOrEqual(1);
    wrapper.unmount();
  });

  it('shows the empty state for an empty matrix', async () => {
    const wrapper = await mountWith([matrixEndpoint([])]);

    expect(wrapper.find('[data-testid="pact-broker-verifications-table"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('does not crash on an unexpected body shape', async () => {
    const wrapper = await mountWith([
      { path: '/api/broker/pacts', status: 200, body: { unexpected: true } },
    ]);

    expect(wrapper.find('[data-testid="pact-broker-verifications-table"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
