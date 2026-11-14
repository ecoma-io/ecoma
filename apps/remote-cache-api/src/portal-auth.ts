/**
 * Xac thuc human principal tren portal surface cua control plane (issue #202).
 *
 * Mo hinh authorization (chuong trinh doc: R16/R17/R22 + quyet dinh pham vi
 * #177; dai dien gia tri cua actor la quyet dinh con mo §4 cua domain model):
 * portal BFF (#180) xac thuc developer qua Ecoma Account phia server, roi goi
 * control plane qua private service binding bang envelope HMAC noi bo
 * `ecoma-internal-v2` (`@ecoma-io/internal-auth-contracts`) mang actor `sub`
 * DA VERIFY trong `x-ecoma-internal-actor-sub` — header nay nam trong
 * canonical string nen chu ky bao trum no; control plane KHONG BAO GIO tin
 * danh tinh do browser cung cap va khong co duong nao nhan actor tu body.
 *
 * Chuoi tu choi (fail-closed o moi buoc):
 *   thieu cau hinh secret -> 503
 *   body vuot gioi han    -> 413
 *   envelope sai/het han/replay -> 401
 *   envelope hop le nhung KHONG mang actor sub -> 401 (portal surface chi
 *   phuc vu human principal; caller may chi dung API-key routes)
 *   loi store nonce o claim -> 503; loi KHAC loai (bug lap trinh, loi moi
 *   truong) thoat ra cho app.onError -> 500 — 503 chi danh cho su co storage,
 *   khong dung de giau bug.
 * Sau buoc verify, membership resolve o `src/portal-routes.ts` tu DB.
 *
 * Pattern middleware tuong duong: `apps/staff-access/src/main.ts` — cung
 * protocol, cung claim nonce chiem-ghi nguyen tu, cung `WWW-Authenticate`.
 */
import {
  INTERNAL_BODY_LIMIT_BYTES,
  NONCE_TTL_BUFFER_SECONDS,
  assertNonceExpirySeconds,
  verifyRequest,
  type VerifyRequestInput,
  type VerifyResult,
} from '@ecoma-io/internal-auth-contracts';
import type { RemoteCacheClient } from '@ecoma-io/remote-cache-infrastructure';
import type { RemoteCacheConfig } from './config';

/** Identity human principal da duoc verify cho mot request portal. */
export interface PortalIdentity {
  /** Opaque `sub` Ecoma Account cua developer — resolve membership tu day. */
  readonly actorSub: string;
}

/** That bai auth portal — status + body chuan, khong leak nguyen nhan noi bo. */
export type PortalAuthFailure =
  | {
      readonly status: 401;
      readonly body: { error: 'Unauthorized'; message: string };
      readonly headers: { readonly 'WWW-Authenticate': string };
    }
  | { readonly status: 413; readonly body: { error: 'Payload Too Large'; message: string } }
  | {
      readonly status: 503;
      readonly body: { error: 'Service Unavailable'; message: string };
    };

/** Header chu chuan tra kem 401 — caller khong phai biet protocol de map. */
const HMAC_CHALLENGE: { readonly 'WWW-Authenticate': string } = {
  'WWW-Authenticate': 'HMAC realm="ecoma-internal"',
};

function unauthorizedEnvelope(): PortalAuthFailure {
  return {
    status: 401,
    body: { error: 'Unauthorized', message: 'A valid internal envelope is required.' },
    headers: HMAC_CHALLENGE,
  };
}

function serviceUnavailable(): PortalAuthFailure {
  return {
    status: 503,
    body: { error: 'Service Unavailable', message: 'Service is unavailable' },
  };
}

/**
 * Loi store nonce — ranh gioi storage cua duong verify. Day la DUY NHAT loi
 * hop le nem ra khoi `verifyRequest`: moi sai lech protocol deu tra ket qua
 * co cau truc (`{ ok: false, reason }`), nen trong khoi `try` chi co claim
 * nonce (DB/driver) la nguon nem thuc su. Loi khac loai (bug lap trinh, loi
 * moi truong crypto) phai THOAT RA — `app.onError` cua `src/main.ts` log
 * errorName va tra 500 that, chu khong nguoi dung nao bi qua va 503 khong
 * dua van hanh di kiem tra DB khi su co nam o code.
 */
class PortalNonceStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super('the replay-guard nonce store rejected the claim');
    this.name = 'PortalNonceStoreUnavailableError';
    this.cause = cause;
  }
}

/**
 * Doc DUNG byte cua request body (gioi han `INTERNAL_BODY_LIMIT_BYTES`).
 * Tra `null` khi vuot gioi han — caller tra 413 thay vi doan hash.
 * Envelope ky tren byte tho; khong bao gio verify qua chuoi da decode.
 */
export async function readBodyBytes(request: Request): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > INTERNAL_BODY_LIMIT_BYTES) return null;
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Nguon header phang cho verifyRequest — truyen thang Headers cung duoc. */
function headersForVerification(request: Request): VerifyRequestInput['headers'] {
  // `Headers.forEach` cua Web API luon truyen gia tri string (khong bao gio
  // null) — kieu cua map la `string` du chinh, khong goi y header co the null.
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

/**
 * Resolver secret theo `kid` — chi khi config co `kid`: kid khac tren wire la
 * KHOA KHONG BIET, resolver nem => verifyRequest ve `bad_signature`
 * (fail-closed, khong co secret fallback). Khi config khong dat kid, bo qua
 * resolver: header kid chi la chi dan, chu ky van phai dung chung secret.
 */
function resolveInternalSecret(
  internalAuth: NonNullable<RemoteCacheConfig['internalAuth']>,
): ((kid: string) => Promise<string>) | undefined {
  if (internalAuth.kid === null) return undefined;
  const expectedKid = internalAuth.kid;
  const secret = internalAuth.secret;
  return async (kid: string) => {
    if (kid !== expectedKid) {
      throw new Error('unknown internal kid');
    }
    return secret;
  };
}

/** Tham so verify cho mot request portal da doc byte. */
export interface VerifyPortalIdentityInput {
  /** Request goc — method/path/headers doc tu day, dung chuoi ma sender ky. */
  readonly request: Request;
  /** Byte tho cua body — `null` cung do readBodyBytes tra. */
  readonly body: Uint8Array | null;
  readonly config: RemoteCacheConfig;
  /** Client DB cho claim nonce — cung mot client cua request. */
  readonly db: RemoteCacheClient;
  /** Epoch giay hien tai, chuoi — nguoi goi truyen de test khong doc dong ho. */
  readonly now: string;
}

/**
 * Verify envelope + doi actor sub. Tra identity hoac that bai HTTP chuan.
 *
 * ⚠️ Claim nonce la CHIEM-GHI nguyen tu (`INSERT ... ON CONFLICT DO NOTHING
 * RETURNING`) tren `remote_cache.internal_nonces`, TTL neo vao timestamp cua
 * envelope (xem JSDoc `claimNonce` cua contract — neo vao `now` cua phia nhan
 * lam TTL ngan hon cua so replay). Prune theo lo chay trong CUNG statement.
 */
export async function verifyPortalIdentity(
  input: VerifyPortalIdentityInput,
): Promise<PortalIdentity | PortalAuthFailure> {
  const internalAuth = input.config.internalAuth;
  if (internalAuth === null) {
    // Portal surface khong duoc cap secret: fail-closed 503, phan con lai cua
    // app (machine routes + data plane) khong anh huong.
    return serviceUnavailable();
  }
  const skewSeconds = internalAuth.skewSeconds;
  const url = new URL(input.request.url);
  let verification: VerifyResult;
  try {
    verification = await verifyRequest({
      method: input.request.method,
      path: url.pathname + url.search,
      body: input.body,
      headers: headersForVerification(input.request),
      secret: internalAuth.secret,
      secretByKid: resolveInternalSecret(internalAuth),
      now: input.now,
      skewSeconds,
      claimNonce: async (nonce, timestampSeconds) => {
        const expiresAt = timestampSeconds + skewSeconds + NONCE_TTL_BUFFER_SECONDS;
        // Chan o TANG GHI, khong chi dua vao rang buoc o tang verify: mot loi
        // don vi (mili-giay vs giay) lam `to_timestamp` tao `expires_at` vao
        // nam 57000 — hang khong bao gio duoc prune, tuc replay guard bi vo
        // hieu hoa IM LANG (JSDoc `assertNonceExpirySeconds` cua contract).
        // Dat TRUOC khoi `try` ben duoi: day la loi lap trinh/don vi, khong
        // phai su co storage, nen no phai thoat ra cho `app.onError` (500 +
        // log errorName) thay vi bi danh nhan la `PortalNonceStoreUnavailableError`.
        assertNonceExpirySeconds(expiresAt);
        // Cat prune dung DONG HO CUA NGUOI GOI, khong phai `Date.now()`: buoc
        // verify da chan `|now - timestamp| <= skew` tren chinh `input.now`
        // (verifyRequest kiem no bang `isEpochSeconds`), nen prune phai neo
        // cung moc do. Lech dong ho thi mot `now` tiem vao (test, hoac mot
        // buoc doi sau nay) bi prune that xoa mat nonce ma replay guard con
        // can. Production: `input.now` chinh la dong ho that.
        const nowSeconds = Number(input.now);
        let rows: readonly { nonce: string }[];
        try {
          rows = await input.db.unsafe(
            `WITH deleted AS (
               DELETE FROM remote_cache.internal_nonces WHERE expires_at <= to_timestamp($3)
             )
             INSERT INTO remote_cache.internal_nonces (nonce, expires_at)
             VALUES ($1, to_timestamp($2))
             ON CONFLICT (nonce) DO NOTHING
             RETURNING nonce`,
            [nonce, expiresAt, nowSeconds],
          );
        } catch (error) {
          // Danh dau ranh gioi storage: moi loi tu day la su co DB/driver,
          // khong phai sai lech protocol (cai do verifyRequest tu tra).
          throw new PortalNonceStoreUnavailableError(error);
        }
        return rows.length === 0;
      },
    });
  } catch (error) {
    if (!(error instanceof PortalNonceStoreUnavailableError)) {
      // Khong phai loi store nonce: bug lap trinh hoac loi moi truong — nem
      // tiep cho app.onError (500 + log errorName), that bai that cua no,
      // thay vi nguoi dung qua va van hanh doc 503 nhu hieu DB hong.
      throw error;
    }
    // Log mot dong JSON chi mang ten loi (khong bao gio token/body —
    // invariant observability): khong co log thi loi DB that bi an sau 503
    // chung. Chi ten loi, khong dua raw message — message cua postgres/
    // Hyperdrive co the mang chi tiet binding/connection.
    // oxlint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'portal-auth',
        errorName: error.name,
        causeName: error.cause instanceof Error ? error.cause.name : String(error.cause),
      }),
    );
    // Loi DB/postgres tu claim nonce hoac loi driver: 503, khong leak chi
    // tiet binding/connection vao body.
    return serviceUnavailable();
  }
  if (!verification.ok) {
    return unauthorizedEnvelope();
  }
  const actorSub = verification.actorSub;
  if (typeof actorSub !== 'string' || actorSub.length === 0) {
    // Envelope hop le nhung khong mang human principal: portal surface khong
    // phuc vu caller may (caller may dung API-key routes). 401 chu khong 403
    // — caller chua duoc xac thuc DUOI dung principal ma surface nay nhan.
    return {
      status: 401,
      body: {
        error: 'Unauthorized',
        message: 'The internal envelope must carry a verified actor identity.',
      },
      headers: HMAC_CHALLENGE,
    };
  }
  return { actorSub };
}
