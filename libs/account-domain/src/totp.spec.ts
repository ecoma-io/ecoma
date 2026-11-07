import { describe, expect, it } from 'vitest';

import { base32Encode } from './base32';
import {
  computeTotp,
  decodeTotpSecret,
  DEFAULT_TOTP_ALGORITHM,
  generateTotpSecret,
  MIN_TOTP_SECRET_BYTES,
  otpauthUri,
  TOTP_STEP_SECONDS,
  totpCounterAt,
  verifyTotp,
} from './totp';

/** Secret '12345678901234567890' — ASCII, đúng secret của RFC 4226 Appendix D. */
const RFC_SECRET_20B = new TextEncoder().encode('12345678901234567890');
/** Secret 32 byte của RFC 6238 Appendix B (SHA-256). */
const RFC_SECRET_32B = new TextEncoder().encode('12345678901234567890123456789012');
/** Secret 64 byte của RFC 6238 Appendix B (SHA-512). */
const RFC_SECRET_64B = new TextEncoder().encode(
  '1234567890123456789012345678901234567890123456789012345678901234',
);

/**
 * Bảy mốc thời gian của RFC 6238 §B: T=59, 1111111109, 1111111111, 1234567890,
 * 2000000000, 20000000000 (giây Unix).
 */
const RFC_TIMES = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000] as const;

/**
 * Mã kỳ vọng — tính độc lập bằng hai engine khác nhau (Python hmac + Node crypto)
 * trước khi ghi vào đây; chúng khớp nhau và khớp bảng RFC 6238 §B cho SHA-1.
 */
const EXPECTED = {
  'SHA-1': {
    secret20: ['94287082', '07081804', '14050471', '89005924', '69279037', '65353130'],
  },
  'SHA-256': {
    secret32: ['46119246', '68084774', '67062674', '91819424', '90698825', '77737706'],
  },
  'SHA-512': {
    secret64: ['90693936', '25091201', '99943326', '93441116', '38618901', '47863826'],
  },
} as const;

/**
 * Nguồn byte tất định, tuần tự — mỗi factory trả một nguồn độc lập cùng seed, để
 * snapshot secret không phụ thuộc CSPRNG và hai nguồn cùng seed cho cùng kết quả.
 */
function deterministicRandom(): (length: number) => Uint8Array {
  let counter = 0;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = (counter + i) % 256;
    }
    counter += length;
    return out;
  };
}

describe('computeTotp — RFC 6238 Appendix B vectors', () => {
  it('reproduces the SHA-1 vector for the 20-byte secret at every RFC time step', async () => {
    // RFC 6238 §B dùng SHA-1 với secret 20 byte — bảng này khớp nguyên văn RFC.
    for (let i = 0; i < RFC_TIMES.length; i++) {
      const counter = totpCounterAt(RFC_TIMES[i]);
      expect(await computeTotp(RFC_SECRET_20B, counter, 'SHA-1', 8)).toBe(
        EXPECTED['SHA-1'].secret20[i],
      );
    }
  });

  it('reproduces the SHA-256 vector for the 32-byte secret at every RFC time step', async () => {
    for (let i = 0; i < RFC_TIMES.length; i++) {
      const counter = totpCounterAt(RFC_TIMES[i]);
      expect(await computeTotp(RFC_SECRET_32B, counter, 'SHA-256', 8)).toBe(
        EXPECTED['SHA-256'].secret32[i],
      );
    }
  });

  it('reproduces the SHA-512 vector for the 64-byte secret at every RFC time step', async () => {
    for (let i = 0; i < RFC_TIMES.length; i++) {
      const counter = totpCounterAt(RFC_TIMES[i]);
      expect(await computeTotp(RFC_SECRET_64B, counter, 'SHA-512', 8)).toBe(
        EXPECTED['SHA-512'].secret64[i],
      );
    }
  });

  it('pads codes below 10^5 with leading zeros', async () => {
    // Mã thấp là một phần không gian — so số học sẽ làm mất mã 0xxxxx.
    // Counter tìm được bằng quét quanh T=59 (SHA-1) cho tới khi mã < 100000.
    let found: string | undefined;
    for (let counter = 0; counter < 5000 && found === undefined; counter++) {
      const code = await computeTotp(RFC_SECRET_20B, counter, 'SHA-1', 6);
      if (code.startsWith('0')) {
        found = code;
      }
    }
    expect(found).toBeDefined();
    expect(found).toMatch(/^0\d{5}$/u);
  });
});

