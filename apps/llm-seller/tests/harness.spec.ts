import { afterEach, describe, expect, it, vi } from 'vitest';

import { flush, mountPactBrokerApp, mountPactBrokerPage, stubFetch } from './harness';
import { NUXT_GLOBALS, VUE_GLOBALS, pactBrokerStores } from './nuxt-globals';
import { resetNuxtAppBridge } from './nuxt-app-state';
import IndexPage from '../app/pages/index.vue';

afterEach(() => {
  vi.unstubAllGlobals();
  resetNuxtAppBridge();
});

describe('test harness bridge', () => {
  it('installs every declared Nuxt and Vue global as functions', () => {
    for (const name of [...NUXT_GLOBALS, ...VUE_GLOBALS]) {
      expect(typeof (globalThis as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('keeps the global useRuntimeConfig and the #app bridge on the same state', async () => {
    // Hai đường vào (global của auto-import và alias `#app`) phải đọc cùng
    // state: nếu lệch nhau, runtime config mà harness cài không phải cái page
    // đọc, và mọi test gating sẽ xanh vì lý do sai.
    const setBy = 'shared-state-probe';
    const wrapper = await mountPactBrokerPage(IndexPage, {
      runtimeConfig: { probe: setBy },
    });
    const { useRuntimeConfig } = await import('./nuxt-app-bridge');
    expect(useRuntimeConfig().public.probe).toBe(setBy);
    expect(
      (
        globalThis as { useRuntimeConfig: () => { public: Record<string, unknown> } }
      ).useRuntimeConfig().public.probe,
    ).toBe(setBy);
    wrapper.unmount();
  });

  it('resets the bridge so state from a previous test does not leak', async () => {
    const wrapper = await mountPactBrokerPage(IndexPage, {
      runtimeConfig: { leak: 'yes' },
    });
    wrapper.unmount();
    resetNuxtAppBridge();
    const { useRuntimeConfig } = await import('./nuxt-app-bridge');
    expect(useRuntimeConfig().public.leak).toBeUndefined();
  });

  it('stubFetch matches by path prefix and returns JSON', async () => {
    const fetchStub = stubFetch([{ path: '/api/broker/pacts', status: 201, body: { ok: 1 } }]);
    vi.stubGlobal('fetch', fetchStub);
    const res = await fetch('https://broker.test/api/broker/pacts?x=1');
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: 1 });
  });

  it('stubFetch throws on an unmapped path instead of returning a fake success', async () => {
    const fetchStub = stubFetch([{ path: '/api/broker/pacts' }]);
    await expect(async () => fetchStub('https://broker.test/api/broker/other')).rejects.toThrow(
      /no endpoint/u,
    );
  });
});

describe('index page', () => {
  it('renders exactly one h1 and real links to the three areas', async () => {
    const wrapper = await mountPactBrokerPage(IndexPage);
    expect(wrapper.findAll('h1')).toHaveLength(1);
    const hrefs = wrapper.findAll('a').map((a) => a.attributes('href'));
    expect(hrefs).toContain('/pacts');
    expect(hrefs).toContain('/environments');
    expect(hrefs).toContain('/tokens');
    wrapper.unmount();
  });

  it('flush() settles onMounted data loads before assertions', async () => {
    // Trang index không fetch, nhưng hợp đồng của flush vẫn được ghim: một
    // page có fetch sẽ treo ở loading nếu flush thiếu.
    const wrapper = await mountPactBrokerPage(IndexPage);
    await flush();
    expect(wrapper.text()).not.toContain('Loading');
    wrapper.unmount();
  });

  it('mounts the full app shell with the index page inside', async () => {
    const wrapper = await mountPactBrokerApp({ page: IndexPage });
    // Shell render brand + nav; page render h1 của mình. Hai h1 (shell không
    // có h1 nào, trang có đúng một) là bất biến a11y của mọi trang.
    expect(wrapper.findAll('h1')).toHaveLength(1);
    expect(pactBrokerStores.navigations).toEqual([]);
    wrapper.unmount();
  });
});
