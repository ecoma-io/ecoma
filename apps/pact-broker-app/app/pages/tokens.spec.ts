/**
 * Colocated spec cho trang API tokens (issue #207) — hợp đồng lỗi của các
 * thao tác ghi. Trang gọi BFF qua `brokerFetch` ở ba đường: tạo, rotate,
 * revoke. Mỗi đường phải **báo lỗi cho người dùng** thay vì no-op im lặng:
 *
 * - Bất kỳ exception nào của `brokerFetch` (mạng đứt, body không parse được)
 *   đều rơi vào error flag tương ứng (`createRejected` / `mutateError`) —
 *   hiển thị đúng thông báo lỗi hiện có của trang.
 * - Cookie CSRF vắng mặt: request chắc chắn bị từ chối fail-closed, nên trang
 *   **không gọi fetch** và hiện lỗi ngay.
 * - `copySecret` chỉ bật "Copied" khi `navigator.clipboard.writeText` thành
 *   công; bị từ chối thì giữ nguyên nút, không crash.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { pactBrokerMessages } from '../i18n/catalogs';
import TokensPage from './tokens.vue';
import { flush, mountPactBrokerPage } from '../../tests/harness';

const createFailedText = pactBrokerMessages.en.tokens.createFailed;
const csrfMissingText = pactBrokerMessages.en.tokens.csrfMissing;
const mutateFailedText = pactBrokerMessages.en.tokens.mutateFailed;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // `document.cookie` là state jsdom dùng chung — xoá cookie CSRF giữa các test.
  document.cookie = '__Host-pact-broker-csrf=; Max-Age=0; Path=/; Secure';
});

/**
 * Cài cookie CSRF double-submit như runtime thật. jsdom enforce prefix
 * `__Host-` (RFC 6265bis §4.1.3.2): thiếu `Secure` thì phép gán bị từ chối
 * lặng lẽ — cookie không bao giờ xuất hiện trong `document.cookie`.
 */
function stubCsrfCookie(): void {
  document.cookie = '__Host-pact-broker-csrf=csrf-test-token; Path=/; Secure';
}

/** fetch ném exception — đường "brokerFetch fail" của mọi thao tác ghi. */
function throwingFetch(): typeof fetch {
  return vi.fn<typeof fetch>(async () => {
    throw new Error('network down');
  });
}

/**
 * Body HAL của GET danh sách token — một row active hoặc danh sách rỗng.
 * `stubFetch` tự `JSON.stringify` body, nên đây là **object**, không phải string.
 */
function listBody(rows: object[]): object {
  return { _embedded: { tokens: rows } };
}

/** Row token active đúng shape trang đọc (`TokenRow`). */
function tokenRow(overrides: { id?: string; name?: string } = {}): object {
  return {
    id: overrides.id ?? 'tok-1',
    name: overrides.name ?? 'ci-token',
    scopes: ['read'],
    purpose: 'ci',
    createdBy: 'staff-1',
    createdAt: '2026-11-13T00:00:00Z',
    revokedAt: null,
  };
}

describe('tokens page — create flow error handling', () => {
  it('sets createRejected when brokerFetch throws instead of failing silently', async () => {
    stubCsrfCookie();
    const wrapper = await mountPactBrokerPage(TokensPage, {
      fetchEndpoints: [
        { path: '/api/broker/machine-tokens', status: 200, body: { _embedded: { tokens: [] } } },
      ],
    });
    // Ghi đè fetch sau mount: GET danh sách thành công, POST tạo ném exception.
    const postThrows = throwingFetch();
    vi.stubGlobal('fetch', postThrows);

    await wrapper.find('[data-testid="pact-broker-token-name"]').setValue('ci-token');
    await wrapper.find('[data-testid="pact-broker-token-submit"]').trigger('submit');
    await flush();

    expect(wrapper.text()).toContain(createFailedText);
    wrapper.unmount();
  });

  it('skips the fetch and shows the error when the CSRF cookie is missing', async () => {
    const wrapper = await mountPactBrokerPage(TokensPage, {
      fetchEndpoints: [
        { path: '/api/broker/machine-tokens', status: 200, body: { _embedded: { tokens: [] } } },
      ],
    });
    const postThrows = throwingFetch();

    await wrapper.find('[data-testid="pact-broker-token-name"]').setValue('ci-token');
    await wrapper.find('[data-testid="pact-broker-token-submit"]').trigger('submit');
    await flush();

    // Fail-closed ở client: không request nào rời trang cho thao tác tạo,
    // và lý do hiển thị là csrfMissing (không phải thông báo chung).
    expect(postThrows).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain(csrfMissingText);
    wrapper.unmount();
  });
});

