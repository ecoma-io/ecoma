import { describe, expect, it, vi } from 'vitest';

import { readNuxtApp, setNuxtApp, setRuntimeConfig } from '../../tests/nuxt-app-state';
import { useBackofficeAdapter } from './use-backoffice-adapter';

/**
 * Dựng một phiên Nuxt giả với `runtimeConfig.public.backofficeDataMode` đã cho.
 * Không đóng trên biến nào nên khai ở phạm vi module.
 */
function withRuntimeMode(mode: unknown): void {
  setNuxtApp({});
  setRuntimeConfig({ public: { backofficeDataMode: mode } });
}

/**
 * Đường runtime thật của composable.
 *
 * `#app` được vitest alias sang `tests/nuxt-app-bridge.ts` (xem
 * `vitest.config.mts`), nên test điều khiển trực tiếp hai thứ composable được
 * phép đọc: `nuxtApp` và `runtimeConfig` (hàm điều khiển nằm ở
 * `tests/nuxt-app-state.ts`). Mọi thứ khác — query, cookie, header,
 * localStorage, hostname — test cố tình đặt giá trị **mâu thuẫn** để khẳng định
 * chúng không ảnh hưởng tới chế độ.
 */
describe('useBackofficeAdapter — selects the adapter from runtime config', () => {
  it('prototype mode yields a mock adapter with isPreview true', () => {
    withRuntimeMode('prototype');

    expect(useBackofficeAdapter().isPreview).toBe(true);
  });

  it('disabled mode yields an unavailable adapter with isPreview false', () => {
    withRuntimeMode('disabled');

    expect(useBackofficeAdapter().isPreview).toBe(false);
  });

  it('fails closed when the config key is missing', () => {
    withRuntimeMode(undefined);

    expect(useBackofficeAdapter().isPreview).toBe(false);
  });

  it('fails closed when the config value has the wrong type', () => {
    withRuntimeMode({ mode: 'prototype' });

    expect(useBackofficeAdapter().isPreview).toBe(false);
  });

  it('unavailable mode rejects every read with a stable error code', async () => {
    withRuntimeMode('disabled');
    const adapter = useBackofficeAdapter();

    await expect(adapter.listStaff()).rejects.toMatchObject({
      code: 'backoffice_backend_unavailable',
    });
  });

  it('caches the adapter on nuxtApp: the same session returns the same instance', () => {
    withRuntimeMode('prototype');

    const adapter = useBackofficeAdapter();
    expect(adapter).toBe(useBackofficeAdapter());
    expect(readNuxtApp().$backofficeAdapter).toBe(adapter);
  });

  it('SSR and client agree on the mode when public runtimeConfig matches', () => {
    // Payload `runtimeConfig.public` là thứ duy nhất client hydrate để dựng lại
    // cấu hình, nên "cùng giá trị ⇒ cùng adapter" là điều kiện đồng nhất SSR/client.
    const ssrConfig = { public: { backofficeDataMode: 'prototype' } };

    setNuxtApp({});
    setRuntimeConfig(ssrConfig);
    const serverAdapter = useBackofficeAdapter();

    setNuxtApp({});
    setRuntimeConfig({ public: { ...ssrConfig.public } });
    const clientAdapter = useBackofficeAdapter();

    expect(serverAdapter.isPreview).toBe(clientAdapter.isPreview);
    expect(serverAdapter.isPreview).toBe(true);
  });

  it('SSR and client both fail closed when the payload omits the mode', () => {
    setNuxtApp({});
    setRuntimeConfig({ public: {} });
    const serverAdapter = useBackofficeAdapter();

    setNuxtApp({});
    setRuntimeConfig({ public: {} });
    const clientAdapter = useBackofficeAdapter();

    expect(serverAdapter.isPreview).toBe(false);
    expect(clientAdapter.isPreview).toBe(false);
  });

  it('two different sessions do not share an adapter', () => {
    setNuxtApp({});
    setRuntimeConfig({ public: { backofficeDataMode: 'prototype' } });
    const previewAdapter = useBackofficeAdapter();

    setNuxtApp({});
    setRuntimeConfig({ public: { backofficeDataMode: 'disabled' } });
    const unavailableAdapter = useBackofficeAdapter();

    expect(previewAdapter).not.toBe(unavailableAdapter);
    expect(previewAdapter.isPreview).toBe(true);
    expect(unavailableAdapter.isPreview).toBe(false);
  });
});

