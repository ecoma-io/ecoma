/**
 * Cipher credential — roundtrip, sai khóa, và **routing theo version** (§7.3).
 *
 * ⚠️ **Ba điều kiện của `§7.3` mà test này bảo vệ, mỗi điều kiện một nhóm test:**
 *
 * 1. **Ghi bằng current version, đọc bằng version của record.** Một record mã hoá bằng `K1`
 *    phải luôn đọc được bằng `K1`, kể cả sau khi `K2` thành current. Nếu `decrypt` có
 *    `defaultVersion`, toàn bộ credential cũ mất khả năng đọc **đúng lúc rotation** — đó là
 *    kịch bản `§7.2` cấm.
 * 2. **Cipher thật, không phải XOR hay base64.** `WebCryptoCredentialCipher` dùng
 *    AES-256-GCM; một test chỉ assert `decrypt(encrypt(x)) === x` sẽ xanh với một hàm
 *    `x => x`. Test dưới đây assert thêm: ciphertext **không** chứa plaintext, và sai khóa
 *    **ném**.
 * 3. **IV ngẫu nhiên mỗi lần mã hoá.** Hai lần mã hoá cùng một plaintext cho hai ciphertext
 *    khác nhau — đó là IND-CPA của GCM, và IV cố định sẽ phá nó.
 *
 * ⚠️ **Test này chạy trên `globalThis.crypto` thật** (`webcrypto` của Node 20+), tức cùng
 * một API mà Workers runtime cung cấp — không phải một polyfill trong test.
 */

import { describe, expect, it } from 'vitest';

import { WebCryptoCredentialCipher } from '@ecoma-io/push-notification-infrastructure';

import { rootKeyK1, rootKeyK2 } from '../tests/integrations/fixture-ports';

/** Cipher một key `K1`, current `K1`. */
function k1Only(): WebCryptoCredentialCipher {
  return new WebCryptoCredentialCipher({
    keysByVersion: { K1: rootKeyK1() },
    currentVersion: 'K1',
  });
}

/** Cipher hai key `K1` + `K2`, current `K2` — trạng thái sau khi `K2` được giới thiệu. */
function k2Current(): WebCryptoCredentialCipher {
  return new WebCryptoCredentialCipher({
    keysByVersion: { K1: rootKeyK1(), K2: rootKeyK2() },
    currentVersion: 'K2',
  });
}

