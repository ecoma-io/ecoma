/**
 * `globalSetup` của Vitest cho `pact-broker-app` — probe Docker **một lần**
 * mỗi lần chạy, trước khi bất kỳ worker/spec nào khởi động.
 *
 * Mỗi spec file chạy trong worker riêng (pool `forks`) nên cache ở module
 * scope không vượt qua ranh giới worker — không có globalSetup thì N spec =
 * N probe, mỗi probe là một container PostgreSQL thật.
 *
 * Probe dùng chính container PostgreSQL mà suite sắp dùng (docker CLI, cùng
 * image) — probe thất bại là NÉM và toàn bộ lần chạy đỏ ngay lập tức
 * (fail-loud, 06-testing.md §6); skip với exit 0 không phải kết quả chấp nhận
 * được. Lưu ý: target `test-integration` của app này có browser suite +
 * contract suite dựng full stack thật, nên vắng Docker là cả target đỏ — đúng
 * luật, không phải lỗi của suite `worker-runtime` đơn lẻ.
 */

import { probeDocker } from './broker-stack.ts';

export default async function setup(): Promise<void> {
  await probeDocker();
}
