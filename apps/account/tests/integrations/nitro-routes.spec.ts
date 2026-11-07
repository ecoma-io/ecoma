/**
 * Route table trong bundle Nitro thật — bắt lỗi class "middleware canh sai path".
 *
 * Nitro serve `server/api/**` dưới prefix `/api`, còn `server/routes/**` ở root.
 * Internal contract nằm ở `/internal/**` (middleware canh đúng prefix đó), nên
 * đặt route trong `server/api/internal/...` tạo ra endpoint thật sự là
 * `/api/internal/...` — middleware KHÔNG BAO GIỜ chạm tới, request công khai đi
 * thẳng handler. Test h3 app thủ công (e2e middleware) không bắt được lỗi này
 * vì nó tự dựng route đúng ý mình; chỉ bundle build thật nói đường đi thật.
 *
 * Vì vậy test này đọc `.output/server` — artifact của `account:build`, và
 * `test`/`test-integration` `dependsOn` `build` để artifact tồn tại ở mọi
 * runner sạch (không tin cache local).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const NITRO_CHUNK = resolve(import.meta.dirname, '../../.output/server/chunks/nitro/nitro.mjs');

describe('built Nitro route table', () => {
  const nitro = readFileSync(NITRO_CHUNK, 'utf8');

  it('serves the internal status contract at /internal, not under /api', () => {
    // Route thật khớp đúng chuỗi ký: chữ ký HMAC phủ `event.path`, nên route
    // Đăng ký dưới `/api/...` là hai contract khác nhau — không chỉ sai prefix.
    expect(nitro).toMatch(/route:"\/internal\/account\/status"/u);
    // Không còn đường `/api/internal/**` nào trong bảng route: đó chính là
    // đường mở công khai nếu ai đó trả route về `server/api/`.
    expect(nitro).not.toMatch(/route:"\/api\/internal\//u);
  });
});
