import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildRootHost,
  extractTraefikHostPort,
  LOCAL_ENV_OWNED_KEYS,
  LOCAL_ENV_RETIRED_KEYS,
  LOCAL_ROOT_HOSTNAME,
  localServiceHostname,
  localServiceOrigin,
  POSTGRES_PASSWORD_ENV_KEY,
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

describe('localServiceHostname', () => {
  it('embeds the namespace so different worktrees get different hostnames for the same service', () => {
    // #316: hai worktree song song phải có cookie jar độc lập — cùng service,
    // namespace khác là hostname khác, cookies `__Host-` theo hostname.
    expect(localServiceHostname('auth', 'fbi.com', 'w1a2b3c4d5e6f')).toBe(
      'auth-w1a2b3c4d5e6f.fbi.com',
    );
    expect(localServiceHostname('auth', 'fbi.com', 'wffffffffffff')).toBe(
      'auth-wffffffffffff.fbi.com',
    );
  });

  it('always produces exactly one extra DNS label — the wildcard `*.fbi.com` covers it', () => {
    // Cert SAN là `fbi.com` + `*.fbi.com` — wildcard chỉ match MỘT nhãn thêm.
    // Ghim hình dạng: không dot trong sub, không dot trong namespace (cả hai
    // theo `worktreeNamespace`: prefix `w` + 12 hex), nên `<sub>-<ns>.<root>`
    // luôn một nhãn duy nhất trước apex.
    const services = ['auth', 'account', 'office', 'api', 'pact', 'llm-console'];
    for (const sub of services) {
      expect(localServiceHostname(sub, 'fbi.com', 'w1a2b3c4d5e6f')).toMatch(
        /^[a-z0-9-]+\.fbi\.com$/u,
      );
      expect(localServiceHostname(sub, 'fbi.com', 'w1a2b3c4d5e6f').split('.')).toHaveLength(3);
    }
  });

  it('does not touch the apex hostname — home stays shared across worktrees', () => {
    // Apex (home) không qua helper: contract giữ `LOCAL_ROOT_HOSTNAME` nguyên
    // và `buildRootHost` không nhận namespace.
    expect(LOCAL_ROOT_HOSTNAME).toBe('fbi.com');
    expect(buildRootHost(32768)).toBe('fbi.com:32768');
  });
});

describe('localServiceOrigin', () => {
  it('keeps the dynamic Traefik port in the origin — browsers can only reach the published port', () => {
    expect(localServiceOrigin('auth', 'fbi.com', 'w1a2b3c4d5e6f', 33118)).toBe(
      'https://auth-w1a2b3c4d5e6f.fbi.com:33118',
    );
  });

  it('differs per namespace for the same service', () => {
    expect(localServiceOrigin('account', 'fbi.com', 'w1a2b3c4d5e6f', 33118)).not.toEqual(
      localServiceOrigin('account', 'fbi.com', 'wffffffffffff', 33118),
    );
  });

  it('rejects empty sub, rootHostname and namespace, and a dot inside sub or namespace', () => {
    // Ranh giới contract: đầu vào xấu phải fail-loud — hostname invalid làm
    // router `Host()` lệch và cookie `__Host-` scope sai, lặng lẽ là tệ nhất.
    expect(() => localServiceHostname('', 'fbi.com', 'w1a2b3c4d5e6f')).toThrow(/sub/u);
    expect(() => localServiceHostname('auth', '', 'w1a2b3c4d5e6f')).toThrow(/rootHostname/u);
    expect(() => localServiceHostname('auth', 'fbi.com', '')).toThrow(/namespace/u);
    expect(() => localServiceHostname('auth.x', 'fbi.com', 'w1a2b3c4d5e6f')).toThrow(
      /single DNS label/u,
    );
    expect(() => localServiceHostname('auth', 'fbi.com', 'w1a.3c4d5e6f')).toThrow(
      /single DNS label/u,
    );
  });

  it('rejects a non-integer or out-of-range Traefik port', () => {
    expect(() => localServiceOrigin('auth', 'fbi.com', 'w1a2b3c4d5e6f', Number.NaN)).toThrow(
      /valid TCP port/u,
    );
    expect(() => localServiceOrigin('auth', 'fbi.com', 'w1a2b3c4d5e6f', 0)).toThrow(
      /valid TCP port/u,
    );
    expect(() => localServiceOrigin('auth', 'fbi.com', 'w1a2b3c4d5e6f', 70000)).toThrow(
      /valid TCP port/u,
    );
    expect(() => localServiceOrigin('auth', 'fbi.com', 'w1a2b3c4d5e6f', 3.5)).toThrow(
      /valid TCP port/u,
    );
  });
});

describe('local .env owned keys contract', () => {
  it('owns exactly the keys ROOT_HOST and POSTGRES_PASSWORD', () => {
    // Ghim toàn bộ tập key sở hữu: thêm/bớt một key của `upsertLocalEnv` là
    // thay đổi contract ghi `.env` và phải đi qua test này một cách có chủ ý.
    expect([...LOCAL_ENV_OWNED_KEYS]).toEqual([ROOT_HOST_ENV_KEY, POSTGRES_PASSWORD_ENV_KEY]);
  });

  it('ROOT_DOMAIN is retired, not owned, and the key literals are pinned', () => {
    // `ROOT_DOMAIN` từng là alias E2E-facing trùng giá trị `ROOT_HOST`; #210
    // gộp về một key duy nhất. Ghim literal của cả hai tập để một key retired
    // bị "hồi sinh" vào tập owned — hay một lỗi đánh máy tên key — không lọt
    // qua consumer nào đọc `.env`.
    expect([...LOCAL_ENV_RETIRED_KEYS]).toEqual(['ROOT_DOMAIN']);
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
