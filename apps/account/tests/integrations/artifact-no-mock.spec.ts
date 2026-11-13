/**
 * Artifact đã build **không chứa đường mock** — điều kiện chấp nhận của Issue
 * #123, kiểm trên toàn bộ `.output/` chứ không phải trên source.
 *
 * Vì sao phải quét build output: mọi gate trên source (ranh giới import, guard
 * `nuxt.options.dev`) khẳng định điều ở **trước** bundler. Đây là lớp cuối: nếu
 * một đường nào đó đưa `mock-adapter` vào module graph — một import mới, một
 * đăng ký plugin sai — các marker chuỗi dưới đây xuất hiện trong artifact và
 * test đỏ, bất kể bundler đặt code vào chunk nào.
 *
 * Marker là **string literal chỉ tồn tại trong `mock-adapter.ts` hoặc trong
 * `tests/test-adapter.ts`** (fixtures dữ liệu và message của hai file đó — test
 * double cũng không được ship như mock): string literal sống sót qua minify,
 * nên phép quét không phụ thuộc tên chunk hay dạng code. Không dùng tên module
 * (`mock-adapter`) làm marker — comment của source hợp lệ cũng nhắc tên đó, và
 * sourcemap (nếu bật) sẽ đưa comment vào output mà không có đường chạy nào.
 * Prefix id tuần tự (`email-mock`) được lấy **không kèm ký tự nối**: chuỗi
 * nguồn là prefix, còn id đầy đủ (`email-mock-1`) được dựng lúc chạy nên không
 * bao giờ xuất hiện dưới dạng literal trong bundle nào.
 *
 * Test này đọc `.output/` — artifact của `account:build`, và `test-integration`
 * `dependsOn` `build` để artifact tồn tại ở mọi runner sạch (không tin cache
 * local). Cùng cơ chế với `nitro-routes.spec.ts`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const OUTPUT_DIR = resolve(import.meta.dirname, '../../.output');

/**
 * Chuỗi chỉ có thể đến từ `mock-adapter.ts`. Sinh ra một chuỗi mới trong mock là
 * phải cân nhắc: nó có làm marker hàng rào build yếu đi không — câu trả lời đúng
 * là phải thêm nó vào danh sách này nếu nó nhận diện được đường mock.
 */
const MOCK_MARKERS = [
  'Nguyen Van A', // profile fixture của mock
  'nguyen.van.a@example.com', // email fixture của mock
  'a.nguyen@example.org', // email fixture của mock
  'Firefox on macOS', // session fixture của mock
  'Safari on iPhone', // session fixture của mock
  'mock adapter refused', // message refuse() của mock
  'email-mock', // prefix id tuần tự của mock (không kèm '-' — xem JSDoc trên)
  'privacy-mock', // prefix id tuần tự của mock
  'mock-consent-handle', // handle consent cũ của mock — dead tripwire, không được sống lại
  'test adapter refused', // message refuse() của test-adapter
  'test-consent-handle', // handle consent của test-adapter
  'MacBook Pro', // passkey fixture của test-adapter
  'no server handoff in test harness', // message handoff của test-adapter
] as const;

/** Gate fail-closed của server phải **có mặt** trong artifact (khôi phục được từ output). */
const MOCK_IN_ARTIFACT_GATE = 'data_mode_mock_in_artifact';

/** Liệt kê đệ quy mọi file của `.output/`, bỏ sourcemap (artifact debug, không phải đường chạy). */
function listOutputFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith('.map')) {
        files.push(full);
      }
    }
  };
  walk(OUTPUT_DIR);
  return files;
}

describe('built artifact contains no mock path', () => {
  // Guard này chạy trước `listOutputFiles()`: khi `.output/` chưa tồn tại
  // (checkout sạch, build hỏng), `readdirSync` sẽ ném ENOENT không lời nhắn —
  // thông điệp "hãy build trước" phải là lỗi người đọc nhìn thấy được.
  if (!existsSync(OUTPUT_DIR)) {
    throw new Error(`no build output at ${OUTPUT_DIR} — run the account build first`);
  }
  const files = listOutputFiles();

  it('has an artifact to scan (test-integration depends on build)', () => {
    expect(files.length, `no files under ${OUTPUT_DIR} — run the build first`).toBeGreaterThan(0);
  });

  it('contains none of the mock adapter markers anywhere in the output', () => {
    const hits: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const marker of MOCK_MARKERS) {
        if (content.includes(marker)) {
          hits.push(`${file}: ${marker}`);
        }
      }
    }
    // Một marker trong artifact là một đường mock chạy được — đúng điều mà
    // `docs/architecture/05-code-architecture.md` §5 cấm, kể cả khi không có
    // nhánh runtime nào gọi tới nó.
    expect(hits, 'mock markers found in the built artifact').toEqual([]);
  });

  it('ships the fail-closed server gate that refuses mock mode in artifacts', () => {
    // Quét tìm marker phải đi cặp với gate dương: artifact chủ động từ chối mode
    // mock lúc boot (`data_mode_mock_in_artifact` ⇒ 503). Chuỗi reason nằm trong
    // bundle server — nếu ai gỡ gate, test này đỏ trước khi hành vi mất.
    const serverFiles = files.filter((file) => file.includes('/server/'));
    const gateShipped = serverFiles.some((file) =>
      readFileSync(file, 'utf8').includes(MOCK_IN_ARTIFACT_GATE),
    );
    expect(gateShipped, 'mock-in-artifact boot gate missing from the server bundle').toBe(true);
  });
});