describe('WebCryptoCredentialCipher — roundtrip', () => {
  it('decrypts back to the exact plaintext it encrypted', async () => {
    const cipher = k1Only();
    const plaintext = 'private-vapid-key-material-0123456789';

    const sealed = await cipher.encrypt(plaintext);
    // ⚠️ `version` ghi kèm là điều kiện để `decrypt` chọn đúng key — không phải metadata trang
    // trí. Một record không có version là một record không đọc được sau khi rotate.
    expect(sealed.version).toBe('K1');

    await expect(cipher.decrypt(sealed.ciphertext, sealed.version)).resolves.toBe(plaintext);
  });

  it('round-trips a UTF-8 plaintext with multi-byte characters', async () => {
    const cipher = k1Only();
    // ⚠️ `TextEncoder`/`TextDecoder` là cặp byte↔chuỗi; một key material chứa ký tự nhiều
    // byte mà round-trip hỏng thì credential ghi ra không giải mã lại được.
    const plaintext = 'khoá-mật-ẫn-danh-🔐-✓';

    const sealed = await cipher.encrypt(plaintext);
    await expect(cipher.decrypt(sealed.ciphertext, 'K1')).resolves.toBe(plaintext);
  });

  it('produces a different ciphertext each time for the same plaintext', async () => {
    const cipher = k1Only();
    const plaintext = 'same-plaintext-every-time';

    const first = await cipher.encrypt(plaintext);
    const second = await cipher.encrypt(plaintext);

    // ⚠️ Đây là IV ngẫu nhiên: hai ciphertext khác nhau chứng minh IV khác nhau. IV cố định
    // sẽ biến GCM thành một mã đơn giản theo khoá — attacker đọc được plaintext nào bằng
    // nhau, và đó là hỏng IND-CPA.
    expect(first.ciphertext).not.toEqual(second.ciphertext);
    // ⚠️ Nhưng **cả hai** vẫn phải giải mã về cùng một plaintext — ngẫu nhiên không được
    // phá tính đúng.
    await expect(cipher.decrypt(first.ciphertext, 'K1')).resolves.toBe(plaintext);
    await expect(cipher.decrypt(second.ciphertext, 'K1')).resolves.toBe(plaintext);
  });

  it('does not leave the plaintext inside the ciphertext bytes', async () => {
    const cipher = k1Only();
    const plaintext = 'SENSITIVE-VAPID-PRIVATE-KEY';

    const sealed = await cipher.encrypt(plaintext);
    const asLatin1 = Buffer.from(sealed.ciphertext).toString('latin1');
    const asUtf8 = new TextDecoder('utf-8', { fatal: false }).decode(sealed.ciphertext);

    // ⚠️ Một "mã hoá" mà plaintext nằm trong đó ở dạng đọc được là một rò rỉ secret vào D1,
    // và `credential_ciphertext` là cột BLOB — ai đọc cũng đọc được. Assert này bắt được một
    // implementation base64/hex/XOR "tạm cho có".
    expect(asLatin1).not.toContain(plaintext);
    expect(asUtf8).not.toContain(plaintext);
    // ⚠️ Ciphertext phải **dài hơn** plaintext: 12 byte IV + 16 byte tag.
    expect(sealed.ciphertext.length).toBeGreaterThan(plaintext.length);
  });

  it('rejects an empty plaintext instead of encrypting a credential that decrypts to nothing', async () => {
    // ⚠️ Một credential rỗng sẽ mã hoá thành một record mà giải mã ra `''`, và provider
    // handshake fail với một lỗi không truy được về chỗ gốc.
    await expect(k1Only().encrypt('')).rejects.toThrowError(/plaintext/u);
  });
});

describe('WebCryptoCredentialCipher — wrong key and corrupted ciphertext', () => {
  it('rejects decrypting with a different key of the same version slot', async () => {
    const written = await k1Only().encrypt('material');
    // ⚠️ Một keyring **khác** với cùng tên version: đây là hình dạng của một operator đã
    // rotate secret nhưng quên giữ `K1` cũ. GCM phải từ chặn ở tag.
    const wrongKeyRing = new WebCryptoCredentialCipher({
      keysByVersion: { K1: rootKeyK2() },
      currentVersion: 'K1',
    });

    await expect(wrongKeyRing.decrypt(written.ciphertext, 'K1')).rejects.toThrowError(
      /Giải mã credential thất bại/u,
    );
  });

  it('rejects decrypting a ciphertext whose body was tampered with', async () => {
    const cipher = k1Only();
    const sealed = await cipher.encrypt('material');
    // ⚠️ Lật **một byte** trong thân ciphertext (bỏ qua 12 byte IV). Tag GCM phải bắt được
    // — đó là thứ phân biệt GCM với một mã dựa trên XOR.
    const tampered = new Uint8Array(sealed.ciphertext);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;

    await expect(cipher.decrypt(tampered, 'K1')).rejects.toThrowError(
      /Giải mã credential thất bại/u,
    );
  });

  it('rejects a ciphertext shorter than the IV without calling WebCrypto', async () => {
    // ⚠️ Gọi `subtle.decrypt` với IV ngắn hơn 12 byte ném `DataError` khó chẩn đoán với lỗi
    // authentication — hai remediation hoàn toàn khác nhau lọt chung một thông điệp.
    const cipher = k1Only();
    await expect(cipher.decrypt(new Uint8Array(8), 'K1')).rejects.toThrowError(
      /Giải mã credential thất bại/u,
    );
  });

  it('names the missing version instead of blaming the ciphertext', async () => {
    // ⚠️ Version không có trong keyring là **cấu hình sai** (thêm key vào keyring), còn
    // ciphertext hỏng là kiểm tra dữ liệu. Hai remediation khác nhau nên phải có hai thông điệp
    // khác nhau — nếu gộp, operator đi sai hướng.
    const sealed = await k1Only().encrypt('material');
    await expect(k1Only().decrypt(sealed.ciphertext, 'K9')).rejects.toThrowError(/K9/u);
  });

  it('never puts the key material or the plaintext into the error message', async () => {
    const cipher = k1Only();
    // ⚠️ Dùng kết quả, không bỏ đi: một test giữ một biến không dùng là một `tsc` error, và
    // việc xoá nó đi thì mất đúng thứ cần khẳng định — rằng một record **thật** sinh ra
    // trước khi ta cố giải mã nó bằng dữ liệu hỏng.
    const sealed = await cipher.encrypt('SENSITIVE-VAPID-PRIVATE-KEY');
    expect(sealed.ciphertext.length).toBeGreaterThan(0);
    expect(sealed.version).toBe('K1');

    let message = '';
    try {
      await cipher.decrypt(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]), 'K1');
    } catch (error: unknown) {
      message = (error as Error).message;
    }

    expect(message).not.toBe('');
    expect(message).not.toContain('SENSITIVE-VAPID-PRIVATE-KEY');
    // ⚠️ Root key của `K1` ở fixture là byte `1..32`; `Buffer` in ra dạng hex thì dài, nên kiểm
    // bằng base64 là kiểm chuỗi mà một log có thể chứa.
    expect(message).not.toContain(Buffer.from(rootKeyK1()).toString('base64'));
  });
});

