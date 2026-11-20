/**
 * Hợp đồng config staging của `wrangler.jsonc` (lane #358): identity
 * `stg-ecoma-pact-broker-app`, binding Hyperdrive `DB_PACT_BROKER_APP` khai
 * lại TƯỜNG MINH cho `env.staging` (Wrangler KHÔNG inherit binding top-level
 * vào `env.<lane>` — `02-delivery.md` §4.1 điều 1), origin MOD1 tất định cho
 * cả `devOrigin` lẫn base URL của API mà BFF gọi, không còn placeholder dạng
 * `REPLACE-WITH-*` trong subtree staging.
 *
 * JSONC được strip comment + trailing comma — không dependency nào thêm. Strip
 * nhận biết chuỗi (string-aware): scanner tự viết đi qua file một lần (cùng
 * hình `apps/account/tests/wrangler-services.spec.ts`), vì một giá trị chứa
 * `//` — ví dụ URL — không được phép bị hỏng.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Strip line comments (`//`) and block comments outside string literals, then drop trailing commas. */
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
  return JSON.parse(out.replace(/,(\s*[}\]])/gu, '$1')) as Record<string, unknown>;
}

type HyperdriveBinding = { binding?: unknown; id?: unknown };

describe('wrangler.jsonc env.staging (lane #358)', () => {
  const config = parseJsonc(resolve(import.meta.dirname, '../wrangler.jsonc'));
  const env = config['env'] as Record<string, Record<string, unknown>> | undefined;
  const staging = env?.['staging'];

  it('exposes the staging env', () => {
    expect(staging, 'env.staging must exist').toBeDefined();
  });

  it('names the staging worker identity stg-ecoma-pact-broker-app', () => {
    expect(staging?.['name']).toBe('stg-ecoma-pact-broker-app');
  });

  it('declares no parallel workers.dev hostname on staging', () => {
    // §4.2: public surface staging là hostname MOD1 qua Router non-production;
    // `workers_dev` bật là mở hostname song song ngoài scheme.
    expect(staging?.['workers_dev']).toBe(false);
  });

  it('redeclares the DB_PACT_BROKER_APP binding for the env with a hex-32 id shape', () => {
    // Binding KHÔNG inherit từ top-level vào env.staging — thiếu khai lại là
    // deploy lỗi định danh. `id` hex-32 là convention placeholder của lane
    // chờ operator fill id thật từ stack output `hyperdriveConfigId` (#358);
    // empty string / garbage là trôi khỏi convention.
    const hyperdrive = staging?.['hyperdrive'] as HyperdriveBinding[] | undefined;
    expect(Array.isArray(hyperdrive) && hyperdrive.length === 1).toBe(true);
    expect(hyperdrive?.[0]?.binding).toBe('DB_PACT_BROKER_APP');
    expect(hyperdrive?.[0]?.id).toMatch(/^[0-9a-f]{32}$/u);
  });

  it('pins the deterministic MOD1 origin as devOrigin', () => {
    // MOD1 (§4.2): subdomain của zone non-production `ecoma.io.vn` — giá trị
    // suy ra được từ repo, không phải suy đoán subdomain account (placeholder
    // `REPLACE-WITH-*` cũ fail closed đúng chủ ý và đã được thay).
    expect(staging?.['devOrigin']).toBe('https://pact-broker-app.ecoma.io.vn');
  });

  it('points the BFF at the MOD1 origin of the API unit', () => {
    // `vars` KHÔNG inherit từ top-level, nên khai tường minh cho env này;
    // hostname MOD1 của unit API, cùng Router non-production.
    const vars = staging?.['vars'] as Record<string, unknown> | undefined;
    expect(vars?.['NITRO_PACT_BROKER_API_BASE_URL']).toBe('https://pact-broker-api.ecoma.io.vn');
  });

  it('declares the staging smoke surface', () => {
    // Bề mặt smoke staging được khai tường minh cho wiring smoke của lane
    // dùng chung (mô hình tham số origin của #535) — bỏ khoá này là lane
    // smoke mất bề mặt của unit.
    expect(staging?.['smokeSurface']).toEqual({});
  });

  it('carries no REPLACE-WITH placeholder inside the staging subtree', () => {
    expect(JSON.stringify(staging)).not.toContain('REPLACE-WITH');
  });
});
