/**
 * Entrypoint chạy độc lập: parse config từ env, listen trên địa chỉ cấu hình
 * (mặc định loopback `127.0.0.1`; `MOCK_UPSTREAM_HOST=0.0.0.0` cho chế độ
 * container trên lane local), đóng sạch khi nhận SIGINT/SIGTERM.
 *
 * Chạy: `pnpm exec tsx tools/llm-upstream-mock/src/main.ts` từ repo root
 * (host) hoặc trong container lane do `deploys/llm-api-deploy` target
 * `test-lane-up` dựng. Không dùng ở production topology — mock chỉ phục vụ
 * integration/system test (Issue #132).
 */

import { parseConfig } from './config.js';
import { createUpstreamMockServer } from './server.js';

const config = parseConfig(process.env);
const handle = createUpstreamMockServer(config);

handle.server.listen(config.port, config.host, () => {
  const address = handle.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  console.log(`llm-upstream-mock listening on http://${config.host}:${port}`);
});

/** Đóng sạch: destroy socket treo (scenario `timeout`) rồi close server. */
function shutdown(): void {
  handle.destroyPendingSockets();
  handle.server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
