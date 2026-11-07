/**
 * Test-support của `auth-application`: dựng một `SigningKeyProvider` thật
 * (crypto thật, đường `jose` thật) cho spec colocated.
 *
 * ⚠️ KHÔNG phải đường production. Bản cài đặt tham chiếu của port là class
 * `SigningKeyProvider` ở `auth-infrastructure`; tầng application KHÔNG được
 * import infrastructure (cấm transitive theo tag trong `.oxlintrc.json`),
 * nên spec của tầng này dựng riêng một object thoả port — cùng đường
 * `importPKCS8`/`exportJWK` và cùng ràng buộc non-extractable, để token được
 * ký ở đây verify được như token production. File này chỉ được import bởi
 * `*.spec.ts`; tsconfig.lib.json loại nó khỏi bundle lib.
 */
import { importPKCS8, exportJWK } from 'jose';

import {
  SIGNING_ALGORITHM,
  SIGNING_CURVE,
  SIGNING_KEY_TYPE,
  type PublicJwk,
  type SigningKeyProvider,
} from '@ecoma-io/auth-domain';

/**
 * PEM PKCS#8 đầu vào đã qua kiểm hình dạng ở tầng trên (cùng luật với bản
 * production: prefix/suffix chính xác, không regex `[\s\S]+`).
 */
const DASHES = '-'.repeat(5);
const PKCS8_BEGIN = `${DASHES}BEGIN PRIVATE KEY${DASHES}`;
const PKCS8_END = `${DASHES}END PRIVATE KEY${DASHES}`;

function isPkcs8Pem(pem: string): boolean {
  return (
    pem.startsWith(PKCS8_BEGIN) &&
    pem.endsWith(PKCS8_END) &&
    pem.length > PKCS8_BEGIN.length + PKCS8_END.length
  );
}

/**
 * Dựng provider từ PEM PKCS#8 đã sinh trong spec (`generateKeyPair('ES256')`).
 *
 * Handle để KÝ non-extractable — cùng thuộc tính với bản production; public
 * JWK rút từ MỘT bản tạm extractable rồi dựng lại từ allow-list `{x, y}`.
 */
export async function signingKeyProviderFromPemForSpec(params: {
  pem: string;
  kid: string;
}): Promise<SigningKeyProvider> {
  const { pem, kid } = params;
  if (!isPkcs8Pem(pem)) {
    throw new Error('spec fixture requires a PKCS#8 PEM');
  }

  const signingKey = await importPKCS8(pem, SIGNING_ALGORITHM, { extractable: false });

  const temporary = await importPKCS8(pem, SIGNING_ALGORITHM, { extractable: true });
  const exported = (await exportJWK(temporary)) as Record<string, unknown>;
  const x = exported['x'];
  const y = exported['y'];
  if (typeof x !== 'string' || x === '' || typeof y !== 'string' || y === '') {
    throw new Error('spec fixture failed to export x/y');
  }
  const jwk: PublicJwk = {
    kty: SIGNING_KEY_TYPE,
    crv: SIGNING_CURVE,
    x,
    y,
    alg: SIGNING_ALGORITHM,
    use: 'sig',
    kid,
  };

  return {
    kid,
    privateKey: () => Promise.resolve(signingKey),
    publicJwk: () => Promise.resolve(jwk),
    key: () => Promise.resolve(signingKey),
  };
}
