/**
 * Vòng kiểm **receiver**: giải mã đúng output của `encryptPushPayload` bằng private key
 * của user agent.
 *
 * ⚠️ Vì sao cần file này khi đã có `rfc8291-vectors.spec.ts`. Vector RFC dùng `as_private`
 * **cố định** của Appendix A, còn `encryptPushPayload` sinh cặp ECDH mới mỗi lần
 * (RFC 8291 §2/§4) — nên không thể chạy production code để ra đúng vector đó. Hệ quả: một
 * mutation trong `encryptPushPayload` (sai padding delimiter, thiếu `0x00` trong `key_info`,
 * `rs` sai endian, keyid sai độ dài…) **không** làm đỏ vector test, vì vector test dựng lại
 * chuỗi HKDF bằng tay.
 *
 * Thí nghiệm mutation đã xác nhận điều đó: đổi `0x02` thành `0x01` trong production code
 * vẫn cho 35/35 xanh. File này đóng lỗ hổng đó — nó là **user agent thật** giải mã body
 * mà production code vừa tạo, nên mọi sai khác trong chuỗi mã hoá đều lộ ngay.
 */

import { describe, expect, it } from 'vitest';

import { toBase64Url } from './base64url';
import { encryptPushPayload, importP256ScalarForTest, isUncompressedP256Point } from './encryption';
import { generateSubscriptionKeyPair, unb64u, utf8 } from './test-fixtures';
import { asBytes, asJsonWebKey, asKeyPair, asRawBytes, ecdhDeriveParams } from './webcrypto';

/** Header `aes128gcm` đã phân tích (RFC 8188 §2.1). */
interface ParsedHeader {
  readonly salt: Uint8Array;
  readonly recordSize: number;
  readonly keyId: Uint8Array;
}

/**
 * Phân tích header — cố tình **độc lập** với phép lắp byte trong `encryption.ts`: đọc trực
 * tiếp `DataView` thay vì so sánh với hằng số, để test không cùng sai với implementation.
 */
function parseHeader(body: Uint8Array): ParsedHeader {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const salt = body.slice(0, 16);
  const recordSize = view.getUint32(16, false);
  const idLen = view.getUint8(20);
  const keyId = body.slice(21, 21 + idLen);
  expect(keyId.length).toBe(idLen);
  return { salt, recordSize, keyId };
}

/** HMAC-SHA-256 — mô phỏng receiver theo RFC 8291 §3.4. */
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

/**
 * Giải mã một body `aes128gcm` như user agent thật.
 *
 * Trả plaintext **đã** cắt padding delimiter, và delimiter đọc được để test khẳng định
 * nó là `0x02` (RFC 8188 §2: record cuối dùng delimiter `2`; giá trị khác phải bị loại).
 */
async function decryptAsUserAgent(
  body: Uint8Array,
  userAgentScalarBase64Url: string,
  userAgentPointBase64Url: string,
  authSecret: string,
): Promise<{ plaintext: Uint8Array; delimiter: number; paddingOctets: number }> {
  const { salt, keyId } = parseHeader(body);

  // RFC 8291 §3.1: receiver ghép private key của mình với public key trong `keyid`.
  const asPublicKey = await crypto.subtle.importKey(
    'raw',
    keyId,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const uaPrivate = await importP256ScalarForTest(
    userAgentScalarBase64Url,
    userAgentPointBase64Url,
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(ecdhDeriveParams(asPublicKey), uaPrivate, 256),
  );

  // RFC 8291 §3.3 + §3.4 — cùng chuỗi HKDF, nhưng chạy phía receiver.
  const prkKey = await hmacSha256(unb64u(authSecret), ecdhSecret);
  const keyInfo = new Uint8Array([
    ...utf8('WebPush: info'),
    0,
    ...unb64u(userAgentPointBase64Url),
    ...keyId,
  ]);
  const ikm = await hmacSha256(prkKey, new Uint8Array([...keyInfo, 1]));
  const prk = await hmacSha256(salt, ikm);
  const cek = (
    await hmacSha256(prk, new Uint8Array([...utf8('Content-Encoding: aes128gcm'), 0, 1]))
  ).subarray(0, 16);
  const nonce = (
    await hmacSha256(prk, new Uint8Array([...utf8('Content-Encoding: nonce'), 0, 1]))
  ).subarray(0, 12);

  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const decrypted = asBytes(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128 },
      cekKey,
      body.subarray(21 + keyId.length),
    ),
  );

  // Padding delimiter là octet non-zero cuối cùng; phần còn lại là zero padding
  // (RFC 8188 §2).
  let delimiterIndex = decrypted.length - 1;
  while (delimiterIndex >= 0 && decrypted[delimiterIndex] === 0) {
    delimiterIndex -= 1;
  }
  return {
    plaintext: decrypted.slice(0, delimiterIndex),
    delimiter: decrypted[delimiterIndex] ?? 0,
    paddingOctets: decrypted.length - delimiterIndex - 1,
  };
}

