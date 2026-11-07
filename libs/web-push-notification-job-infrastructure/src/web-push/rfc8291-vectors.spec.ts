/**
 * Đối chiếu **byte-exactly** vector làm việc của RFC 8291 (Appendix A + §5).
 *
 * ⚠️ Vì sao test này tồn tại: mọi bước của `aes128gcm` — ECDH, HKDF combine, HKDF của
 * RFC 8188, header 86 octet, padding delimiter — đều là hằng số byte-exact mà một sai lệch
 * 1 bit chỉ lộ ra ở tầng user agent. Nếu chỉ assert "decrypt được bằng key của receiver"
 * thì một implementation sai vẫn xanh khi nó sai **cả hai** vế. Ở đây ta chốt từng
 * intermediate value với đúng giá trị RFC in ra, nên phải đúng theo nghĩa đen.
 *
 * Vector lấy từ `rfc8291.txt` bằng script (không gõ tay) và đã verify chéo: RFC 8291 §5
 * in body 144 octet, Appendix A in header 86 octet + ciphertext 58 octet, và hai bản khớp
 * nhau byte-for-byte.
 */

import { describe, expect, it } from 'vitest';

import { toBase64Url } from './base64url';
import { encryptPushPayload, importP256ScalarForTest } from './encryption';
import { asBytes, ecdhDeriveParams } from './webcrypto';
import { RFC8291_APPENDIX_A as V, unb64u, utf8 } from './test-fixtures';

/** HMAC-SHA-256 — cùng bước mà `encryption.ts` dùng cho HKDF. */
async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return asBytes(await crypto.subtle.sign('HMAC', cryptoKey, data));
}

/** Trích `keyid` (65 octet tính từ offset 21) khỏi header — RFC 8188 §2.1. */
function keyidOf(body: Uint8Array): string {
  return toBase64Url(body.subarray(21));
}

/** Trích `salt` (16 octet đầu) khỏi header. */
function saltOf(body: Uint8Array): string {
  return toBase64Url(body.subarray(0, 16));
}

