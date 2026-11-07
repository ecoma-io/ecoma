/**
 * `globalSetup` của Vitest cho `pact-broker-api` — probe Docker **một lần**
 * mỗi lần chạy, trước khi bất kỳ worker/spec nào khởi động.
 *
 * Mỗi spec file chạy trong worker riêng (pool `forks`) nên cache ở module
 * scope không vượt qua ranh giới worker — không có globalSetup thì N spec =
 * N probe, mỗi probe là một container PostgreSQL thật.
 */

import { probeDocker } from './harness.ts';

export default async function setup(): Promise<void> {
  await probeDocker();
}
