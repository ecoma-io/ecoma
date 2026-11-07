import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildRootHost,
  extractTraefikHostPort,
  LOCAL_ENV_OWNED_KEYS,
  LOCAL_ROOT_HOSTNAME,
  POSTGRES_PASSWORD_ENV_KEY,
  ROOT_DOMAIN_ENV_KEY,
  ROOT_HOST_ENV_KEY,
  TRAEFIK_INTERNAL_PORT,
} from './platform-outputs-contract.js';

describe('buildRootHost', () => {
  it('joins the hostname with the actual port — `fbi.com:<port>`', () => {
    expect(buildRootHost(32768)).toBe('fbi.com:32768');
    expect(buildRootHost(44301)).toBe('fbi.com:44301');
  });

  it('the hostname is the agreed local constant', () => {
    expect(LOCAL_ROOT_HOSTNAME).toBe('fbi.com');
  });
});

describe('local .env owned keys contract', () => {
  it('owns exactly the three keys: ROOT_HOST, ROOT_DOMAIN and POSTGRES_PASSWORD', () => {
    // Ghim toàn bộ tập key sở hữu: thêm/bớt một key của `upsertLocalEnv` là
    // thay đổi contract ghi `.env` và phải đi qua test này một cách có chủ ý.
    expect([...LOCAL_ENV_OWNED_KEYS]).toEqual([
      ROOT_HOST_ENV_KEY,
      ROOT_DOMAIN_ENV_KEY,
      POSTGRES_PASSWORD_ENV_KEY,
    ]);
  });

  it('ROOT_DOMAIN is the E2E-facing alias with the same literal as ROOT_HOST', () => {
    // Hai key là hai tên gọi cho cùng một giá trị `host[:port]`; ghim literal
    // để một lỗi đánh máy tên key không lọt qua consumer E2E đọc `.env`.
    expect(ROOT_DOMAIN_ENV_KEY).toBe('ROOT_DOMAIN');
    expect(ROOT_HOST_ENV_KEY).toBe('ROOT_HOST');
    expect(POSTGRES_PASSWORD_ENV_KEY).toBe('POSTGRES_PASSWORD');
  });
});

describe('traefik-dynamic.yml consistency', () => {
  it('the cert filename in the dynamic config matches LOCAL_ROOT_HOSTNAME — the two sources of truth are locked together', () => {
    // `deploys/platform-deploy/index.ts` suy tên cert từ `LOCAL_ROOT_HOSTNAME`,
    // còn `traefik-dynamic.yml` hardcode — lệch một chữ là MỌI worktree sập
    // (Traefik không có certificate trong store). Test đọc chính file YAML và
    // khóa hai bên với nhau thay vì dựa kỷ luật "sửa cùng lúc".
    //
    // Anchor từ vị trí file này (`import.meta.dirname` — ESM, thay cho
    // `__dirname` CJS): spec nằm ở libs/deployment/src nên cần ba mức `../`
    // về repo root. Sai một mức là ENOENT ngay khi chạy.
    const dynamic = readFileSync(
      join(import.meta.dirname, '../../../deploys/platform-deploy/traefik-dynamic.yml'),
      'utf8',
    );
    expect(dynamic).toContain(`certFile: /certs/${LOCAL_ROOT_HOSTNAME}.crt`);
    expect(dynamic).toContain(`keyFile: /certs/${LOCAL_ROOT_HOSTNAME}.key`);
    // Mọi dòng `certFile:`/`keyFile:` phải trỏ đúng hostname hằng số — thu về
    // một mảng trước, assert không điều kiện (vitest cấm `expect` trong if).
    const mounted = dynamic
      .split('\n')
      .map((line) => line.match(/(certFile|keyFile): \/certs\/(\S+)/u))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({ kind: m[1], file: m[2] }));
    expect(mounted.length).toBeGreaterThanOrEqual(2);
    expect(mounted).toEqual([
      { kind: 'certFile', file: `${LOCAL_ROOT_HOSTNAME}.crt` },
      { kind: 'keyFile', file: `${LOCAL_ROOT_HOSTNAME}.key` },
    ]);
  });
});

describe('extractTraefikHostPort', () => {
  it('reads the external of the exact internal HTTPS port', () => {
    expect(
      extractTraefikHostPort([
        { internal: 8080, external: 39000 },
        { internal: TRAEFIK_INTERNAL_PORT, external: 39001 },
      ]),
    ).toBe(39001);
  });

  it('fail-closed when ports is undefined', () => {
    expect(() => extractTraefikHostPort(undefined)).toThrow(/not ready/u);
  });

  it('fail-closed when the HTTPS port has no external (Docker has not assigned one)', () => {
    expect(() => extractTraefikHostPort([{ internal: TRAEFIK_INTERNAL_PORT }])).toThrow(
      /not ready/u,
    );
    expect(() =>
      extractTraefikHostPort([{ internal: TRAEFIK_INTERNAL_PORT, external: 0 }]),
    ).toThrow(/not ready/u);
  });

  it('fail-closed with NaN — a <= comparison against NaN is always false, so Number.isInteger must guard', () => {
    expect(() =>
      extractTraefikHostPort([{ internal: TRAEFIK_INTERNAL_PORT, external: Number.NaN }]),
    ).toThrow(/not ready/u);
  });

  it('fail-closed when no port matches the internal HTTPS port', () => {
    expect(() => extractTraefikHostPort([{ internal: 80, external: 39002 }])).toThrow(/not ready/u);
  });
});
