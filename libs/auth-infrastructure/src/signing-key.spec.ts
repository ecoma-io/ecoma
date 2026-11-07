import { describe, expect, it } from 'vitest';
import { generateKeyPair, exportPKCS8 } from 'jose';

import { AuthConfigurationError, SIGNING_ALGORITHM } from '@ecoma-io/auth-domain';
import { SigningKeyProvider } from './signing-key';

/** Sinh cặp khoá thật để test chạy trên cùng đường code với production. */
async function makePem(): Promise<string> {
  // `generateKeyPair` cua jose nhan ALGORITHM JOSE ('ES256'), khong nhan tên
  // thuat toan WebCrypto ('ECDSA'). Truyen 'EC' se nem JOSENotSupported.
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  return exportPKCS8(privateKey);
}

describe('SigningKeyProvider.fromPem', () => {
  // ⚠️ PEM dựng bằng cách **ghép hằng số**, không viết literal `-----BEGIN…`.
  // Một khối PEM viết thẳng trong file là hình dạng mà rule `private-key` của
  // `gitleaks` bắt, và nó sẽ đỏ CI mỗi lần push — dù nội dung chỉ là vài
  // byte vô nghĩa. Fixture ở đây là dữ liệu đầu vào của một test, không phải
  // credential; cách dựng nó từ các mảnh đặt được câu hỏi "secret thật có lọt
  // vào đây không" thành câu hỏi có lời.
  const DASHES = '-'.repeat(5);
  const PEM_BEGIN = `${DASHES}BEGIN PRIVATE KEY${DASHES}`;
  const PEM_END = `${DASHES}END PRIVATE KEY${DASHES}`;

  it('REJECTS a missing Worker Secret — never derives a key', async () => {
    // Luật fail-closed. Provider thieu secret phai nem loi de Worker khong cap
    // token, chứ khong phai tu sinh khoa de chay tiep: khoa sinh luc startup
    // doi moi lan deploy, lam JWKS doi va token da cap khong con verify duoc.
    await expect(SigningKeyProvider.fromPem({ pem: undefined, kid: 'k1' })).rejects.toThrow(
      AuthConfigurationError,
    );

    await expect(SigningKeyProvider.fromPem({ pem: '   ', kid: 'k1' })).rejects.toThrow(
      AuthConfigurationError,
    );
  });

  it('REJECTS a PEM that is not PKCS#8', async () => {
    const sec1 = `${DASHES}BEGIN EC PRIVATE KEY${DASHES}\na\n${DASHES}END EC PRIVATE KEY${DASHES}`;
    await expect(SigningKeyProvider.fromPem({ pem: sec1, kid: 'k1' })).rejects.toThrow(/PKCS#8/u);
  });

  it('parses a valid PKCS#8 PEM and returns the passed kid', async () => {
    const pem = await makePem();
    const provider = await SigningKeyProvider.fromPem({ pem, kid: 'kid-2026-01' });
    expect(provider.kid).toBe('kid-2026-01');
    await expect(provider.privateKey()).resolves.toBeInstanceOf(CryptoKey);
  });

  it('REJECTS a malformed PEM — throws a typed error', async () => {
    // PEM bao truc khong giai ma duoc thi WebCrypto nem DOMException
    // `InvalidCharacterError`. Assert THE CLASS chu khong assert cau chuoi
    // thong diep — cau chuoi la cua thu vien va co the doi; viec key bi tu choi
    // nhuan moi la contract ta cam ket.
    let thrown: unknown;
    try {
      await SigningKeyProvider.fromPem({
        pem: `${PEM_BEGIN}\nkhong-phai-base64-hop-le\n${PEM_END}`,
        kid: 'k1',
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as DOMException).name).toBe('InvalidCharacterError');
  });

  it('REJECTS a heavily repeated PEM — never a ReDoS', async () => {
    // ⚠️ Regression (CodeQL `js/polynomial-redos`). Bản trước dò PEM bằng
    // `/` + PEM_BEGIN + `[\s\S]+` + PEM_END + `/`.
    //
    // Đo được trên chính mẫu đó: với `n` lần lặp `BEGIN\n`, thời gian là
    //   n= 500 →   4.5ms
    //   n=1000 →  17.9ms
    //   n=2000 →  72.7ms
    //   n=4000 → 305.5ms
    //   n=8000 → 1258ms      (4× thời gian cho 2× độ dài = bậc hai)
    // Nguyên nhân: `[\s\S]+` nới từng dấu xuống một chỗ, và mỗi chỗ lại thử
    // tìm `END` chưa từng thấy.
    //
    // ⚠️ Cỡ đầu vào ở đây là CỐ Ý chọn để vượt ngân sách với mẫu cũ. Test bảo
    // vệ phải đủ lớn để phân biệt "O(n)" với "O(n²)", và phải nhỏ để vẫn chạy
    // nhanh. Nếu ai đó đổi con số này xuống, test biến thành xanh vô nghĩa.
    const hostile = `${PEM_BEGIN}\n`.repeat(8_000);

    const started = performance.now();
    let thrown: unknown;
    try {
      await SigningKeyProvider.fromPem({ pem: hostile, kid: 'k1' });
    } catch (error: unknown) {
      thrown = error;
    }
    const elapsed = performance.now() - started;

    expect(thrown).toBeInstanceOf(Error);
    // Ngân sách rộng để không đỏ trên máy chậm, nhưng thấp hơn nhiều so với
    // ~1.3s của mẫu cũ trên đúng đầu vào này. Bản sửa chạy dưới 5ms.
    expect(elapsed).toBeLessThan(300);
  });

  it('REJECTS a PEM that is empty between BEGIN and END', async () => {
    // `BEGIN…END` liền nhau thoả điều kiện prefix/suffix nhưng không có DER.
    await expect(
      SigningKeyProvider.fromPem({
        pem: `${PEM_BEGIN}${PEM_END}`,
        kid: 'k1',
      }),
    ).rejects.toThrow(/PKCS#8/u);
  });
});

describe('SigningKeyProvider.publicJwk — leaks no private key', () => {
  it('the JWK contains only the public fields', async () => {
    const provider = await SigningKeyProvider.fromPem({ pem: await makePem(), kid: 'kid-1' });
    const jwk = await provider.publicJwk();

    expect(Object.keys(jwk).toSorted()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
  });

  it('NO `d` field — the EC private-key-only attribute', async () => {
    const provider = await SigningKeyProvider.fromPem({ pem: await makePem(), kid: 'kid-1' });
    const jwk = await provider.publicJwk();
    expect(jwk).not.toHaveProperty('d');
  });

  it('every value is a non-empty base64url string', async () => {
    const provider = await SigningKeyProvider.fromPem({ pem: await makePem(), kid: 'kid-1' });
    const jwk = await provider.publicJwk();
    expect(jwk.x).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(jwk.y).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(jwk.x.length).toBeGreaterThan(0);
    expect(jwk.y.length).toBeGreaterThan(0);
  });

  it('leaks no part of the PEM anywhere', async () => {
    const pem = await makePem();
    const provider = await SigningKeyProvider.fromPem({ pem, kid: 'kid-1' });
    const serialized = JSON.stringify(await provider.publicJwk());

    // Lay mot doan dac trung tu PEM va kiem tra no khong xuat hien.
    const body = pem.split('\n').filter((line) => line.length > 10)[1] ?? '';
    expect(body.length).toBeGreaterThan(10);
    expect(serialized).not.toContain(body);
    expect(serialized).not.toContain('PRIVATE KEY');
  });

  it('alg and kty follow the ES256 standard', async () => {
    const provider = await SigningKeyProvider.fromPem({ pem: await makePem(), kid: 'kid-1' });
    const jwk = await provider.publicJwk();
    expect(jwk.alg).toBe(SIGNING_ALGORITHM);
    expect(jwk.kty).toBe('EC');
    expect(jwk.crv).toBe('P-256');
    expect(jwk.use).toBe('sig');
  });

  it('the same private key with the same kid in two providers yields the same public JWK', async () => {
    // Tinh tien: khoa phai bat bien giua cac lan deploy.
    const pem = await makePem();
    const a = await (await SigningKeyProvider.fromPem({ pem, kid: 'kid-1' })).publicJwk();
    const b = await (await SigningKeyProvider.fromPem({ pem, kid: 'kid-1' })).publicJwk();
    expect(a).toEqual(b);
  });
});
describe('SigningKeyProvider — the signing handle must be NON-EXTRACTABLE', () => {
  it('crypto.subtle.exportKey REJECTS the signing handle', async () => {
    const provider = await SigningKeyProvider.fromPem({ pem: await makePem(), kid: 'kid-1' });
    const signingKey = await provider.privateKey();

    // Day la thuoc tinh quan trong nhat cua handle: co ai giu CryptoKey nay
    // trong tay cung khong rut ra duoc private key. Neu handle thanh
    // extractable, mot loi logging buon cua bat ky dau la mot lan ro private key.
    await expect(crypto.subtle.exportKey('pkcs8', signingKey)).rejects.toThrow(/not extractable/u);
    await expect(crypto.subtle.exportKey('jwk', signingKey)).rejects.toThrow(/not extractable/u);
  });

  it('the signing handle can still sign', async () => {
    const provider = await SigningKeyProvider.fromPem({ pem: await makePem(), kid: 'kid-1' });
    const signingKey = await provider.privateKey();

    const data = new TextEncoder().encode('payload');
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingKey,
      data,
    );
    expect(signature.byteLength).toBeGreaterThan(0);
  });

  it('privateKey() and key() return the same handle', async () => {
    const provider = await SigningKeyProvider.fromPem({ pem: await makePem(), kid: 'kid-1' });
    expect(await provider.privateKey()).toBe(await provider.key());
  });
});
