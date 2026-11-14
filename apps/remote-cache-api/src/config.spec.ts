/**
 * Unit spec cho duong cau hinh portal auth trong loadRemoteCacheConfig —
 * colocated, khong cham DB (06-testing.md §4).
 *
 * Nguyen tac duoc ghim (src/config.ts): thieu `INTERNAL_AUTH_SECRET` thi
 * `internalAuth` la `null` — portal routes fail-closed 503 theo request, phan
 * con lai cua app khong bat boot phai co secret (expand-friendly). Nguoc lai,
 * `kid` sai dinh dang hay skew ngoai khoang hop le cua contract phai NEM luc
 * boot — mot cau hinh sai cua duong xac thuc khong duoc im lang chay voi
 * default.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SKEW_SECONDS,
  MAX_SKEW_SECONDS,
  MIN_SKEW_SECONDS,
} from '@ecoma-io/internal-auth-contracts';

import { loadRemoteCacheConfig, type RemoteCacheEnv } from './config';

const BASE_ENV = {
  DB_REMOTE_CACHE: { connectionString: 'postgres://host/db-remote-cache' },
} as const;

function envWith(overrides: {
  INTERNAL_AUTH_SECRET?: string;
  INTERNAL_AUTH_KID?: string;
  INTERNAL_AUTH_SKEW_SECONDS?: string;
}): RemoteCacheEnv {
  return { ...BASE_ENV, ...overrides };
}

describe('loadRemoteCacheConfig internalAuth (unit)', () => {
  it('leaves internalAuth null when INTERNAL_AUTH_SECRET is absent — portal fails closed per request', () => {
    const config = loadRemoteCacheConfig(BASE_ENV);
    expect(config.internalAuth).toBeNull();
  });

  it('treats an empty INTERNAL_AUTH_SECRET the same as an absent one', () => {
    const config = loadRemoteCacheConfig(envWith({ INTERNAL_AUTH_SECRET: '' }));
    expect(config.internalAuth).toBeNull();
  });

  it('loads the secret with the contract default skew when only the secret is set', () => {
    const config = loadRemoteCacheConfig(envWith({ INTERNAL_AUTH_SECRET: 's3cret' }));
    expect(config.internalAuth).toEqual({
      secret: 's3cret',
      kid: null,
      skewSeconds: DEFAULT_SKEW_SECONDS,
    });
  });

  it('accepts a well-formed kid alongside the secret', () => {
    const config = loadRemoteCacheConfig(
      // Fixture kid co entropy thap ('aaaaaaaa') — 16 hex batch ky hop le nhung
      // khong trung generic-api-key cua gitleaks nhu mot hex string 16 ky tu.
      envWith({ INTERNAL_AUTH_SECRET: 's3cret', INTERNAL_AUTH_KID: 'aaaaaaaa' }),
    );
    expect(config.internalAuth?.kid).toBe('aaaaaaaa');
  });

  it('throws at boot naming INTERNAL_AUTH_KID when the kid is malformed', () => {
    // Sai dinh dang chu khong thieu: phai nem chu khong im lang bo qua kid.
    expect(() =>
      loadRemoteCacheConfig(
        envWith({ INTERNAL_AUTH_SECRET: 's3cret', INTERNAL_AUTH_KID: 'NOT-HEX' }),
      ),
    ).toThrow(/INTERNAL_AUTH_KID/u);
  });

  it('keeps the original assertKid reason in the thrown message', () => {
    // Nguyen nhan goc cua contract phai song sot trong message — neu quy tac
    // validation doi, nguoi van hanh doc duoc ly do that chu khong chi thong
    // bao tinh. InvalidKidError chi neu ten truong ('kid'), khong gia tri.
    let message = '';
    try {
      loadRemoteCacheConfig(
        envWith({ INTERNAL_AUTH_SECRET: 's3cret', INTERNAL_AUTH_KID: 'NOT-HEX' }),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/INTERNAL_AUTH_KID.*internal-auth: kid field/su);
    // Mo ta dinh dang den TU contract va chi mot lan: mot ban hardcode thu hai
    // trong config se lech khi contract doi quy tac ma khong ai phat hien.
    expect(message.match(/8-16 lowercase hex characters/gu)).toHaveLength(1);
  });

  it('accepts the full skew range of the contract and rejects outside values by name', () => {
    const min = loadRemoteCacheConfig(
      envWith({ INTERNAL_AUTH_SECRET: 's', INTERNAL_AUTH_SKEW_SECONDS: String(MIN_SKEW_SECONDS) }),
    );
    expect(min.internalAuth?.skewSeconds).toBe(MIN_SKEW_SECONDS);
    const max = loadRemoteCacheConfig(
      envWith({ INTERNAL_AUTH_SECRET: 's', INTERNAL_AUTH_SKEW_SECONDS: String(MAX_SKEW_SECONDS) }),
    );
    expect(max.internalAuth?.skewSeconds).toBe(MAX_SKEW_SECONDS);
    expect(() =>
      loadRemoteCacheConfig(
        envWith({ INTERNAL_AUTH_SECRET: 's', INTERNAL_AUTH_SKEW_SECONDS: '0' }),
      ),
    ).toThrow(/INTERNAL_AUTH_SKEW_SECONDS/u);
    expect(() =>
      loadRemoteCacheConfig(
        envWith({
          INTERNAL_AUTH_SECRET: 's',
          INTERNAL_AUTH_SKEW_SECONDS: String(MAX_SKEW_SECONDS + 1),
        }),
      ),
    ).toThrow(/INTERNAL_AUTH_SKEW_SECONDS/u);
    expect(() =>
      loadRemoteCacheConfig(
        envWith({ INTERNAL_AUTH_SECRET: 's', INTERNAL_AUTH_SKEW_SECONDS: 'not-a-number' }),
      ),
    ).toThrow(/INTERNAL_AUTH_SKEW_SECONDS/u);
  });

  it('rejects skew strings that Number() would silently coerce to an integer', () => {
    // `Number()` cham ngoai so chu so van tra so hop le: khoang trang vi, hex,
    // dau cong, thap phan, chuoi khoa hoc. Khong gia tri nao la y nghia giay
    // skew duoc khai bao; fail-loud luc boot thay vi doan gia tri gan dung.
    for (const lenient of [' 5 ', '0x10', '+5', '5.0', '1e2']) {
      expect(() =>
        loadRemoteCacheConfig(
          envWith({ INTERNAL_AUTH_SECRET: 's', INTERNAL_AUTH_SKEW_SECONDS: lenient }),
        ),
      ).toThrow(/INTERNAL_AUTH_SKEW_SECONDS/u);
    }
  });
});