describe('useBackofficeAdapter — client input cannot change the mode', () => {
  const CONFLICTING_CLIENT_INPUT = 'prototype';

  it('a query param does not enable the mock when deployment config says disabled', () => {
    setNuxtApp({});
    setRuntimeConfig({ public: { backofficeDataMode: 'disabled' } });
    window.history.replaceState({}, '', `/?backofficeDataMode=${CONFLICTING_CLIENT_INPUT}`);

    expect(window.location.search).toContain(CONFLICTING_CLIENT_INPUT);
    expect(useBackofficeAdapter().isPreview).toBe(false);
  });

  it('a cookie does not enable the mock', () => {
    setNuxtApp({});
    setRuntimeConfig({ public: { backofficeDataMode: 'disabled' } });
    document.cookie = `backofficeDataMode=${CONFLICTING_CLIENT_INPUT}`;

    expect(document.cookie).toContain(`backofficeDataMode=${CONFLICTING_CLIENT_INPUT}`);
    expect(useBackofficeAdapter().isPreview).toBe(false);
  });

  it('localStorage does not enable the mock', () => {
    setNuxtApp({});
    setRuntimeConfig({ public: { backofficeDataMode: 'disabled' } });
    window.localStorage.setItem('backofficeDataMode', CONFLICTING_CLIENT_INPUT);

    expect(window.localStorage.getItem('backofficeDataMode')).toBe(CONFLICTING_CLIENT_INPUT);
    expect(useBackofficeAdapter().isPreview).toBe(false);
  });

  it('the hostname does not enable the mock', () => {
    setNuxtApp({});
    setRuntimeConfig({ public: { backofficeDataMode: 'disabled' } });
    const localHostname = window.location.hostname;

    expect(localHostname).toBeDefined();
    expect(useBackofficeAdapter().isPreview).toBe(false);
  });

  it('client-controlled globals (useRoute/useRequestHeaders) do not enable the mock', () => {
    setNuxtApp({});
    setRuntimeConfig({ public: { backofficeDataMode: 'disabled' } });
    const container = globalThis as Record<string, unknown>;
    container.useRoute = () => ({ query: { backofficeDataMode: CONFLICTING_CLIENT_INPUT } });
    container.useRequestHeaders = () => ({
      'x-backoffice-data-mode': CONFLICTING_CLIENT_INPUT,
    });

    try {
      expect(useBackofficeAdapter().isPreview).toBe(false);
    } finally {
      Reflect.deleteProperty(container, 'useRoute');
      Reflect.deleteProperty(container, 'useRequestHeaders');
    }
  });

  it('the mode comes from runtime config, not from a passed argument', () => {
    setNuxtApp({});
    setRuntimeConfig({ public: { backofficeDataMode: 'disabled' } });

    // Composable không nhận tham số; gọi với đối số lạ vẫn phải theo cấu hình.
    const adapter = (useBackofficeAdapter as (...args: unknown[]) => { isPreview: boolean })({
      mode: CONFLICTING_CLIENT_INPUT,
    });

    expect(adapter.isPreview).toBe(false);
  });

  it('the client cannot override the adapter chosen in the same session', () => {
    setNuxtApp({});
    setRuntimeConfig({ public: { backofficeDataMode: 'disabled' } });
    const first = useBackofficeAdapter();

    // Một mode khác đến "giữa phiên" không được đổi adapter đã cache.
    setRuntimeConfig({ public: { backofficeDataMode: 'prototype' } });

    expect(useBackofficeAdapter()).toBe(first);
    expect(useBackofficeAdapter().isPreview).toBe(false);
  });

  it('reads no request-derived API at all (checked with spies)', () => {
    setNuxtApp({});
    setRuntimeConfig({ public: { backofficeDataMode: 'prototype' } });
    const container = globalThis as Record<string, unknown>;
    const spies = new Map<string, () => void>();

    for (const name of [
      'useRoute',
      'useRequestHeaders',
      'useRequestURL',
      'useCookie',
      'useState',
    ]) {
      const spy = vi.fn<() => void>(() => {
        throw new Error(`composable không được gọi ${name}`);
      });
      spies.set(name, spy);
      container[name] = spy;
    }

    try {
      expect(useBackofficeAdapter().isPreview).toBe(true);
    } finally {
      for (const [name, spy] of spies) {
        expect(spy).not.toHaveBeenCalled();
        Reflect.deleteProperty(container, name);
      }
    }
  });
});

