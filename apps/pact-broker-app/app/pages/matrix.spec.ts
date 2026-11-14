/**
 * Colocated spec của trang Matrix (issue #208) — hợp đồng render trên catalog
 * thật và BFF stub thật:
 *
 * - Tri-state verdict là ý nghĩa cốt lõi: `deployable: true`/`false`/`null`
 *   hiển thị bằng **ba** văn bản catalog khác nhau; unknown (null) KHÔNG được
 *   hiện như pass (domain-model §2.3).
 * - Form vô hiệu hoá khi thiếu pacticipant/version.
 * - 503 của BFF ⇒ unavailable; lỗi khác ⇒ error kèm retry.
 * - Body shape lạ của API không được làm trang vỡ.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pactBrokerMessages } from '../i18n/catalogs';
import MatrixPage from './matrix.vue';
import { flush, mountPactBrokerPage, stubFetch, type FetchEndpoint } from '../../tests/harness';

const verdictTexts = {
  deployable: pactBrokerMessages.en.matrix.verdict.deployable,
  notDeployable: pactBrokerMessages.en.matrix.verdict['not-deployable'],
  unknown: pactBrokerMessages.en.matrix.verdict.unknown,
} as const;

function pacticipantsEndpoint(names: string[]): FetchEndpoint {
  return {
    path: '/api/broker/pacticipants',
    status: 200,
    body: { _embedded: { pacticipants: names.map((name) => ({ name })) } },
  };
}

function canIDeployEndpoint(deployable: boolean | null, rows: object[]): FetchEndpoint {
  return {
    path: '/api/broker/can-i-deploy',
    status: 200,
    body: { summary: { deployable }, matrix: rows },
  };
}

function matrixRow(
  consumerName: string,
  version: string,
  providerName: string,
  success?: boolean,
): object {
  return {
    consumer: { name: consumerName, version: { number: version } },
    provider: { name: providerName },
    pact: { createdAt: '2026-11-13T00:00:00Z' },
    verificationResult:
      success === undefined ? null : { success, verifiedAt: '2026-11-13T01:00:00Z' },
  };
}

async function mountWith(endpoints: FetchEndpoint[]) {
  vi.stubGlobal('fetch', stubFetch(endpoints));
  const wrapper = await mountPactBrokerPage(MatrixPage);
  await flush();
  return wrapper;
}

/** Điền form và submit — đi qua DOM thật của trang, không đụng internal. */
async function askVerdict(wrapper: Awaited<ReturnType<typeof mountWith>>): Promise<void> {
  stubCsrfCookie();
  await wrapper.find('[data-testid="pact-broker-matrix-pacticipant"]').setValue('svc-a');
  await wrapper.find('[data-testid="pact-broker-matrix-version"]').setValue('1.0.0');
  await wrapper.find('form').trigger('submit.prevent');
  await flush();
}

const csrfMissingText = pactBrokerMessages.en.tokens.csrfMissing;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // `document.cookie` là state jsdom dùng chung — xoá cookie CSRF giữa các test.
  document.cookie = '__Host-pact-broker-csrf=; Max-Age=0; Path=/; Secure';
});

/**
 * Cài cookie CSRF double-submit như runtime thật (cùng pattern tokens.spec.ts).
 * jsdom enforce prefix `__Host-`: thiếu `Secure` thì phép gán bị từ chối lặng lẽ.
 */
function stubCsrfCookie(): void {
  document.cookie = '__Host-pact-broker-csrf=csrf-test-token; Path=/; Secure';
}

