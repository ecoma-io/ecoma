/**
 * `globalSetup` của Vitest cho `deploys/backoffice-db` — probe Docker
 * **một lần** mỗi lần chạy, trước khi bất kỳ worker/spec file nào khởi động.
 *
 * Kết quả được đăng ký qua `process.env` (worker kế thừa khi fork) trong
 * `probeDocker` của harness; khi probe thất bại, ném lỗi làm **toàn bộ** lần
 * chạy đỏ — Docker là phụ thuộc cứng (06-testing.md §6).
 */

import { probeDocker } from './harness.ts';

export default async function setup(): Promise<void> {
  await probeDocker();
}
