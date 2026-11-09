import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import healthHandler from '../server/routes/health.get';
import readyHandler from '../server/routes/ready.get';
import { stripComments } from './source-code';

/**
 * Hợp đồng của hai route vận hành: `/health` là liveness, `/ready` là readiness.
 *
 * ⚠️ Vì sao spy `setResponseStatus` thay vì chỉ so giá trị trả về:
 * `defineEventHandler` trả chính handler và h3 đọc **status đã set trên event**
 * khi dựng response. Một route gọi `setResponseStatus(event, 503)` rồi trả
 * `{ status: 'ready' }` vẫn "trả về đúng object" nhưng phục vụ 503 — phép so
 * giá trị trả về một mình sẽ xanh nhầm cho đúng lỗi mà route này phải tránh.
 *
 * `vi.hoisted` là bắt buộc: `vi.mock` được hoist lên trên import, nên factory
 * chạy trước khi `const spy` ở thân file được khởi tạo — tham chiếu trực tiếp
 * sẽ ném TDZ thay vì mock.
 */
const { setResponseStatusSpy } = vi.hoisted(() => ({
  setResponseStatusSpy: vi.fn<(event: unknown, status: number) => void>(),
}));

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>();
  return { ...actual, setResponseStatus: setResponseStatusSpy };
});

/** Source của route — dùng cho bất biến "không có downstream". */
const READY_SOURCE = readFileSync(resolve(import.meta.dirname, '../server/routes/ready.get.ts'), {
  encoding: 'utf8',
});

/**
 * Source với comment đã bị bỏ.
 *
 * ⚠️ Phải bỏ comment trước khi quét: chính comment của `ready.get.ts` **phải**
 * nhắc tới `llm-api`, `marketplace`, `financial` để giải thích vì sao readiness
 * cố ý không phụ thuộc chúng. Quét cả comment sẽ biến tài liệu trung thực thành
 * lỗi, và cách "sửa" duy nhất là xoá giải thích — đúng thứ không nên làm.
 */
const READY_CODE = stripComments(READY_SOURCE);

describe('health and ready routes', () => {
  it('GET /health reports liveness without touching any dependency', async () => {
    // `health.get.ts` không nhận event — truyền `{}` để chứng minh nó không đọc gì.
    await expect(Promise.resolve(healthHandler({} as never))).resolves.toEqual({
      status: 'ok',
      service: 'llm-seller',
    });
    expect(setResponseStatusSpy).not.toHaveBeenCalled();
  });

  it('GET /ready reports ready for a scaffold with no downstream', async () => {
    await expect(Promise.resolve(readyHandler({} as never))).resolves.toEqual({ status: 'ready' });
    expect(setResponseStatusSpy).not.toHaveBeenCalled();
  });
});

/**
 * Bất biến fail-closed: readiness **không** được phụ thuộc một service chưa
 * hiện thực. Nếu ai đó thêm một lần gọi `fetch(`/`llm-api`/`LLM_API`/
 * `hyperdrive`/`D1` vào route này, readiness của seller portal rung theo một
 * service khác và trở thành serving-path dependency — đúng thứ kiến trúc cấm.
 *
 * Khi app có phụ thuộc cấu hình thật, route phải trả 503 kèm mã ổn định thay vì
 * mặc định `ready`; lúc đó test này là điểm phải sửa **có ý thức**, không phải
 * một chốt chặn bị vô hiệu hoá im lặng.
 */
describe('ready route has no downstream dependency', () => {
  it.each([
    ['llm-api', /llm-api/u],
    ['LLM_API', /LLM_API/u],
    ['hyperdrive', /hyperdrive/iu],
    ['D1', /\bD1\b/u],
    ['fetch(', /fetch\s*\(/u],
  ])('does not reference %s', (_label, pattern) => {
    expect(READY_CODE).not.toMatch(pattern);
  });
});
