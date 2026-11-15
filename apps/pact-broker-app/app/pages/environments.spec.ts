/**
 * Colocated spec của phần mở rộng trang Environments (issue #208) — deployment
 * records qua BFF mới `/api/broker/deployments`:
 *
 * - Deployments có dữ liệu ⇒ bảng riêng với pacticipant/version/environment.
 * - `undeployedAt: null` hiển thị "—" (đang hiệu lực), không phải chuỗi "null".
 * - Deployments lỗi/unavailable ⇒ trạng thái riêng của section, bảng
 *   environment vẫn đứng (dữ liệu phụ không phá dữ liệu chính).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import EnvironmentsPage from './environments.vue';
import { flush, mountPactBrokerPage, stubFetch, type FetchEndpoint } from '../../tests/harness';

function environmentsEndpoint(): FetchEndpoint {
  return {
    path: '/api/broker/environments',
    status: 200,
    body: {
      _embedded: {
        environments: [
          {
            name: 'test',
            displayName: 'Test',
            production: false,
            createdAt: '2026-11-13T00:00:00Z',
          },
        ],
      },
    },
  };
}

function deploymentsEndpoint(body: object, status = 200): FetchEndpoint {
  return { path: '/api/broker/deployments', status, body };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('environments page — deployment records', () => {
  it('renders the deployments table for the latest versions', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([
        environmentsEndpoint(),
        deploymentsEndpoint({
          deployments: [
            {
              pacticipant: 'svc-consumer',
              version: '1.0.0',
              environment: 'test',
              deployedAt: '2026-11-13T02:00:00Z',
              undeployedAt: null,
            },
          ],
        }),
      ]),
    );
    const wrapper = await mountPactBrokerPage(EnvironmentsPage);
    await flush();

    expect(wrapper.find('[data-testid="pact-broker-environments-table"]').exists()).toBe(true);
    const table = wrapper.find('[data-testid="pact-broker-deployments-table"]');
    expect(table.exists()).toBe(true);
    const text = table.text();
    expect(text).toContain('svc-consumer');
    expect(text).toContain('1.0.0');
    expect(text).toContain('test');
    // undeployedAt null ⇒ "—" đang hiệu lực, không phải chữ "null".
    expect(text).not.toContain('null');
    wrapper.unmount();
  });

  it('keeps the environments table when the deployments read fails', async () => {
    vi.stubGlobal('fetch', stubFetch([environmentsEndpoint(), deploymentsEndpoint({}, 502)]));
    const wrapper = await mountPactBrokerPage(EnvironmentsPage);
    await flush();

    expect(wrapper.find('[data-testid="pact-broker-environments-table"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="pact-broker-deployments-unavailable"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('treats any non-ok deployments status as the section unavailable state', async () => {
    vi.stubGlobal('fetch', stubFetch([environmentsEndpoint(), deploymentsEndpoint({}, 500)]));
    const wrapper = await mountPactBrokerPage(EnvironmentsPage);
    await flush();

    expect(wrapper.find('[data-testid="pact-broker-environments-table"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="pact-broker-deployments-unavailable"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('shows the deployments empty state when no deployment is recorded', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([environmentsEndpoint(), deploymentsEndpoint({ deployments: [] })]),
    );
    const wrapper = await mountPactBrokerPage(EnvironmentsPage);
    await flush();

    expect(wrapper.find('[data-testid="pact-broker-deployments-table"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