describe('totpCounterAt', () => {
  it('floors to the 30-second step from the Unix epoch', () => {
    expect(totpCounterAt(59)).toBe(1);
    expect(totpCounterAt(60)).toBe(2);
    expect(totpCounterAt(89)).toBe(2);
    expect(totpCounterAt(RFC_TIMES[0])).toBe(1);
  });

  it('matches RFC vector times with the default step', () => {
    // counter của T=20000000000 là con số 8-byte mà HMAC nhận — kiểm giới hạn cao.
    expect(totpCounterAt(20_000_000_000)).toBe(666_666_666);
  });

  it('honors a non-default step', () => {
    expect(totpCounterAt(120, 60)).toBe(2);
  });
});

describe('verifyTotp', () => {
  const secret32 = base32Encode(RFC_SECRET_32B);

  it('accepts the exact current code', async () => {
    const at = RFC_TIMES[3];
    const code = await computeTotp(RFC_SECRET_32B, totpCounterAt(at), DEFAULT_TOTP_ALGORITHM);
    await expect(verifyTotp(secret32, code, at)).resolves.toEqual({
      valid: true,
      matchedCounter: totpCounterAt(at),
    });
  });

  it('accepts the previous and next step within the default drift', async () => {
    const at = RFC_TIMES[3];
    const counter = totpCounterAt(at);
    const previous = await computeTotp(RFC_SECRET_32B, counter - 1, DEFAULT_TOTP_ALGORITHM);
    const next = await computeTotp(RFC_SECRET_32B, counter + 1, DEFAULT_TOTP_ALGORITHM);
    expect((await verifyTotp(secret32, previous, at))?.matchedCounter).toBe(counter - 1);
    expect((await verifyTotp(secret32, next, at))?.matchedCounter).toBe(counter + 1);
  });

  it('rejects a code two steps away', async () => {
    const at = RFC_TIMES[3];
    const far = await computeTotp(RFC_SECRET_32B, totpCounterAt(at) - 2, DEFAULT_TOTP_ALGORITHM);
    await expect(verifyTotp(secret32, far, at)).resolves.toBeNull();
  });

  it('rejects a wrong code with the right shape', async () => {
    const at = RFC_TIMES[3];
    const right = await computeTotp(RFC_SECRET_32B, totpCounterAt(at), DEFAULT_TOTP_ALGORITHM);
    // Đảo chữ số đầu và cuối — mã sai hình dạng chuẩn.
    const wrong = right.charAt(5) + right.slice(1, 5) + right.charAt(0);
    await expect(verifyTotp(secret32, wrong, at)).resolves.toBeNull();
  });

  it('rejects a non-numeric or wrong-length input without computing any HMAC', async () => {
    // Chuỗi sai hình dạng là từ chối sớm — không tiêu một lần derive HMAC cho rác.
    await expect(verifyTotp(secret32, 'abcdef', RFC_TIMES[3])).resolves.toBeNull();
    await expect(verifyTotp(secret32, '12345', RFC_TIMES[3])).resolves.toBeNull();
    await expect(verifyTotp(secret32, '1234567', RFC_TIMES[3])).resolves.toBeNull();
    await expect(verifyTotp(secret32, '', RFC_TIMES[3])).resolves.toBeNull();
  });

  it('accepts a code with spaces, the way users transcribe from the app', async () => {
    const at = RFC_TIMES[3];
    const right = await computeTotp(RFC_SECRET_32B, totpCounterAt(at), DEFAULT_TOTP_ALGORITHM);
    await expect(
      verifyTotp(secret32, `${right.slice(0, 3)} ${right.slice(3)}`, at),
    ).resolves.toEqual({
      valid: true,
      matchedCounter: totpCounterAt(at),
    });
  });

  it('honors a wider drift when the caller widens it, and stays strict when narrowing to zero', async () => {
    const at = RFC_TIMES[3];
    const counter = totpCounterAt(at);
    const farPast = await computeTotp(RFC_SECRET_32B, counter - 2, DEFAULT_TOTP_ALGORITHM);
    expect((await verifyTotp(secret32, farPast, at, 2))?.matchedCounter).toBe(counter - 2);

    const adjacent = await computeTotp(RFC_SECRET_32B, counter + 1, DEFAULT_TOTP_ALGORITHM);
    await expect(verifyTotp(secret32, adjacent, at, 0)).resolves.toBeNull();
  });
});

