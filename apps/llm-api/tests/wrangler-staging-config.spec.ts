/**
 * Hợp đồng config staging của `apps/llm-api/wrangler.jsonc` (issue #359):
 * env `staging` khai đủ BA Hyperdrive binding với đúng tên binding top-level,
 * identity `stg-ecoma-llm-api` theo scheme MOD1, và KHÔNG bao giờ mang
 * placeholder id.
 *
 * Vì sao phải ghim: lệch ở đây là fail-closed im lặng theo hai hướng khác
 * nhau — thiếu binding trong `env.staging` làm deploy staging ra Worker
 * KHÔNG có DB bound (Wrangler không inherit binding top-level vào `env.*`,
 * hiện trạng đã đo ở `02-delivery.md` §4.1); còn placeholder id (toàn-zeros)
 * là định danh giả mà guard `resource-bindings` chặn (§9.1). Test tĩnh này là
 * chỗ duy nhất nhìn thấy cả hai phía (top-level ↔ env.staging) cùng nhau
 * trước khi lane staging deploy thật.
 *
 * Hợp đồng id: giá trị ĐÚNG duy nhất là UUID thật do Pulumi cấp (stack output
 * `<target>HyperdriveConfigId` của `deploys/llm-api-deploy` sau một lần
 * `staging-up` xanh — §9.1: id do provisioning cung cấp, Wrangler không tạo
 * config). Chuỗi rỗng là trạng thái TRƯỚC khi fill xảy ra; mọi hình placeholder
 * khác (toàn-zeros, text) đều bị chặn. Pattern UUID được khai cục bộ ở đây vì
 * app không được import xuyên sang `deploys/*` (nx module boundary) — hai bên
 * cùng so khớp một hình, không chia sẻ code.
 *
 * JSONC được strip comment + trailing comma — không dependency nào thêm. Strip
 * nhận biết chuỗi (string-aware): scanner tự viết đi qua file một lần, không
 * strip bên trong string literal (một giá trị chứa `//` — vd URL — không bị
 * hỏng), thay vì regex mù (cùng pattern `apps/account/tests/wrangler-services.spec.ts`).
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

interface HyperdriveBinding {
  binding?: unknown;
  id?: unknown;
}

const STAGING_BINDING_NAMES = ['DB_LLM_GATEWAY', 'DB_LLM_TENANT', 'DB_LLM_MARKETPLACE'] as const;

// Cùng invariant với `isProvisionedHyperdriveConfigId` của
// `deploys/llm-api-deploy/staging-run.ts` và guard placeholder của
// `tools/delivery` (§9.1) — UUID thường, không phải toàn-zeros.
const HYPERDRIVE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HYPERDRIVE_PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';

function hyperdriveBindings(config: Record<string, unknown>, scope: string): HyperdriveBinding[] {
  const value = config[scope];
  if (value === undefined) return [];
  expect(
    Array.isArray(value),
    `wrangler.jsonc "${scope}" must be an array of binding objects`,
  ).toBe(true);
  return value as HyperdriveBinding[];
}

describe('wrangler.jsonc staging config contract (#359)', () => {
  const config = parseJsonc(resolve(import.meta.dirname, '../wrangler.jsonc'));
  const stagingEnv = config['env'] as Record<string, Record<string, unknown>> | undefined;
  const staging = stagingEnv?.['staging'] as Record<string, unknown> | undefined;

  it('declares an env.staging identity stg-ecoma-llm-api and no parallel public hostname (MOD1)', () => {
    expect(staging, 'wrangler.jsonc must declare env.staging').toBeDefined();
    expect(staging?.['name']).toBe('stg-ecoma-llm-api');
    // A13/MOD1 (02-delivery.md §4.2): hostname public staging qua Router
    // non-production — Worker không tự gắn Custom Domain/route nào, và
    // workers.dev tắt để không có hostname song song.
    expect(staging?.['workers_dev']).toBe(false);
    expect(staging?.['routes']).toBeUndefined();
  });

  it('re-declares exactly the three top-level hyperdrive bindings inside env.staging', () => {
    const topLevel = hyperdriveBindings(config, 'hyperdrive')
      .map((entry) => entry.binding)
      .toSorted();
    expect(topLevel).toEqual(['DB_LLM_GATEWAY', 'DB_LLM_MARKETPLACE', 'DB_LLM_TENANT']);

    const stagingBindings = hyperdriveBindings(staging as Record<string, unknown>, 'hyperdrive');
    const names = stagingBindings.map((entry) => entry.binding);
    expect(names.toSorted()).toEqual([...STAGING_BINDING_NAMES].toSorted());
  });

  it('carries no placeholder id: every staging id is empty (pending) or a real Pulumi-provided UUID', () => {
    const stagingBindings = hyperdriveBindings(staging as Record<string, unknown>, 'hyperdrive');
    expect(stagingBindings).toHaveLength(3);
    for (const entry of stagingBindings) {
      const id = entry.id;
      const idLabel = `hyperdrive id for ${String(entry.binding)}`;
      expect(typeof id, `${idLabel} must be a string`).toBe('string');
      const value = id as string;
      if (value.length === 0) continue; // pending staging-up fill — trạng thái được phép duy nhất
      expect(
        value,
        `${idLabel} must be a Pulumi-provided UUID (stack output <target>HyperdriveConfigId), never a placeholder`,
      ).toMatch(HYPERDRIVE_ID_PATTERN);
      expect(value, `${idLabel} must not be the all-zeros placeholder`).not.toBe(
        HYPERDRIVE_PLACEHOLDER_ID,
      );
    }
  });
});
