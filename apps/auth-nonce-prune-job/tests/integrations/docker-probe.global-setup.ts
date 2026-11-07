/**
 * `globalSetup` của Vitest cho `apps/auth-nonce-prune-job` — probe Docker **một lần**
 * mỗi lần chạy, trước khi bất kỳ worker/spec file nào khởi động.
 *
 * Vì sao không để từng spec tự probe (pattern mà `apps/auth` đã bỏ): mỗi spec file chạy
 * trong worker riêng (pool `forks`, isolate) nên cache ở module scope hay `globalThis`
 * không vượt qua được ranh giới worker. Probe là một container PostgreSQL thật, tự dựng
 * và huỷ: tốn vài giây và là nguồn flake không cần thiết.
 *
 * Kết quả được đăng ký qua `process.env` (worker kế thừa khi fork) trong
 * {@link probeDocker}; khi probe thất bại, harness ném lỗi làm **toàn bộ** lần chạy đỏ
 * — Docker là phụ thuộc cứng, suite phải ĐỎ thay vì bỏ qua nửa suite với exit 0
 * (06-testing.md §6).
 */

import { probeDocker } from './harness.ts';

export default async function setup(): Promise<void> {
  await probeDocker();
}