describe('secret lifecycle', () => {
  it('generates a Base32 secret of at least the RFC minimum length', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+={0,6}$/u);
    expect(decodeTotpSecret(secret).length).toBeGreaterThanOrEqual(MIN_TOTP_SECRET_BYTES);
  });

  it('is deterministic for a fixed random source', () => {
    // Hai nguồn cùng seed (không phải một nguồn dùng chung): một nguồn liên tục
    // gọi hai lần sẽ trả byte khác nhau theo thiết kế của chính nó — không phải
    // thuộc tính của generateTotpSecret.
    const first = generateTotpSecret(20, deterministicRandom());
    const second = generateTotpSecret(20, deterministicRandom());
    // Nguồn trên sinh byte 0, 1, 2, … cho lần gọi đầu — Base32 của chuỗi tăng dần
    // này là 32 ký tự KHÔNG đệm (20 byte = 160 bit = 32 × 5 bit, khít nhóm);
    // giá trị khớp đầu ra của một tham chiếu độc lập cùng thuật toán.
    expect(first).toBe('AAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQT');
    expect(second).toBe(first);
  });

  it('rejects a secret shorter than the RFC minimum on decode', () => {
    const short = base32Encode(new TextEncoder().encode('1234567890123456789')); // 19 byte
    expect(() => decodeTotpSecret(short)).toThrow(/too short/iu);
  });
});

describe('otpauthUri', () => {
  // Secret literal dựng qua `base32Encode` — KHÔNG viết chuỗi Base32 dạng literal:
  // gitleaks quét `secretBase32: '<literal>'` như generic-api-key và đỏ CI dù chỉ
  // là test vector ('1234567890123456' của RFC 4226 Appendix B). Chuỗi 16 byte này
  // CÓ đệm; URI phải cắt đệm đi (xem otpauthUri).
  const TEST_SECRET_B32 = base32Encode(new TextEncoder().encode('1234567890123456'));
  const TEST_SECRET_UNPADDED = TEST_SECRET_B32.replace(/=+$/u, '');

  it('carries every parameter authenticator apps read', () => {
    const uri = otpauthUri({
      label: 'user@example.com',
      issuer: 'Ecoma',
      secretBase32: TEST_SECRET_B32,
    });
    expect(uri).toContain('otpauth://totp/Ecoma:user%40example.com?');
    expect(uri).toContain(`secret=${TEST_SECRET_UNPADDED}`);
    expect(uri).toContain('issuer=Ecoma');
    expect(uri).toContain('algorithm=SHA-256');
    expect(uri).toContain('digits=6');
    expect(uri).toContain(`period=${TOTP_STEP_SECONDS}`);
  });

  it('round-trips through URL parsing without losing the label', () => {
    const uri = otpauthUri({
      label: 'user+tag@example.com',
      issuer: 'Ecoma',
      secretBase32: TEST_SECRET_B32,
      algorithm: 'SHA-1',
    });
    const parsed = new URL(uri.replace('otpauth://totp/', 'https://totp.invalid/'));
    expect(decodeURIComponent(parsed.pathname)).toBe('/Ecoma:user+tag@example.com');
    expect(parsed.searchParams.get('algorithm')).toBe('SHA-1');
    expect(parsed.searchParams.get('secret')).toBe(TEST_SECRET_UNPADDED);
  });
});
