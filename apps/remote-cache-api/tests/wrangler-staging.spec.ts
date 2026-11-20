/**
 * Config contract của lane staging trong `wrangler.jsonc` của unit
 * `remote-cache-api` (#357/#350) — check tĩnh, không mạng, không deploy.
 *
 * Vì sao phải ghim: hostname MOD1 (`remote-cache-api.ecoma.io.vn`), Worker
 * identity `stg-ecoma-remote-cache-api` và binding `DB_REMOTE_CACHE` là các
 * bề mặt mà nhiều phía đọc độc lập (platform-deploy suy record từ inventory
 * eligibility, Router non-production route theo hostname, guard
 * `resource-bindings` chặn id placeholder trước deploy) — lệch một tên là
 * fail-closed im lặng ở một phía nào đó. Spec này là chỗ duy nhất nhìn thấy
 * cả hai phía cùng nhau.
 *
 * JSONC được strip comment + trailing comma — không dependency nào thêm.
 * Strip nhận biết chuỗi (string-aware): một giá trị chứa `//` (vd URL) không
 * bị hỏng (cùng pattern `apps/account/tests/wrangler-services.spec.ts`).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Bản copy cục bộ của cả hai spec cùng lane — dedupe thành helper dùng chung đợi #546.

/**
 * Strip comment + trailing comma TRONG MỘT lượt duyệt, nhận biết chuỗi
 * (string-aware): một giá trị chứa `//` (vd URL) hay `,}` (vd mô tả) không
 * bị hỏng (cùng pattern `apps/account/tests/wrangler-services.spec.ts`).
 */
function stripJsonc(source: string): string {
  let out = '';
  let inString = false;
  let pendingComma = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      out += char;
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
    // Ký tự quyết định đầu sau comma: `}`/`]` → comma là trailing (bỏ); ký tự
    // khác (kể cả `"` mở string) → comma là thật (flush). Whitespace giữ trạng thái.
    if (pendingComma && /\S/u.test(char)) {
      if (char !== '}' && char !== ']') out += ',';
      pendingComma = false;
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
    if (char === ',') {
      pendingComma = true;
      continue;
    }
    out += char;
  }
  return out;
}

/** Parse JSONC của wrangler.jsonc — strip comment + trailing comma string-aware. */
function parseJsonc(path: string): Record<string, unknown> {
  return JSON.parse(stripJsonc(readFileSync(path, 'utf8'))) as Record<string, unknown>;
}

/** Hyperdrive id hợp lệ: rỗng (chỗ dành), toàn số 0 (placeholder), hoặc UUID thật sau khi operator điền. */
const FILLABLE_HYPERDRIVE_ID =
  /^(|0{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|0{8}-0{4}-0{4}-0{4}-0{12})$/u;

interface HyperdriveBinding {
  binding?: unknown;
  id?: unknown;
}

interface StagingEnv {
  name?: unknown;
  hyperdrive?: HyperdriveBinding[];
  devOrigin?: unknown;
  vars?: Record<string, unknown>;
}

const config = parseJsonc(resolve(import.meta.dirname, '../wrangler.jsonc'));
const env = config['env'] as Record<string, StagingEnv> | undefined;
const staging = env?.['staging'];
const topHyperdrive = config['hyperdrive'] as HyperdriveBinding[] | undefined;

describe('remote-cache-api wrangler.jsonc staging env', () => {
  it('exists as an env.staging block with the stg-ecoma-remote-cache-api identity', () => {
    expect(staging, 'env.staging must exist for the staging lane').toBeDefined();
    expect(staging?.name).toBe('stg-ecoma-remote-cache-api');
  });

  it('redeclares the DB_REMOTE_CACHE hyperdrive binding (no env inheritance) matching the top-level binding name', () => {
    expect(topHyperdrive?.map((entry) => entry.binding)).toContain('DB_REMOTE_CACHE');
    const bindings = staging?.hyperdrive ?? [];
    const match = bindings.find((entry) => entry.binding === 'DB_REMOTE_CACHE');
    expect(match, 'env.staging must redeclare hyperdrive binding DB_REMOTE_CACHE').toBeDefined();
    // Id chưa điền là chỗ dành CỐ Ý (rỗng/toàn-zeros) theo hợp đồng wiring
    // #539 — không bao giờ một id bịa nửa vời nào khác được nằm trong Git.
    expect(typeof match?.id).toBe('string');
    expect(FILLABLE_HYPERDRIVE_ID.test(match?.id as string)).toBe(true);
  });

  it('uses the MOD1 staging hostname as devOrigin, never a workers.dev guess', () => {
    expect(staging?.devOrigin).toBe('https://remote-cache-api.ecoma.io.vn');
    expect(String(staging?.devOrigin)).not.toMatch(/workers\.dev/u);
  });

  it('pins the staging S3 bucket var to the bucket the staging program provisions', () => {
    expect(staging?.vars?.['S3_BUCKET']).toBe('ecoma-remote-cache-staging');
  });

  it('keeps account-bound S3 values out of vars (they travel as Worker Secrets)', () => {
    // `S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` gắn account và
    // credential — đặt qua `wrangler secret put` (`04` R22/R23), không bao giờ
    // nằm trong Git dưới dạng var.
    for (const key of ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
      expect(staging?.vars?.[key], `${key} must not be a plaintext var`).toBeUndefined();
    }
  });

  it('leaves no REPLACE-WITH placeholder anywhere in the staging scope', () => {
    const serialized = JSON.stringify(staging);
    expect(serialized).not.toContain('REPLACE-WITH');
  });
});

describe('stripJsonc', () => {
  it('keeps a string value containing ,} intact instead of corrupting the parse', () => {
    const parsed = JSON.parse(stripJsonc('{"description":"a,} weird","count":1,}')) as {
      description: string;
      count: number;
    };
    expect(parsed.description).toBe('a,} weird');
    expect(parsed.count).toBe(1);
  });

  it('still drops a real trailing comma before a closing brace or bracket', () => {
    expect(JSON.parse(stripJsonc('{"a":1,}'))).toEqual({ a: 1 });
    expect(JSON.parse(stripJsonc('{"a":1 , }'))).toEqual({ a: 1 });
    expect(JSON.parse(stripJsonc('[1,2,]'))).toEqual([1, 2]);
    expect(JSON.parse(stripJsonc('{"a":1,\n  "b":2}'))).toEqual({ a: 1, b: 2 });
  });
});