describe('matrix page — verdict tri-state', () => {
  it('shows the deployable verdict and the matrix rows for deployable: true', async () => {
    const wrapper = await mountWith([
      pacticipantsEndpoint(['svc-a']),
      canIDeployEndpoint(true, [matrixRow('svc-a', '1.0.0', 'svc-b', true)]),
    ]);
    await askVerdict(wrapper);

    expect(wrapper.find('[data-testid="pact-broker-matrix-verdict"]').text()).toContain(
      verdictTexts.deployable,
    );
    expect(wrapper.find('[data-testid="pact-broker-matrix-table"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('svc-b');
    wrapper.unmount();
  });

  it('shows the not-deployable verdict for deployable: false — distinct text', async () => {
    const wrapper = await mountWith([
      pacticipantsEndpoint(['svc-a']),
      canIDeployEndpoint(false, [matrixRow('svc-a', '1.0.0', 'svc-b', false)]),
    ]);
    await askVerdict(wrapper);

    const verdictText = wrapper.find('[data-testid="pact-broker-matrix-verdict"]').text();
    expect(verdictText).toContain(verdictTexts.notDeployable);
    expect(verdictText).not.toContain(verdictTexts.deployable);
    wrapper.unmount();
  });

  it('shows unknown for deployable: null — never rendered as pass', async () => {
    const wrapper = await mountWith([
      pacticipantsEndpoint(['svc-a']),
      canIDeployEndpoint(null, [matrixRow('svc-a', '1.0.0', 'svc-b')]),
    ]);
    await askVerdict(wrapper);

    const verdictText = wrapper.find('[data-testid="pact-broker-matrix-verdict"]').text();
    expect(verdictText).toContain(verdictTexts.unknown);
    expect(verdictText).not.toContain(verdictTexts.deployable);
    // Row của unknown verification hiển thị đúng trạng thái "chưa verify".
    expect(wrapper.find('[data-testid="pact-broker-matrix-table"]').text()).toContain(
      pactBrokerMessages.en.pacts.verificationNone,
    );
    wrapper.unmount();
  });

  it('disables the submit control while pacticipant or version is missing', async () => {
    const wrapper = await mountWith([pacticipantsEndpoint(['svc-a'])]);

    const button = wrapper.find('[data-testid="pact-broker-matrix-ask"]');
    expect(button.attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it('renders the unavailable state when the BFF is not configured', async () => {
    const wrapper = await mountWith([{ path: '/api/broker/pacticipants', status: 503, body: {} }]);

    expect(wrapper.find('[data-testid="pact-broker-matrix-form"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('renders the error state with retry for a non-503 API failure', async () => {
    const wrapper = await mountWith([
      { path: '/api/broker/pacticipants', status: 500, body: null },
    ]);

    expect(wrapper.findAll('button').length).toBeGreaterThanOrEqual(1);
    wrapper.unmount();
  });

  it('shows the POST error body message when the verdict query fails', async () => {
    const wrapper = await mountWith([
      pacticipantsEndpoint(['svc-a']),
      { path: '/api/broker/can-i-deploy', status: 400, body: { message: 'bad selector' } },
    ]);
    await askVerdict(wrapper);

    expect(wrapper.find('[data-testid="pact-broker-matrix-error"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('bad selector');
    wrapper.unmount();
  });

  it('skips the fetch and shows the error when the CSRF cookie is missing', async () => {
    const wrapper = await mountWith([pacticipantsEndpoint(['svc-a'])]);
    // Bọc fetch đã stub sau mount: GET nạp danh sách đi qua bình thường, còn
    // POST can-i-deploy được đếm để assert không bao giờ rời trang.
    const base = globalThis.fetch;
    const postCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        if (String(input).includes('/api/broker/can-i-deploy')) {
          postCalls.push(String(input));
        }
        return base(input, init);
      }),
    );

    await wrapper.find('[data-testid="pact-broker-matrix-pacticipant"]').setValue('svc-a');
    await wrapper.find('[data-testid="pact-broker-matrix-version"]').setValue('1.0.0');
    await wrapper.find('form').trigger('submit.prevent');
    await flush();

    // Fail-closed ở client: POST không rời trang, lỗi hiển thị thay vì để
    // brokerFetch dịch 401 thành redirect login.
    expect(postCalls).toHaveLength(0);
    expect(wrapper.find('[data-testid="pact-broker-matrix-error"]').exists()).toBe(true);
    expect(wrapper.text()).toContain(csrfMissingText);
    wrapper.unmount();
  });

  it('does not crash on an unexpected verdict body shape', async () => {
    const wrapper = await mountWith([
      pacticipantsEndpoint(['svc-a']),
      { path: '/api/broker/can-i-deploy', status: 200, body: { unexpected: true } },
    ]);
    await askVerdict(wrapper);

    // deployable thiếu ⇒ unknown (fail-closed hiển thị), trang không vỡ.
    expect(wrapper.find('[data-testid="pact-broker-matrix-verdict"]').text()).toContain(
      verdictTexts.unknown,
    );
    wrapper.unmount();
  });
});
