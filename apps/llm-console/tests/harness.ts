/**
 * Harness mount cho unit test của `pact-broker-app`.
 *
 * Ba lối vào:
 * - `mountPactBrokerPage(component, { runtimeConfig, fetchStub })` — mount một
 *   page với bridge state đã cài; dùng cho test trang dữ liệu.
 * - `mountPactBrokerApp({ page, route })` — mount `app.vue` (shell + `<NuxtPage />>`).
 * - `flush()` — `flushPromises` + `nextTick`: `onMounted` của `useAsyncState`
 *   chạy sau lượt render đầu, nên một lần flush sau mount là bắt buộc trước
 *   mọi assertion về dữ liệu.
 *
 * ⚠️ Component trong `app/components/` được cấp bằng `import.meta.glob(...,
 * { eager: true })` — **không** liệt kê tay: component mới thêm mà không khai
 * ở đây render thành thẻ rỗng **không** báo lỗi. `eager: true` cố ý vì import
 * động chỉ resolve được sau khi cây đã render.
 *
 * ⚠️ `fetch` được stub qua `vi.stubGlobal('fetch', ...)`: page gọi
 * `fetch('/api/broker/...')` ở browser-relative path, và test cần mô phỏng
 * đúng hợp đồng đó — status + JSON body. Stub theo path prefix để một page
 * gọi nhiều endpoint vẫn hoạt động.
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { vi } from 'vitest';
import { defineComponent, h, nextTick, type Component } from 'vue';

import { setRuntimeConfig } from './nuxt-app-state';
import { i18n } from './nuxt-globals';

/**
 * Cấp mọi component của `app/components/` với `import.meta.glob({ eager: true })`
 * — thay thế cho auto-import của Nuxt mà raw mount không có. **Không** liệt kê
 * tay: component mới thêm mà không qua glob này render thành thẻ rỗng **không**
 * báo lỗi (đúng cảnh báo trong comment đầu file).
 */
const componentModules = import.meta.glob<{ default: Component }>('../app/components/**/*.vue', {
  eager: true,
});
const pactBrokerComponents: Record<string, Component> = Object.fromEntries(
  Object.entries(componentModules).map(([path, module]) => {
    const base = path.split('/').pop() ?? path;
    return [base.replace(/\.vue$/u, ''), module.default];
  }),
);

/** Một stub endpoint: khớp theo prefix path, trả status + JSON. */
export interface FetchEndpoint {
  /** Prefix path, ví dụ `/api/broker/pacts`. */
  readonly path: string;
  readonly status?: number;
  readonly body?: unknown;
}

/** Dựng một `fetch` giả từ danh sách endpoint — khớp prefix đầu tiên thắng. */
export function stubFetch(endpoints: readonly FetchEndpoint[]): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const path = url.startsWith('http') ? new URL(url).pathname : url;
    const match = endpoints.find((endpoint) => path.startsWith(endpoint.path));
    if (match === undefined) {
      throw new Error(`stubFetch: no endpoint for ${path}`);
    }
    const status = match.status ?? 200;
    const body = match.body === undefined ? null : JSON.stringify(match.body);
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

/** Tuỳ chọn mount page. */
export interface MountPageOptions {
  /** Runtime config `public` mà page đọc qua `useRuntimeConfig()` — mặc định rỗng. */
  readonly runtimeConfig?: Record<string, unknown>;
  /** Endpoint giả cho `fetch` — không truyền thì fetch thật bị chặn và ném. */
  readonly fetchEndpoints?: readonly FetchEndpoint[];
}

/** Cấu hình runtime mặc định: BFF "đã cấu hình" với giá trị giả an toàn. */
export const CONFIGURED_RUNTIME: Record<string, unknown> = {
  pactBrokerApiBaseUrl: 'https://broker-api.test',
  pactBrokerApiToken: 'test-token-not-a-secret',
};

/** Mount một page component với bridge state + fetch stub. */
export async function mountPactBrokerPage(
  component: Component,
  options: MountPageOptions = {},
): Promise<VueWrapper> {
  setRuntimeConfig({ public: options.runtimeConfig ?? CONFIGURED_RUNTIME });
  if (options.fetchEndpoints !== undefined) {
    vi.stubGlobal('fetch', stubFetch(options.fetchEndpoints));
  }
  const wrapper = mount(component, {
    global: {
      components: { ...pactBrokerComponents, NuxtLink: NuxtLinkStub },
      plugins: [i18n],
    },
  });
  await flush();
  return wrapper;
}

/** Ghi lại `to` của mọi `<NuxtLink>` được render — không điều hướng thật. */
export const NuxtLinkStub = defineComponent({
  name: 'NuxtLinkStub',
  props: {
    to: { type: [String, Object], required: true },
  },
  setup(props, { slots }) {
    return (): ReturnType<typeof h> =>
      h('a', { href: typeof props.to === 'string' ? props.to : '#' }, slots.default?.());
  },
});

/** `flushPromises` + hai `nextTick`: mounted hooks + re-render đã ổn định. */
export async function flush(): Promise<void> {
  await flushPromises();
  await nextTick();
  await nextTick();
}

/**
 * Mount `app.vue` nguyên khối (shell + `<NuxtPage />`) với route cho trước.
 *
 * `NuxtPage` được stub: page component được truyền trực tiếp thay vì qua
 * vue-router — test đơn trang không cần router thật, và router thật kéo theo
 * toàn bộ lịch sử điều hướng mà jsdom không có.
 */
export async function mountPactBrokerApp(options: {
  readonly page: Component;
  readonly path?: string;
  readonly runtimeConfig?: Record<string, unknown>;
  readonly fetchEndpoints?: readonly FetchEndpoint[];
}): Promise<VueWrapper> {
  setRuntimeConfig({ public: options.runtimeConfig ?? CONFIGURED_RUNTIME });
  if (options.fetchEndpoints !== undefined) {
    vi.stubGlobal('fetch', stubFetch(options.fetchEndpoints));
  }
  const { pactBrokerStores } = await import('./nuxt-globals');
  if (options.path !== undefined) {
    pactBrokerStores.route.path = options.path;
  }
  const NuxtPageStub = defineComponent({
    name: 'NuxtPageStub',
    setup() {
      return (): ReturnType<typeof h> => h(options.page);
    },
  });
  const { default: App } = await import('../app/app.vue');
  const wrapper = mount(App, {
    global: {
      plugins: [i18n],
      components: { ...pactBrokerComponents, NuxtLink: NuxtLinkStub, NuxtPage: NuxtPageStub },
      stubs: {
        // Shell dùng teleport cho panel/dialog — jsdom không có target nào đáng
        // tin, stub để giữ cây trong wrapper.
        Teleport: true,
      },
    },
  });
  await flush();
  return wrapper;
}
