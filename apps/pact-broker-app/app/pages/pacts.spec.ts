/**
 * Colocated spec đầu tiên của một trang dữ liệu — hợp đồng render của trang
 * Pacts trên catalog thật và BFF stub thật. Trang là một state machine nhỏ,
 * và từng nhánh là một quyết định sản phẩm:
 *
 * - `503` từ BFF là **unavailable**, không phải lỗi lần tải — người dùng thấy
 *   trạng thái tạm dừng, không phải nút "thử lại" vô nghĩa.
 * - Lỗi khác của API là **error** kèm nút retry.
 * - `MAX_ROWS = 100` là giới hạn hiển thị phía trang (quan sát, không phân
 *   trang) — cắt đúng số row và **ghi lại** tổng số bị cắt.
 * - Khác biệt "rỗng thật" (`_embedded` trống) với "shape lạ" (không phải
 *   `_embedded.matrix`) là cùng một nhánh empty — trang không vỡ với HAL body
 *   bất thường.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import PactsPage from './pacts.vue';
import { flush, mountPactBrokerPage, stubFetch, type FetchEndpoint } from '../../tests/harness';

function matrixBody(rows: object[]): FetchEndpoint {
  return { path: '/api/broker/pacts', status: 200, body: { _embedded: { matrix: rows } } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pacts page — BFF states', () => {
  it('renders the table rows for a populated matrix', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([
        matrixBody([
          {
            consumer: { name: 'svc-a' },
            provider: { name: 'svc-b' },
            consumerVersion: { number: '1.2.3' },
          },
          {
            consumer: { name: 'svc-c' },
            provider: { name: 'svc-d' },
            consumerVersion: { number: '2.0.0' },
          },
        ]),
      ]),
    );

    const wrapper = await mountPactBrokerPage(PactsPage);
    await flush();

    expect(wrapper.find('[data-testid="pact-broker-pacts-table"]').exists()).toBe(true);
    expect(wrapper.findAll('tbody tr')).toHaveLength(2);
    expect(wrapper.text()).toContain('svc-a');
    expect(wrapper.text()).toContain('svc-d');
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

  it('does not crash on an unexpected HAL shape and shows the empty state', async () => {
    // `_embedded` thiếu hay không phải mảng đều rơi về `[]` — shape lạ của API
    // là dữ liệu hiển thị trống, không phải exception trắng trang.
    vi.stubGlobal(
      'fetch',
      stubFetch([{ path: '/api/broker/pacts', status: 200, body: { _embedded: {} } }]),
    );

    const wrapper = await mountPactBrokerPage(PactsPage);
    await flush();

    expect(wrapper.find('[data-testid="pact-broker-pacts-table"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('renders fallback dashes for rows whose fields are not strings', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([matrixBody([{ consumer: { name: 42 }, provider: null, consumerVersion: {} }])]),
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
    const rows = Array.from({ length: 120 }, (_, index) => ({
      consumer: { name: `svc-${index}` },
      provider: { name: 'provider' },
      consumerVersion: { number: '1.0.0' },
    }));
    let fetchBodyLength = -1;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        // HAL embedding dùng tiền tố gạch dưới theo đặc tả — không thể tránh,
        // nên chuỗi truy cập đi qua chỉ mục thay vì thuộc tính.
        const payload = JSON.stringify({ _embedded: { matrix: rows } });
        const root = JSON.parse(payload) as {
          readonly [key: string]: { readonly matrix?: readonly unknown[] } | undefined;
        };
        fetchBodyLength = root['_embedded']?.matrix?.length ?? 0;
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