describe('encryptPushPayload as seen by a real user agent', () => {
  it('emits a header whose keyid is the ephemeral ECDH public key', async () => {
    const { p256dh, auth } = await generateSubscriptionKeyPair();
    const { body } = await encryptPushPayload({
      p256dh,
      auth,
      plaintext: utf8('hello'),
      salt: crypto.getRandomValues(new Uint8Array(16)),
    });

    const { recordSize, keyId } = parseHeader(body);
    expect(recordSize).toBe(4096);
    expect(isUncompressedP256Point(keyId)).toBe(true);
    // Header 86 octet = 16 + 4 + 1 + 65.
    expect(21 + keyId.length).toBe(86);
  });

  it('writes the last-record padding delimiter 0x02, not 0x01', async () => {
    const { p256dh, auth } = await generateSubscriptionKeyPair();
    const plaintext = utf8('When I grow up, I want to be a watermelon');
    const { body } = await encryptPushPayload({
      p256dh,
      auth,
      plaintext,
      salt: crypto.getRandomValues(new Uint8Array(16)),
    });

    // User agent sinh scalar riêng để giải mã — không dùng lại `p256dh` công khai.
    const uaPair = asKeyPair(
      await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
    );
    const uaPoint = asBytes(asRawBytes(await crypto.subtle.exportKey('raw', uaPair.publicKey)));
    const uaJwk = asJsonWebKey(await crypto.subtle.exportKey('jwk', uaPair.privateKey));
    const receiverAuth = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));

    const { body: receiverBody } = await encryptPushPayload({
      // Receiver "đăng ký" với điểm công khai của user agent vừa sinh.
      p256dh: toBase64Url(uaPoint),
      auth: receiverAuth,
      plaintext,
      salt: crypto.getRandomValues(new Uint8Array(16)),
    });

    const decoded = await decryptAsUserAgent(
      receiverBody,
      uaJwk.d ?? '',
      toBase64Url(uaPoint),
      receiverAuth,
    );

    // Đây là assertion mà mutation `0x02 → 0x01` làm đỏ: receiver **phải** thấy 0x02,
    // vì RFC 8188 §2 nói record cuối dùng delimiter 2 (record khác dùng 1).
    expect(decoded.delimiter).toBe(0x02);
    expect(decoded.paddingOctets).toBe(0);
    expect(new TextDecoder().decode(decoded.plaintext)).toBe(
      'When I grow up, I want to be a watermelon',
    );
    expect(body.length).toBeGreaterThan(0);
  });

  it('round-trips an arbitrary payload through the receiver path', async () => {
    const payloadJson = JSON.stringify({ title: 'a', body: 'b', url: '/c', data: { k: 1 } });
    const uaPair = asKeyPair(
      await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
    );
    const uaPoint = asBytes(asRawBytes(await crypto.subtle.exportKey('raw', uaPair.publicKey)));
    const uaJwk = asJsonWebKey(await crypto.subtle.exportKey('jwk', uaPair.privateKey));
    const receiverAuth = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));

    const { body } = await encryptPushPayload({
      p256dh: toBase64Url(uaPoint),
      auth: receiverAuth,
      plaintext: utf8(payloadJson),
      salt: crypto.getRandomValues(new Uint8Array(16)),
    });

    const decoded = await decryptAsUserAgent(
      body,
      uaJwk.d ?? '',
      toBase64Url(uaPoint),
      receiverAuth,
    );

    expect(decoded.delimiter).toBe(0x02);
    expect(new TextDecoder().decode(decoded.plaintext)).toBe(payloadJson);
    // 86 header + plaintext + 1 delimiter + 16 tag
    expect(body.length).toBe(86 + utf8(payloadJson).length + 1 + 16);
  });

  it('binds the body to both p256dh and auth — wrong auth fails the AEAD tag', async () => {
    const uaPair = asKeyPair(
      await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
    );
    const uaPoint = asBytes(asRawBytes(await crypto.subtle.exportKey('raw', uaPair.publicKey)));
    const uaJwk = asJsonWebKey(await crypto.subtle.exportKey('jwk', uaPair.privateKey));
    const receiverAuth = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));

    const { body } = await encryptPushPayload({
      p256dh: toBase64Url(uaPoint),
      auth: receiverAuth,
      plaintext: utf8('secret'),
      salt: crypto.getRandomValues(new Uint8Array(16)),
    });

    // `auth` sai → CEK khác → AEAD tag không khớp → decrypt ném.
    await expect(
      decryptAsUserAgent(
        body,
        uaJwk.d ?? '',
        toBase64Url(uaPoint),
        toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
      ),
    ).rejects.toThrow(/./u);

    // `p256dh` sai → ECDH secret khác → cũng vậy.
    const wrongPair = asKeyPair(
      await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
    );
    const wrongPoint = asBytes(
      asRawBytes(await crypto.subtle.exportKey('raw', wrongPair.publicKey)),
    );
    await expect(
      decryptAsUserAgent(body, uaJwk.d ?? '', toBase64Url(wrongPoint), receiverAuth),
    ).rejects.toThrow(/./u);
  });

  it('refuses to encrypt a plaintext over the 3993-octet budget', async () => {
    const { p256dh, auth } = await generateSubscriptionKeyPair();
    await expect(
      encryptPushPayload({
        p256dh,
        auth,
        plaintext: new Uint8Array(3994),
        salt: crypto.getRandomValues(new Uint8Array(16)),
      }),
    ).rejects.toThrow(RangeError);
  });
});
