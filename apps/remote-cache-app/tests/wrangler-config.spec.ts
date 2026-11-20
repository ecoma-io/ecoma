/**
 * Hợp đồng config staging của `wrangler.jsonc` (lane #357): identity
 * `stg-ecoma-remote-cache-app`, binding Hyperdrive `DB_REMOTE_CACHE_APP` khai
 * lại TƯỜNG MINH cho `env.staging` (Wrangler KHÔNG inherit binding top-level
 * vào `env.<lane>` — `02-delivery.md` §4.1 điều 1), origin MOD1 tất định cho
 * cả `devOrigin` lẫn base URL của control plane mà BFF gọi, không còn
 * placeholder dạng `REPLACE-WITH-*` trong subtree staging.
 *
 * JSONC được strip comment + trailing comma — không dependency nào thêm. Strip
 * nhận biết chuỗi (string-aware): scanner tự viết đi qua file một lần (cùng
 * hình `apps/pact-broker-app/tests/wrangler-config.spec.ts`), vì một giá trị
 * chứa `//` — ví dụ URL — không được phép bị hỏng.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Strip line comment (`//`) và block comment ngoài string literal, rồi bỏ
 * trailing comma — cả hai phase đều string-aware: giá trị chứa `//` hay `,}`
 * không bị biến đổi.
 */
function parseJsonc(path: string): Record<string, unknown> {
  const source = readFileSync(path, 'utf8');
  let out = '';
  let inString = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      out += char;
      // `\"` escape là phần của string, không đóng string.
      if (char === '\\' && i + 1 < source.length) {
        out += source[i + 1];
        i += 1;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      out += '\n';
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) {
        throw new Error('unterminated block comment in wrangler.jsonc');
      }
      i = end + 1;
      continue;
    }
    out += char;
  }
  // Pass hai — drop trailing comma, string-aware trên text đã strip comment:
  // `,` kế cận (chỉ qua khoảng trắng) `}`/`]` của struct là trailing comma,
  // bỏ; `,` bên trong string literal giữ nguyên.
  let json = '';
  let inJsonString = false;
  for (let i = 0; i < out.length; i += 1) {
    const char = out[i];
    if (inJsonString) {
      json += char;
      if (char === '\\' && i + 1 < out.length) {
        json += out[i + 1];
        i += 1;
        continue;
      }
      if (char === '"') {
        inJsonString = false;
      }
      continue;
    }
    if (char === '"') {
      inJsonString = true;
      json += char;
      continue;
    }
    if (char === ',') {
      let j = i + 1;
      while (j < out.length && /\s/u.test(out[j])) {
        j += 1;
      }
      if (out[j] === '}' || out[j] === ']') {
        continue;
      }
    }
    json += char;
  }
  return JSON.parse(json) as Record<string, unknown>;
}

type HyperdriveBinding = { binding?: unknown; id?: unknown };

describe('wrangler.jsonc env.staging (lane #357)', () => {
  const config = parseJsonc(resolve(import.meta.dirname, '../wrangler.jsonc'));
  const env = config['env'] as Record<string, Record<string, unknown>> | undefined;
  const staging = env?.['staging'];

  it('exposes the staging env', () => {
    expect(staging, 'env.staging must exist').toBeDefined();
  });

  it('names the staging worker identity stg-ecoma-remote-cache-app', () => {
    expect(staging?.['name']).toBe('stg-ecoma-remote-cache-app');
  });

  it('declares no parallel workers.dev hostname on staging', () => {
    // §4.2: public surface staging là hostname MOD1 qua Router non-production;
    // `workers_dev` bật là mở hostname song song ngoài scheme.
    expect(staging?.['workers_dev']).toBe(false);
  });

  it('redeclares the DB_REMOTE_CACHE_APP binding for the env in the deliberately-unwired empty-id state', () => {
    // Binding KHÔNG inherit từ top-level vào env.staging — thiếu khai lại là
    // deploy lỗi định danh. `id` rỗng cố ý: wiring sau lần `up` xanh đầu tiên
    // của `deploys/remote-cache-app-deploy` (stack output `hyperdriveConfigId`)
    // — operator fill; audit `resource-bindings` (#362) chặn id rỗng khi flip
    // eligibility — id giả đủ shape sẽ qua mặt gate đó nên KHÔNG được phép
    // xuất hiện ở đây.
    const hyperdrive = staging?.['hyperdrive'] as HyperdriveBinding[] | undefined;
    expect(Array.isArray(hyperdrive) && hyperdrive.length === 1).toBe(true);
    expect(hyperdrive?.[0]?.binding).toBe('DB_REMOTE_CACHE_APP');
    expect(hyperdrive?.[0]?.id).toBe('');
  });

  it('pins the deterministic MOD1 origin as devOrigin', () => {
    // MOD1 (§4.2): subdomain của zone non-production `ecoma.io.vn` — giá trị
    // suy ra được từ repo, không phải suy đoán subdomain account.
    expect(staging?.['devOrigin']).toBe('https://remote-cache-app.ecoma.io.vn');
  });

  it('points the BFF at the MOD1 origin of the control-plane unit', () => {
    // `vars` KHÔNG inherit từ top-level, nên khai tường minh cho env này;
    // hostname MOD1 của unit `remote-cache-api`, cùng Router non-production.
    const vars = staging?.['vars'] as Record<string, unknown> | undefined;
    expect(vars?.['NITRO_REMOTE_CACHE_API_BASE_URL']).toBe('https://remote-cache-api.ecoma.io.vn');
  });

  it('declares the staging smoke surface', () => {
    // Bề mặt smoke staging được khai tường minh cho wiring smoke của lane
    // dùng chung — bỏ khoá này là lane smoke mất bề mặt của unit.
    expect(staging?.['smokeSurface']).toEqual({});
  });

  it('carries no REPLACE-WITH placeholder inside the staging subtree', () => {
    expect(staging, 'env.staging must exist').toBeDefined();
    expect(JSON.stringify(staging)).not.toContain('REPLACE-WITH');
  });
});
