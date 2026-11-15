/**
 * `globalSetup` của Vitest cho browser suite của `remote-cache-app` — probe
 * Docker **một lần** mỗi lần chạy, trước khi bất kỳ worker/spec nào khởi động
 * (cùng luật fail-loud với harness pact).
 */

import { probeDocker } from './stack.ts';

export default async function setup(): Promise<void> {
  await probeDocker();
}