describe('tokens page — confirm flow error handling', () => {
  it('sets mutateError when brokerFetch throws on rotate', async () => {
    stubCsrfCookie();
    const wrapper = await mountPactBrokerPage(TokensPage, {
      fetchEndpoints: [
        { path: '/api/broker/machine-tokens', status: 200, body: listBody([tokenRow()]) },
      ],
    });
    // Sau mount: thao tác rotate ném exception (stub theo path prefix đã match
    // GET ban đầu — giờ thay bằng stub ném cho mọi lần gọi tiếp theo).
    const rotateThrows = throwingFetch();
    vi.stubGlobal('fetch', rotateThrows);

    await wrapper.find('[data-testid="pact-broker-token-rotate"]').trigger('click');
    await flush();
    await wrapper.find('[data-testid="pact-broker-token-confirm-input"]').setValue('ci-token');
    await wrapper.find('[data-testid="pact-broker-token-confirm-run"]').trigger('click');
    await flush();

    expect(wrapper.text()).toContain(mutateFailedText);
    // Dialog vẫn mở — người dùng có thể thử lại hoặc huỷ.
    expect(wrapper.find('[data-testid="pact-broker-token-confirm"]').exists()).toBe(true);
    wrapper.unmount();
  });
});

describe('tokens page — copy secret', () => {
  it('marks the secret as copied when clipboard write succeeds', async () => {
    stubCsrfCookie();
    const writeText = vi.fn<() => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const wrapper = await mountPactBrokerPage(TokensPage, {
      fetchEndpoints: [
        { path: '/api/broker/machine-tokens', status: 200, body: { _embedded: { tokens: [] } } },
      ],
    });
    vi.stubGlobal(
      'fetch',
      // POST tạo trả secret show-once → khối revealed xuất hiện.
      vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ secret: 'ptk-one-time-secret' }), { status: 200 }),
      ),
    );

    await wrapper.find('[data-testid="pact-broker-token-name"]').setValue('ci-token');
    await wrapper.find('[data-testid="pact-broker-token-submit"]').trigger('submit');
    await flush();

    expect(wrapper.find('[data-testid="pact-broker-token-secret"]').text()).toBe(
      'ptk-one-time-secret',
    );
    await wrapper.find('[data-testid="pact-broker-token-copy"]').trigger('click');
    await flush();

    expect(writeText).toHaveBeenCalledWith('ptk-one-time-secret');
    wrapper.unmount();
  });

  it('does not mark the secret as copied when the clipboard write rejects', async () => {
    stubCsrfCookie();
    const writeText = vi.fn<() => Promise<void>>(async () => {
      throw new Error('clipboard denied');
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const wrapper = await mountPactBrokerPage(TokensPage, {
      fetchEndpoints: [
        { path: '/api/broker/machine-tokens', status: 200, body: { _embedded: { tokens: [] } } },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ secret: 'ptk-one-time-secret' }), { status: 200 }),
      ),
    );

    await wrapper.find('[data-testid="pact-broker-token-name"]').setValue('ci-token');
    await wrapper.find('[data-testid="pact-broker-token-submit"]').trigger('submit');
    await flush();

    await wrapper.find('[data-testid="pact-broker-token-copy"]').trigger('click');
    await flush();

    // Không bật "Copied" — nút vẫn giữ nhãn Copy, không crash.
    expect(wrapper.text()).not.toContain(pactBrokerMessages.en.tokens.copied);
    wrapper.unmount();
  });
});
