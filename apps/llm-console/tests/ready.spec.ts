import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import healthRoute from '../server/routes/health.get';
import readyRoute from '../server/routes/ready.get';
import { stripComments } from './source-code';

/**
 * Hợp đồng của hai route vận hành của scaffold `llm-console`.
 *
 * Ba bất biến được ghim ở đây:
 *
 * 1. **`/health` là liveness** — trả JSON ổn định và không đọc gì từ event.
 * 2. **`/ready` là readiness của một scaffold không có downstream** — trả JSON
 *    ổn định, không đọc gì từ event, không tự đổi response status.
 * 3. **Không có downstream nào trong `ready.get.ts`** — phần **code** (comment đã
 *    bị bóc) không được tham chiếu `llm-api`/`LLM_API`/`hyperdrive`/`D1`/`fetch(`.
 *    Đây là bất biến "fail-closed, không phụ thuộc serving-path": khi một phụ
 *    thuộc thật xuất hiện, nó phải được thêm cùng nhánh 503 — không được lén
 *    thêm một lần gọi mạng vào route này để "cho có kiểm".
 *
 * ⚠️ Event được thay bằng một `Proxy` **ném khi bị đọc bất kỳ thuộc tính nào**:
 * nếu route lỡ chạm `event.context`, `event.node` hay bất cứ thứ gì, test đỏ
 * ngay tại đó. Một object rỗng chỉ chứng minh "không ném với event rỗng", không
 * chứng minh route không đọc event.
 *
 * ⚠️ Vì cùng lý do, không có `vi.mock('h3')` nào: route chỉ dùng
 * `defineEventHandler`, và việc import `h3` thật chứng minh route không kéo
 * dependency lạ vào.
 */

/** Event cấm đọc — mọi truy cập thuộc tính đều ném. */
const FORBIDDEN_EVENT = new Proxy(
  {},
  {
    get(_target, property): never {
      throw new Error(`route must not read event.${String(property)}`);
    },
  },
);

const ROUTES_DIR = resolve(import.meta.dirname, '../server/routes');

/**
 * Bỏ comment nhưng **không** đụng vào string literal: `//` trong `'https://…'`
 * không phải comment, và cắt nhầm ở đó sẽ khiến phép quét chạy trên đoạn mã
 * hỏng — đúng loại false-green mà spec này tồn tại để chặn.
 */
const codeOf = stripComments;

describe('/health — liveness', () => {
  it('returns ok and the service name without reading the event', () => {
    const result = healthRoute(FORBIDDEN_EVENT as never);

    expect(result).toEqual({ status: 'ok', service: 'llm-console' });
  });

  it('does not set a response status', () => {
    const source = readFileSync(resolve(ROUTES_DIR, 'health.get.ts'), 'utf8');

    expect(codeOf(source)).not.toMatch(/\bsetResponseStatus\b/u);
  });
});

describe('/ready — readiness for a scaffold with no downstream', () => {
  it('returns ready with no thrown error', () => {
    const result = readyRoute(FORBIDDEN_EVENT as never);

    expect(result).toEqual({ status: 'ready' });
  });

  it('does not set a response status — a ready scaffold is a 200', () => {
    const source = readFileSync(resolve(ROUTES_DIR, 'ready.get.ts'), 'utf8');

    expect(codeOf(source)).not.toMatch(/\bsetResponseStatus\b/u);
  });
});

describe('ready route has no downstream of any kind', () => {
  const source = readFileSync(resolve(ROUTES_DIR, 'ready.get.ts'), 'utf8');
  // Bóc comment trước khi kiểm: comment **phải** được phép nói "không phụ thuộc
  // llm-api" — chính câu đó là tài liệu của bất biến này. Thứ bị cấm là một
  // tham chiếu trong code chạy được.
  const code = codeOf(source);

  it.each([
    ['llm-api', /\bllm-api\b/u],
    ['LLM_API', /\bLLM_API\b/u],
    ['hyperdrive', /\bhyperdrive\b/iu],
    ['D1', /\bD1\b/u],
    ['fetch(', /\bfetch\s*\(/u],
  ])('does not reference %s', (_label, pattern) => {
    expect(code).not.toMatch(pattern);
  });

  it('keeps the fail-closed requirement documented for a future dependency', () => {
    // Khi một phụ thuộc cấu hình thật được thêm, route phải fail closed
    // (503 + mã ổn định) thay vì mặc định ready. Comment là nơi hợp đồng đó
    // sống cho tới khi có code thật.
    expect(source).toMatch(/fail closed/u);
    expect(source).toMatch(/503/u);
  });
});
