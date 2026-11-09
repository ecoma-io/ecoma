/**
 * State và hàm điều khiển cho bridge `#app` dùng trong unit test.
 *
 * Tách riêng khỏi `tests/nuxt-app-bridge.ts` để bề mặt module `#app`
 * (được vitest alias) chỉ chứa đúng những gì app code sử dụng —
 * `useNuxtApp`, `useRuntimeConfig` và kiểu `NuxtApp`. Cách tách này giúp
 * tránh việc app/test import nhầm các hàm chỉ dành cho harness.
 */

/**
 * `NuxtApp` giả, chứa đúng slot mà app này dùng.
 *
 * Dashboard **không** có adapter phía client — mọi dữ liệu đi qua BFF — nên
 * không có slot adapter nào: nếu một ngày app thêm slot, khai ở đây để
 * `setNuxtApp({...})` gõ sai tên là lỗi.
 */
export type BridgeNuxtApp = Record<string, never>;

let currentApp: BridgeNuxtApp = {};

let runtimeConfig: { public: Record<string, unknown> } = { public: {} };

export function setNuxtApp(app: BridgeNuxtApp): void {
  currentApp = app;
}

export function setRuntimeConfig(cfg: { public: Record<string, unknown> }): void {
  runtimeConfig = cfg;
}

export function readNuxtApp(): BridgeNuxtApp {
  return currentApp;
}

export function readRuntimeConfig(): { public: Record<string, unknown> } {
  return runtimeConfig;
}

export function resetNuxtAppBridge(): void {
  currentApp = {};
  runtimeConfig = { public: {} };
}