/**
 * Chốt chặn cho tính cô lập của harness (xem `tests/setup.ts`).
 *
 * Các test dưới đây **cố ý phụ thuộc thứ tự**: mỗi test đầu độc client state của
 * jsdom, test sau khẳng định state đó không rò sang. Vitest chạy tuần tự theo thứ
 * tự khai báo trong file, nên các cặp này ổn định — và đây là cách duy nhất
 * chứng minh "state không rò giữa các test", thứ mà một test đơn lẻ không kiểm
 * được.
 *
 * Hai cặp, mỗi cặp đúng một cơ chế dọn khác nhau:
 *
 * 1. Cookie ở **path mặc định** của một URL sâu (`/staff` khi URL ở
 *    `/staff/roles`, RFC 6265 default-path), cùng localStorage/sessionStorage và
 *    query. Test sau phải điều hướng về đúng path đó thì mới kiểm được — ở `/`
 *    cookie sâu vốn không hiển thị.
 * 2. Cookie mà lúc dọn **tên không hiển thị ở đâu cả**: test đầu kết thúc ở `/`
 *    nên `document.cookie` không thấy cookie `path=/staff` — xoá được nó chỉ khi
 *    danh sách cookie được ghi lại lúc gán, không phải lúc dọn. Kèm theo một
 *    cookie `Domain=localhost` (jsdom lưu nó host-only, đo trong `tests/setup.ts`)
 *    để giữ luôn ca cookie có `Domain` không rò sang test sau.
 *
 * Nếu `resetClientState` trong `tests/setup.ts` bị bỏ, các test thứ hai, thứ tư,
 * thứ sáu đỏ: các khẳng định "client không bật được mock" ở trên có thể xanh vì
 * lý do sai (state rò từ test trước) thay vì vì gating chỉ đọc runtime config.
 */
describe('harness — client state does not leak between tests', () => {
  it('poisons jsdom state (setup for the next test)', () => {
    document.cookie = 'backofficeRootMode=prototype; path=/';
    window.localStorage.setItem('backofficeDataMode', 'prototype');
    window.sessionStorage.setItem('backofficeDataMode', 'prototype');
    window.history.replaceState({}, '', '/staff/roles?backofficeDataMode=prototype');
    // Không khai `path`: cookie này mang path mặc định là thư mục hiện tại
    // (`/staff`), nên nó là ca mà việc xoá chỉ ở `path=/` bỏ sót.
    document.cookie = 'backofficeDeepMode=prototype';

    expect(document.cookie).toContain('backofficeRootMode=prototype');
    expect(document.cookie).toContain('backofficeDeepMode=prototype');
    expect(window.localStorage.getItem('backofficeDataMode')).toBe('prototype');
    expect(window.sessionStorage.getItem('backofficeDataMode')).toBe('prototype');
    expect(window.location.search).toContain('backofficeDataMode=prototype');
  });

  it('the next test starts with clean state', () => {
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
    expect(document.cookie).not.toContain('backofficeRootMode');
    expect(window.localStorage.getItem('backofficeDataMode')).toBeNull();
    expect(window.sessionStorage.getItem('backofficeDataMode')).toBeNull();

    // Điều hướng về đúng path đã đặt cookie sâu: nếu nó sống sót, nó hiện lại ở
    // đây (ở `/` nó vốn không hiển thị nên chỉ khẳng định tại `/` là vô nghĩa).
    window.history.replaceState({}, '', '/staff/roles');
    expect(document.cookie).not.toContain('backofficeDeepMode');
  });

  it('poisons a cookie hidden from the cleanup path, plus one scoped by Domain', () => {
    window.history.replaceState({}, '', '/staff/roles');
    document.cookie = 'backofficeHiddenMode=prototype; path=/staff';
    document.cookie = 'backofficeDomainMode=prototype; path=/; domain=localhost';

    expect(document.cookie).toContain('backofficeHiddenMode=prototype');
    expect(document.cookie).toContain('backofficeDomainMode=prototype');

    // Kết thúc ở `/`: ở đó `document.cookie` **không** hiển thị cookie
    // `path=/staff`, nên một vòng dọn dựa trên tên đang hiển thị sẽ không bao giờ
    // biết tên `backofficeHiddenMode` — dù nó đã nằm trong cùng jsdom.
    window.history.replaceState({}, '', '/');
    expect(document.cookie).not.toContain('backofficeHiddenMode');
  });

  it('clears a cookie name it never saw displayed, at the path the cookie lives', () => {
    // `backofficeDomainMode` được đặt kèm `Domain=localhost`: jsdom lưu nó như
    // cookie host-only nên `(name, path)` đã đủ để xoá (đo trong `tests/setup.ts`);
    // câu này giữ ca đó không rò sang test sau.
    expect(document.cookie).not.toContain('backofficeDomainMode');

    // Còn `backofficeHiddenMode` chỉ lộ ra ở `/staff/roles` — nơi nó đã bị xoá.
    window.history.replaceState({}, '', '/staff/roles');
    expect(document.cookie).not.toContain('backofficeHiddenMode');
  });
});
