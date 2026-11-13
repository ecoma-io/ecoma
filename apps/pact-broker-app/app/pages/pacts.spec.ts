/**
 * Colocated spec đầu tiên của một trang dữ liệu — hợp đồng render của trang
 * Pacts trên catalog thật và BFF stub thật. Trang là một state machine nhỏ,
 * và từng nhánh là một quyết định sản phẩm:
 *
 * - `503` từ BFF là **unavailable**, không phải lỗi lần tải — người dùng thấy
 *   trạng thái tạm dừng, không phải nút "thử lại" vô nghĩa.
 * - Lỗi khác của API là **error** kèm nút retry.
 * - **Matrix HAL thật** (`{matrix}` ở top-level, row có `consumer.version`,
 *   `verificationResult` — issue #181): cột Verification phản chiếu đúng ba
 *   trạng thái success/failed/chưa verification.
 * - `MAX_ROWS = 100` là giới hạn hiển thị phía trang (quan sát, không phân
 *   trang) — cắt đúng số row và **ghi lại** tổng số bị cắt.
 * - Khác biệt "rỗng thật" (`matrix` trống) với "shape lạ" (không phải `matrix`
 *   array) là cùng một nhánh empty — trang không vỡ với HAL body bất thường.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { pactBrokerMessages } from '../i18n/catalogs';
import PactsPage from './pacts.vue';
import { flush, mountPactBrokerPage, stubFetch, type FetchEndpoint } from '../../tests/harness';

/** Body mà BFF trả khi composition thành công — matrix ở top-level, không _embedded. */
function matrixBody(rows: object[]): FetchEndpoint {
  return { path: '/api/broker/pacts', status: 200, body: { matrix: rows } };
}

/**
 * Row HAL mà trang đọc — kiểu cụ thể (không `object`) để fixture lệch shape là
 * lỗi compile; cùng cấu trúc mà `pacts.vue` khai trong `MatrixRow` của nó.
 */
interface MatrixRowFixture {
  consumer: { name: string; version: { number: string } };
  provider: { name: string };
  pact: { createdAt: string };
  verificationResult: { success: boolean; verifiedAt: string } | null;
}

/** Row đúng hình dạng mà `decorateMatrixRow` của API công bố. */
function matrixRow(overrides: {
  consumerName: string;
  providerName: string;
  version: string;
  verificationResult?: { success: boolean; verifiedAt: string } | null;
}): MatrixRowFixture {
  return {
    consumer: { name: overrides.consumerName, version: { number: overrides.version } },
    provider: { name: overrides.providerName },
    pact: { createdAt: '2026-11-13T00:00:00Z' },
    verificationResult: overrides.verificationResult ?? null,
  };
}

/**
 * Chuỗi verification lấy từ **catalog en thật** mà harness mount (cùng object
 * với production) — assert ngữ nghĩa "đúng key cho đúng trạng thái" mà không
 * nhân bản literal i18n vào test.
 */