describe('WebCryptoCredentialCipher — routing follows the version of the record', () => {
  it('reads a K1 record with K1 even after K2 becomes current', async () => {
    // ⚠️ **Đây là kịch bản §7.2/§7.3 cấm.** `§7.3`: `K1 active → K2 introduced (đọc K1+K2,
    // ghi mới dùng K2)`. Nếu `decrypt` mặc định sang `currentVersion` thì toàn bộ credential
    // cũ mất khả năng đọc **đúng lúc** một App bắt đầu phục vụ subscription mới.
    const beforeRotation = k1Only();
    const sealedWithK1 = await beforeRotation.encrypt('credential-written-under-K1');
    expect(sealedWithK1.version).toBe('K1');

    const afterRotation = k2Current();
    await expect(afterRotation.decrypt(sealedWithK1.ciphertext, 'K1')).resolves.toBe(
      'credential-written-under-K1',
    );
  });

  it('writes new credentials under the current version after rotation', async () => {
    const afterRotation = k2Current();
    const sealed = await afterRotation.encrypt('credential-written-under-K2');

    // ⚠️ Chiều còn lại của rotation: ghi **mới** dùng `K2`. Nếu nó vẫn ghi `K1` thì key `K1`
    // không bao giờ ngừng được dùng và không bao giờ có thể retire.
    expect(sealed.version).toBe('K2');
    await expect(afterRotation.decrypt(sealed.ciphertext, 'K2')).resolves.toBe(
      'credential-written-under-K2',
    );
    // ⚠️ Và record mới **không** đọc được bằng `K1` — đó là bằng chứng nó thật sự mã hoá bằng
    // `K2` chứ không chỉ ghi nhãn version.
    await expect(afterRotation.decrypt(sealed.ciphertext, 'K1')).rejects.toThrowError(
      /Giải mã credential thất bại/u,
    );
  });

  it('reads both versions side by side in the same keyring', async () => {
    // ⚠️ Trạng thái thật giữa `K1 → K2`: hai loại credential cùng tồn tại trong D1. Test này
    // giữ cả hai và đọc cả hai — đó là điều kiện để `§7.3` coi rotation là hoàn tất.
    const rotation = k2Current();
    const underK1 = await k1Only().encrypt('old');
    const underK2 = await rotation.encrypt('new');

    await expect(rotation.decrypt(underK1.ciphertext, 'K1')).resolves.toBe('old');
    await expect(rotation.decrypt(underK2.ciphertext, 'K2')).resolves.toBe('new');
  });
});

