/**
 * Hợp đồng config staging của `wrangler.jsonc` (lane #358): identity
 * `stg-ecoma-pact-broker-api`, binding Hyperdrive khai lại TƯỜNG MINH cho
 * `env.staging` (Wrangler KHÔNG inherit binding top-level vào `env.<lane>` —
 * `02-delivery.md` §4.1 điều 1), origin MOD1 tất định, không còn placeholder
 * dạng `REPLACE-WITH-*` trong subtree staging, và KHÔNG có queue consumer
 * trên staging (consumer entitlement được defer cùng rationale đóng của
 * #356 — note trong PR của #358).
 *
 * JSONC được strip comment + trailing comma — không dependency nào thêm. Strip
 * nhận biết chuỗi (string-aware): scanner tự viết đi qua file một lần (cùng
 * hình `apps/account/tests/wrangler-services.spec.ts`), vì một giá trị chứa
 * `//` — ví dụ URL — không được phép bị hỏng.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
  // bỏ; `,` bên trong string literal giữ nguyên (giá trị chứa `,}` không bị
  // biến đổi như replace regex nguyên thủy từng làm).
  let json = '';
  // Trạng thái string của pass hai là biến riêng, không tái dùng `inString`
  // của pass một — hai pass quét hai text khác nhau, chia sẻ biến chỉ tạo
  // rủi ro regression khi một pass đổi mà quên pass kia.
  let inJsonString = false;
  for (let i = 0; i < out.length; i += 1) {
    const char = out[i];
    if (inJsonString) {
      json += char;
      // `\"` escape là phần của string, không đóng string.
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

describe('wrangler.jsonc env.staging (lane #358)', () => {
  const config = parseJsonc(resolve(import.meta.dirname, '../wrangler.jsonc'));
  const env = config['env'] as Record<string, Record<string, unknown>> | undefined;
  const staging = env?.['staging'];

  it('exposes the staging env', () => {
    expect(staging, 'env.staging must exist').toBeDefined();
  });

  it('names the staging worker identity stg-ecoma-pact-broker-api', () => {
    expect(staging?.['name']).toBe('stg-ecoma-pact-broker-api');
  });

  it('declares no parallel workers.dev hostname on staging', () => {
    // §4.2: public surface staging là hostname MOD1 qua Router non-production;
    // `workers_dev` bật là mở hostname song song ngoài scheme.
    expect(staging?.['workers_dev']).toBe(false);
  });

  it('redeclares the HYPERDRIVE binding for the env in the deliberately-unwired empty-id state', () => {
    // Binding KHÔNG inherit từ top-level vào env.staging — thiếu khai lại là
    // deploy lỗi định danh. `id` rỗng cố ý theo wiring contract #539: trạng
    // thái "chưa wire" trung thực, operator fill id thật từ stack output
    // `hyperdriveConfigId` sau lần `up` xanh (#358); audit `resource-bindings`
    // (#362) chặn id rỗng khi flip eligibility — id giả đủ shape sẽ qua mặt
    // gate đó nên KHÔNG được phép xuất hiện ở đây.
    const hyperdrive = staging?.['hyperdrive'] as HyperdriveBinding[] | undefined;
    expect(Array.isArray(hyperdrive) && hyperdrive.length === 1).toBe(true);
    expect(hyperdrive?.[0]?.binding).toBe('HYPERDRIVE');
    expect(hyperdrive?.[0]?.id).toBe('');
  });

  it('keeps the top-level HYPERDRIVE binding for the local lane', () => {
    const hyperdrive = config['hyperdrive'] as HyperdriveBinding[] | undefined;
    expect(hyperdrive?.[0]?.binding).toBe('HYPERDRIVE');
  });

  it('pins the deterministic MOD1 origin as devOrigin', () => {
    // MOD1 (§4.2): subdomain của zone non-production `ecoma.io.vn` — giá trị
    // suy ra được từ repo, không phải suy đoán subdomain account.
    expect(staging?.['devOrigin']).toBe('https://pact-broker-api.ecoma.io.vn');
  });

  it('declares no entitlement queue consumer on staging', () => {
    // Consumer phụ thuộc producer `staff-access-relay` (#356 closed not
    // planned) — defer cùng rationale đó; khai consumer trỏ queue chưa tồn
    // tại trên staging là lỗi định danh khi deploy.
    const queues = staging?.['queues'] as { consumers?: unknown } | undefined;
    expect(queues?.['consumers']).toBeUndefined();
  });

  it('carries no REPLACE-WITH placeholder inside the staging subtree', () => {
    // JSON.stringify(undefined) là primitive `undefined` — guard trước để
    // assert không dính thông báo sai lệch khi env.staging vắng mặt.
    expect(staging, 'env.staging must exist').toBeDefined();
    expect(JSON.stringify(staging)).not.toContain('REPLACE-WITH');
  });
});

describe('parseJsonc', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('a string value containing `,}` survives parsing intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrangler-jsonc-spec-'));
    cleanup.push(dir);
    const file = join(dir, 'wrangler.jsonc');
    // Giá trị chứa đúng chuỗi mà replace trailing-comma không string-aware
    // biến đổi trong string literal (`/,(\s*[}\]])/`) — parser string-aware
    // phải giữ nguyên; comment chứa `, }` cũng không được phá parse.
    writeFileSync(
      file,
      [
        '{',
        '  // comment containing , } and a comma,',
        '  "vars": { "NOTE": "keep ,} intact,}," },',
        '  "list": [1, 2,],',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const parsed = parseJsonc(file);
    expect(parsed['vars']).toEqual({ NOTE: 'keep ,} intact,},' });
    expect(parsed['list']).toEqual([1, 2]);
  });

  it('a block comment containing `, }` is stripped without touching string values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrangler-jsonc-spec-'));
    cleanup.push(dir);
    const file = join(dir, 'wrangler.jsonc');
    // Block comment chứa `, }` phải bị strip ở pass một — nếu sót, pass hai
    // nhìn thấy `,` kế cận `}` và hành vi trailing-comma lệch khỏi contract.
    writeFileSync(
      file,
      [
        '{',
        '  /* comment containing , } and a comma, */',
        '  "vars": { "NOTE": "keep ,} intact,}," },',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const parsed = parseJsonc(file);
    expect(parsed['vars']).toEqual({ NOTE: 'keep ,} intact,},' });
  });
});