describe('RFC 8291 Appendix A worked example', () => {
  it('reproduces the ecdh_secret the RFC publishes', async () => {
    // Scalar của application server trong RFC là 32 octet **raw**, không phải PKCS#8 —
    // đúng dạng `importP256ScalarForTest` dựng lại bằng JWK (WebCrypto không nhận scalar
    // raw qua `importKey('raw', …)` cho EC private).
    const asPrivate = await importP256ScalarForTest(V.as_private, V.as_public);
    const uaPublic = await crypto.subtle.importKey(
      'raw',
      unb64u(V.ua_public),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );

    const ecdhSecret = asBytes(
      await crypto.subtle.deriveBits(ecdhDeriveParams(uaPublic), asPrivate, 256),
    );

    expect(toBase64Url(ecdhSecret)).toBe(V.ecdh_secret);
  });

  it('reproduces every HKDF intermediate value the RFC publishes', async () => {
    const ecdhSecret = unb64u(V.ecdh_secret);
    const authSecret = unb64u(V.auth_secret);
    const uaPoint = unb64u(V.ua_public);
    const asPoint = unb64u(V.as_public);

    // PRK_key = HKDF-Extract(salt=auth_secret, IKM=ecdh_secret) — RFC 8291 §3.3/§3.4.
    const prkKey = await hmacSha256(authSecret, ecdhSecret);
    expect(toBase64Url(prkKey)).toBe(V.PRK_key);

    // key_info = "WebPush: info" || 0x00 || ua_public || as_public
    const keyInfo = new Uint8Array([...utf8('WebPush: info'), 0, ...uaPoint, ...asPoint]);
    expect(toBase64Url(keyInfo)).toBe(V.key_info);

    // IKM = HKDF-Expand(PRK_key, key_info, L=32)
    const ikm = await hmacSha256(prkKey, new Uint8Array([...keyInfo, 1]));
    expect(toBase64Url(ikm)).toBe(V.IKM);

    // PRK = HKDF-Extract(salt, IKM) — RFC 8188 §2.2
    const prk = await hmacSha256(unb64u(V.salt), ikm);
    expect(toBase64Url(prk)).toBe(V.PRK);

    // CEK = HKDF-Expand(PRK, "Content-Encoding: aes128gcm" || 0x00, L=16)
    const cekInfo = new Uint8Array([...utf8('Content-Encoding: aes128gcm'), 0]);
    expect(toBase64Url(cekInfo)).toBe(V.cek_info);
    const cek = (await hmacSha256(prk, new Uint8Array([...cekInfo, 1]))).subarray(0, 16);
    expect(toBase64Url(cek)).toBe(V.CEK);

    // NONCE = HKDF-Expand(PRK, "Content-Encoding: nonce" || 0x00, L=12)
    const nonceInfo = new Uint8Array([...utf8('Content-Encoding: nonce'), 0]);
    expect(toBase64Url(nonceInfo)).toBe(V.nonce_info);
    const nonce = (await hmacSha256(prk, new Uint8Array([...nonceInfo, 1]))).subarray(0, 12);
    expect(toBase64Url(nonce)).toBe(V.NONCE);
  });

  it('encrypts to the exact ciphertext and header the RFC publishes', async () => {
    // `encryptPushPayload` sinh cặp ECDH **mới** mỗi lần (RFC 8291 §2/§4), nên không thể
    // dùng nó để tái lập vector có `as_public` cố định. Ta dựng lại đúng chuỗi RFC 8291
    // §3.4 với scalar của Appendix A rồi chốt byte — đây là phép tính mà production code
    // chạy, chỉ khác nguồn khóa.
    const asPrivate = await importP256ScalarForTest(V.as_private, V.as_public);
    const asPoint = unb64u(V.as_public);
    const uaPublic = await crypto.subtle.importKey(
      'raw',
      unb64u(V.ua_public),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const ecdhSecret = asBytes(
      await crypto.subtle.deriveBits(ecdhDeriveParams(uaPublic), asPrivate, 256),
    );
    const prkKey = await hmacSha256(unb64u(V.auth_secret), ecdhSecret);
    const keyInfo = new Uint8Array([
      ...utf8('WebPush: info'),
      0,
      ...unb64u(V.ua_public),
      ...asPoint,
    ]);
    const ikm = await hmacSha256(prkKey, new Uint8Array([...keyInfo, 1]));
    const prk = await hmacSha256(unb64u(V.salt), ikm);
    const cek = (
      await hmacSha256(prk, new Uint8Array([...utf8('Content-Encoding: aes128gcm'), 0, 1]))
    ).subarray(0, 16);
    const nonce = (
      await hmacSha256(prk, new Uint8Array([...utf8('Content-Encoding: nonce'), 0, 1]))
    ).subarray(0, 12);

    // Plaintext + padding delimiter 0x02 (record cuối và duy nhất — RFC 8188 §2).
    const plaintext = unb64u(V.plaintext);
    expect(toBase64Url(new Uint8Array([...plaintext, 0x02]))).toBe(V.padded);

    const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, tagLength: 128 },
        cekKey,
        new Uint8Array([...plaintext, 0x02]),
      ),
    );
    expect(toBase64Url(ciphertext)).toBe(V.ciphertext);

    // Header 86 octet: salt(16) || rs(4, network byte order) || idlen(1) || keyid(65).
    const header = new Uint8Array(21 + asPoint.length);
    header.set(unb64u(V.salt), 0);
    new DataView(header.buffer).setUint32(16, 4096, false);
    header.set([asPoint.length], 20);
    header.set(asPoint, 21);
    expect(toBase64Url(header)).toBe(V.header);
    expect(header.length).toBe(86);

    // Body = header || ciphertext, và §5 của RFC in đúng 144 octet này. Vector `body`
    // lấy nguyên văn từ §5 chứ không nối hai chuỗi base64 (base64 mã hoá theo dòng).
    const body = new Uint8Array([...header, ...ciphertext]);
    expect(toBase64Url(body)).toBe(V.body);
    expect(body.length).toBe(144);
    // Và §5 in body đúng bằng header + ciphertext của Appendix A — kiểm chéo hai nơi
    // trong RFC không mâu thuẫn nhau.
    expect(new Uint8Array([...unb64u(V.header), ...unb64u(V.ciphertext)])).toEqual(body);
  });

  it('round-trips the RFC ciphertext under the receiver key the RFC publishes', async () => {
    // Vế còn lại của kiểm chéo: giải mã bằng `ua_private` của chính RFC. Nếu byte ở trên
    // đúng, bước này **phải** ra đúng plaintext gốc — nó bảo chứng vector là của một
    // message Web Push thật chứ không phải một chuỗi byte vô nghĩa.
    const uaPrivate = await importP256ScalarForTest(
      // Appendix A không công bố `ua_private` trong Appendix A mà ở §5; cùng giá trị.
      'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
      V.ua_public,
    );
    const asPublic = await crypto.subtle.importKey(
      'raw',
      unb64u(V.as_public),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const ecdhSecret = asBytes(
      await crypto.subtle.deriveBits(ecdhDeriveParams(asPublic), uaPrivate, 256),
    );
    expect(toBase64Url(ecdhSecret)).toBe(V.ecdh_secret);

    const cekKey = await crypto.subtle.importKey('raw', unb64u(V.CEK), 'AES-GCM', false, [
      'decrypt',
    ]);
    const decrypted = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unb64u(V.NONCE), tagLength: 128 },
        cekKey,
        unb64u(V.ciphertext),
      ),
    );

    expect(decrypted[decrypted.length - 1]).toBe(0x02);
    expect(toBase64Url(decrypted.subarray(0, decrypted.length - 1))).toBe(V.plaintext);
  });

  it('produces a fresh ephemeral ECDH key and a fresh salt on every call', async () => {
    // RFC 8291 §2: "The ECDH key pair can be discarded after encrypting the message" — và
    // RFC 8292 §3.2: VAPID key **MUST** khác key trao đổi. Nếu adapter lấy lại `keyid`, người
    // nhận đã ghi về key của message trước.
    const plaintext = unb64u(V.plaintext);
    const first = await encryptPushPayload({
      p256dh: V.ua_public,
      auth: V.auth_secret,
      plaintext,
      salt: crypto.getRandomValues(new Uint8Array(16)),
    });
    const second = await encryptPushPayload({
      p256dh: V.ua_public,
      auth: V.auth_secret,
      plaintext,
      salt: crypto.getRandomValues(new Uint8Array(16)),
    });

    expect(keyidOf(first.body)).not.toBe(keyidOf(second.body));
    expect(saltOf(first.body)).not.toBe(saltOf(second.body));
  });
});