describe('WebCryptoCredentialCipher — fails early on initialisation', () => {
  it('refuses to construct when the current version is absent from the keyring', () => {
    // ⚠️ Fail **lúc khởi tạo**, không phải lúc ghi credential đầu tiên: lúc ghi thì lỗi xảy
    // ra giữa một rotation, khi đã có credential trong D1 cần version không có trong keyring.
    expect(
      () =>
        new WebCryptoCredentialCipher({
          keysByVersion: { K1: rootKeyK1() },
          currentVersion: 'K2',
        }),
    ).toThrowError(/K2/u);
  });

  it('refuses to construct with a key that is not 32 bytes', () => {
    // ⚠️ AES-256 đòi đúng 32 byte. Một key 16 byte lọt vào sẽ thành "chạy được" cho tới lúc
    // có credential đầu tiên — và lúc đó lỗi không liên quan gì tới nguyên nhân thật.
    for (const badLength of [0, 16, 31, 33, 64]) {
      expect(
        () =>
          new WebCryptoCredentialCipher({
            keysByVersion: { K1: new Uint8Array(badLength) },
            currentVersion: 'K1',
          }),
      ).toThrowError(/32 byte/u);
    }
  });

  it('refuses to construct with an empty keyring or an empty current version', () => {
    expect(
      () =>
        new WebCryptoCredentialCipher({
          keysByVersion: {},
          currentVersion: 'K1',
        }),
    ).toThrowError(/root key/u);
    expect(
      () =>
        new WebCryptoCredentialCipher({
          keysByVersion: { K1: rootKeyK1() },
          currentVersion: '',
        }),
    ).toThrowError(/currentVersion/u);
  });

  it('validates every key in the keyring, not only the current one', () => {
    // ⚠️ Một `K2` 16 byte trong keyring sẽ **không** được chạm tới cho tới khi `K2` thành
    // current. Nếu kiểm chỉ key hiện hành thì lỗi đó chỉ lộ ra đúng lúc rotate — tức lúc
    // credential cũ đã phục vụ subscription và việc ghi credential mới đang cần `K2`.
    expect(
      () =>
        new WebCryptoCredentialCipher({
          keysByVersion: { K1: rootKeyK1(), K2: new Uint8Array(16) },
          currentVersion: 'K1',
        }),
    ).toThrowError(/K2/u);
  });

  it('names the offending version rather than the cipher in general', () => {
    // ⚠️ Thông điệp phải nêu **version** bị sai: operator có nhiều secret, và "root key sai
    // độ dài" không nói là secret nào.
    let message: string;
    try {
      // ⚠️ Gán kết quả cho một biến thay vì `new` đứng trần: `@typescript-eslint/no-new` cấm
      // `new` chỉ để có side effect — ở đây `new` **không** ném (key 32 byte, version có mặt),
      // nên `expect(() => new …)` sẽ xanh sai. Gán vào `leaked` làm đối tượng thật đã được dựng,
      // và nhánh xanh sai ghi ra một thông điệp **khác** để assertion bên dưới bắt được.
      //
      // ⚠️ Khởi tạo `message` bằng `''` sẽ đỏ `no-useless-assignment`: cả hai nhánh đều gán
      // nó, nên giá trị khởi tạo không bao giờ được đọc. Khai báo không khởi tạo và để cả hai
      // nhánh gán là hình dạng đúng — `message` không thể "chạy tới" `expect` mà chưa được gán.
      const leaked = new WebCryptoCredentialCipher({
        keysByVersion: { K1: rootKeyK1(), K7: new Uint8Array(16) },
        currentVersion: 'K1',
      });
      message = `constructor không ném; đối tượng là ${typeof leaked}.`;
    } catch (error: unknown) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('constructor không ném');
    expect(message).toContain('K7');
    expect(message).not.toContain('K1');
  });
});