const verificationTexts = {
  success: pactBrokerMessages.en.pacts.verificationSuccess,
  failed: pactBrokerMessages.en.pacts.verificationFailed,
  none: pactBrokerMessages.en.pacts.verificationNone,
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pacts page — BFF states', () => {
  it('renders consumer, provider, consumer version and the verification outcome', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([
        matrixBody([
          matrixRow({
            consumerName: 'svc-a',
            providerName: 'svc-b',
            version: '1.2.3',
            verificationResult: { success: true, verifiedAt: '2026-11-13T01:00:00Z' },
          }),
          matrixRow({
            consumerName: 'svc-c',
            providerName: 'svc-d',
            version: '2.0.0',
            verificationResult: { success: false, verifiedAt: '2026-11-13T02:00:00Z' },
          }),
          matrixRow({ consumerName: 'svc-e', providerName: 'svc-f', version: '0.1.0' }),
        ]),
      ]),
    );

    const wrapper = await mountPactBrokerPage(PactsPage);
    await flush();

    expect(wrapper.find('[data-testid="pact-broker-pacts-table"]').exists()).toBe(true);
    expect(wrapper.findAll('tbody tr')).toHaveLength(3);
    expect(wrapper.text()).toContain('svc-a');
    expect(wrapper.text()).toContain('svc-d');
    // Version nằm ở consumer.version.number — đúng shape HAL của matrix thật.
    expect(wrapper.text()).toContain('1.2.3');
    expect(wrapper.text()).toContain('2.0.0');
    // Ba trạng thái verification hiển thị bằng văn bản catalog en thật —
    // đúng key cho đúng trạng thái, không nhân bản chuỗi vào test.
    expect(wrapper.text()).toContain(verificationTexts.success);
    expect(wrapper.text()).toContain(verificationTexts.failed);
    expect(wrapper.text()).toContain(verificationTexts.none);
    wrapper.unmount();
  });

  it('treats a 503 from the BFF as unavailable instead of an error with retry', async () => {
    // 503 = BFF chưa cấu hình — nút "thử lại" không sửa được cấu hình deployment,
    // nên trang phải vào trạng thái dừng có kiểm, không phải vòng retry.
    vi.stubGlobal('fetch', stubFetch([{ path: '/api/broker/pacts', status: 503, body: {} }]));

    const wrapper = await mountPactBrokerPage(PactsPage);
    await flush();

    expect(wrapper.text()).not.toContain('pacts.title');
    expect(wrapper.find('[data-testid="pact-broker-pacts-table"]').exists()).toBe(false);
    // Không có nút retry nào ở trạng thái này.
    expect(wrapper.findAll('button')).toHaveLength(0);
    wrapper.unmount();
  });

  it('renders an error with a retry control for a non-503 API failure', async () => {
    vi.stubGlobal('fetch', stubFetch([{ path: '/api/broker/pacts', status: 500, body: null }]));

    const wrapper = await mountPactBrokerPage(PactsPage);
    await flush();

    expect(wrapper.find('[data-testid="pact-broker-pacts-table"]').exists()).toBe(false);
    // Nhánh error là nhánh duy nhất mang nút retry.
    expect(wrapper.findAll('button').length).toBeGreaterThanOrEqual(1);
    wrapper.unmount();
  });

  it('shows the empty state for an empty matrix — distinct from the table', async () => {
    vi.stubGlobal('fetch', stubFetch([matrixBody([])]));

    const wrapper = await mountPactBrokerPage(PactsPage);
    await flush();

    expect(wrapper.find('[data-testid="pact-broker-pacts-table"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('<table');
    wrapper.unmount();
  });

  it('does not crash on an unexpected body shape and shows the empty state', async () => {
    // `matrix` thiếu hay không phải mảng đều rơi về `[]` — shape lạ của API là
    // dữ liệu hiển thị trống, không phải exception trắng trang.
    vi.stubGlobal(
      'fetch',
      stubFetch([{ path: '/api/broker/pacts', status: 200, body: { unexpected: true } }]),
    );

    const wrapper = await mountPactBrokerPage(PactsPage);
    await flush();

    expect(wrapper.find('[data-testid="pact-broker-pacts-table"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('renders fallback dashes for rows whose fields are not strings', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([matrixBody([{ consumer: { name: 42 }, provider: null, version: {} }])]),
    );

    const wrapper = await mountPactBrokerPage(PactsPage);
    await flush();

    expect(wrapper.find('[data-testid="pact-broker-pacts-table"]').exists()).toBe(true);
    expect(wrapper.findAll('tbody tr')).toHaveLength(1);
    // Không field nào là number không kiểm — mọi ô hiển thị qua `nameOf`.
    expect(wrapper.find('tbody tr').text()).not.toContain('42');
    wrapper.unmount();
  });
});

describe('pacts page — MAX_ROWS display cap', () => {
  it('caps the rendered rows at 100 without changing the fetch payload', async () => {
    // 120 row từ API ⇒ trang render đúng 100 — cắt ở tầng hiển thị, và fetch
    // nhận nguyên payload (trang không giả định phân trang của API).
    const rows = Array.from({ length: 120 }, (_, index) =>
      matrixRow({
        consumerName: `svc-${index}`,
        providerName: 'provider',
        version: '1.0.0',
      }),
    );
    let fetchBodyLength = -1;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const payload = JSON.stringify({ matrix: rows });
        const root = JSON.parse(payload) as { readonly matrix?: readonly unknown[] };
        fetchBodyLength = root.matrix?.length ?? 0;
        return new Response(payload, { status: 200 });
      }),
    );

    const wrapper = await mountPactBrokerPage(PactsPage);
    await flush();

    expect(fetchBodyLength).toBe(120);
    expect(wrapper.findAll('tbody tr')).toHaveLength(100);
    wrapper.unmount();
  });
});
